import crypto from 'node:crypto';
import http from 'node:http';

import { ApiError, discover, request } from './api.mjs';
import { dropSpool } from './events.mjs';
import { grantTokens, isSignedIn, isStateBusy } from './state.mjs';
import { CLIENT_NAME, PLUGIN_VERSION, logError, safeCode, sha256, sleep } from './util.mjs';

const LOOPBACK_PORTS = [47651, 47652, 47653, 47654, 47655];
export const redirectUriFor = (port) => `http://127.0.0.1:${port}/callback`;
const PLUGIN_SCOPE = 'pulse:plugin';
export const SCOPES = `openid profile email offline_access ${PLUGIN_SCOPE}`;
const REFRESH_SKEW_MS = 60_000;
const SETTLE_REFRESHES_MS = 10_000;
const REFUSED_LOCK_WAIT_MS = 5_000;
const REVOKE_TIMEOUT_MS = 5_000;
const LISTENER_PING_TIMEOUT_MS = 1_500;
const STORE_ATTEMPTS = 3;

const inflight = new Map();

export const REFRESH_RETRY = { delaysMs: [1_000, 5_000], lateAfterMs: 50_000, storeWaitMs: 3_000, storeRetryMs: 500 };
const tokenHash = (token) => sha256(`pulse-refresh|${token}`).slice(0, 32);

export function refreshOutcomeUnknown(record) {
  const u = record?.refreshUnknown;
  return Boolean(u && record.refreshToken && u.token === tokenHash(record.refreshToken) && !u.late);
}

export async function settleRefreshes(ms = SETTLE_REFRESHES_MS) {
  if (inflight.size === 0) {
    return;
  }
  let timer;
  await Promise.race([
    Promise.allSettled([...inflight.values()]),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

export class Auth {
  constructor(state, apiUrl, providerId = null) {
    this.state = state;
    this.apiUrl = apiUrl;
    this.providerId = providerId;
  }

  record() {
    return this.state.auth(this.apiUrl);
  }

  registered(providerId = this.providerId) {
    return Boolean(providerId && this.record()?.registeredProviders?.[providerId]);
  }

  async noteRegistered(grantId, now = Date.now(), providerId = this.providerId) {
    if (!providerId) {
      return;
    }
    try {
      await this.state.setAuth(this.apiUrl, (r) =>
        (r.grantId ?? null) === (grantId ?? null) && isSignedIn(r)
          ? {
              ...r,
              registeredProviders: { ...(r.registeredProviders ?? {}), [providerId]: now },
              registeredVersions: { ...(r.registeredVersions ?? {}), [providerId]: PLUGIN_VERSION },
            }
          : r,
      );
    } catch (err) {
      if (!isStateBusy(err)) {
        throw err;
      }
      logError(this.state.home, 'registration not saved: state busy');
    }
  }

  signedIn() {
    return isSignedIn(this.record());
  }

  reason() {
    return this.record()?.needsSignIn ? 'needs_sign_in' : 'not_signed_in';
  }

  async markNeedsSignIn({ keepGrant = false, failed = null } = {}) {
    let marked = false;
    await this.state.setAuth(this.apiUrl, (r) => {
      if (failed && !holdsTokens(r, failed)) {
        return r;
      }
      marked = true;
      return {
        ...r,
        ...(keepGrant && (r.accessToken || r.refreshToken) ? { previousGrant: grantOf(r) } : {}),
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        needsSignIn: true,
        refreshUnknown: undefined,
      };
    });
    if (marked) {
      dropSpool(this.state, { apiUrl: this.apiUrl });
    }
    return marked;
  }

  async refused({ keepGrant = false, failed }) {
    const release = await this.state.authLock(REFUSED_LOCK_WAIT_MS);
    if (!release) {
      logError(this.state.home, 'a refused sign-in was not marked: another Pulse process holds the sign-in lock');
      throw new ApiError(0, { error: 'busy', error_description: 'Another Pulse process holds the sign-in lock' });
    }
    try {
      return await this.markNeedsSignIn({ keepGrant, failed });
    } catch (err) {
      throw busyAsApiError(err);
    } finally {
      await release();
    }
  }

  async accessToken({ force = false, failed = null, now = Date.now } = {}) {
    const r = this.record();
    if (!r || r.needsSignIn) {
      return null;
    }
    if (!force && r.accessToken && (r.expiresAt ?? 0) - REFRESH_SKEW_MS > now()) {
      return r.accessToken;
    }
    const key = this.apiUrl;
    if (!inflight.has(key)) {
      inflight.set(
        key,
        this.refreshLocked({ force, failed, now })
          .then((token) => (token === REFRESH_AGAIN ? this.refreshLocked({ force: false, failed: null, now }) : token))
          .then((token) => (token === REFRESH_AGAIN ? this.currentToken() : token))
          .catch((err) => {
            throw busyAsApiError(err);
          })
          .finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  }

  async refreshLocked({ force, failed, now }) {
    const release = await this.state.authLock();
    if (!release) {
      logError(this.state.home, 'refresh lock busy');
      throw new ApiError(0, { error: 'busy', error_description: 'Another Pulse process is refreshing the sign-in' });
    }
    try {
      const r = this.record();
      if (!r || r.needsSignIn) {
        return null;
      }
      const fresh = r.accessToken && (r.expiresAt ?? 0) - REFRESH_SKEW_MS > now();
      if (fresh && (!force || r.accessToken !== failed)) {
        return r.accessToken;
      }
      if (!r.refreshToken || !r.clientId) {
        await this.markNeedsSignIn({ failed: { accessToken: r.accessToken ?? null, refreshToken: r.refreshToken ?? null } });
        return null;
      }
      const tokenEndpoint = r.tokenEndpoint ?? (await discover(this.apiUrl)).token_endpoint;
      release.touch();
      const sent = r.refreshToken;
      const grant = { clientId: r.clientId, grantId: r.grantId ?? null };
      const stillOurs = () => holdsRefresh(this.record(), sent, grant);
      const firstAt = r.refreshUnknown?.token === tokenHash(sent) ? r.refreshUnknown.firstAt : now();
      const post = () =>
        request(tokenEndpoint, { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: sent, client_id: r.clientId } });
      const transientStatus = (status) => status === 0 || status === 429 || status >= 500;
      await this.noteRefreshUnknown(sent, firstAt, now());
      let res = await post();
      for (const delay of REFRESH_RETRY.delaysMs) {
        if (!transientStatus(res.status)) {
          break;
        }
        release.touch();
        await sleep(delay);
        release.touch();
        if (!stillOurs()) {
          return this.tokenAfterChange(grant, now);
        }
        res = await post();
      }
      release.touch();
      if (res.status === 200 && res.json?.access_token) {
        const stored = await this.storeRefreshed(res.json, sent, grant, tokenEndpoint, now, release);
        if (stored === 'stored') {
          return res.json.access_token;
        }
        if (stored === 'replaced' || stored === 'superseded') {
          return this.tokenAfterChange(grant, now);
        }
        await this.noteRefreshUnknown(sent, firstAt, now());
        throw new ApiError(0, { error: 'busy', error_description: 'The new Pulse sign-in could not be saved' });
      }
      if (res.status === 400 || res.status === 401) {
        logError(this.state.home, `refresh rejected ${safeCode(res.json?.error, String(res.status))}`);
        if (!(await this.markNeedsSignIn({ failed: { refreshToken: r.refreshToken } }))) {
          const current = this.record();
          return isSignedIn(current) ? (current.accessToken ?? null) : null;
        }
        return null;
      }
      logError(this.state.home, 'refresh failed', { code: 'refresh', status: res.status });
      if (transientStatus(res.status)) {
        await this.noteRefreshUnknown(sent, firstAt, now());
      }
      throw new ApiError(res.status, res.json ?? { error: res.status === 0 ? 'network' : `http_${res.status}` });
    } finally {
      await release();
    }
  }

  tokenAfterChange(grant, now) {
    const rec = this.record();
    if (isSignedIn(rec) && sameGrant(rec, grant)) {
      return rec.accessToken && (rec.expiresAt ?? 0) - REFRESH_SKEW_MS > now() ? rec.accessToken : REFRESH_AGAIN;
    }
    return this.currentToken();
  }

  currentToken() {
    const current = this.record();
    return isSignedIn(current) ? (current.accessToken ?? null) : null;
  }

  async storeRefreshed(tokens, sent, grant, tokenEndpoint, now, release) {
    for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        release.touch();
        await sleep(REFRESH_RETRY.storeRetryMs);
        release.touch();
      }
      let outcome = 'busy';
      try {
        await this.state.setAuth(
          this.apiUrl,
          (rec) => {
            if (holdsRefresh(rec, sent, grant)) {
              outcome = 'stored';
              return storedPair(rec, tokens, now());
            }
            if (isSignedIn(rec) && sameGrant(rec, grant)) {
              outcome = rec.refreshToken === tokens.refresh_token ? 'stored' : 'superseded';
              return rec;
            }
            outcome = 'replaced';
            return withOrphanGrant(rec, grantFromTokens(tokens, { clientId: grant.clientId, tokenEndpoint }, now()));
          },
          { waitMs: REFRESH_RETRY.storeWaitMs },
        );
        if (outcome === 'replaced') {
          logError(this.state.home, 'refresh answer for a grant that was left: queued for revoking');
        }
        return outcome;
      } catch (err) {
        if (!isStateBusy(err)) {
          throw err;
        }
        logError(this.state.home, `the refreshed sign-in was not saved yet (attempt ${attempt + 1} of ${STORE_ATTEMPTS})`, err);
      }
    }
    return 'busy';
  }

  async noteRefreshUnknown(sent, firstAt, at) {
    try {
      await this.state.setAuth(this.apiUrl, (rec) =>
        rec.refreshToken === sent
          ? { ...rec, refreshUnknown: { token: tokenHash(sent), firstAt, late: at - firstAt > REFRESH_RETRY.lateAfterMs } }
          : rec,
        { waitMs: REFRESH_RETRY.storeWaitMs },
      );
    } catch (err) {
      logError(this.state.home, 'refresh outcome not saved', err);
    }
  }

  async saveTokens(tokens, now = Date.now(), client = null) {
    await this.state.setAuth(this.apiUrl, (prev) => {
      const r = client
        ? { ...prev, ...client, refreshToken: null, scope: null, user: null, registeredProviders: {}, registeredVersions: {}, grantId: crypto.randomBytes(8).toString('hex') }
        : prev;
      if (client) {
        delete r.pendingClient;
        delete r.previousGrant;
        delete r.orphanGrants;
        delete r.legacySpoolProvider;
      }
      return { ...storedPair(r, tokens, now), ...(client ? { signedInAt: now } : {}) };
    });
  }
}

const DEFAULT_TOKEN_TTL_S = 3600;
const expiryOf = (tokens, now) => now + Number(tokens.expires_in ?? DEFAULT_TOKEN_TTL_S) * 1000;

function grantFromTokens(tokens, { clientId, tokenEndpoint }, now) {
  return {
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: expiryOf(tokens, now),
    clientId,
    tokenEndpoint,
  };
}

function sharesTokens(record, grant) {
  const same = (key) => Boolean(grant?.[key] && record?.[key] === grant[key]);
  return same('accessToken') || same('refreshToken');
}

function withOrphanGrant(record, grant) {
  const queued = record.orphanGrants ?? [];
  if (sharesTokens(record, grant) || queued.some((g) => sharesTokens(g, grant))) {
    return record;
  }
  return { ...record, orphanGrants: [...queued, grant] };
}

function storedPair(r, tokens, now) {
  const out = {
    ...r,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? r.refreshToken ?? null,
    expiresAt: expiryOf(tokens, now),
    scope: tokens.scope ?? r.scope ?? null,
    needsSignIn: false,
  };
  delete out.refreshUnknown;
  return out;
}

function holdsRefresh(rec, sent, grant) {
  return Boolean(rec && !rec.needsSignIn && rec.refreshToken === sent && sameGrant(rec, grant));
}

function sameGrant(rec, grant) {
  return Boolean(rec && rec.clientId === grant.clientId && (rec.grantId ?? null) === grant.grantId);
}

const REFRESH_AGAIN = Symbol('refresh again');

function busyAsApiError(err) {
  return isStateBusy(err) ? new ApiError(0, { error: 'busy', error_description: 'Pulse sign-in state is busy' }) : err;
}

function holdsTokens(record, tokens) {
  return Object.entries(tokens).every(([key, value]) => (record?.[key] ?? null) === (value ?? null));
}

export function grantOf(record) {
  if (!record) {
    return null;
  }
  if (record.accessToken || record.refreshToken) {
    return grantTokens(record);
  }
  return record.previousGrant ?? null;
}

export async function revokeGrantOutcome(state, apiUrl, grant, { now = Date.now(), timeoutMs = REVOKE_TIMEOUT_MS } = {}) {
  let current = grant;
  const result = (outcome) => ({ outcome, grant: current });
  if (!grant) {
    return result('refused');
  }
  const ok = (status) => status >= 200 && status < 300;
  const transient = (status) => status === 0 || status === 429 || status >= 500;
  const logout = async (token) =>
    (await request(`${apiUrl}/plugin/v1/logout`, { method: 'POST', token, json: {}, timeoutMs })).status;
  const outcome = (status) => result(ok(status) ? 'revoked' : transient(status) ? 'transient' : 'refused');
  try {
    if (grant.accessToken && (grant.expiresAt ?? Infinity) > now) {
      const status = await logout(grant.accessToken);
      if (status !== 401) {
        return outcome(status);
      }
    }
    if (!grant.refreshToken || !grant.clientId) {
      return result('refused');
    }
    const tokenEndpoint = grant.tokenEndpoint ?? (await discover(apiUrl)).token_endpoint;
    const res = await request(tokenEndpoint, {
      method: 'POST',
      form: { grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: grant.clientId },
      timeoutMs,
    });
    if (res.status !== 200 || !res.json?.access_token) {
      return result(transient(res.status) ? 'transient' : 'refused');
    }
    current = {
      ...grant,
      accessToken: res.json.access_token,
      refreshToken: res.json.refresh_token ?? grant.refreshToken,
      expiresAt: expiryOf(res.json, now),
    };
    return outcome(await logout(res.json.access_token));
  } catch (err) {
    logError(state.home, 'revoking a grant failed; it is kept to try again', err);
    return result('transient');
  }
}

export async function revokeOrphans(state, apiUrl) {
  const record = state.auth(apiUrl);
  const orphans = record?.orphanGrants ?? [];
  if (orphans.length === 0) {
    return 0;
  }
  const done = [];
  const rotated = [];
  for (const grant of orphans) {
    if (sharesTokens(record, grant)) {
      done.push(grant);
      continue;
    }
    const { outcome, grant: after } = await revokeGrantOutcome(state, apiUrl, grant);
    if (outcome !== 'transient') {
      done.push(grant);
    } else if (after !== grant) {
      rotated.push([grant, after]);
    }
  }
  const same = (a, b) => a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
  const next = await state.setAuth(apiUrl, (r) => {
    const left = (r.orphanGrants ?? [])
      .filter((g) => !done.some((d) => same(d, g)))
      .map((g) => rotated.find(([old]) => same(old, g))?.[1] ?? g);
    const out = { ...r, orphanGrants: left };
    if (left.length === 0) {
      delete out.orphanGrants;
    }
    return out;
  });
  return next?.orphanGrants?.length ?? 0;
}

export const REFUSED_GRANT_OUTCOMES = ['revoked', 'queued', 'left'];

export async function removeRefusedGrant(state, apiUrl, grant) {
  const { outcome, grant: after } = await revokeGrantOutcome(state, apiUrl, grant);
  if (outcome === 'revoked') {
    return 'revoked';
  }
  if (outcome === 'transient' && (await queueOrphanGrant(state, apiUrl, after))) {
    return 'queued';
  }
  return 'left';
}

async function queueOrphanGrant(state, apiUrl, grant) {
  let release = null;
  try {
    release = await state.authLock();
    if (!release) {
      logError(state.home, 'the grant a refused sign-in left was not queued for revoking: another Pulse process holds the sign-in lock');
      return false;
    }
    let queued = false;
    await state.setAuth(apiUrl, (record) => {
      const next = withOrphanGrant(record, grant);
      queued = next !== record;
      return next;
    });
    return queued;
  } catch (err) {
    logError(state.home, 'the grant a refused sign-in left was not queued for revoking', err);
    return false;
  } finally {
    await release?.();
  }
}

const hasPluginScope = (scope) => typeof scope === 'string' && scope.split(/\s+/).includes(PLUGIN_SCOPE);

async function verifyPluginGrant(apiUrl, tokens) {
  if (typeof tokens.scope === 'string') {
    if (!hasPluginScope(tokens.scope)) {
      throw unsupportedServer();
    }
    return;
  }
  const me = await request(`${apiUrl}/plugin/v1/me`, { token: tokens.access_token });
  if (me.status >= 200 && me.status < 300) {
    return;
  }
  if (me.status === 0 || me.status === 429 || me.status >= 500) {
    throw new ApiError(me.status, me.json);
  }
  throw unsupportedServer();
}

const unsupportedServer = () =>
  new ApiError(0, { error: 'plugin_unsupported', error_description: 'This Pulse server does not support the plugin yet' });

export function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: crypto.randomBytes(16).toString('base64url') };
}

export async function ensureClient(state, apiUrl, meta, { renew = false } = {}) {
  const redirectUris = LOOPBACK_PORTS.map(redirectUriFor);
  const existing = state.auth(apiUrl);
  const reusable = (c) =>
    c?.clientId &&
    JSON.stringify(c.redirectUris) === JSON.stringify(redirectUris) &&
    c.registrationEndpoint === meta.registration_endpoint;
  if (!renew && reusable(existing)) {
    return { clientId: existing.clientId, redirectUris, registrationEndpoint: existing.registrationEndpoint, tokenEndpoint: meta.token_endpoint };
  }
  if (!renew && reusable(existing?.pendingClient)) {
    return { ...existing.pendingClient, tokenEndpoint: meta.token_endpoint };
  }
  const res = await request(meta.registration_endpoint, {
    method: 'POST',
    json: {
      client_name: CLIENT_NAME,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPES,
    },
  });
  if ((res.status !== 201 && res.status !== 200) || typeof res.json?.client_id !== 'string') {
    throw new ApiError(res.status, res.json);
  }
  const client = {
    clientId: res.json.client_id,
    redirectUris,
    registrationEndpoint: meta.registration_endpoint,
    tokenEndpoint: meta.token_endpoint,
  };
  await state.setAuth(apiUrl, (r) => ({ ...r, pendingClient: client }));
  return client;
}

export function authorizeUrl(meta, { clientId, redirectUri, challenge, state }) {
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', SCOPES);
  return url.toString();
}

export async function listenLoopback(handler) {
  for (const port of LOOPBACK_PORTS) {
    const server = http.createServer(handler);
    const ok = await new Promise((resolve, reject) => {
      server.once('error', (err) => (err.code === 'EADDRINUSE' ? resolve(false) : reject(err)));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      return { server, port };
    }
  }
  throw new ApiError(0, {
    error: 'ports_busy',
    error_description: `Ports ${LOOPBACK_PORTS[0]}-${LOOPBACK_PORTS.at(-1)} on 127.0.0.1 are all in use`,
  });
}

const page = (title, text) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1c1b19;background:#f5f4f1}' +
  'h1{font-size:1.4rem}@media(prefers-color-scheme:dark){body{background:#1c1b19;color:#f5f4f1}}</style></head>' +
  `<body><h1>${title}</h1><p>${text}</p></body></html>`;

export const DISCONNECT_HINT =
  'In Pulse Settings → AI assistants → Connected apps, each computer has its own "Pulse plugin" entry: choose Disconnect on this one. ' +
  'Not sure which one? Disconnect all of them, then sign in again on the computers you keep. ' +
  'If the Pulse plugin card on that page shows Disconnect plugin, it signs out every computer at once.';
export const REMOVE_LEFT_GRANT = `Pulse kept the connection this sign-in created. ${DISCONNECT_HINT}`;
export const RETRY_LEFT_GRANT = `Pulse could not remove the connection this sign-in created yet and tries again later. ${DISCONNECT_HINT}`;
export const RETRY_ORPHAN_GRANTS = `Pulse still has to remove a connection a refused or replaced sign-in left, and tries again with the next upload or sign-in. ${DISCONNECT_HINT}`;
export const REFUSED_GRANT_NOTICES = { queued: RETRY_LEFT_GRANT, left: REMOVE_LEFT_GRANT };

export const SIGN_IN_REPLACED = 'sign_in_replaced';

export const signInReplaced = () => new ApiError(0, { error: SIGN_IN_REPLACED, error_description: 'A newer sign-in replaced this one' });

export function revokeUnsavedTokens(state, apiUrl, tokens, { clientId, tokenEndpoint }) {
  return removeRefusedGrant(state, apiUrl, grantFromTokens(tokens, { clientId, tokenEndpoint }, Date.now()));
}

export function awaitCallback({ server, pending, timeoutMs, onRefusedGrant, signal = null }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new ApiError(0, { error: 'timeout', error_description: 'Sign-in was not completed in time' }));
    }, timeoutMs);
    const stop = () => {
      clearTimeout(timer);
      server.close();
    };
    let callbackClaimed = false;
    signal?.addEventListener(
      'abort',
      () => {
        if (!callbackClaimed) {
          stop();
          server.closeAllConnections?.();
          reject(signInReplaced());
        }
      },
      { once: true },
    );
    const answer = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/ping') {
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(pingToken(pending.state));
        return;
      }
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      if (callbackClaimed) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page('Pulse sign-in', 'This sign-in is already being completed. You can close this tab.'));
        return;
      }
      const finish = (status, title, text, outcome) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page(title, text));
        stop();
        outcome();
      };
      if (url.searchParams.get('state') !== pending.state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          page(
            'Sign-in link mismatch',
            'This sign-in link was replaced by a newer one. Use the newest link your agent showed, or ask your agent for Pulse status.',
          ),
        );
        return;
      }
      callbackClaimed = true;
      const error = url.searchParams.get('error');
      if (error) {
        finish(200, 'Pulse was not connected', 'You cancelled the connection. You can close this tab.', () =>
          reject(new ApiError(0, { error: error === 'access_denied' ? 'access_denied' : 'authorize_failed' })),
        );
        return;
      }
      const code = url.searchParams.get('code');
      const tokens = await request(pending.tokenEndpoint, {
        method: 'POST',
        form: {
          grant_type: 'authorization_code',
          code: code ?? '',
          redirect_uri: pending.redirectUri,
          client_id: pending.clientId,
          code_verifier: pending.verifier,
        },
      });
      if (tokens.status === 200 && tokens.json?.access_token) {
        try {
          await verifyPluginGrant(pending.apiUrl, tokens.json);
          if (signal?.aborted) {
            throw signInReplaced();
          }
        } catch (err) {
          err.refusedGrant = await onRefusedGrant(
            grantFromTokens(tokens.json, { clientId: pending.clientId, tokenEndpoint: pending.tokenEndpoint }, Date.now()),
          );
          const notice = REFUSED_GRANT_NOTICES[err.refusedGrant];
          const leftGrant = notice ? ` ${notice}` : '';
          const text = new Map([
            ['plugin_unsupported', `This Pulse server does not support the plugin yet. Nothing was connected.${leftGrant} You can close this tab.`],
            [SIGN_IN_REPLACED, `A newer Pulse sign-in replaced this one. Nothing was connected here.${leftGrant} Use the newest link your agent showed.`],
          ]).get(err.code) ?? `The sign-in could not be completed.${leftGrant} Start again from your agent.`;
          finish(400, 'Pulse was not connected', text, () => reject(err));
          return;
        }
        finish(200, 'Pulse is connected', 'You can close this tab and return to your agent.', () => resolve(tokens.json));
      } else {
        finish(400, 'Pulse was not connected', 'The sign-in could not be completed. Start again from your agent.', () =>
          reject(new ApiError(tokens.status, tokens.json)),
        );
      }
    };
    server.on('request', (req, res) => {
      answer(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'cache-control': 'no-store' }).end();
        }
        stop();
        reject(err);
      });
    });
  });
}

const pingToken = (nonce) => sha256(`pulse-login-ping|${nonce}`).slice(0, 32);

export async function listenerAlive(pending, timeoutMs = LISTENER_PING_TIMEOUT_MS) {
  if (!pending?.port || !pending.state) {
    return false;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${pending.port}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && (await res.text()) === pingToken(pending.state);
  } catch (err) {
    const code = err?.cause?.code ?? err?.code;
    return !(code === 'ECONNREFUSED' || code === 'ECONNRESET');
  }
}
