import { runUnlessBusy } from './state.mjs';
import { noteOutdated, notePluginInfo } from './updates.mjs';
import { PLUGIN_VERSION, hasUnsafeForOneLine, logError, parseJson, safeCode, urlOrNull } from './util.mjs';

const REQUEST_TIMEOUT_MS = 10_000;
const MCP_TIMEOUT_MS = 120_000;
const BROWSER_URL_MAX = 4096;
const SKILL_LIST_MAX_BYTES = 1024 * 1024;
const SKILL_TIMEOUT_MS = 30_000;

export class NotSignedIn extends Error {
  constructor(reason = 'not_signed_in') {
    super(reason);
    this.code = reason;
  }
}

export class ApiError extends Error {
  constructor(status, json) {
    super(json?.error_description ?? json?.message ?? json?.error ?? `HTTP ${status}`);
    this.status = status;
    this.code = safeCode(json?.error, status === 0 ? 'network' : `http_${status}`);
    this.json = json;
  }
}

const PROJECT_NOT_FOUND = 'project_not_found';

export const isProjectGone = (err) => err instanceof ApiError && err.status === 404 && err.code === PROJECT_NOT_FOUND;

export const isUnknownNotFound = (err) => err instanceof ApiError && err.status === 404 && err.code !== PROJECT_NOT_FOUND;

export async function request(
  url,
  { method = 'GET', token, json, form, accept = 'application/json', timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = 0 } = {},
) {
  const headers = { accept, 'user-agent': `pulse-plugin/${PLUGIN_VERSION}` };
  let body;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { status: 0, json: null, error: err.name };
  }
  let answer;
  try {
    answer = maxBytes > 0 ? await readCapped(res, maxBytes) : { text: await res.text() };
  } catch (err) {
    return { status: 0, json: null, error: err.name };
  }
  const authenticate = res.headers.get('www-authenticate') ?? '';
  if (answer.tooLarge) {
    return { status: res.status, json: null, tooLarge: true, stopError: answer.stopError, authenticate };
  }
  const { text } = answer;
  const parsed = text ? parseJson(text) : { ok: true, value: null };
  if (parsed.ok) {
    return { status: res.status, json: parsed.value, authenticate };
  }
  const eventStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
  return { status: res.status, json: eventStream ? lastSseMessage(text) : null, authenticate };
}

async function stopReadingBody(stream) {
  try {
    await stream.cancel();
    return null;
  } catch (err) {
    return err;
  }
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { tooLarge: true, stopError: res.body ? await stopReadingBody(res.body) : null };
  }
  if (!res.body) {
    return { text: '' };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      return { tooLarge: true, stopError: await stopReadingBody(reader) };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

function lastSseMessage(text) {
  let last = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    const parsed = data ? parseJson(data) : { ok: false };
    if (parsed.ok) {
      last = parsed.value;
    }
  }
  return last;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function safeBrowserUrl(value, { allowQuery = false } = {}) {
  if (typeof value !== 'string' || value.length > BROWSER_URL_MAX || hasUnsafeForOneLine(value)) {
    return false;
  }
  const forbidden = allowQuery ? /[\s"'`<>\\^|{}$;()!*]/ : /[\s"'`<>\\^|{}$;()!*&?#]/;
  if (forbidden.test(value)) {
    return false;
  }
  const url = urlOrNull(value);
  if (!url) {
    return false;
  }
  if (url.username || url.password) {
    return false;
  }
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

export async function discover(apiUrl) {
  const base = new URL(apiUrl);
  const candidates = [`${apiUrl}/.well-known/oauth-authorization-server`];
  if (`${base.origin}` !== apiUrl) {
    candidates.push(`${base.origin}/.well-known/oauth-authorization-server`);
  }
  for (const url of candidates) {
    const res = await request(url);
    const meta = res.json;
    if (res.status === 200 && meta?.authorization_endpoint && meta?.token_endpoint && meta?.registration_endpoint) {
      if (!safeBrowserUrl(meta.authorization_endpoint)) {
        throw new ApiError(0, { error: 'untrusted_metadata', error_description: 'authorization_endpoint is not a plain https URL' });
      }
      for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
        const endpoint = urlOrNull(meta[key]);
        if (!endpoint) {
          throw new ApiError(0, { error: 'untrusted_metadata', error_description: `${key} is not a URL` });
        }
        const sameOrigin = endpoint.origin === base.origin;
        const local = LOOPBACK.has(base.hostname) && LOOPBACK.has(endpoint.hostname);
        if (!sameOrigin && !local) {
          throw new ApiError(0, { error: 'untrusted_metadata', error_description: `${key} is not on ${base.origin}` });
        }
      }
      const methods = meta.code_challenge_methods_supported;
      if (Array.isArray(methods) && !methods.includes('S256')) {
        throw new ApiError(0, { error: 'unsupported_server', error_description: 'The server does not support PKCE S256' });
      }
      return meta;
    }
    if (res.status === 0) {
      throw new ApiError(0, { error: 'network', error_description: `Cannot reach ${base.origin}` });
    }
  }
  throw new ApiError(404, { error: 'no_metadata', error_description: `No OAuth metadata at ${base.origin}` });
}

const API_HOST_PREFIX = 'api.';

function isOnApiSite(link, api) {
  if (LOOPBACK.has(link.hostname) || LOOPBACK.has(api.hostname)) {
    return LOOPBACK.has(link.hostname) && LOOPBACK.has(api.hostname);
  }
  return link.hostname === api.hostname || api.hostname === `${API_HOST_PREFIX}${link.hostname}`;
}

export function webLinkOnApiSite(value, apiUrl) {
  if (!safeBrowserUrl(value, { allowQuery: true })) {
    return null;
  }
  const link = new URL(value);
  return isOnApiSite(link, new URL(apiUrl)) ? link.href : null;
}

const grantReplaced = (res) =>
  new ApiError(res.status, { error: 'grant_replaced', error_description: 'The Pulse sign-in changed while this request ran' });

const routeLabelOf = (path) => path.split('?')[0].replace(/[0-9a-f-]{36}/g, ':id');

const heartbeatBody = (auth) => ({ provider: auth.providerId, pluginVersion: PLUGIN_VERSION });

async function noteOutdatedOrLog(auth, json) {
  try {
    await noteOutdated(auth.state, auth.apiUrl, json);
  } catch (err) {
    logError(auth.state.home, 'plugin outdated state not saved', err);
  }
}

const isInsufficientScope = (res) =>
  res.status === 403 && (res.json?.error === 'insufficient_scope' || /insufficient_scope/.test(res.authenticate ?? ''));

async function sendSignedIn(auth, send) {
  let token = await auth.accessToken();
  if (!token) {
    throw new NotSignedIn(auth.reason());
  }
  let res = await send(token);
  if (res.status === 401) {
    token = await auth.accessToken({ force: true, failed: token });
    if (!token) {
      throw new NotSignedIn(auth.reason());
    }
    res = await send(token);
    if (res.status === 401) {
      if (!(await auth.refused({ failed: { accessToken: token } }))) {
        throw grantReplaced(res);
      }
      throw new NotSignedIn('needs_sign_in');
    }
  }
  if (isInsufficientScope(res)) {
    if (!(await auth.refused({ keepGrant: true, failed: { accessToken: token } }))) {
      throw grantReplaced(res);
    }
    throw new NotSignedIn('insufficient_scope');
  }
  return { res, token };
}

export async function pluginCall(auth, method, path, json, limits = {}) {
  const url = `${auth.apiUrl}/plugin/v1${path}`;
  const options = (t) => ({ method, token: t, json, ...limits });
  const sent = await sendSignedIn(auth, (t) => request(url, options(t)));
  const { token } = sent;
  let { res } = sent;
  if (res.status === 409 && res.json?.error === 'not_registered' && path !== '/heartbeat' && auth.providerId) {
    const grantId = auth.record()?.grantId;
    const hb = await request(`${auth.apiUrl}/plugin/v1/heartbeat`, { method: 'POST', token, json: heartbeatBody(auth) });
    if (hb.status >= 200 && hb.status < 300) {
      await auth.noteRegistered(grantId);
      await runUnlessBusy(auth.state, 'plugin version info not saved', () => notePluginInfo(auth.state, auth.apiUrl, hb.json?.plugin));
      res = await request(url, options(token));
    }
  }
  if (res.status === 426) {
    await noteOutdatedOrLog(auth, res.json);
  }
  if (res.tooLarge) {
    if (res.stopError) {
      logError(auth.state.home, `api ${method} ${routeLabelOf(path)}: stopping the read of a too large answer failed`, res.stopError);
    }
    throw new ApiError(502, { error: 'response_too_large', error_description: 'Pulse sent more data than the plugin accepts' });
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new ApiError(res.status, res.json);
    if (res.status === 0 || res.status >= 500) {
      logError(auth.state.home, `api ${method} ${routeLabelOf(path)}`, err);
    }
    throw err;
  }
  return res.json;
}

export async function mcpCall(auth, message, { timeoutMs = MCP_TIMEOUT_MS } = {}) {
  const url = `${auth.apiUrl}/mcp`;
  const { res } = await sendSignedIn(auth, (t) =>
    request(url, { method: 'POST', token: t, json: message, accept: 'application/json, text/event-stream', timeoutMs }),
  );
  if (res.status === 202 && message.id === undefined) {
    return null;
  }
  const rpc = res.json && typeof res.json === 'object' && res.json.jsonrpc === '2.0' && ('result' in res.json || 'error' in res.json);
  if (rpc && res.status > 0 && res.status < 500 && res.status !== 429) {
    return res.json;
  }
  if (res.status < 200 || res.status >= 300 || !res.json || typeof res.json !== 'object') {
    const err = new ApiError(res.status, res.json?.error && typeof res.json.error === 'object' ? { error: `mcp_${res.json.error.code}` } : res.json);
    if (res.status === 0 || res.status >= 500) {
      logError(auth.state.home, `api mcp ${message.method ?? 'message'}`, err);
    }
    throw err;
  }
  return res.json;
}

export async function listSkills(auth, projectId) {
  const result = await pluginCall(auth, 'GET', `/projects/${encodeURIComponent(projectId)}/skills`, undefined, { maxBytes: SKILL_LIST_MAX_BYTES });
  return Array.isArray(result?.skills) ? result.skills : [];
}

const SKILL_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

export function getSkill(auth, projectId, slug) {
  return pluginCall(auth, 'GET', `/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(slug)}`, undefined, {
    maxBytes: SKILL_RESPONSE_MAX_BYTES,
    timeoutMs: SKILL_TIMEOUT_MS,
  });
}

export { heartbeatBody };
