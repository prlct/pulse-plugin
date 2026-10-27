import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTurnEvent, parseCounterLog, saveDroppedEvents, spoolEvent, spoolPending } from './events.mjs';
import { repoContext } from './git.mjs';
import { attachSkillRun, noteEndedSession, settleRuns, takeSessionRuns } from './skills.mjs';
import { sessionNotice } from './updates.mjs';
import {
  COLLECTION_REFRESH_AFTER_MS,
  bindingStatus,
  isCollectionOlderThan,
  isRecordingStateUnusable,
  isSignedIn,
  recordingAllowed,
  reportWindowStart,
  runUnlessBusy,
} from './state.mjs';
import { claudeUsage, codexBaseline, codexUsage, readNewLines } from './transcript.mjs';
import {
  appendLine,
  countKey,
  deriveSessionFileKey,
  fileSizeOrZero,
  findProvider,
  homeDir,
  isMissingPath,
  isoNow,
  localDateTime,
  logError,
  modifiedAtOrNull,
  parseJson,
  pastTimeOrNull,
  readJson,
  removeFileOrLog,
  renameIfPresent,
  spawnDetached,
  writeJson,
} from './util.mjs';

const SCRIPT = fileURLToPath(new URL('../pulse.mjs', import.meta.url));
const SEEN_IDS_MAX = 64;
const EMITTED_MAX = 64;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_REQUEST_EVERY_MS = 30_000;
const REGISTER_REQUEST_EVERY_MS = 10 * 60 * 1000;
const REFRESHABLE_REASONS = new Set(['unknown_collection', 'collection_blocked', 'block_not_cached']);
export const SESSION_END_LOCK_WAIT_MS = 500;
const MS_PER_MINUTE = 60_000;
function reportPrompt(collection) {
  const start = reportWindowStart(collection);
  const window = start ? `Cover only work after ${localDateTime(start)} (local time), never work from while collection was paused. ` : '';
  return (
    'Pulse: a scheduled session report is due for this project. Run the Pulse report skill (/pulse:report) and send the report with trigger "scheduled". ' +
    `${window}If there was no real work in that time (only chat, thanks or nothing new), send nothing and say so in one line.`
  );
}

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

export function pickPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const skill = p.tool_name === 'Skill' && p.tool_input && typeof p.tool_input === 'object' ? str(p.tool_input.skill) : null;
  return {
    sessionId: str(p.session_id),
    cwd: str(p.cwd),
    transcriptPath: str(p.transcript_path),
    turnKey: str(p.turn_id) ?? str(p.prompt_id),
    model: str(p.model),
    toolName: str(p.tool_name),
    toolUseId: typeof p.tool_use_id === 'string' && /^[\w-]{1,200}$/.test(p.tool_use_id) ? p.tool_use_id : null,
    skill,
    expansionType: str(p.expansion_type),
    commandName: str(p.command_name),
    stopHookActive: p.stop_hook_active === true,
  };
}

export function counterLines(fields) {
  const lines = [];
  const name = fields.toolName;
  if (name) {
    if (name.startsWith('mcp__')) {
      const server = countKey(name.slice(5).split('__')[0]);
      if (server) {
        lines.push(`m\t${server}`);
      }
    } else {
      const key = countKey(name);
      if (key) {
        lines.push(`t\t${key}`);
      }
    }
  }
  if (fields.skill) {
    const key = countKey(fields.skill);
    if (key) {
      lines.push(`s\t${key}`);
    }
  }
  if (fields.expansionType === 'slash_command' && fields.commandName) {
    const key = countKey(fields.commandName.replace(/^\//, ''));
    if (key) {
      lines.push(`s\t${key}`);
    }
  }
  return lines;
}

function sessionPaths(state, providerId, sessionId) {
  const key = deriveSessionFileKey(providerId, sessionId);
  const name = path.join('sessions', `${key}.json`);
  return {
    name,
    json: state.file(name),
    log: state.file(path.join('sessions', `${key}.log`)),
  };
}

function removeSessionFiles(state, files) {
  removeFileOrLog(state.home, files.json, 'ended session');
  removeFileOrLog(state.home, files.log, 'ended session');
}

function drainLog(state, file) {
  const taken = `${file}.${process.pid}.take`;
  let text = '';
  try {
    if (renameIfPresent(file, taken)) {
      text = fs.readFileSync(taken, 'utf8');
    }
  } catch (err) {
    logError(state.home, 'tool counts of this turn could not be read; the turn is recorded without them', err);
  }
  removeFileOrLog(state.home, taken, 'drained tool counts');
  return parseCounterLog(text);
}

export const SPAWN_FAILURE_LOG_EVERY_MS = 10 * 60 * 1000;

export function spawnFlush(args = [], env = process.env, now = Date.now()) {
  try {
    spawnDetached(process.execPath, [SCRIPT, 'flush', '--background', ...args], env).unref();
    return true;
  } catch (err) {
    logSpawnFailureThrottled(homeDir(env), err, now);
    return false;
  }
}

function logSpawnFailureThrottled(home, err, now) {
  const marker = path.join(home, 'flush-spawn-failed.json');
  const onUnreadable = (markerError) => logError(home, 'background upload throttle marker could not be read', markerError);
  if (now - (readJson(marker, null, { onUnreadable })?.at ?? 0) < SPAWN_FAILURE_LOG_EVERY_MS) {
    return false;
  }
  try {
    writeJson(marker, { at: now });
  } catch (markerError) {
    return logError(home, 'background upload could not start; the next hook tries again (throttle marker not saved)', markerError);
  }
  return logError(home, 'background upload could not start; the next hook tries again', err);
}

const isEmpty = (counts) =>
  Object.keys(counts.tools).length + Object.keys(counts.mcp).length + Object.keys(counts.skills).length === 0;

const sessionTurnKey = (session) => `n${session.turns}.${session.startedAt}`;

export async function runHook(host, eventName, payload, { state, now = Date.now(), flush = spawnFlush } = {}) {
  const provider = findProvider(host);
  if (!provider) {
    return;
  }
  const fields = pickPayload(payload);
  if (!fields.sessionId) {
    return;
  }
  const providerId = provider.id;
  const apiUrl = state.apiUrl();
  const ctx = repoContext(fields.cwd ?? process.cwd());
  const files = sessionPaths(state, providerId, fields.sessionId);

  const record = state.auth(apiUrl);
  const signedIn = isSignedIn(record);
  const flushArgs = (projectId) => ['--provider', providerId, ...(projectId ? ['--project', projectId] : [])];

  if (eventName === 'SessionStart') {
    const prev = state.read(files.name, null);
    state.writeIfReadable(files.name, {
      startedAt: now,
      turns: prev?.turns ?? 0,
      emitted: prev?.emitted ?? [],
      seen: prev?.seen ?? [],
      offset: fields.transcriptPath ? fileSizeOrZero(fields.transcriptPath) : 0,
      baseline: host === 'codex' && fields.transcriptPath ? codexBaseline(fields.transcriptPath) : null,
      model: fields.model,
      lastStopAt: null,
    });
    await runUnlessBusy(state, 'assistant of this repository not saved', () => state.noteHost(ctx.key, host, now));
    const bound = signedIn ? bindingStatus(state, ctx, apiUrl) : { ok: false };
    const cached = bound.ok ? state.collection(apiUrl, bound.binding.projectId) : null;
    const stale = bound.ok && (!cached || isCollectionOlderThan(cached, COLLECTION_REFRESH_AFTER_MS, now));
    const register =
      signedIn &&
      !record.registeredProviders?.[providerId] &&
      now - (pastTimeOrNull(state.status(apiUrl).registerRequestedAt?.[providerId]) ?? 0) > REGISTER_REQUEST_EVERY_MS;
    if (register) {
      await runUnlessBusy(state, 'registration request time not saved', () =>
        state.setStatus(apiUrl, (s) => ({ ...s, registerRequestedAt: { ...(s.registerRequestedAt ?? {}), [providerId]: now } })),
      );
    }
    if (spoolPending(state, apiUrl, now) || stale || register || record?.orphanGrants?.length > 0) {
      flush(flushArgs(bound.ok ? bound.binding.projectId : null));
    }
    pruneSessions(state, now);
    const notice = signedIn ? await runUnlessBusy(state, 'update notice skipped', () => sessionNotice(state, apiUrl, host, now)) : null;
    return notice ? { systemMessage: notice } : undefined;
  }

  if (eventName === 'UserPromptSubmit') {
    const salt = await state.salt();
    const runs = await runUnlessBusy(
      state,
      'skill runs of the previous turn not settled',
      () => takeSessionRuns(state, { providerId, sessionId: fields.sessionId, repoKey: ctx.key, now, attachedOnly: true, before: now }),
      [],
    );
    if (runs.length > 0 && (await settleRuns(state, runs, { end: 'session_end', now, salt })) > 0) {
      flush(flushArgs(null));
    }
    return;
  }

  if (eventName === 'PostToolUse' || eventName === 'UserPromptExpansion') {
    if (eventName === 'PostToolUse' && isSkillTool(fields.toolName)) {
      await runUnlessBusy(state, 'skill run not attached to this session', () =>
        attachSkillRun(state, { providerId, sessionId: fields.sessionId, toolUseId: fields.toolUseId, repoKey: ctx.key, now }),
      );
    }
    const allowed = recordingAllowed(state, ctx, apiUrl, now);
    await requestRefresh(state, allowed, { apiUrl, now, flush, flushArgs });
    if (!allowed.ok) {
      return;
    }
    for (const line of counterLines(fields)) {
      appendLine(files.log, line);
    }
    return;
  }

  if (eventName !== 'Stop' && eventName !== 'SessionEnd') {
    return;
  }

  const isSessionEnd = eventName === 'SessionEnd';
  const lockWait = isSessionEnd ? { waitMs: SESSION_END_LOCK_WAIT_MS } : {};
  const describeEndedSession = () => ({
    providerId,
    sessionId: fields.sessionId,
    repoKey: ctx.key,
    sessionStartedAt: state.read(files.name, null)?.startedAt ?? null,
    endedAt: now,
  });
  const salt = isSessionEnd
    ? await runUnlessBusy(state, 'the last turn of this session is kept for a resumed session', () => state.salt(lockWait))
    : await state.salt();
  if (salt === null) {
    leaveRunsForNextUpload(state, describeEndedSession());
    return;
  }
  const allowed = recordingAllowed(state, ctx, apiUrl, now);
  if (!allowed.ok && isRecordingStateUnusable(state)) {
    if (eventName === 'SessionEnd') {
      logError(state.home, 'the last turn of this session is not recorded: a Pulse file needed to decide it could not be read');
      removeSessionFiles(state, files);
      return;
    }
    logError(state.home, 'this turn is not recorded: a Pulse file needed to decide it could not be read; its tool counts and tokens stay in place for the next turn of this session');
    return;
  }
  const counts = drainLog(state, files.log);
  const sess = state.read(files.name, null);
  let tokens = null;
  let model = fields.model ?? sess?.model ?? null;
  let startedAt = null;
  const next = sess ?? { startedAt: now, turns: 0, emitted: [], seen: [], baseline: null, model: null, lastStopAt: null };
  if (fields.transcriptPath) {
    if (!sess) {
      next.offset = fileSizeOrZero(fields.transcriptPath);
      if (host === 'codex') {
        next.baseline = codexBaseline(fields.transcriptPath);
      }
    } else {
      const chunk = readNewLines(fields.transcriptPath, sess.offset ?? 0);
      next.offset = chunk.offset;
      if (!chunk.skipped && chunk.lines.length > 0) {
        if (host === 'claude') {
          const usage = claudeUsage(chunk.lines, sess.seen);
          tokens = usage.tokens;
          model = usage.model ?? model;
          startedAt = usage.startedAt;
          next.seen = [...(sess.seen ?? []), ...usage.ids].slice(-SEEN_IDS_MAX);
        } else {
          const usage = codexUsage(chunk.lines, sess.baseline);
          tokens = usage.tokens;
          model = usage.model ?? model;
          startedAt = usage.startedAt;
          next.baseline = usage.baseline;
        }
      } else if (chunk.skipped && host === 'codex') {
        next.baseline = codexBaseline(fields.transcriptPath);
      }
    }
  }
  next.model = model;

  const nothing = isEmpty(counts) && !tokens;
  if (allowed.ok && !(eventName === 'SessionEnd' && nothing)) {
    let turnKey = fields.turnKey ?? sessionTurnKey(next);
    if (next.emitted.includes(turnKey)) {
      turnKey = `${turnKey}#${next.turns}`;
    }
    const endedAt = isoNow(now);
    const event = buildTurnEvent({
      providerId,
      sessionId: fields.sessionId,
      turnKey,
      salt,
      counts,
      tokens,
      model,
      remote: ctx.kind === 'git' && allowed.binding.matched ? ctx.remote : null,
      branch: ctx.kind === 'git' && allowed.binding.matched ? ctx.branch : null,
      startedAt: startedAt ?? (next.lastStopAt ? isoNow(next.lastStopAt) : isoNow(next.startedAt)),
      endedAt,
    });
    const drops = new Map();
    spoolEvent(state, { apiUrl, projectId: allowed.binding.projectId, providerId, grantId: state.auth(apiUrl)?.grantId ?? null, event, drops });
    await saveDroppedEvents(state, drops, now);
    next.turns += 1;
    next.emitted = [...next.emitted, turnKey].slice(-EMITTED_MAX);
  }
  next.lastStopAt = now;

  const runs = await runUnlessBusy(
    state,
    isSessionEnd ? 'skill runs of this session are settled by the next upload' : 'skill runs of this turn not settled',
    () =>
      takeSessionRuns(state, {
        providerId,
        sessionId: fields.sessionId,
        repoKey: ctx.key,
        sessionStartedAt: sess?.startedAt ?? null,
        now,
        endSession: isSessionEnd,
        ...lockWait,
      }),
  );
  const skillEvents = runs?.length > 0 ? await settleRuns(state, runs, { end: isSessionEnd ? 'session_end' : 'stop', now, salt, ...lockWait }) : 0;

  if (isSessionEnd) {
    if (runs === null) {
      leaveRunsForNextUpload(state, describeEndedSession());
    }
    removeSessionFiles(state, files);
    return;
  }
  state.writeIfReadable(files.name, next);
  if (allowed.ok) {
    flush(flushArgs(allowed.binding.projectId));
  } else if (skillEvents > 0) {
    flush(flushArgs(null));
  } else {
    await requestRefresh(state, allowed, { apiUrl, now, flush, flushArgs });
  }
  if (host === 'claude' && allowed.ok) {
    const promptKey = `${allowed.binding.projectId}:${deriveSessionFileKey(providerId, fields.sessionId)}`;
    return promptReportIfDue(state, { apiUrl, projectId: allowed.binding.projectId, promptKey, isContinuation: fields.stopHookActive, now });
  }
}

const isReportDue = (report, promptedAt, now) =>
  Date.parse(report.nextReportAt) <= now && now - promptedAt >= report.intervalMinutes * MS_PER_MINUTE;

const recentPrompts = (prompts, now) =>
  Object.fromEntries(Object.entries(prompts).filter(([, prompt]) => now - (prompt?.seenAt ?? 0) <= SESSION_MAX_AGE_MS));

const latestPromptIn = (prompts, projectId) =>
  Math.max(
    0,
    ...Object.entries(prompts)
      .filter(([key]) => key.startsWith(`${projectId}:`))
      .map(([, prompt]) => prompt?.promptedAt ?? 0),
  );

async function promptReportIfDue(state, { apiUrl, projectId, promptKey, isContinuation, now }) {
  const collection = state.collection(apiUrl, projectId)?.state;
  if (collection?.level !== 'summary' || collection.report?.mode !== 'scheduled') {
    return undefined;
  }
  let isDue = false;
  const saved = await runUnlessBusy(
    state,
    'scheduled report prompt skipped',
    async () => {
      await state.setStatus(apiUrl, (s) => {
        const prompts = recentPrompts(s.reportPrompts ?? {}, now);
        const promptedAt = latestPromptIn(prompts, projectId);
        isDue = !isContinuation && isReportDue(collection.report, promptedAt, now);
        return { ...s, reportPrompts: { ...prompts, [promptKey]: { promptedAt: isDue ? now : promptedAt, seenAt: now } } };
      });
      return true;
    },
    false,
  );
  return saved && isDue ? { decision: 'block', reason: reportPrompt(collection) } : undefined;
}

function leaveRunsForNextUpload(state, ended) {
  try {
    noteEndedSession(state, ended);
  } catch (err) {
    logError(state.home, 'the end of this session was not noted; its skill runs are sent when they expire', err);
  }
}

async function requestRefresh(state, allowed, { apiUrl, now, flush, flushArgs }) {
  const refreshable = allowed.ok || REFRESHABLE_REASONS.has(allowed.reason);
  if (!allowed.binding || !refreshable) {
    return;
  }
  const { projectId } = allowed.binding;
  const cached = state.collection(apiUrl, projectId);
  if (cached?.state && !isCollectionOlderThan(cached, COLLECTION_REFRESH_AFTER_MS, now)) {
    return;
  }
  const key = projectId;
  if (now - (pastTimeOrNull(state.status(apiUrl).refreshRequestedAt?.[key]) ?? 0) < REFRESH_REQUEST_EVERY_MS) {
    return;
  }
  await runUnlessBusy(state, 'collection refresh request time not saved', () =>
    state.setStatus(apiUrl, (s) => ({ ...s, refreshRequestedAt: { ...(s.refreshRequestedAt ?? {}), [key]: now } })),
  );
  flush(flushArgs(projectId));
}

export function isSkillTool(name) {
  const match = typeof name === 'string' && name.length <= 200 ? /^mcp__([\w-]+?)__pulse_skill$/.exec(name) : null;
  return Boolean(match && match[1].toLowerCase().includes('pulse'));
}

function pruneSessions(state, now) {
  const dir = state.file('sessions');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (!isMissingPath(err)) {
      logError(state.home, 'old sessions were not pruned; the next session start tries again', err);
    }
    return;
  }
  for (const f of entries) {
    const full = path.join(dir, f);
    const modifiedAt = modifiedAtOrNull(full);
    if (modifiedAt !== null && now - modifiedAt > SESSION_MAX_AGE_MS) {
      removeFileOrLog(state.home, full, 'old session');
    }
  }
}

export async function hookMain(host, eventName, { state, stdin = process.stdin, stdout = process.stdout } = {}) {
  try {
    const raw = await readStdin(stdin, state.home);
    const parsed = parseJson(raw);
    const payload = parsed.ok ? parsed.value : salvage(raw);
    const out = await runHook(host, eventName, payload, { state });
    if (out?.systemMessage) {
      stdout.write(`${JSON.stringify({ systemMessage: out.systemMessage })}\n`);
    }
    if (out?.decision) {
      stdout.write(`${JSON.stringify({ decision: out.decision, reason: out.reason })}\n`);
    }
  } catch (err) {
    logError(state.home, `hook ${host} ${eventName} failed`, { code: err?.code ?? err?.name ?? 'error' });
  }
}

const STDIN_MAX = 64 * 1024 * 1024;
const SALVAGE_HEAD_BYTES = 8192;

function readStdin(stream, home) {
  return new Promise((resolve) => {
    if (stream.isTTY) {
      resolve('');
      return;
    }
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size <= STDIN_MAX) {
        chunks.push(chunk);
      }
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', (err) => {
      logError(home, 'hook input not fully read; using what arrived', err);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function salvage(raw) {
  const head = raw.slice(0, SALVAGE_HEAD_BYTES);
  const field = (name) => {
    const match = new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.){0,500}")`).exec(head);
    return match ? parseJson(match[1]).value : null;
  };
  return {
    session_id: field('session_id'),
    cwd: field('cwd'),
    transcript_path: field('transcript_path'),
    tool_name: field('tool_name'),
  };
}
