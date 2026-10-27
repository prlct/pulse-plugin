import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildSkillEvent, saveDroppedEvents, spoolEvent } from './events.mjs';
import { ApiUrlError, PROVIDER_IDS, StateBusyError, isRecordingStateUnusable, recordingAllowed } from './state.mjs';
import {
  UPLOAD_LOCK_STALE_MS,
  acquireLock,
  deriveSessionFileKey,
  ensureDir,
  isInRanges,
  isAlive,
  isInvisibleCodePoint,
  isMissingPath,
  logError,
  readJson,
  removeFileOrLog,
  renameIfPresent,
  replaceCodePoints,
  sha256,
  writeJson,
} from './util.mjs';

const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_SLUG_MAX = 100;
const SKILL_VERSION_RE = /^[0-9a-f]{16}$/;
export const SKILL_ENTRY_FILE = 'SKILL.md';
const BUNDLE_MAX_FILES = 200;
export const BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
const PATH_MAX = 300;
const PATH_DEPTH_MAX = 32;
const CONTROL_RANGES = [
  [0x00, 0x1f],
  [0x7f, 0x7f],
];
const HIDDEN_CONTROL_RANGES = [
  [0x00, 0x08],
  [0x0b, 0x1f],
];
const hasControlChar = (text) => [...text].some((char) => isInRanges(char.codePointAt(0), CONTROL_RANGES));
const isHiddenCodePoint = (codePoint) => isInRanges(codePoint, HIDDEN_CONTROL_RANGES) || isInvisibleCodePoint(codePoint);
const WINDOWS_FORBIDDEN_CHARS_RE = /[<>"|?*]/;
const WINDOWS_RESERVED_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)(?: *\..*)?$/i;
const WINDOWS_TRAILING_RE = /[. ]$/;
const VERSIONS_KEPT = 3;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

export const RUN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const RUNS_MAX = 50;
const ATTACH_WINDOW_MS = 10 * 60 * 1000;
const DOUBLE_LOAD_MS = 2 * 60 * 1000;
const INSTANCE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const RUNS_FILE = 'skill-runs.json';
const CACHE_LOCK_STALE_MS = 10_000;
const CACHE_LOCK_WAIT_MS = 3_000;
const SESSION_START_SKEW_MS = 1_000;
const ENDED_SESSIONS_DIR = 'ended-sessions';
const ENDED_NOTE_SUFFIX = '.json';
const ENDED_NOTE_CLAIM_SUFFIX = '.settling';
const ENDED_NOTE_CLAIM_RE = /^(.+\.json)\.(\d+)\.[0-9a-f]{8}\.settling$/;

export class SkillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const isSkillSlug = (value) => typeof value === 'string' && value.length <= SKILL_SLUG_MAX && SKILL_SLUG_RE.test(value);

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function skillVersion(files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort((a, b) => byCodePoint(a.path, b.path))) {
    hash.update(file.path).update('\0').update(file.content).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function isSafeBundlePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > PATH_MAX) {
    return false;
  }
  if (p.startsWith('/') || p.includes('\\') || p.includes(':') || hasControlChar(p) || WINDOWS_FORBIDDEN_CHARS_RE.test(p)) {
    return false;
  }
  const segments = p.split('/');
  return segments.length <= PATH_DEPTH_MAX && segments.every(isSafeSegment);
}

function isSafeSegment(segment) {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !WINDOWS_TRAILING_RE.test(segment) &&
    !WINDOWS_RESERVED_NAME_RE.test(segment)
  );
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    return null;
  }
  const buf = Buffer.from(value, 'base64');
  return buf.toString('base64') === value ? buf : null;
}

const fail = (code, message) => {
  throw new SkillError(code, message);
};

export function verifyBundle(body, slug) {
  const skill = body?.skill;
  if (!skill || typeof skill !== 'object' || skill.slug !== slug || !SKILL_VERSION_RE.test(String(skill.version ?? ''))) {
    fail('invalid_bundle', 'the answer does not describe this skill');
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    fail('invalid_bundle', 'the skill has no files');
  }
  if (body.files.length > BUNDLE_MAX_FILES) {
    fail('too_large', `more than ${BUNDLE_MAX_FILES} files`);
  }
  const files = [];
  const seen = new Set();
  let total = 0;
  for (const raw of body.files) {
    if (!raw || typeof raw !== 'object' || !isSafeBundlePath(raw.path)) {
      fail('unsafe_path', 'a file path is not a plain path inside the skill folder');
    }
    const folded = raw.path.normalize('NFC').toLowerCase();
    if (seen.has(folded)) {
      fail('unsafe_path', 'two files have the same name');
    }
    seen.add(folded);
    const content = decodeBase64(raw.content);
    if (!content) {
      fail('invalid_bundle', 'a file is not valid base64');
    }
    total += content.length;
    if (total > BUNDLE_MAX_BYTES) {
      fail('too_large', `more than ${BUNDLE_MAX_BYTES / (1024 * 1024)} MB of files`);
    }
    files.push({ path: raw.path, content });
  }
  for (const f of files) {
    const segments = f.path.normalize('NFC').toLowerCase().split('/');
    for (let i = 1; i < segments.length; i += 1) {
      if (seen.has(segments.slice(0, i).join('/'))) {
        fail('unsafe_path', 'a file name is also used as a folder');
      }
    }
  }
  if (!files.some((f) => f.path === SKILL_ENTRY_FILE)) {
    fail('invalid_bundle', `${SKILL_ENTRY_FILE} is missing`);
  }
  if (skillVersion(files) !== skill.version) {
    fail('version_mismatch', 'the files do not match the version Pulse announced');
  }
  return {
    skill: {
      id: typeof skill.id === 'string' ? skill.id.slice(0, 100) : null,
      slug,
      name: typeof skill.name === 'string' ? skill.name : slug,
      description: typeof skill.description === 'string' ? skill.description : '',
      version: skill.version,
    },
    files,
  };
}

export function apiHostKey(apiUrl) {
  const url = new URL(apiUrl);
  const host = `${url.hostname}${url.port ? `_${url.port}` : ''}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return `${host}-${sha256(apiUrl).slice(0, 8)}`;
}

function skillsRoot(state, apiUrl) {
  return state.file(path.join('skills', apiHostKey(apiUrl)));
}

export function skillFolder(state, apiUrl, slug, version) {
  if (!isSkillSlug(slug) || !SKILL_VERSION_RE.test(version)) {
    throw new SkillError('invalid_bundle', 'not a skill name and version');
  }
  return path.join(skillsRoot(state, apiUrl), slug, version);
}

class CachedEntryRefused extends Error {}

function readFolder(dir) {
  const files = [];
  let total = 0;
  const walk = (rel) => {
    const full = rel ? path.join(dir, ...rel.split('/')) : dir;
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full)) {
        walk(rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (!stat.isFile() || !rel || !isSafeBundlePath(rel)) {
      throw new CachedEntryRefused('unexpected entry');
    }
    total += stat.size;
    if (files.length >= BUNDLE_MAX_FILES || total > BUNDLE_MAX_BYTES) {
      throw new CachedEntryRefused('too large');
    }
    files.push({ path: rel, content: fs.readFileSync(full) });
  };
  try {
    if (!fs.lstatSync(dir).isDirectory()) {
      return null;
    }
    walk('');
  } catch (err) {
    if (isMissingPath(err) || err instanceof CachedEntryRefused) {
      return null;
    }
    throw err;
  }
  return files;
}

export function cachedSkill(state, apiUrl, slug, version) {
  const dir = skillFolder(state, apiUrl, slug, version);
  const files = readFolder(dir);
  if (!files || !files.some((f) => f.path === SKILL_ENTRY_FILE) || skillVersion(files) !== version) {
    return null;
  }
  return { dir, files };
}

export function writeSkillCache(state, apiUrl, bundle) {
  const { slug, version } = bundle.skill;
  const existing = cachedSkill(state, apiUrl, slug, version);
  if (existing) {
    return { ...existing, reused: true };
  }
  const dir = skillFolder(state, apiUrl, slug, version);
  const parent = path.dirname(dir);
  ensureDir(state.home);
  ensureDir(path.join(state.home, 'skills'));
  ensureDir(path.dirname(parent));
  ensureDir(parent);
  const tmp = path.join(parent, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmp, { mode: 0o700 });
  try {
    for (const file of bundle.files) {
      const target = path.join(tmp, ...file.path.split('/'));
      const rel = path.relative(tmp, target);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new SkillError('unsafe_path', 'a file path leaves the skill folder');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, file.content, { mode: 0o600, flag: 'wx' });
    }
    const written = readFolder(tmp);
    if (!written || skillVersion(written) !== version) {
      throw new SkillError('cache_failed', 'the files written do not match the skill version');
    }
    try {
      fs.renameSync(tmp, dir);
    } catch (err) {
      if (!TARGET_EXISTS_CODES.has(err.code)) {
        throw err;
      }
      const raced = cachedSkill(state, apiUrl, slug, version);
      if (raced) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return { ...raced, reused: true };
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    }
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  pruneVersions(state, parent, version);
  return { dir, files: bundle.files, reused: false };
}

const TARGET_EXISTS_CODES = new Set(['ENOTEMPTY', 'EEXIST', 'EPERM']);

function statEntry(parent, name) {
  try {
    return { name, mtime: fs.lstatSync(path.join(parent, name)).mtimeMs };
  } catch (err) {
    if (isMissingPath(err)) {
      return null;
    }
    throw err;
  }
}

function pruneVersions(state, parent, current, now = Date.now()) {
  try {
    const entries = fs
      .readdirSync(parent)
      .map((name) => statEntry(parent, name))
      .filter(Boolean);
    for (const e of entries) {
      if (e.name.startsWith('.tmp-') && now - e.mtime > TEMP_MAX_AGE_MS) {
        fs.rmSync(path.join(parent, e.name), { recursive: true, force: true });
      }
    }
    const versions = entries.filter((e) => SKILL_VERSION_RE.test(e.name) && e.name !== current).sort((a, b) => b.mtime - a.mtime);
    for (const e of versions.slice(VERSIONS_KEPT - 1)) {
      fs.rmSync(path.join(parent, e.name), { recursive: true, force: true });
    }
  } catch (err) {
    logError(state.home, 'old skill versions were not removed; the next load tries again', err);
  }
}

const INDEX_FILE = '.projects.json';
export const PRUNE_MIN_AGE_MS = 10 * 60 * 1000;

function cacheLock(state, apiUrl) {
  return acquireLock(state.file(path.join('skills', `${apiHostKey(apiUrl)}.lock`)), { staleMs: CACHE_LOCK_STALE_MS, waitMs: CACHE_LOCK_WAIT_MS, home: state.home });
}

function recentlyUsed(dir, now) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) {
      return false;
    }
    if (now - stat.mtimeMs < PRUNE_MIN_AGE_MS) {
      return true;
    }
    for (const name of fs.readdirSync(dir)) {
      const age = now - fs.lstatSync(path.join(dir, name)).mtimeMs;
      if (age < PRUNE_MIN_AGE_MS || (name.startsWith('.tmp-') && age < TEMP_MAX_AGE_MS)) {
        return true;
      }
    }
  } catch (err) {
    if (isMissingPath(err)) {
      return true;
    }
    throw err;
  }
  return false;
}

function readIndex(root) {
  const value = readJson(path.join(root, INDEX_FILE), {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isDirectory(target) {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch (err) {
    if (isMissingPath(err)) {
      return false;
    }
    throw err;
  }
}

function writeIndex(root, index) {
  if (!isDirectory(root)) {
    return;
  }
  const tmp = path.join(root, `${INDEX_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, path.join(root, INDEX_FILE));
}

function removeInside(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

export async function noteCachedSkill(state, apiUrl, slug, projectId) {
  const root = skillsRoot(state, apiUrl);
  const release = await cacheLock(state, apiUrl);
  if (!release) {
    throw new StateBusyError(INDEX_FILE);
  }
  try {
    const index = readIndex(root);
    const projects = new Set(Array.isArray(index[slug]) ? index[slug] : []);
    if (!projects.has(projectId)) {
      projects.add(projectId);
      index[slug] = [...projects];
      writeIndex(root, index);
    }
  } finally {
    await release();
  }
}

export async function pruneSkillCache(state, apiUrl, projectId, slugs, now = Date.now()) {
  const root = skillsRoot(state, apiUrl);
  if (!isDirectory(root)) {
    return 0;
  }
  const release = await cacheLock(state, apiUrl);
  if (!release) {
    return 0;
  }
  try {
    return pruneLocked(root, projectId, slugs, now);
  } finally {
    await release();
  }
}

function pruneLocked(root, projectId, slugs, now) {
  const keep = new Set(slugs);
  const index = readIndex(root);
  let removed = 0;
  let changed = false;
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    if (isMissingPath(err)) {
      return 0;
    }
    throw err;
  }
  for (const name of names) {
    if (!isSkillSlug(name) || keep.has(name)) {
      continue;
    }
    const projects = Array.isArray(index[name]) ? index[name] : [];
    const rest = projects.filter((id) => id !== projectId);
    if (projects.length > 0 && rest.length === projects.length) {
      continue;
    }
    if (rest.length > 0) {
      index[name] = rest;
    } else if (recentlyUsed(path.join(root, name), now)) {
      continue;
    } else {
      removeInside(root, path.join(root, name));
      delete index[name];
      removed += 1;
    }
    changed = true;
  }
  if (changed) {
    writeIndex(root, index);
  }
  return removed;
}

export async function removeSkillCache(state, apiUrl) {
  const release = await cacheLock(state, apiUrl);
  if (!release) {
    throw new StateBusyError(path.basename(skillsRoot(state, apiUrl)));
  }
  try {
    removeInside(state.file('skills'), skillsRoot(state, apiUrl));
  } finally {
    await release();
  }
}

const SKILL_TEXT_MAX = 100_000;

export function skillText(content) {
  const text = replaceCodePoints(Buffer.from(content).toString('utf8').replace(/\r\n?/g, '\n'), isHiddenCodePoint, '');
  return text.length > SKILL_TEXT_MAX ? { text: text.slice(0, SKILL_TEXT_MAX), truncated: true } : { text, truncated: false };
}

const readRuns = (all) => ({
  runs: Array.isArray(all?.runs) ? all.runs.filter((r) => r && typeof r === 'object' && typeof r.id === 'string') : [],
  instances: all?.instances && typeof all.instances === 'object' ? all.instances : {},
});

const runsExist = (state) => readRuns(state.read(RUNS_FILE, null)).runs.length > 0;

export async function recordSkillRun(state, run, now = Date.now()) {
  let kept = null;
  await state.update(RUNS_FILE, (all) => {
    const data = readRuns(all);
    for (const [key, info] of Object.entries(data.instances)) {
      if (!(now - (info?.at ?? 0) < INSTANCE_MAX_AGE_MS)) {
        delete data.instances[key];
      }
    }
    const open = data.runs.find(
      (r) =>
        r.slug === run.slug &&
        r.projectId === run.projectId &&
        r.apiUrl === run.apiUrl &&
        (run.toolUseId
          ? r.toolUseId === run.toolUseId
          : r.instance === run.instance && now - r.startedAt >= 0 && now - r.startedAt < DOUBLE_LOAD_MS),
    );
    if (open) {
      kept = open;
      return data;
    }
    const guessSessionId = data.instances[run.instance]?.sessionId ?? null;
    kept = { ...run, id: crypto.randomBytes(12).toString('hex'), startedAt: now, sessionId: run.sessionId ?? null, guessSessionId };
    data.runs = [...data.runs, kept].slice(-RUNS_MAX);
    return data;
  });
  return kept;
}

export async function attachSkillRun(state, { providerId, sessionId, toolUseId = null, repoKey, now = Date.now() }) {
  if (!sessionId || !runsExist(state)) {
    return null;
  }
  let attached = null;
  await state.update(RUNS_FILE, (all) => {
    const data = readRuns(all);
    const candidates = data.runs.filter((r) => r.providerId === providerId && !r.sessionId);
    const byId = toolUseId ? candidates.find((r) => r.toolUseId === toolUseId) : null;
    const target =
      byId ??
      candidates
        .filter((r) => !(toolUseId && r.toolUseId) && r.repoKey === repoKey && now - r.startedAt < ATTACH_WINDOW_MS && r.startedAt <= now)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!target) {
      return data;
    }
    for (const r of data.runs) {
      if (r === target || (r.instance === target.instance && !r.sessionId)) {
        r.sessionId = sessionId;
      }
    }
    data.instances[target.instance] = { sessionId, at: now };
    attached = target;
    return data;
  });
  return attached;
}

export async function takeSessionRuns(
  state,
  { providerId, sessionId, repoKey, sessionStartedAt = null, now = Date.now(), attachedOnly = false, before = null, endSession = false, waitMs },
) {
  if (!sessionId || !runsExist(state)) {
    return [];
  }
  const taken = [];
  await state.update(
    RUNS_FILE,
    (all) => {
      const data = readRuns(all);
      data.runs = data.runs.filter((r) => {
        const mine =
          r.providerId === providerId &&
          r.startedAt <= now &&
          (before === null || r.startedAt < before) &&
          (r.sessionId
            ? r.sessionId === sessionId
            : !attachedOnly && r.repoKey === repoKey && (!sessionStartedAt || r.startedAt >= sessionStartedAt - SESSION_START_SKEW_MS));
        if (mine) {
          taken.push(r.sessionId ? r : { ...r, sessionId });
        }
        return !mine;
      });
      if (endSession) {
        for (const [key, info] of Object.entries(data.instances)) {
          if (info?.sessionId === sessionId) {
            delete data.instances[key];
          }
        }
      }
      return data;
    },
    {},
    { waitMs },
  );
  return taken;
}

async function takeExpiredRuns(state, now = Date.now()) {
  if (!runsExist(state)) {
    return [];
  }
  const taken = [];
  await state.update(RUNS_FILE, (all) => {
    const data = readRuns(all);
    data.runs = data.runs.filter((r) => {
      const expired = !(now - r.startedAt < RUN_MAX_AGE_MS);
      if (expired) {
        taken.push(r);
      }
      return !expired;
    });
    return data;
  });
  return taken;
}

function runAllowed(state, run, now = Date.now()) {
  let apiUrl;
  try {
    apiUrl = state.apiUrl();
  } catch (err) {
    if (err instanceof ApiUrlError) {
      return false;
    }
    throw err;
  }
  if (run.apiUrl !== apiUrl || (run.grantId && state.auth(apiUrl)?.grantId !== run.grantId)) {
    return false;
  }
  const ctx = { key: run.repoKey, kind: run.repoKind, remoteKey: run.remoteKey ?? null };
  const allowed = recordingAllowed(state, ctx, apiUrl, now);
  return allowed.ok && allowed.binding.projectId === run.projectId;
}

async function putBackRuns(state, runs, waitMs) {
  if (runs.length === 0) {
    return;
  }
  try {
    await state.update(
      RUNS_FILE,
      (all) => {
        const data = readRuns(all);
        const kept = new Set(data.runs.map((r) => r.id));
        data.runs = [...runs.filter((r) => !kept.has(r.id)), ...data.runs].slice(-RUNS_MAX);
        return data;
      },
      {},
      { waitMs },
    );
  } catch (err) {
    logError(state.home, `${runs.length} skill run(s) waiting for a readable Pulse file were not put back; they are not recorded`, err);
  }
}

export async function settleRuns(state, runs, { end, now = Date.now(), salt, waitMs }) {
  let spooled = 0;
  const waiting = [];
  const drops = new Map();
  for (const run of runs) {
    try {
      if (!runAllowed(state, run, now)) {
        if (isRecordingStateUnusable(state)) {
          waiting.push(run);
        }
        continue;
      }
      const expired = end === 'expired' || !(now - run.startedAt < RUN_MAX_AGE_MS);
      const outcome = expired ? { outcome: 'invoked', durationState: 'unavailable' } : end === 'stop'
        ? { outcome: 'completed', durationState: 'measured', finishedAt: now }
        : { outcome: 'invoked', durationState: 'interrupted' };
      const event = buildSkillEvent({ salt, run, ...outcome });
      if (spoolEvent(state, { apiUrl: run.apiUrl, projectId: run.projectId, providerId: run.providerId, grantId: run.grantId ?? null, event, drops })) {
        spooled += 1;
      }
    } catch (err) {
      logError(state.home, 'skill run not recorded', err);
    }
  }
  await saveDroppedEvents(state, drops, now);
  await putBackRuns(state, waiting, waitMs);
  return spooled;
}

const locateEndedSessionFile = (state, providerId, sessionId) =>
  state.file(path.join(ENDED_SESSIONS_DIR, `${deriveSessionFileKey(providerId, sessionId)}${ENDED_NOTE_SUFFIX}`));

export function noteEndedSession(state, { providerId, sessionId, repoKey, sessionStartedAt, endedAt }) {
  writeJson(locateEndedSessionFile(state, providerId, sessionId), { providerId, sessionId, repoKey, sessionStartedAt, endedAt });
}

function readEndedSession(value) {
  const isText = (v) => typeof v === 'string' && v.length > 0;
  if (!value || !PROVIDER_IDS.includes(value.providerId) || !isText(value.sessionId) || !isText(value.repoKey) || !Number.isFinite(value.endedAt)) {
    return null;
  }
  const sessionStartedAt = Number.isFinite(value.sessionStartedAt) ? value.sessionStartedAt : null;
  return { providerId: value.providerId, sessionId: value.sessionId, repoKey: value.repoKey, sessionStartedAt, endedAt: value.endedAt };
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if (isMissingPath(err)) {
      return null;
    }
    throw err;
  }
}

function claimEndedSessionNote(state, dir, name, now) {
  const claim = ENDED_NOTE_CLAIM_RE.exec(name);
  if (!claim && !name.endsWith(ENDED_NOTE_SUFFIX)) {
    return null;
  }
  const full = path.join(dir, name);
  const stat = lstatOrNull(full);
  if (!stat) {
    return null;
  }
  if (!stat.isFile()) {
    fs.rmSync(full, { recursive: true, force: true });
    logError(state.home, 'an ended session note that is not a file was removed');
    return null;
  }
  const owner = claim ? Number(claim[2]) : null;
  const isClaimFresh = now - stat.ctimeMs <= UPLOAD_LOCK_STALE_MS;
  if (owner !== null && owner !== process.pid && isAlive(owner) && isClaimFresh) {
    return null;
  }
  const taken = path.join(dir, `${claim ? claim[1] : name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}${ENDED_NOTE_CLAIM_SUFFIX}`);
  return renameIfPresent(full, taken) ? taken : null;
}

function claimEndedSessionNotes(state, now) {
  const dir = state.file(ENDED_SESSIONS_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (isMissingPath(err)) {
      return [];
    }
    throw err;
  }
  return names.map((name) => claimEndedSessionNote(state, dir, name, now)).filter(Boolean);
}

function readClaimedNote(state, file) {
  let unreadable = false;
  const value = readJson(file, null, {
    onUnreadable: (err) => {
      unreadable = true;
      logError(state.home, 'an ended session note could not be read and was removed; its skill runs are sent when they expire', err);
    },
  });
  return unreadable ? { unreadable } : { ended: readEndedSession(value) };
}

export async function settleEndedSessions(state, now = Date.now()) {
  const claimed = claimEndedSessionNotes(state, now);
  if (claimed.length === 0) {
    return 0;
  }
  const salt = await state.salt();
  let spooled = 0;
  for (const file of claimed) {
    const { ended } = readClaimedNote(state, file);
    if (ended) {
      const runs = await takeSessionRuns(state, { ...ended, now: ended.endedAt, endSession: true });
      if (runs.length > 0) {
        spooled += await settleRuns(state, runs, { end: 'session_end', now: ended.endedAt, salt });
      }
    }
    removeFileOrLog(state.home, file, ended ? 'settled ended session note' : 'unusable ended session note');
  }
  return spooled;
}

export async function settleExpiredRuns(state, now = Date.now()) {
  if (!runsExist(state)) {
    return 0;
  }
  const salt = await state.salt();
  return settleRuns(state, await takeExpiredRuns(state, now), { end: 'expired', now, salt });
}
