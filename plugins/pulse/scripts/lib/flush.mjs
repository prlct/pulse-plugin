import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ApiError, NotSignedIn, heartbeatBody, isProjectGone, isUnknownNotFound, pluginCall } from './api.mjs';
import { Auth, refreshOutcomeUnknown, revokeOrphans } from './auth.mjs';
import {
  CLAIM_MARK,
  QUEUE_FILE_SUFFIX,
  claimMarkOf,
  dropSpool,
  isRecentRecord,
  isUnfinishedWrite,
  isWaitingForAnotherServer,
  keepFullQueues,
  queueNameOf,
  spoolDir,
} from './events.mjs';
import { repoContext } from './git.mjs';
import { settleEndedSessions, settleExpiredRuns } from './skills.mjs';
import { notePluginInfo, uploadsBlocked } from './updates.mjs';
import { AUTH_FILE, COLLECTION_REFRESH_AFTER_MS, COLLECTION_TTL_MS, PROVIDER_IDS, collectionAllows, isCollectionOlderThan, isSignedIn, isStateBusy, runUnlessBusy } from './state.mjs';
import {
  EVENTS_BATCH_MAX,
  PLUGIN_VERSION,
  UPLOAD_LOCK_STALE_MS,
  acquireLock,
  atomicWrite,
  changedAtOrNull,
  isAlive,
  isMissingPath,
  isUnreadablePath,
  keepLockFresh,
  logError,
  modifiedAtOrNull,
  parseJson,
  pastTimeOrNull,
  removeFileOrLog,
  renameIfPresent,
} from './util.mjs';

const HEARTBEAT_EVERY_MS = 6 * 60 * 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_DOUBLINGS = 6;
const FLUSH_WAIT_MS = 10_000;
const FLUSH_PASSES_MAX = 3;
const FLUSH_LOCK_TOUCH_EVERY_MS = UPLOAD_LOCK_STALE_MS / 4;
const BATCH_ENVELOPE_BYTES = 64;
const NEWLINE_BYTE = 0x0a;
const CLAIM_OWNER_RE = /^(\d+)(?:\.[0-9a-f]+)?$/;
export const BATCH_MAX_BYTES = 200 * 1024;
export const UPLOAD_RUNNING_ERROR = 'busy';
export const STATE_BUSY_ERROR = 'state_busy';
const AUTH_UNREADABLE_ERROR = 'auth_file_unreadable';
const SIGN_IN_CHANGED_ERROR = 'sign_in_changed';
const BLOCKING_409 = new Set(['collection_off', 'paused', 'excluded', 'not_configured']);
export const REMOTE_MATCH_CHECK_EVERY_MS = 60 * 60 * 1000;
export const REMOTE_MATCH_RETRY_AFTER_MS = 10 * 60 * 1000;

export async function refreshCollection(state, auth, projectId, now = Date.now()) {
  try {
    const collection = await pluginCall(auth, 'GET', `/projects/${projectId}/collection`);
    await state.cacheCollection(auth.apiUrl, projectId, collection, now);
    return collection;
  } catch (err) {
    if (isProjectGone(err)) {
      await runUnlessBusy(state, 'removed project not marked', () => state.markProjectStale(auth.apiUrl, projectId, 'not_found'));
      await state.cacheCollection(auth.apiUrl, projectId, null, now);
      return null;
    }
    throw err;
  }
}

export async function fetchProjects(auth, remote) {
  const query = remote ? `?remote=${encodeURIComponent(remote)}` : '';
  const result = await pluginCall(auth, 'GET', `/projects${query}`);
  return { repository: result?.repository ?? null, projects: Array.isArray(result?.projects) ? result.projects : [] };
}

function isRemoteMatchDue(binding, now) {
  const retryAt = Number.isFinite(binding.matchRetryAt) ? binding.matchRetryAt : 0;
  const isRetryWaiting = retryAt > now && retryAt - now <= REMOTE_MATCH_RETRY_AFTER_MS;
  return !isRetryWaiting && now - (pastTimeOrNull(binding.matchCheckedAt) ?? 0) >= REMOTE_MATCH_CHECK_EVERY_MS;
}

function findBindingsToRecheck(state, apiUrl, projectIds, now) {
  const allowedProjectIds = new Set(projectIds.filter((projectId) => collectionAllows(state.collection(apiUrl, projectId)?.state)));
  return Object.entries(state.bindings()).filter(
    ([, binding]) =>
      binding?.apiUrl === apiUrl &&
      binding.kind === 'git' &&
      !binding.stale &&
      allowedProjectIds.has(binding.projectId) &&
      isRemoteMatchDue(binding, now),
  );
}

const saveRemoteMatch = (state, key, binding, patch) =>
  runUnlessBusy(state, 'repository match not saved', () => state.setRemoteMatch(key, binding, patch));

async function refreshRemoteMatches(state, auth, projectIds, now) {
  const projectsByRemote = new Map();
  const due = findBindingsToRecheck(state, auth.apiUrl, projectIds, now);
  for (const [index, [key, binding]] of due.entries()) {
    const ctx = repoContext(key);
    if (ctx.kind !== 'git' || ctx.key !== key || !ctx.remote || ctx.remoteKey !== binding.remote) {
      await saveRemoteMatch(state, key, binding, { matchCheckedAt: now });
      continue;
    }
    if (!projectsByRemote.has(ctx.remote)) {
      try {
        projectsByRemote.set(ctx.remote, (await fetchProjects(auth, ctx.remote)).projects);
      } catch (err) {
        logError(state.home, 'repository match check failed; the saved match stays and is checked again later', err);
        for (const [laterKey, laterBinding] of due.slice(index)) {
          await saveRemoteMatch(state, laterKey, laterBinding, { matchRetryAt: now + REMOTE_MATCH_RETRY_AFTER_MS });
        }
        return;
      }
    }
    const matched = projectsByRemote.get(ctx.remote).some((project) => project.id === binding.projectId && project.matched === true);
    await saveRemoteMatch(state, key, binding, { matched, matchCheckedAt: now, matchRetryAt: null });
  }
}

function claimSpoolFiles(state, apiUrl, now) {
  const dir = spoolDir(state);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (isMissingPath(err)) {
      return [];
    }
    throw err;
  }
  const claimed = [];
  for (const name of names) {
    try {
      const claim = claimSpoolFile(state, dir, name, apiUrl, now);
      if (claim) {
        claimed.push(claim);
      }
    } catch (err) {
      logError(state.home, 'an upload queue file could not be claimed; the next upload tries again', err);
    }
  }
  return claimed;
}

const makeClaimName = (liveName) => `${liveName}${CLAIM_MARK}${process.pid}.${crypto.randomBytes(4).toString('hex')}`;

function readClaimOwner(name, mark) {
  const match = CLAIM_OWNER_RE.exec(name.slice(name.indexOf(mark) + mark.length));
  return match ? Number(match[1]) : null;
}

function removeLeftoverWrite(state, full, now) {
  const modifiedAt = modifiedAtOrNull(full);
  if (modifiedAt !== null && now - modifiedAt > UPLOAD_LOCK_STALE_MS) {
    removeFileOrLog(state.home, full, 'a write an upload left unfinished');
  }
}

function claimSpoolFile(state, dir, name, apiUrl, now) {
  const full = path.join(dir, name);
  if (isUnfinishedWrite(name)) {
    removeLeftoverWrite(state, full, now);
    return null;
  }
  if (name.endsWith(QUEUE_FILE_SUFFIX)) {
    if (isWaitingForAnotherServer(state, name, apiUrl, now)) {
      return null;
    }
    const taken = path.join(dir, makeClaimName(name));
    return renameIfPresent(full, taken) ? { live: full, taken } : null;
  }
  const mark = claimMarkOf(name);
  if (!mark) {
    return null;
  }
  const owner = readClaimOwner(name, mark);
  const claimedAt = changedAtOrNull(full);
  if (claimedAt === null) {
    return null;
  }
  const liveName = queueNameOf(name);
  const live = path.join(dir, liveName);
  if (owner === process.pid && mark === CLAIM_MARK) {
    return { live, taken: full };
  }
  if (owner !== process.pid && isAlive(owner) && now - claimedAt <= UPLOAD_LOCK_STALE_MS) {
    return null;
  }
  const taken = path.join(dir, makeClaimName(liveName));
  return renameIfPresent(full, taken) ? { live, taken } : null;
}

function readRecords(file) {
  const out = [];
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (isMissingPath(err)) {
      return { records: out, readBytes: 0 };
    }
    if (isUnreadablePath(err)) {
      return { records: null, error: err };
    }
    throw err;
  }
  const readBytes = bytes.lastIndexOf(NEWLINE_BYTE) + 1;
  for (const line of bytes.toString('utf8', 0, readBytes).split('\n')) {
    if (!line) {
      continue;
    }
    const record = parseJson(line);
    if (record.ok) {
      out.push(record.value);
    }
  }
  return { records: out, readBytes };
}

const serialize = (records) => (records.length > 0 ? `${records.map((r) => JSON.stringify(r)).join('\n')}\n` : '');

function readTextAfter(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (isMissingPath(err)) {
      return '';
    }
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) {
      return '';
    }
    const buffer = Buffer.alloc(size - offset);
    const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.toString('utf8', 0, length);
  } finally {
    fs.closeSync(fd);
  }
}

function takeLateLines(home, claim) {
  const late = readTextAfter(claim.taken, claim.readBytes);
  const end = late.lastIndexOf('\n') + 1;
  if (end < late.length) {
    logError(home, 'an unfinished line written into a claimed upload queue was dropped');
  }
  return late.slice(0, end);
}

function returnLateLines(home, claim) {
  const lines = takeLateLines(home, claim);
  if (lines) {
    fs.appendFileSync(claim.live, lines, { mode: 0o600 });
  }
}

function removeClaim(home, claim) {
  returnLateLines(home, claim);
  fs.rmSync(claim.taken, { force: true });
}

function persistClaim(home, claim, records) {
  if (!fs.existsSync(claim.taken)) {
    return false;
  }
  if (records.length === 0) {
    removeClaim(home, claim);
    return true;
  }
  returnLateLines(home, claim);
  const text = serialize(records);
  atomicWrite(claim.taken, text);
  claim.readBytes = Buffer.byteLength(text);
  return true;
}

function releaseClaim(home, claim, records) {
  if (!fs.existsSync(claim.taken)) {
    return 0;
  }
  const text = serialize(records) + takeLateLines(home, claim);
  if (text) {
    fs.appendFileSync(claim.live, text, { mode: 0o600 });
  }
  fs.rmSync(claim.taken, { force: true });
  return records.length;
}

export function nextBatch(records, maxCount = EVENTS_BATCH_MAX, maxBytes = BATCH_MAX_BYTES) {
  const batch = [];
  let bytes = BATCH_ENVELOPE_BYTES;
  for (const r of records) {
    const size = Buffer.byteLength(JSON.stringify(r.event)) + 1;
    if (batch.length >= maxCount || (batch.length > 0 && bytes + size > maxBytes)) {
      break;
    }
    batch.push(r);
    bytes += size;
  }
  return batch;
}

const transient = (err) => err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500 || isUnknownNotFound(err));

function releaseForAnotherServer(home, claim, records, { now, drop }) {
  const recent = records.filter((r) => isRecentRecord(r, now));
  drop(records.length - recent.length);
  if (recent.length === 0) {
    removeClaim(home, claim);
  } else {
    releaseClaim(home, claim, recent);
  }
}

export async function flush(state, { projects = [], provider = null, background = false, now = Date.now() } = {}) {
  const summary = { sent: 0, duplicates: 0, rejected: 0, dropped: 0, kept: 0, errors: [] };
  const release = await acquireLock(state.file('flush.lock'), { staleMs: UPLOAD_LOCK_STALE_MS, waitMs: background ? 0 : FLUSH_WAIT_MS, home: state.home });
  if (!release) {
    summary.errors.push(UPLOAD_RUNNING_ERROR);
    return summary;
  }
  const stopKeepingLockFresh = keepLockFresh(release, state.home, FLUSH_LOCK_TOUCH_EVERY_MS);
  try {
    const apiUrl = state.apiUrl();
    const status = state.status(apiUrl);
    if (background && (status.backoffUntil ?? 0) > now && !refreshOutcomeUnknown(state.auth(apiUrl))) {
      return summary;
    }
    const authFor = (providerId) => new Auth(state, apiUrl, providerId);
    let networkFailed = false;
    let stateBusy = false;

    try {
      await settleEndedSessions(state, now);
    } catch (err) {
      logError(state.home, 'skill runs of ended sessions not settled; the next upload tries again', err);
    }
    try {
      await settleExpiredRuns(state, now);
    } catch (err) {
      logError(state.home, 'skill runs expiry failed', err);
    }

    const shared = authFor(provider);
    for (const projectId of projects) {
      const cached = state.collection(apiUrl, projectId);
      if (shared.signedIn() && (!background || !cached || isCollectionOlderThan(cached, COLLECTION_REFRESH_AFTER_MS, now))) {
        try {
          await refreshCollection(state, shared, projectId, now);
        } catch (err) {
          networkFailed ||= transient(err);
          logError(state.home, 'collection refresh failed', err);
        }
      }
    }

    if (!networkFailed && shared.signedIn() && projects.length > 0) {
      try {
        await refreshRemoteMatches(state, shared, projects, now);
      } catch (err) {
        logError(state.home, 'repository match check stopped; the upload goes on', err);
      }
    }

    const blocked = uploadsBlocked(state, apiUrl);
    if (blocked) {
      summary.errors.push('plugin_outdated');
    }
    const unreadableClaims = new Set();
    const passes = blocked ? 0 : FLUSH_PASSES_MAX;
    for (let pass = 0; pass < passes; pass += 1) {
      const files = claimSpoolFiles(state, apiUrl, now).filter((claim) => !unreadableClaims.has(claim.taken));
      if (files.length === 0) {
        break;
      }
      const keptBefore = summary.kept;
      let fileFailed = false;
      for (const claim of files) {
        try {
          const holdBack = networkFailed || stateBusy || uploadsBlocked(state, apiUrl);
          const result = await flushFile(state, claim, { apiUrl, authFor, now, holdBack, summary });
          networkFailed ||= result.networkFailed;
          stateBusy ||= result.stateBusy;
          if (result.unreadable) {
            unreadableClaims.add(claim.taken);
          }
        } catch (err) {
          fileFailed = true;
          summary.errors.push('queue_file_failed');
          logError(state.home, 'an upload queue file failed; it stays queued for the next upload', err);
        }
      }
      if (networkFailed || stateBusy || fileFailed || summary.kept > keptBefore || uploadsBlocked(state, apiUrl)) {
        break;
      }
    }

    const record = state.auth(apiUrl);
    if (!networkFailed && isSignedIn(record)) {
      const registered = record.registeredProviders ?? {};
      const versions = record.registeredVersions ?? {};
      const due = PROVIDER_IDS.filter(
        (id) =>
          (id === provider && !registered[id]) ||
          (registered[id] && (now - registered[id] > HEARTBEAT_EVERY_MS || versions[id] !== PLUGIN_VERSION)),
      );
      for (const providerId of due) {
        try {
          await heartbeat(state, authFor(providerId), now);
        } catch (err) {
          networkFailed ||= transient(err);
          if (!transient(err) || isUnknownNotFound(err)) {
            logError(state.home, `heartbeat for ${providerId} failed`, err);
          }
        }
      }
    }
    if (!networkFailed && record?.orphanGrants?.length) {
      try {
        await revokeOrphans(state, apiUrl);
      } catch (err) {
        logError(state.home, 'orphan revoke not saved', err);
      }
    }

    await runUnlessBusy(state, 'upload status not saved', () =>
      state.setStatus(apiUrl, (s) => {
        const failures = networkFailed ? (s.failures ?? 0) + 1 : 0;
        return {
          ...s,
          lastFlushAt: now,
          failures,
          backoffUntil: networkFailed ? now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, BACKOFF_MAX_DOUBLINGS)) : 0,
          lastError: summary.errors[0] ?? null,
          queueFull: keepFullQueues(state, s.queueFull),
        };
      }),
    );
    if (networkFailed) {
      summary.errors.push('network');
    }
    return summary;
  } finally {
    stopKeepingLockFresh();
    await release();
  }
}

async function flushFile(state, claimed, { apiUrl, authFor, now, holdBack, summary }) {
  const out = { networkFailed: false, stateBusy: false };
  const read = readRecords(claimed.taken);
  if (!read.records) {
    summary.errors.push('queue_file_unreadable');
    logError(state.home, 'an upload queue file could not be read; it is kept, not deleted', read.error);
    return { ...out, unreadable: true };
  }
  const claim = { ...claimed, readBytes: read.readBytes };
  let { records } = read;
  const drop = (n) => {
    summary.dropped += n;
  };
  const keep = (reason) => {
    summary.kept += releaseClaim(state.home, claim, records);
    if (reason) {
      summary.errors.push(reason);
    }
    return out;
  };
  const keepWhileAuthUnreadable = () => {
    if (!summary.errors.includes(AUTH_UNREADABLE_ERROR)) {
      summary.errors.push(AUTH_UNREADABLE_ERROR);
      logError(state.home, `${AUTH_FILE} could not be read or is not valid JSON; the upload queue is kept unchanged for the next upload`);
    }
    return keep(null);
  };
  const first = records.find((r) => r?.event);
  if (!first) {
    drop(records.length);
    removeClaim(state.home, claim);
    return out;
  }
  const { projectId, providerId } = first;
  if (first.apiUrl !== apiUrl) {
    releaseForAnotherServer(state.home, claim, records, { now, drop });
    return out;
  }
  const auth = authFor(providerId);
  const record = auth.record();
  if (state.wasUnusable(AUTH_FILE)) {
    return keepWhileAuthUnreadable();
  }
  const before = records.length;
  const sameGrant = (r) =>
    r.grantId ? r.grantId === record?.grantId : !record?.legacySpoolProvider || r.providerId === record.legacySpoolProvider;
  records = records.filter((r) => {
    const at = Date.parse(r?.event?.occurredAt);
    return isRecentRecord(r, now) && !(record?.signedInAt && at < record.signedInAt) && sameGrant(r);
  });
  drop(before - records.length);
  if (!isSignedIn(record)) {
    drop(records.length);
    removeClaim(state.home, claim);
    return out;
  }
  if (holdBack) {
    return keep(null);
  }
  let maxCount = EVENTS_BATCH_MAX;
  try {
    const cached = state.collection(apiUrl, projectId);
    let collection = cached?.state ?? null;
    if (!cached || isCollectionOlderThan(cached, COLLECTION_TTL_MS, now)) {
      collection = await refreshCollection(state, auth, projectId, now);
    }
    if (!collectionAllows(collection)) {
      drop(records.length);
      removeClaim(state.home, claim);
      return out;
    }
    const since = Date.parse(collection.collectingSince ?? '');
    if (Number.isFinite(since)) {
      const open = records.filter((r) => Date.parse(r.event.occurredAt) >= since);
      drop(records.length - open.length);
      records = open;
    }
    if (records.length > 0 && !auth.registered()) {
      await heartbeat(state, auth, now);
    }
    while (records.length > 0) {
      const batch = nextBatch(records, maxCount);
      let result;
      try {
        result = await pluginCall(auth, 'POST', `/projects/${projectId}/events`, {
          provider: providerId,
          events: batch.map((r) => r.event),
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 413 && batch.length > 1) {
          maxCount = Math.max(1, Math.floor(batch.length / 2));
          continue;
        }
        if (err instanceof ApiError && (err.status === 400 || err.status === 413 || err.status === 422)) {
          drop(batch.length);
          summary.errors.push(err.code ?? 'error');
          logError(state.home, 'events batch refused', err);
          records = records.slice(batch.length);
          if (!persistClaim(state.home, claim, records)) {
            drop(records.length);
            return out;
          }
          continue;
        }
        throw err;
      }
      records = records.slice(batch.length);
      summary.sent += result?.accepted ?? 0;
      summary.duplicates += result?.duplicates ?? 0;
      summary.rejected += result?.rejected?.length ?? 0;
      await runUnlessBusy(state, 'last sync time not saved', () => state.setCollection(apiUrl, projectId, (c) => ({ ...c, lastSyncAt: now })));
      if (!persistClaim(state.home, claim, records)) {
        drop(records.length);
        return out;
      }
    }
    removeClaim(state.home, claim);
    return out;
  } catch (err) {
    if (err instanceof ApiError && err.status === 426) {
      return keep('plugin_outdated');
    }
    if (isStateBusy(err) || (err instanceof ApiError && err.code === 'busy')) {
      logError(state.home, 'an upload queue file waits: a Pulse file is locked by another Pulse task', err);
      out.stateBusy = true;
      return keep(STATE_BUSY_ERROR);
    }
    if (err instanceof ApiError && err.status === 409 && BLOCKING_409.has(err.code)) {
      drop(records.length);
      removeClaim(state.home, claim);
      try {
        await refreshCollection(state, auth, projectId, now);
      } catch (refreshError) {
        logError(state.home, 'collection refresh after a refused upload failed; the next upload refreshes it', refreshError);
      }
      dropSpool(state, { apiUrl, projectId });
      return out;
    }
    if (isProjectGone(err)) {
      drop(records.length);
      removeClaim(state.home, claim);
      await runUnlessBusy(state, 'removed project not marked', () => state.markProjectStale(apiUrl, projectId, 'not_found'));
      return out;
    }
    if (err instanceof NotSignedIn) {
      if (auth.signedIn()) {
        logError(state.home, 'the sign-in was not usable during this upload but is signed in now; the upload queue is kept for the next upload', err);
        return keep(SIGN_IN_CHANGED_ERROR);
      }
      if (state.wasUnusable(AUTH_FILE)) {
        return keepWhileAuthUnreadable();
      }
      drop(records.length);
      removeClaim(state.home, claim);
      summary.errors.push(err.code);
      return out;
    }
    if (isUnknownNotFound(err)) {
      logError(state.home, 'Pulse answered 404 without project_not_found; the upload queue and the binding are kept and the upload backs off', err);
    }
    if (transient(err) || (err instanceof ApiError && err.code === 'not_registered')) {
      out.networkFailed = true;
      return keep(err.code);
    }
    drop(records.length);
    removeClaim(state.home, claim);
    summary.errors.push(err.code ?? 'error');
    logError(state.home, 'events upload failed', err);
    return out;
  }
}

export async function heartbeat(state, auth, now = Date.now()) {
  if (!auth.providerId) {
    return;
  }
  const grantId = auth.record()?.grantId;
  const answer = await pluginCall(auth, 'POST', '/heartbeat', heartbeatBody(auth));
  await auth.noteRegistered(grantId, now);
  await runUnlessBusy(state, 'plugin version info not saved', () => notePluginInfo(state, auth.apiUrl, answer?.plugin, now));
}

export async function ensureRegistered(state, auth, now = Date.now()) {
  if (auth.providerId && !auth.registered()) {
    await heartbeat(state, auth, now);
  }
}
