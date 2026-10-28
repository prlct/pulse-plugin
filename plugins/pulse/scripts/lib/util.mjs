import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN_VERSION = '0.5.1';
export const DEFAULT_API_URL = 'https://api.paralect.ai';
export const SCHEMA_VERSION = 1;
export const EVENTS_BATCH_MAX = 100;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 50;
const REMOVAL_GUARD_SUFFIX = '.guard';
const GUARD_STALE_MS = 60_000;
const GUARD_ATTEMPTS = 3;
const RELEASE_RETRY_MS = 1_000;
const RELEASE_POLL_MS = 5;
const TRY_LOCK_ATTEMPTS = 5;
const LOCK_REMOVAL = { removed: 'removed', kept: 'kept', gone: 'gone', busy: 'busy' };
const COUNT_KEY_MAX = 100;

export const PROVIDERS = {
  claude: { id: 'claude-code', label: 'Claude Code' },
  codex: { id: 'codex', label: 'Codex' },
};

export const findProvider = (host) => (typeof host === 'string' && Object.hasOwn(PROVIDERS, host) ? PROVIDERS[host] : null);

export function cmdRef(host, sub) {
  if (host === 'claude') {
    return `/pulse:${sub}`;
  }
  if (host === 'codex') {
    return `$pulse:${sub}`;
  }
  return `pulse ${sub}`;
}

export const CLIENT_NAME = 'Pulse plugin';

export const pastTimeOrNull = (value) => (Number.isFinite(value) && value <= Date.now() ? value : null);

export function hostKey(name) {
  const value = String(name ?? '').toLowerCase();
  if (value === 'claude' || value === 'claude-code') {
    return 'claude';
  }
  if (value === 'codex') {
    return 'codex';
  }
  return null;
}

export function detectHost(env = process.env) {
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) {
    return 'claude';
  }
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_CI || env.CODEX_SESSION_ID) {
    return 'codex';
  }
  return null;
}

export const inCodex = (env = process.env) =>
  Boolean(env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID);

export function homeDir(env = process.env) {
  return env.PULSE_HOME ? path.resolve(env.PULSE_HOME) : path.join(os.homedir(), '.config', 'pulse');
}

const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR']);
const UNREADABLE_PATH_CODES = new Set([...MISSING_PATH_CODES, 'EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'ENAMETOOLONG']);

export const isMissingPath = (err) => MISSING_PATH_CODES.has(err?.code);
export const isUnreadablePath = (err) => UNREADABLE_PATH_CODES.has(err?.code);

function unlessUnreadable(read, fallback) {
  try {
    return read();
  } catch (err) {
    if (isUnreadablePath(err)) {
      return fallback;
    }
    throw err;
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictMode(dir, 0o700);
}

const unrestrictedDirs = new Map();

function restrictMode(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    if (!unrestrictedDirs.has(target)) {
      unrestrictedDirs.set(target, { err, reported: false });
    }
  }
}

export function reportUnrestrictedDirs(home) {
  for (const [dir, note] of unrestrictedDirs) {
    if (!note.reported) {
      note.reported = true;
      logError(home, `access to ${dir} could not be restricted to this user; Pulse goes on with its current mode`, note.err);
    }
  }
}

export const fileSizeOrZero = (file) => unlessUnreadable(() => fs.statSync(file).size, 0);

export const modifiedAtOrNull = (file) => unlessUnreadable(() => fs.statSync(file).mtimeMs, null);

export const changedAtOrNull = (file) => unlessUnreadable(() => fs.statSync(file).ctimeMs, null);

export const readTextOrNull = (file) => unlessUnreadable(() => fs.readFileSync(file, 'utf8'), null);

export function renameIfPresent(from, to) {
  try {
    fs.renameSync(from, to);
    return true;
  } catch (err) {
    if (isMissingPath(err)) {
      return false;
    }
    throw err;
  }
}

const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;

export const safeCode = (value, fallback = 'error') => (typeof value === 'string' && SAFE_CODE_RE.test(value) ? value : fallback);

export function removeFileOrLog(home, file, context) {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    logError(home, `${context}: ${path.basename(file)} was not removed`, err);
  }
}

export function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { ok: false, value: null };
    }
    throw err;
  }
}

export function urlOrNull(value) {
  try {
    return new URL(value);
  } catch (err) {
    if (err?.code === 'ERR_INVALID_URL') {
      return null;
    }
    throw err;
  }
}

export function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const writeJson = (file, value) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);

export function readJson(file, fallback, { onInvalid = null, onUnreadable = null, onReadable = null } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (isMissingPath(err)) {
      onReadable?.();
      return fallback;
    }
    if (!onUnreadable || !isUnreadablePath(err)) {
      throw err;
    }
    onUnreadable(err);
    return fallback;
  }
  onReadable?.();
  const parsed = parseJson(text);
  if (parsed.ok) {
    return parsed.value;
  }
  onInvalid?.();
  return fallback;
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
}

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const deriveSessionFileKey = (providerId, sessionId) => sha256(`${providerId}|${sessionId}`).slice(0, 32);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const UPLOAD_LOCK_STALE_MS = 120_000;
const PID_MAX = 2 ** 31 - 1;

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > PID_MAX) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') {
      return true;
    }
    if (err.code === 'ESRCH') {
      return false;
    }
    throw err;
  }
}

function createExclusive(file, content) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') {
      return false;
    }
    throw err;
  }
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function readLockHolder(file) {
  let modifiedAt;
  let text;
  try {
    modifiedAt = fs.statSync(file).mtimeMs;
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (isMissingPath(err)) {
      return null;
    }
    throw err;
  }
  const holder = parseJson(text).value;
  return {
    pid: Number.isInteger(holder?.pid) ? holder.pid : null,
    nonce: typeof holder?.nonce === 'string' ? holder.nonce : null,
    age: Date.now() - modifiedAt,
  };
}

const isHolderDead = (holder) => holder.pid !== null && holder.pid !== process.pid && !isAlive(holder.pid);

const makeLockContent = (nonce) => JSON.stringify({ pid: process.pid, at: Date.now(), nonce });

function unlinkIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (!isMissingPath(err)) {
      throw err;
    }
  }
}

function unlinkOrLog(file, home, context) {
  try {
    unlinkIfPresent(file);
  } catch (err) {
    logError(home, `${context}: ${path.basename(file)} was not removed`, err);
  }
}

function copyModifiedTime(from, to, home) {
  try {
    const { atime, mtime } = fs.statSync(from);
    fs.utimesSync(to, atime, mtime);
  } catch (err) {
    logError(home, `${path.basename(to)} was put back with a new modification time`, err);
  }
}

function restoreIfAbsent(grabbed, file, home) {
  const context = `${path.basename(file)} was put back`;
  try {
    fs.linkSync(grabbed, file);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return copyBackIfAbsent(grabbed, file, home, err);
    }
  }
  unlinkOrLog(grabbed, home, context);
  return true;
}

function copyBackIfAbsent(grabbed, file, home, linkError) {
  logError(home, `${path.basename(file)} could not be put back with a hard link; copying it back instead`, linkError);
  try {
    fs.copyFileSync(grabbed, file, fs.constants.COPYFILE_EXCL);
    copyModifiedTime(grabbed, file, home);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      logError(home, `${path.basename(file)} could not be put back; ${path.basename(grabbed)} is left next to it`, err);
      return false;
    }
  }
  unlinkOrLog(grabbed, home, `${path.basename(file)} was copied back`);
  return true;
}

function removeGuardIfNonce(guard, nonce, purpose, home) {
  const grabbed = `${guard}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.${purpose}`;
  if (!renameIfPresent(guard, grabbed)) {
    return true;
  }
  if (readLockHolder(grabbed)?.nonce === nonce) {
    unlinkOrLog(grabbed, home, `${path.basename(guard)} was released`);
    return true;
  }
  return restoreIfAbsent(grabbed, guard, home);
}

function releaseRemovalGuard(guard, nonce, home) {
  try {
    removeGuardIfNonce(guard, nonce, 'release', home);
  } catch (err) {
    logError(home, `${path.basename(guard)} was not released; it is recovered once it is stale`, err);
  }
}

function takeRemovalGuard(file, home) {
  const guard = `${file}${REMOVAL_GUARD_SUFFIX}`;
  const nonce = crypto.randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < GUARD_ATTEMPTS; attempt += 1) {
    if (createExclusive(guard, makeLockContent(nonce))) {
      return () => releaseRemovalGuard(guard, nonce, home);
    }
    const seen = readLockHolder(guard);
    if (!seen) {
      continue;
    }
    const leftover = seen.pid === process.pid || isHolderDead(seen) || seen.age > GUARD_STALE_MS;
    if (!leftover) {
      return null;
    }
    if (!removeGuardIfNonce(guard, seen.nonce, 'stale', home)) {
      return null;
    }
  }
  return null;
}

function removeLockWhen(file, shouldRemove, home) {
  const releaseGuard = takeRemovalGuard(file, home);
  if (!releaseGuard) {
    return LOCK_REMOVAL.busy;
  }
  try {
    const holder = readLockHolder(file);
    if (!holder) {
      return LOCK_REMOVAL.gone;
    }
    if (!shouldRemove(holder)) {
      return LOCK_REMOVAL.kept;
    }
    unlinkIfPresent(file);
    return LOCK_REMOVAL.removed;
  } finally {
    releaseGuard();
  }
}

function tryLock(file, { staleMs, home }) {
  ensureDir(path.dirname(file));
  const nonce = crypto.randomBytes(8).toString('hex');
  const isStale = (holder) => isHolderDead(holder) || holder.age > staleMs;
  for (let attempt = 0; attempt < TRY_LOCK_ATTEMPTS; attempt += 1) {
    if (createExclusive(file, makeLockContent(nonce))) {
      return lockHandle(file, nonce, home);
    }
    const seen = readLockHolder(file);
    if (!seen) {
      continue;
    }
    if (!isStale(seen)) {
      return null;
    }
    const outcome = removeLockWhen(file, (current) => current.nonce === seen.nonce && isStale(current), home);
    if (outcome === LOCK_REMOVAL.busy || outcome === LOCK_REMOVAL.kept) {
      return null;
    }
  }
  return null;
}

export async function removeIfOwner(file, nonce, home) {
  const deadline = Date.now() + RELEASE_RETRY_MS;
  for (;;) {
    const outcome = removeLockWhen(file, (holder) => holder.nonce === nonce, home);
    if (outcome !== LOCK_REMOVAL.busy || Date.now() >= deadline) {
      return outcome;
    }
    await sleep(RELEASE_POLL_MS);
  }
}

function lockHandle(file, nonce, home) {
  let released = false;
  const release = async () => {
    if (released) {
      return false;
    }
    released = true;
    const outcome = await removeIfOwner(file, nonce, home);
    if (outcome === LOCK_REMOVAL.busy) {
      logError(home, `${path.basename(file)} was not released: another Pulse task kept its removal guard; the lock is taken over once it is stale`);
    }
    return outcome === LOCK_REMOVAL.removed;
  };
  release.touch = () => {
    if (readJson(file, null)?.nonce !== nonce) {
      return false;
    }
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
      return true;
    } catch (err) {
      if (isMissingPath(err)) {
        return false;
      }
      throw err;
    }
  };
  return release;
}

export function keepLockFresh(release, home, everyMs) {
  const timer = setInterval(() => {
    try {
      release.touch();
    } catch (err) {
      logError(home, 'a held lock could not be kept fresh; it is touched again at the next interval', err);
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function acquireLock(file, { staleMs = LOCK_STALE_MS, waitMs = 0, home = path.dirname(file) } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = tryLock(file, { staleMs, home });
    if (release || Date.now() >= deadline) {
      return release;
    }
    await sleep(LOCK_POLL_MS);
  }
}

export const spawnDetached = (command, args, env) => spawn(command, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true, env });

export function runInBackground(home, context, work) {
  work().catch((err) => logError(home, context, err));
}

const LOG_MAX_BYTES = 256 * 1024;

export function logError(home, context, err) {
  const file = path.join(home, 'pulse.log');
  try {
    ensureDir(home);
    if (fileSizeOrZero(file) > LOG_MAX_BYTES) {
      renameIfPresent(file, `${file}.1`);
    }
    const detail = err ? ` ${err.code ?? err.name ?? 'error'}${err.status ? ` status=${err.status}` : ''}` : '';
    fs.appendFileSync(file, `${new Date().toISOString()} ${context}${detail}\n`, { mode: 0o600 });
    return true;
  } catch (writeError) {
    process.stderr.write(`Pulse could not write ${file} (${writeError.code ?? writeError.name}): ${context}\n`);
    return false;
  }
}

const RESERVED_COUNT_KEYS = new Set(['constructor', '__proto__', 'prototype']);

export function countKey(name) {
  const key = String(name ?? '')
    .replace(/[^\w.:@/-]/g, '_')
    .slice(0, COUNT_KEY_MAX);
  return key.length > 0 && !RESERVED_COUNT_KEYS.has(key) ? key : null;
}

const INVISIBLE_RANGES = [
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
const CONTROL_RANGE = [0x00, 0x1f];
const BACKTICK = 0x60;

export const isInRanges = (codePoint, ranges) => ranges.some(([from, to]) => codePoint >= from && codePoint <= to);

export const isInvisibleCodePoint = (codePoint) => isInRanges(codePoint, INVISIBLE_RANGES);

const isUnsafeForOneLine = (codePoint) => codePoint === BACKTICK || isInRanges(codePoint, [CONTROL_RANGE, ...INVISIBLE_RANGES]);

export const hasUnsafeForOneLine = (text) => [...text].some((char) => isUnsafeForOneLine(char.codePointAt(0)));

export function replaceCodePoints(text, shouldReplace, replacement) {
  let out = '';
  for (const char of text) {
    out += shouldReplace(char.codePointAt(0)) ? replacement : char;
  }
  return out;
}

export function splitLines(buffer) {
  const parts = buffer.split('\n');
  return { lines: parts.slice(0, -1), rest: parts.at(-1) };
}

export function plain(value, max = 120) {
  const text = replaceCodePoints(String(value ?? ''), isUnsafeForOneLine, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const padTwo = (n) => String(n).padStart(2, '0');

export const localDateTime = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())} ${padTwo(d.getHours())}:${padTwo(d.getMinutes())}`;
};

export const quoted = (value, max = 120) => `"${plain(value, max).replace(/"/g, "'")}"`;

export const isoNow = (now = Date.now()) => new Date(now).toISOString();

export const realpathOr = (p) => unlessUnreadable(() => fs.realpathSync(p), path.resolve(p));
