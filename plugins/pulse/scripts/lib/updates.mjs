import { PLUGIN_VERSION, plain } from './util.mjs';

const VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
export const NOTICE_EVERY_MS = 24 * 60 * 60 * 1000;
const OUTDATED_MESSAGE_MAX = 300;

export function compareVersions(a, b) {
  const x = VERSION_RE.exec(String(a ?? ''));
  const y = VERSION_RE.exec(String(b ?? ''));
  if (!x || !y) {
    return null;
  }
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return 0;
}

const validVersion = (v) => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);

export const UPDATE_COMMANDS = {
  claude: {
    label: 'Claude Code',
    command: 'claude plugin marketplace update pulse && claude plugin update pulse@pulse',
    after: 'Then run /reload-plugins in each open Claude Code session, or restart them. Open sessions keep the old plugin.',
  },
  codex: {
    label: 'Codex',
    command: 'codex plugin marketplace upgrade pulse',
    after: 'Then restart each open Codex session, because open sessions keep the old plugin. When Codex starts, accept the Pulse hooks.',
  },
};

export const updateCommandFor = (host) => (typeof host === 'string' && Object.hasOwn(UPDATE_COMMANDS, host) ? UPDATE_COMMANDS[host].command : null);

export const UPDATE_COPIED = 'Copied to your clipboard: the update command.';

export function updateLines(host, { copied = false } = {}) {
  if (!updateCommandFor(host)) {
    return Object.values(UPDATE_COMMANDS).map((c) => `${c.label}: run in a terminal: ${c.command}. ${c.after}`);
  }
  const c = UPDATE_COMMANDS[host];
  return [
    `Assistant: ask the user "Pulse has an update. Update now?" On yes, run this command in a terminal: ${c.command}. Then tell the user: "${c.after}"`,
    ...(copied ? [UPDATE_COPIED] : []),
  ];
}

export async function notePluginInfo(state, apiUrl, block, now = Date.now()) {
  if (!block || typeof block !== 'object') {
    return;
  }
  const info = {
    latestVersion: validVersion(block.latestVersion),
    minVersion: validVersion(block.minVersion),
    updateAvailable: block.updateAvailable === true,
    outdated: block.outdated === true,
    version: PLUGIN_VERSION,
    fetchedAt: now,
  };
  await state.setStatus(apiUrl, (s) => {
    const next = { ...s, plugin: info };
    if (!info.outdated && next.uploadBlockedFor === PLUGIN_VERSION) {
      delete next.uploadBlockedFor;
      delete next.outdatedMessage;
    }
    return next;
  });
}

export async function noteOutdated(state, apiUrl, json, now = Date.now()) {
  await state.setStatus(apiUrl, (s) => ({
    ...s,
    uploadBlockedFor: PLUGIN_VERSION,
    outdatedMessage: typeof json?.message === 'string' ? plain(json.message, OUTDATED_MESSAGE_MAX) : null,
    plugin: {
      ...(s.plugin ?? {}),
      latestVersion: validVersion(json?.latestVersion) ?? s.plugin?.latestVersion ?? null,
      minVersion: validVersion(json?.minVersion) ?? s.plugin?.minVersion ?? null,
      outdated: true,
      updateAvailable: true,
      version: PLUGIN_VERSION,
      fetchedAt: now,
    },
  }));
}

export const uploadsBlocked = (state, apiUrl) => state.status(apiUrl).uploadBlockedFor === PLUGIN_VERSION;

export function pluginUpdate(state, apiUrl, version = PLUGIN_VERSION) {
  const s = state.status(apiUrl);
  const info = s.plugin ?? null;
  const sameVersion = info?.version === version;
  const behindLatest = compareVersions(version, info?.latestVersion);
  const belowMin = compareVersions(version, info?.minVersion);
  const outdated = (belowMin === null ? sameVersion && info?.outdated === true : belowMin < 0) || s.uploadBlockedFor === version;
  const updateAvailable = outdated || (behindLatest === null ? sameVersion && info?.updateAvailable === true : behindLatest < 0);
  return {
    version,
    latestVersion: validVersion(info?.latestVersion),
    minVersion: validVersion(info?.minVersion),
    updateAvailable,
    outdated,
    blocked: s.uploadBlockedFor === version,
    message: s.uploadBlockedFor === version && typeof s.outdatedMessage === 'string' ? plain(s.outdatedMessage, OUTDATED_MESSAGE_MAX) : null,
  };
}

export function versionLines(update, host, { copied = false } = {}) {
  const lines = [`Plugin version: ${update.version}`];
  if (update.updateAvailable) {
    lines.push(`Pulse has an update${update.latestVersion ? `: ${update.latestVersion}` : ''}.`, ...updateLines(host, { copied }));
  }
  if (update.outdated) {
    lines.push('This version is too old for Pulse: nothing is sent until you update. What was recorded waits on this computer.');
    if (update.message) {
      lines.push(`Pulse says: "${update.message.replace(/"/g, "'")}"`);
    }
  }
  return lines;
}

export async function sessionNotice(state, apiUrl, host, now = Date.now()) {
  const u = pluginUpdate(state, apiUrl);
  if (!u.updateAvailable) {
    return null;
  }
  const last = state.status(apiUrl).updateNoticeAt?.[host] ?? 0;
  if (now - last < NOTICE_EVERY_MS) {
    return null;
  }
  await state.setStatus(apiUrl, (s) => ({ ...s, updateNoticeAt: { ...(s.updateNoticeAt ?? {}), [host]: now } }));
  const head = u.outdated
    ? `Pulse ${u.version} is too old: nothing is sent to Pulse until you update.`
    : `Pulse has an update${u.latestVersion ? `: ${u.latestVersion}` : ''}.`;
  const command = updateCommandFor(host);
  return command ? `${head} Ask your assistant to update Pulse, or run in a terminal: ${command}` : head;
}
