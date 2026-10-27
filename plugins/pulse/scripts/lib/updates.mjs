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
    after: 'then run /reload-plugins or restart Claude Code',
    autoUpdate: '/plugin → Marketplaces → pulse → Enable auto-update',
  },
  codex: {
    label: 'Codex',
    command: 'codex plugin marketplace upgrade pulse',
    after: 'then start a new Codex session',
  },
};

const findUpdateCommands = (host) => (typeof host === 'string' && Object.hasOwn(UPDATE_COMMANDS, host) ? UPDATE_COMMANDS[host] : null);

export function updateLines(host) {
  const hosts = findUpdateCommands(host) ? [host] : ['claude', 'codex'];
  const lines = [];
  for (const h of hosts) {
    const c = UPDATE_COMMANDS[h];
    const who = hosts.length > 1 ? `${c.label}: ` : '';
    lines.push(`${who}run in a terminal: ${c.command} — ${c.after}.`);
    if (c.autoUpdate) {
      lines.push(`${hosts.length > 1 ? `${c.label}: turn` : 'Turn'} on auto-update: ${c.autoUpdate}.`);
    }
  }
  return lines;
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

export function versionLines(state, apiUrl, host) {
  const u = pluginUpdate(state, apiUrl);
  const lines = [`Plugin version: ${u.version}`];
  if (u.updateAvailable) {
    const head = `Update available${u.latestVersion ? `: ${u.latestVersion}` : ''}.`;
    const [first, ...rest] = updateLines(host);
    lines.push(...(findUpdateCommands(host) ? [`${head} To update, ${first}`, ...rest] : [`${head} To update:`, first, ...rest]));
  }
  if (u.outdated) {
    lines.push('Uploads are paused until you update: this plugin version is too old for Pulse. Recorded events wait on this computer and upload after the update.');
    if (u.message) {
      lines.push(`Pulse says: "${u.message.replace(/"/g, "'")}"`);
    }
  }
  return { lines, update: u };
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
    ? `Pulse plugin ${u.version} is too old for Pulse: uploads are paused until you update${u.latestVersion ? ` to ${u.latestVersion}` : ''}.`
    : `Pulse plugin ${u.latestVersion ?? 'update'} is available (installed: ${u.version}).`;
  const [first, ...rest] = updateLines(host);
  return [head, findUpdateCommands(host) ? `To update, ${first}` : `To update: ${first}`, ...rest].join(' ');
}
