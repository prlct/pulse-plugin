import fs from 'node:fs';
import path from 'node:path';

import { safeBranch } from './git.mjs';
import {
  SCHEMA_VERSION,
  appendLine,
  countKey,
  fileSizeOrZero,
  isMissingPath,
  isUnreadablePath,
  logError,
  modifiedAtOrNull,
  parseJson,
  removeFileOrLog,
  sha256,
} from './util.mjs';

const COUNTS_MAX_KEYS = 100;
const COUNT_MAX = 100_000;
const TOKENS_MAX = 50_000_000;
const SPOOL_MAX_BYTES = 2 * 1024 * 1024;
const FIRST_LINE_CHUNK_BYTES = 4 * 1024;
const FIRST_LINE_MAX_BYTES = 256 * 1024;
const FULL_QUEUES_MAX = 100;
const DROPPED_COUNT_MAX = 1_000_000_000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const NEWLINE_BYTE = 0x0a;
const QUEUE_NAME_RE = /^[0-9a-f]{24}\.jsonl$/;
const EVENT_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;
export const QUEUE_FILE_SUFFIX = '.jsonl';
export const CLAIM_MARK = '.claim.';
const LEGACY_CLAIM_MARK = '.sending.';
const WRITE_TEMP_SUFFIX = '.tmp';

export const isUnfinishedWrite = (name) => name.endsWith(WRITE_TEMP_SUFFIX);

export const claimMarkOf = (name) => [CLAIM_MARK, LEGACY_CLAIM_MARK].find((mark) => name.includes(mark)) ?? null;

export function queueNameOf(name) {
  const mark = claimMarkOf(name);
  return mark ? name.slice(0, name.indexOf(mark)) : name;
}

export const sessionHash = (salt, providerId, sessionId) => sha256(`${salt}|${providerId}|${sessionId}`);

export const eventIdFor = (salt, providerId, sessionId, turnKey) =>
  `t_${sha256(`${salt}|${providerId}|${sessionId}|${turnKey}`).slice(0, 40)}`;

export function limitCounts(counts) {
  const entries = Object.entries(counts ?? {}).filter(([k, v]) => countKey(k) === k && v > 0);
  if (entries.length === 0) {
    return undefined;
  }
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = entries.length > COUNTS_MAX_KEYS ? entries.slice(0, COUNTS_MAX_KEYS - 1) : entries;
  const out = Object.fromEntries(kept.map(([k, v]) => [k, Math.min(v, COUNT_MAX)]));
  if (entries.length > COUNTS_MAX_KEYS) {
    const rest = entries.slice(COUNTS_MAX_KEYS - 1).reduce((sum, [, v]) => sum + v, 0);
    out._other = Math.min(rest, COUNT_MAX);
  }
  return out;
}

const tokenInt = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), TOKENS_MAX) : undefined);

export function modelId(model) {
  const value = typeof model === 'string' ? model.trim().replace(/[^\w.:@/+-]/g, '_').slice(0, 100) : '';
  return /[A-Za-z0-9]/.test(value) ? value : undefined;
}

export function buildTurnEvent({
  providerId,
  sessionId,
  turnKey,
  salt,
  counts,
  tokens,
  model,
  remote,
  branch,
  startedAt,
  endedAt,
}) {
  const event = {
    eventId: eventIdFor(salt, providerId, sessionId, turnKey),
    kind: 'turn',
    occurredAt: endedAt,
    captureLevel: 'metadata',
    sessionHash: sessionHash(salt, providerId, sessionId),
    schemaVersion: SCHEMA_VERSION,
  };
  const id = modelId(model);
  if (id) {
    event.model = id;
  }
  if (remote) {
    event.remote = remote;
    const safe = safeBranch(branch);
    if (safe) {
      event.branch = safe;
    }
  }
  const toolCounts = limitCounts(counts?.tools);
  const mcpCounts = limitCounts(counts?.mcp);
  const skillCounts = limitCounts(counts?.skills);
  if (toolCounts) {
    event.toolCounts = toolCounts;
  }
  if (mcpCounts) {
    event.mcpCounts = mcpCounts;
  }
  if (skillCounts) {
    event.skillCounts = skillCounts;
  }
  if (tokens) {
    event.inputTokens = tokenInt(tokens.input);
    event.outputTokens = tokenInt(tokens.output);
    event.cacheReadTokens = tokenInt(tokens.cacheRead);
    event.cacheWriteTokens = tokenInt(tokens.cacheWrite);
  }
  if (startedAt && Date.parse(startedAt) <= Date.parse(endedAt)) {
    event.startedAt = startedAt;
  }
  event.endedAt = endedAt;
  return event;
}

export function buildSkillEvent({ salt, run, outcome, durationState, finishedAt = null }) {
  const startedAt = new Date(run.startedAt).toISOString();
  const skill = { slug: run.slug };
  if (/^[0-9a-f]{16}$/.test(run.version ?? '')) {
    skill.version = run.version;
  }
  skill.outcome = outcome;
  skill.startedAt = startedAt;
  if (durationState === 'measured' && Number.isFinite(finishedAt) && finishedAt >= run.startedAt) {
    skill.finishedAt = new Date(finishedAt).toISOString();
    skill.elapsedDurationMs = Math.floor(finishedAt - run.startedAt);
    skill.durationState = 'measured';
  } else {
    skill.durationState = durationState === 'measured' ? 'unavailable' : durationState;
  }
  const event = {
    eventId: `s_${sha256(`${salt}|skill|${run.id}`).slice(0, 40)}`,
    kind: 'skill',
    occurredAt: startedAt,
    captureLevel: 'metadata',
    sessionHash: sessionHash(salt, run.providerId, run.sessionId ?? run.guessSessionId ?? `pulse-mcp:${run.instance}`),
    schemaVersion: SCHEMA_VERSION,
  };
  if (run.remote) {
    event.remote = run.remote;
    const safe = safeBranch(run.branch);
    if (safe) {
      event.branch = safe;
    }
  }
  event.skill = skill;
  return event;
}

const COUNTER_KINDS = new Map([
  ['t', 'tools'],
  ['m', 'mcp'],
  ['s', 'skills'],
]);

export function parseCounterLog(text) {
  const buckets = new Map([...COUNTER_KINDS.values()].map((field) => [field, new Map()]));
  for (const line of text.split('\n')) {
    const [kind, name] = line.split('\t');
    const bucket = buckets.get(COUNTER_KINDS.get(kind));
    const key = countKey(name);
    if (bucket && key) {
      bucket.set(key, (bucket.get(key) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...buckets].map(([field, bucket]) => [field, Object.fromEntries(bucket)]));
}

export function spoolDir(state) {
  return state.file('spool');
}

export function spoolFile(state, apiUrl, projectId, providerId) {
  return path.join(spoolDir(state), `${sha256(`${apiUrl}|${projectId}|${providerId}`).slice(0, 24)}${QUEUE_FILE_SUFFIX}`);
}

export function isRecentRecord(record, now) {
  const at = Date.parse(record?.event?.occurredAt);
  return Number.isFinite(at) && at <= now + CLOCK_SKEW_MS && now - at < EVENT_MAX_AGE_MS;
}

const isQueueFull = (file) => fileSizeOrZero(file) > SPOOL_MAX_BYTES;

const isCount = (value) => Number.isSafeInteger(value) && value > 0;

function readFullQueues(saved) {
  return (Array.isArray(saved) ? saved.slice(0, FULL_QUEUES_MAX) : []).filter(
    (entry) => typeof entry?.queue === 'string' && QUEUE_NAME_RE.test(entry.queue) && isCount(entry.dropped) && isCount(entry.since),
  );
}

export const keepFullQueues = (state, saved) => readFullQueues(saved).filter((entry) => isQueueFull(path.join(spoolDir(state), entry.queue)));

export function summarizeDroppedEvents(saved) {
  const entries = readFullQueues(saved);
  if (entries.length === 0) {
    return null;
  }
  return entries.reduce(
    (summary, entry) => ({ dropped: Math.min(summary.dropped + entry.dropped, DROPPED_COUNT_MAX), since: Math.min(summary.since, entry.since) }),
    { dropped: 0, since: Number.MAX_SAFE_INTEGER },
  );
}

function addDrops(saved, queues, now) {
  const entries = readFullQueues(saved);
  const others = entries.filter((entry) => !queues.has(entry.queue));
  const added = [...queues].map(([queue, count]) => {
    const entry = entries.find((existing) => existing.queue === queue) ?? { queue, dropped: 0, since: now };
    return { ...entry, dropped: Math.min(entry.dropped + count, DROPPED_COUNT_MAX) };
  });
  return [...others, ...added].slice(-FULL_QUEUES_MAX);
}

export async function saveDroppedEvents(state, drops, now = Date.now()) {
  for (const [apiUrl, queues] of drops) {
    try {
      await state.setStatus(apiUrl, (s) => ({ ...s, queueFull: addDrops(s.queueFull, queues, now) }), { waitMs: 0 });
    } catch (err) {
      logError(state.home, 'the events a full upload queue dropped were not counted for status', err);
    }
  }
}

function countDrop(drops, apiUrl, queue) {
  const queues = drops.get(apiUrl) ?? new Map();
  queues.set(queue, (queues.get(queue) ?? 0) + 1);
  drops.set(apiUrl, queues);
}

export function spoolEvent(state, { apiUrl, projectId, providerId, grantId = null, event, drops }) {
  const file = spoolFile(state, apiUrl, projectId, providerId);
  if (isQueueFull(file)) {
    logError(state.home, 'spool full, event dropped');
    countDrop(drops, apiUrl, path.basename(file));
    return false;
  }
  appendLine(file, JSON.stringify({ apiUrl, projectId, providerId, ...(grantId ? { grantId } : {}), event }));
  return true;
}

function readFirstLineBytes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let head = Buffer.alloc(0);
    while (head.length < FIRST_LINE_MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(Math.max(FIRST_LINE_CHUNK_BYTES, head.length), FIRST_LINE_MAX_BYTES - head.length));
      const length = fs.readSync(fd, chunk, 0, chunk.length, head.length);
      const end = chunk.subarray(0, length).indexOf(NEWLINE_BYTE);
      if (end !== -1) {
        return Buffer.concat([head, chunk.subarray(0, end)]);
      }
      if (length < chunk.length) {
        return null;
      }
      head = Buffer.concat([head, chunk]);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readFirstRecord(state, name) {
  let line;
  try {
    line = readFirstLineBytes(path.join(spoolDir(state), name));
  } catch (err) {
    if (isUnreadablePath(err)) {
      return null;
    }
    throw err;
  }
  if (line === null) {
    return null;
  }
  const record = parseJson(line.toString('utf8')).value;
  return typeof record === 'object' && record !== null ? record : null;
}

export function isWaitingForAnotherServer(state, name, apiUrl, now) {
  const modifiedAt = modifiedAtOrNull(path.join(spoolDir(state), name));
  if (modifiedAt === null || now - modifiedAt >= EVENT_MAX_AGE_MS) {
    return false;
  }
  const queueApiUrl = readFirstRecord(state, name)?.apiUrl;
  return typeof queueApiUrl === 'string' && queueApiUrl !== apiUrl;
}

function listSpoolFiles(state) {
  try {
    return fs.readdirSync(spoolDir(state));
  } catch (err) {
    if (isMissingPath(err)) {
      return [];
    }
    if (!isUnreadablePath(err)) {
      throw err;
    }
    logError(state.home, 'the upload queue folder could not be read', err);
    return [];
  }
}

const listQueueFiles = (state) => listSpoolFiles(state).filter((name) => !isUnfinishedWrite(name));

export function spoolPending(state, apiUrl, now = Date.now()) {
  return listQueueFiles(state).some(
    (f) => claimMarkOf(f) !== null || (f.endsWith(QUEUE_FILE_SUFFIX) && !isWaitingForAnotherServer(state, f, apiUrl, now)),
  );
}

function readSpoolFile(state, name) {
  try {
    return { text: fs.readFileSync(path.join(spoolDir(state), name), 'utf8') };
  } catch (err) {
    if (isMissingPath(err)) {
      return { text: '' };
    }
    if (isUnreadablePath(err)) {
      return { text: '', error: err };
    }
    throw err;
  }
}

export function findUnreadableSpoolFiles(state) {
  return listQueueFiles(state).filter((name) => readSpoolFile(state, name).error);
}

export function countPending(state, apiUrl, projectId) {
  let total = 0;
  for (const f of listQueueFiles(state)) {
    const spooledText = readSpoolFile(state, f).text;
    for (const line of spooledText.split('\n')) {
      if (line && (!projectId || line.includes(`"projectId":"${projectId}"`)) && (!apiUrl || line.includes(JSON.stringify(apiUrl)))) {
        total += 1;
      }
    }
  }
  return total;
}

export function dropSpool(state, { apiUrl, projectId, providerId }) {
  const providers = providerId ? [providerId] : ['claude-code', 'codex'];
  const targets = new Set(
    projectId
      ? providers.map((p) => path.basename(spoolFile(state, apiUrl, projectId, p)))
      : [],
  );
  for (const f of listSpoolFiles(state)) {
    const full = path.join(spoolDir(state), f);
    const base = queueNameOf(f);
    let match = targets.has(base);
    if (!match && !projectId) {
      const rec = readFirstRecord(state, f);
      match = rec?.apiUrl === apiUrl && (!providerId || rec.providerId === providerId);
    }
    if (match) {
      removeFileOrLog(state.home, full, 'dropped upload queue');
    }
  }
}
