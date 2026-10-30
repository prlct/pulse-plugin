import crypto from 'node:crypto';
import path from 'node:path';

import {
  DEFAULT_API_URL,
  PLUGIN_VERSION,
  acquireLock,
  findProvider,
  hasUnsafeForOneLine,
  homeDir,
  isUnreadablePath,
  logError,
  modifiedAtOrNull,
  pastTimeOrNull,
  readJson,
  reportUnrestrictedDirs,
  urlOrNull,
  writeJson,
} from './util.mjs';

export const PROVIDER_IDS = ['claude-code', 'codex'];

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isDeviceId = (value) => typeof value === 'string' && DEVICE_ID_PATTERN.test(value);

export const COLLECTION_TTL_MS = 5 * 60 * 1000;
export const COLLECTION_REFRESH_AFTER_MS = COLLECTION_TTL_MS / 2;

const isFetchedInTheFuture = (cached) => Number.isFinite(cached?.fetchedAt) && pastTimeOrNull(cached.fetchedAt) === null;

const validFetchedAt = (cached) => pastTimeOrNull(cached?.fetchedAt);

export function isCollectionOlderThan(cached, ms, now = Date.now()) {
  const fetchedAt = validFetchedAt(cached);
  return fetchedAt === null || now - fetchedAt > ms;
}
const HOST_RECENT_MS = 12 * 60 * 60 * 1000;
const HOST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_WAIT_MS = 3_000;
const HOOK_RUN_REFRESH_MS = 60 * 60 * 1000;
const HOOK_RUN_VERSIONS_MAX = 4;
const CODEX_HOOK_RUNS_FILE = 'hook-run-codex.json';
const CRITICAL_WAIT_MS = 15_000;
const STATE_LOCK_STALE_MS = 10_000;
const AUTH_LOCK_STALE_MS = 30_000;
const STATE_BUSY_CODE = 'EBUSYSTATE';

const reportedUnreadable = new Set();

export const AUTH_FILE = 'auth.json';
const CONFIG_FILE = 'config.json';
const REPOS_FILE = 'repos.json';
const COLLECTION_FILE = 'collection.json';
const RECORDING_STATE_FILES = [CONFIG_FILE, AUTH_FILE, REPOS_FILE, COLLECTION_FILE];

export class StateBusyError extends Error {
  constructor(name) {
    super(`${name} is busy`);
    this.code = STATE_BUSY_CODE;
  }
}

export const isStateBusy = (err) => err?.code === STATE_BUSY_CODE;

export async function runUnlessBusy(state, context, work, fallback = null) {
  try {
    return await work();
  } catch (err) {
    if (!isStateBusy(err)) {
      throw err;
    }
    logError(state.home, `${context}: the file is locked by another Pulse task`, err);
    return fallback;
  }
}

export class State {
  constructor(env = process.env) {
    this.env = env;
    this.home = homeDir(env);
    this.unreadable = new Map();
    this.invalid = new Set();
  }

  file(name) {
    return path.join(this.home, name);
  }

  read(name, fallback) {
    return readJson(this.file(name), fallback, {
      onInvalid: () => this.noteInvalid(name),
      onUnreadable: (err) => this.noteUnreadable(name, err),
      onReadable: () => this.noteReadable(name),
    });
  }

  noteReadable(name) {
    this.unreadable.delete(name);
    this.invalid.delete(name);
    reportedUnreadable.delete(this.file(name));
  }

  isUnreadable(name) {
    return this.unreadable.has(name);
  }

  wasUnusable(name) {
    return this.unreadable.has(name) || this.invalid.has(name);
  }

  writeIfReadable(name, value) {
    if (this.isUnreadable(name)) {
      return false;
    }
    this.write(name, value);
    return true;
  }

  async updateIfReadable(name, fn, { waitMs = STATE_WAIT_MS } = {}) {
    try {
      return await this.update(name, fn, {}, { waitMs });
    } catch (err) {
      if (isUnreadablePath(err) && this.isUnreadable(name)) {
        return null;
      }
      throw err;
    }
  }

  noteInvalid(name) {
    this.invalid.add(name);
    this.logInvalid(name);
  }

  logInvalid(name) {
    logError(this.home, `${name} is not valid JSON; using defaults`);
  }

  noteUnreadable(name, err) {
    this.unreadable.set(name, err.code);
    const file = this.file(name);
    if (!reportedUnreadable.has(file)) {
      reportedUnreadable.add(file);
      logError(this.home, `${name} could not be read; Pulse uses defaults and leaves the file as it is`, err);
    }
  }

  unreadableFiles() {
    return [...this.unreadable.entries()].map(([name, code]) => ({ name, code }));
  }

  write(name, value) {
    writeJson(this.file(name), value);
    reportUnrestrictedDirs(this.home);
  }

  async runLocked(name, work, waitMs) {
    const release = await acquireLock(this.file(`${name}.lock`), { staleMs: STATE_LOCK_STALE_MS, waitMs, home: this.home });
    if (!release) {
      throw new StateBusyError(name);
    }
    try {
      return work();
    } finally {
      await release();
    }
  }

  update(name, fn, fallback = {}, { waitMs = STATE_WAIT_MS } = {}) {
    return this.runLocked(
      name,
      () => {
        const value = readJson(this.file(name), fallback, {
          onInvalid: () => this.logInvalid(name),
          onUnreadable: (err) => {
            this.noteUnreadable(name, err);
            throw err;
          },
          onReadable: () => this.noteReadable(name),
        });
        const next = fn(value) ?? value;
        this.write(name, next);
        return next;
      },
      waitMs,
    );
  }

  replace(name, value, { waitMs = STATE_WAIT_MS } = {}) {
    return this.runLocked(name, () => this.write(name, value), waitMs);
  }

  config() {
    return this.read(CONFIG_FILE, {});
  }

  async salt({ waitMs = CRITICAL_WAIT_MS } = {}) {
    const cfg = this.config();
    if (cfg.salt) {
      return cfg.salt;
    }
    const saved = await this.update(
      CONFIG_FILE,
      (c) => {
        c.salt ??= crypto.randomBytes(32).toString('hex');
        return c;
      },
      {},
      { waitMs },
    );
    return saved.salt;
  }

  async deviceId() {
    const current = this.config().deviceId;
    if (isDeviceId(current)) {
      return current;
    }
    const saved = await this.update(CONFIG_FILE, (c) => ({ ...c, deviceId: isDeviceId(c.deviceId) ? c.deviceId : crypto.randomUUID() }), {}, { waitMs: CRITICAL_WAIT_MS });
    return saved.deviceId;
  }

  apiUrl() {
    return normalizeApiUrl(this.env.PULSE_API_URL || this.config().apiUrl || DEFAULT_API_URL, this.env);
  }

  async setApiUrl(url) {
    const normalized = normalizeApiUrl(url, this.env);
    await this.update(CONFIG_FILE, (c) => {
      c.apiUrl = normalized;
      return c;
    });
  }

  auth(apiUrl) {
    return migrateAuthEntry(this.read(AUTH_FILE, {})[apiUrl]);
  }

  async setAuth(apiUrl, fn, { waitMs = CRITICAL_WAIT_MS } = {}) {
    let next;
    await this.update(
      AUTH_FILE,
      (all) => {
        next = fn({ ...(migrateAuthEntry(all[apiUrl]) ?? {}) });
        if (next === null) {
          delete all[apiUrl];
        } else {
          all[apiUrl] = { ...next, v: AUTH_FORMAT };
        }
        return all;
      },
      {},
      { waitMs },
    );
    return next;
  }

  authLock(waitMs = CRITICAL_WAIT_MS) {
    return acquireLock(this.file('auth.lock'), { staleMs: AUTH_LOCK_STALE_MS, waitMs, home: this.home });
  }

  binding(key) {
    return this.read(REPOS_FILE, {})[key] ?? null;
  }

  bindings() {
    return this.read(REPOS_FILE, {});
  }

  async setBinding(key, value) {
    const saved = await this.updateIfReadable(REPOS_FILE, (all) => {
      if (value === null) {
        delete all[key];
      } else {
        all[key] = value;
      }
      return all;
    });
    return saved !== null;
  }

  async setRemoteMatch(key, expected, patch) {
    await this.updateIfReadable(REPOS_FILE, (all) => {
      const binding = all[key];
      if (binding?.apiUrl === expected.apiUrl && binding.projectId === expected.projectId && binding.remote === expected.remote) {
        all[key] = { ...binding, ...patch };
      }
      return all;
    });
  }

  async markProjectStale(apiUrl, projectId, reason) {
    await this.updateIfReadable(REPOS_FILE, (all) => {
      for (const binding of Object.values(all)) {
        if (binding.apiUrl === apiUrl && binding.projectId === projectId) {
          binding.stale = reason;
        }
      }
      return all;
    });
  }

  collection(apiUrl, projectId) {
    const all = this.read(COLLECTION_FILE, {});
    return all[`${apiUrl}|${projectId}`] ?? legacyCollection(all, apiUrl, projectId);
  }

  async setCollection(apiUrl, projectId, fn, { waitMs = STATE_WAIT_MS } = {}) {
    const key = `${apiUrl}|${projectId}`;
    const all = await this.update(
      COLLECTION_FILE,
      (saved) => {
        saved[key] = fn(saved[key] ?? legacyCollection(saved, apiUrl, projectId) ?? {});
        for (const providerId of PROVIDER_IDS) {
          delete saved[`${key}|${providerId}`];
        }
        return saved;
      },
      {},
      { waitMs },
    );
    return all[key];
  }

  async cacheCollection(apiUrl, projectId, collectionState, now = Date.now()) {
    await runUnlessBusy(this, 'collection not cached', () =>
      this.setCollection(apiUrl, projectId, (c) => (hasNewerValidFetch(c, now) ? c : { ...c, state: collectionState, fetchedAt: now })),
    );
  }

  codexHookRuns() {
    const versions = this.read(CODEX_HOOK_RUNS_FILE, null)?.versions;
    if (!versions || typeof versions !== 'object') {
      return new Map();
    }
    return new Map(Object.entries(versions).filter(([, ranAt]) => Number.isFinite(ranAt)));
  }

  hasCodexHookRun(version) {
    return this.codexHookRuns().has(version);
  }

  noteCodexHookRun(now = Date.now()) {
    const runs = this.codexHookRuns();
    const ranAt = runs.get(PLUGIN_VERSION);
    if (ranAt !== undefined && now - ranAt < HOOK_RUN_REFRESH_MS) {
      return false;
    }
    runs.set(PLUGIN_VERSION, now);
    const newest = [...runs].sort(([, a], [, b]) => b - a).slice(0, HOOK_RUN_VERSIONS_MAX);
    return this.writeIfReadable(CODEX_HOOK_RUNS_FILE, { versions: Object.fromEntries(newest) });
  }

  async noteHost(key, host, now = Date.now()) {
    await this.updateIfReadable('hosts.json', (all) => {
      for (const [k, hosts] of Object.entries(all)) {
        for (const [h, at] of Object.entries(hosts ?? {})) {
          if (now - at > HOST_MAX_AGE_MS) {
            delete hosts[h];
          }
        }
        if (Object.keys(hosts ?? {}).length === 0) {
          delete all[k];
        }
      }
      all[key] = { ...(all[key] ?? {}), [host]: now };
      return all;
    });
  }

  recentHost(key, now = Date.now()) {
    const hosts = Object.entries(this.read('hosts.json', {})[key] ?? {}).filter(([host, at]) => findProvider(host) && now - at < HOST_RECENT_MS);
    return hosts.length === 1 ? hosts[0][0] : null;
  }

  status(apiUrl) {
    return this.read('status.json', {})[apiUrl] ?? {};
  }

  setStatus(apiUrl, fn, { waitMs = STATE_WAIT_MS } = {}) {
    return this.updateIfReadable(
      'status.json',
      (all) => {
        all[apiUrl] = fn(all[apiUrl] ?? {});
        return all;
      },
      { waitMs },
    );
  }
}

const AUTH_FORMAT = 2;

function migrateAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (entry.v === AUTH_FORMAT) {
    return entry;
  }
  const ids = new Map();
  const legacy = [];
  for (const id of PROVIDER_IDS) {
    if (entry[id] && typeof entry[id] === 'object') {
      ids.set(entry[id], id);
      legacy.push(entry[id]);
    }
  }
  if (legacy.length === 0) {
    return null;
  }
  const recency = (r) => [r.signedInAt ?? 0, r.expiresAt ?? 0];
  const newer = (a, b) => {
    const [x, y] = [recency(a), recency(b)];
    return x[0] !== y[0] ? y[0] - x[0] : y[1] - x[1];
  };
  const signedIn = legacy.filter(isSignedIn).sort(newer);
  const chosen = signedIn[0] ?? [...legacy].sort(newer)[0];
  const orphanGrants = [];
  for (const r of legacy) {
    if (r === chosen) {
      continue;
    }
    if (r.accessToken || r.refreshToken) {
      orphanGrants.push(grantTokens(r));
    }
    if (r.previousGrant) {
      orphanGrants.push(r.previousGrant);
    }
  }
  const kept = { ...chosen };
  delete kept.pendingClient;
  return {
    ...kept,
    v: AUTH_FORMAT,
    needsSignIn: signedIn.length > 0 ? false : legacy.some((r) => r.needsSignIn),
    grantId: chosen.grantId ?? `m${chosen.signedInAt ?? 0}`,
    registeredProviders: {},
    registeredVersions: {},
    legacySpoolProvider: ids.get(chosen),
    ...(orphanGrants.length > 0 ? { orphanGrants } : {}),
  };
}

export const grantTokens = (record) => ({
  accessToken: record.accessToken ?? null,
  refreshToken: record.refreshToken ?? null,
  expiresAt: record.expiresAt ?? null,
  clientId: record.clientId ?? null,
  tokenEndpoint: record.tokenEndpoint ?? null,
});

function hasNewerValidFetch(cached, fetchedAt) {
  const cachedAt = validFetchedAt(cached);
  return cachedAt !== null && cachedAt > fetchedAt;
}

function legacyCollection(all, apiUrl, projectId) {
  const found = PROVIDER_IDS.map((id) => all[`${apiUrl}|${projectId}|${id}`]).filter((c) => c?.state);
  return found.sort((a, b) => (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0))[0] ?? null;
}

const OFFICIAL_API_HOSTS = new Set(['api.paralect.ai', 'staging.paralect.ai']);
const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

export function apiUrlKind(url) {
  const { protocol, hostname } = new URL(url);
  if (isLoopback(hostname)) {
    return 'local';
  }
  return protocol === 'https:' && OFFICIAL_API_HOSTS.has(hostname) ? 'official' : 'custom';
}

export class ApiUrlError extends Error {}

export function normalizeApiUrl(url, env = process.env) {
  const parsed = urlOrNull(String(url).trim());
  if (!parsed) {
    throw new ApiUrlError('The Pulse API URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
    throw new ApiUrlError('The Pulse API URL must use https (http is allowed only for localhost)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ApiUrlError('The Pulse API URL must not carry credentials, a query or a fragment');
  }
  if (apiUrlKind(parsed.href) === 'custom' && env.PULSE_ALLOW_CUSTOM_API !== '1') {
    throw new ApiUrlError(
      `${parsed.host} is not a Pulse server this plugin knows (api.paralect.ai, staging.paralect.ai or localhost). ` +
        'Nothing was changed. To use it anyway, set PULSE_ALLOW_CUSTOM_API=1 and run the command again.',
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export const isRecordingStateUnusable = (state) => RECORDING_STATE_FILES.some((name) => state.wasUnusable(name));

export const isSignedIn = (record) => Boolean(record && !record.needsSignIn && (record.refreshToken || record.accessToken));

function reportWindowStart(collection) {
  if (collection?.report && Object.hasOwn(collection.report, 'windowStartAt')) {
    return Date.parse(collection.report.windowStartAt) || null;
  }
  const start = Math.max(Date.parse(collection?.report?.lastReportAt) || 0, Date.parse(collection?.collectingSince) || 0);
  return start > 0 ? start : null;
}

export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNREPORTED_SESSIONS_MAX = 5;

export const recentPrompts = (prompts, now) =>
  Object.fromEntries(Object.entries(prompts).filter(([, prompt]) => now - (prompt?.seenAt ?? 0) <= SESSION_MAX_AGE_MS));

const TRANSCRIPT_EXTENSION = '.jsonl';

export const transcriptPathOrNull = (file) =>
  typeof file === 'string' && path.isAbsolute(file) && file.endsWith(TRANSCRIPT_EXTENSION) && !hasUnsafeForOneLine(file) ? file : null;

const hasTranscriptFile = (session) => modifiedAtOrNull(session.transcriptPath) !== null;

const isDateTime = (ms) => typeof ms === 'number' && Number.isFinite(new Date(ms).getTime());

function catchUpStart(collection, status) {
  const windowStart = reportWindowStart(collection);
  if (windowStart === null) {
    return null;
  }
  return isDateTime(status.reportPromptsSince) ? Math.max(windowStart, status.reportPromptsSince) : windowStart;
}

const isUnreportedSince = (session, since) =>
  isDateTime(session?.seenAt) &&
  session.seenAt > since &&
  findProvider(session.host) !== null &&
  transcriptPathOrNull(session.transcriptPath) !== null &&
  hasTranscriptFile(session);

export function unreportedSessions(status, { collection, projectId, now }) {
  const start = catchUpStart(collection, status);
  if (start === null) {
    return { start, sessions: [] };
  }
  const sessions = Object.entries(recentPrompts(status.reportPrompts ?? {}, now))
    .filter(([key, session]) => key.startsWith(`${projectId}:`) && isUnreportedSince(session, start))
    .sort(([, a], [, b]) => b.seenAt - a.seenAt)
    .slice(0, UNREPORTED_SESSIONS_MAX)
    .map(([, session]) => session);
  return { start, sessions };
}

export const isReadOnlyCollection = (state) => state?.readOnly === true;

export const collectionAllows = (state) => Boolean(state) && !isReadOnlyCollection(state);

export function bindingStatus(state, ctx, apiUrl) {
  const binding = state.binding(ctx.key);
  if (!binding) {
    return { ok: false, reason: 'unbound' };
  }
  if (binding.apiUrl !== apiUrl) {
    return { ok: false, reason: 'other_api', binding };
  }
  if (binding.stale) {
    return { ok: false, reason: binding.stale, binding };
  }
  if (ctx.kind === 'git' && (binding.remote ?? null) !== (ctx.remoteKey ?? null)) {
    return { ok: false, reason: 'remote_changed', binding };
  }
  return { ok: true, binding };
}

export function recordingAllowed(state, ctx, apiUrl) {
  if (!isSignedIn(state.auth(apiUrl))) {
    return { ok: false, reason: 'not_signed_in' };
  }
  const bound = bindingStatus(state, ctx, apiUrl);
  if (!bound.ok) {
    return bound;
  }
  const cached = state.collection(apiUrl, bound.binding.projectId);
  if (!cached?.state || isFetchedInTheFuture(cached)) {
    return { ok: false, reason: 'unknown_collection', binding: bound.binding };
  }
  if (!collectionAllows(cached.state)) {
    return { ok: false, reason: 'read_only', binding: bound.binding };
  }
  return { ok: true, binding: bound.binding };
}
