import fs from 'node:fs';

import { fileSizeOrZero, parseJson } from './util.mjs';

const MAX_READ_BYTES = 32 * 1024 * 1024;
const TAIL_BYTES = 1024 * 1024;

export function readNewLines(file, offset) {
  const size = file ? fileSizeOrZero(file) : 0;
  if (size === 0) {
    return { lines: [], offset: 0, skipped: false };
  }
  if (size < offset) {
    return { lines: [], offset: size, skipped: true };
  }
  if (size - offset > MAX_READ_BYTES) {
    return { lines: [], offset: size, skipped: true };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    const read = fs.readSync(fd, buf, 0, buf.length, offset);
    const last = buf.lastIndexOf(0x0a, read - 1);
    if (last < 0) {
      return { lines: [], offset, skipped: false };
    }
    const text = buf.subarray(0, last).toString('utf8');
    return { lines: text.split('\n').filter(Boolean), offset: offset + last + 1, skipped: false };
  } finally {
    fs.closeSync(fd);
  }
}

function tailLines(file) {
  const size = fileSizeOrZero(file);
  if (size === 0) {
    return [];
  }
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) {
      lines.shift();
    }
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

const parse = (line) => parseJson(line).value;

const int = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function firstTimestamp(lines) {
  for (const line of lines.slice(0, 5)) {
    const ts = parse(line)?.timestamp;
    if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) {
      return new Date(ts).toISOString();
    }
  }
  return null;
}

export function claudeUsage(lines, seenIds = []) {
  const seen = new Set(seenIds);
  const byId = new Map();
  let model = null;
  for (const line of lines) {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) {
      continue;
    }
    const o = parse(line);
    const msg = o?.type === 'assistant' ? o.message : null;
    const usage = msg?.usage;
    if (!usage || typeof usage !== 'object') {
      continue;
    }
    const id = msg.id ?? o.requestId ?? o.uuid;
    if (!id || seen.has(id)) {
      continue;
    }
    if (typeof msg.model === 'string' && msg.model && !msg.model.startsWith('<')) {
      model = msg.model;
    }
    const prev = byId.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    byId.set(id, {
      input: Math.max(prev.input, int(usage.input_tokens)),
      output: Math.max(prev.output, int(usage.output_tokens)),
      cacheRead: Math.max(prev.cacheRead, int(usage.cache_read_input_tokens)),
      cacheWrite: Math.max(prev.cacheWrite, int(usage.cache_creation_input_tokens)),
    });
  }
  let tokens = null;
  for (const u of byId.values()) {
    tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    tokens.input += u.input;
    tokens.output += u.output;
    tokens.cacheRead += u.cacheRead;
    tokens.cacheWrite += u.cacheWrite;
  }
  return { tokens, model, ids: [...byId.keys()], startedAt: firstTimestamp(lines) };
}

function codexCumulative(lines) {
  let latest = null;
  let model = null;
  for (const line of lines) {
    if (line.includes('"token_count"')) {
      const o = parse(line);
      const total = o?.type === 'event_msg' && o.payload?.type === 'token_count' ? o.payload.info?.total_token_usage : null;
      if (total && typeof total === 'object') {
        latest = {
          input: int(total.input_tokens),
          cached: int(total.cached_input_tokens),
          cacheWrite: int(total.cache_write_input_tokens),
          output: int(total.output_tokens),
        };
      }
    } else if (line.includes('"turn_context"')) {
      const o = parse(line);
      if (o?.type === 'turn_context' && typeof o.payload?.model === 'string') {
        model = o.payload.model;
      }
    }
  }
  return { latest, model };
}

export function codexBaseline(file) {
  return codexCumulative(tailLines(file)).latest;
}

export function codexUsage(lines, baseline) {
  const { latest, model } = codexCumulative(lines);
  if (!latest) {
    return { tokens: null, model, baseline, startedAt: firstTimestamp(lines) };
  }
  const base = baseline ?? { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  const reset = ['input', 'cached', 'cacheWrite', 'output'].some((k) => latest[k] < base[k]);
  const from = reset ? { input: 0, cached: 0, cacheWrite: 0, output: 0 } : base;
  const dInput = latest.input - from.input;
  const dCached = latest.cached - from.cached;
  return {
    tokens: {
      input: Math.max(0, dInput - dCached),
      output: latest.output - from.output,
      cacheRead: dCached,
      cacheWrite: latest.cacheWrite - from.cacheWrite,
    },
    model,
    baseline: latest,
    startedAt: firstTimestamp(lines),
  };
}

const AGENTS_FILE_HEADING = '# AGENTS.md instructions';

function isOnlyTaggedBlocks(text) {
  let at = 0;
  while (at < text.length) {
    if (text[at] !== '<') {
      return false;
    }
    const openEnd = text.indexOf('>', at);
    const name = openEnd === -1 ? '' : text.slice(at + 1, openEnd).split(/[\s/]/)[0];
    const close = name ? text.indexOf(`</${name}>`, openEnd) : -1;
    if (close === -1) {
      return false;
    }
    at = close + name.length + 3;
    while (at < text.length && /\s/.test(text[at])) {
      at += 1;
    }
  }
  return true;
}

const isInjectedContext = (text) => {
  const trimmed = text.trim();
  return trimmed.startsWith(AGENTS_FILE_HEADING) || isOnlyTaggedBlocks(trimmed);
};

const keepPersonText = (text) => !isInjectedContext(text);

const textOfBlocks = (content, keep = () => true) => {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) {
    return '';
  }
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string' && keep(block.text))
    .map((block) => block.text)
    .join('\n');
};

const PERSON = 'USER';
const ASSISTANT = 'ASSISTANT';

const SKIPPED_MESSAGE = { role: null, text: '' };
const CLAUDE_HIDDEN_FLAGS = ['isCompactSummary', 'isVisibleInTranscriptOnly', 'isSidechain'];

const isClaudeConversation = (line) => (line?.type === 'user' || line?.type === 'assistant') && line.isMeta !== true;

function claudeEntry(line) {
  if (isClaudeConversation(line) && CLAUDE_HIDDEN_FLAGS.some((flag) => line[flag] === true)) {
    return SKIPPED_MESSAGE;
  }
  const content = line?.message?.content;
  if (typeof content !== 'string' && !Array.isArray(content)) {
    return null;
  }
  if (line.type === 'user' && line.isMeta !== true && line.message.role === 'user') {
    return { role: PERSON, text: textOfBlocks(content, keepPersonText) };
  }
  if (line.type === 'assistant') {
    return { role: ASSISTANT, text: textOfBlocks(content) };
  }
  return null;
}

const CODEX_PARTS = new Map([
  ['user', { role: PERSON, type: 'input_text' }],
  ['assistant', { role: ASSISTANT, type: 'output_text' }],
]);
const isCodexConversation = (line) => line?.type === 'response_item' && line.payload?.type === 'message';
const CODEX_SKIPPED_ROLES = new Set(['developer', 'system']);

function codexEntry(line) {
  const payload = isCodexConversation(line) ? line.payload : null;
  if (payload && CODEX_SKIPPED_ROLES.has(payload.role)) {
    return SKIPPED_MESSAGE;
  }
  const part = payload ? CODEX_PARTS.get(payload.role) : undefined;
  if (!part || !Array.isArray(payload.content)) {
    return null;
  }
  const texts = payload.content
    .filter((item) => item?.type === part.type && typeof item.text === 'string' && (part.role !== PERSON || keepPersonText(item.text)))
    .map((item) => item.text);
  return { role: part.role, text: texts.join('\n') };
}

const sumWindowTokens = (tokens) => (tokens ? tokens.input + tokens.output + tokens.cacheWrite : 0);

function readTranscriptTail(file) {
  return readNewLines(file, Math.max(0, fileSizeOrZero(file) - MAX_READ_BYTES)).lines;
}

function hostVersionOf(host, line) {
  const codexVersion = line?.type === 'session_meta' ? line.payload?.cli_version : undefined;
  const version = host === 'codex' ? codexVersion : line?.version;
  return typeof version === 'string' && /^[\w.+-]{1,40}$/.test(version) ? version : null;
}

export function readSessionWindow(host, file, { from, to }) {
  const before = [];
  const inside = [];
  const entries = [];
  const entryOf = host === 'codex' ? codexEntry : claudeEntry;
  const isConversation = host === 'codex' ? isCodexConversation : isClaudeConversation;
  let messages = 0;
  let conversation = 0;
  let hostVersion = null;
  for (const line of readTranscriptTail(file)) {
    const parsed = parse(line);
    hostVersion = hostVersionOf(host, parsed) ?? hostVersion;
    const at = Date.parse(parsed?.timestamp);
    if (!Number.isFinite(at) || at > to) {
      continue;
    }
    if (at <= from) {
      before.push(line);
      continue;
    }
    inside.push(line);
    conversation += isConversation(parsed) ? 1 : 0;
    const entry = entryOf(parsed);
    messages += entry ? 1 : 0;
    if (entry?.text.trim()) {
      entries.push({ at, ...entry });
    }
  }
  const tokens = sumWindowTokens(host === 'codex' ? codexUsage(inside, codexUsage(before, null).baseline).tokens : claudeUsage(inside).tokens);
  const isUnreadable = messages === 0 && (tokens > 0 || conversation > 0);
  return { entries, tokens, isUnreadable, hostVersion };
}
