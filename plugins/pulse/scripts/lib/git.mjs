import fs from 'node:fs';
import path from 'node:path';

import { isUnreadablePath, readTextOrNull, realpathOr, urlOrNull } from './util.mjs';

const BRANCH_MAX = 200;
const REMOTE_MAX = 500;
const GITDIR_PREFIX = 'gitdir:';

function gitDirOf(dir) {
  const dotGit = path.join(dir, '.git');
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch (err) {
    if (isUnreadablePath(err)) {
      return null;
    }
    throw err;
  }
  if (stat.isDirectory()) {
    return dotGit;
  }
  if (stat.isFile()) {
    const line = fs.readFileSync(dotGit, 'utf8').split(/\r?\n/).find((l) => l.startsWith(GITDIR_PREFIX));
    const target = line?.slice(GITDIR_PREFIX.length).trim();
    return target ? path.resolve(dir, target) : null;
  }
  return null;
}

function findRepo(cwd) {
  let dir = realpathOr(cwd);
  for (;;) {
    const gitDir = gitDirOf(dir);
    if (gitDir) {
      const linkedWorktreeCommonDir = readTextOrNull(path.join(gitDir, 'commondir'));
      const commonDir = linkedWorktreeCommonDir === null ? gitDir : path.resolve(gitDir, linkedWorktreeCommonDir.trim());
      return { root: dir, gitDir, commonDir, worktree: commonDir !== gitDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function readBranch(gitDir) {
  const head = readTextOrNull(path.join(gitDir, 'HEAD'))?.trim() ?? '';
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return match && match[1].length <= BRANCH_MAX ? match[1] : null;
}

function readRemoteUrl(commonDir) {
  const text = readTextOrNull(path.join(commonDir, 'config'));
  if (text === null) {
    return null;
  }
  const remotes = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line);
    if (section) {
      current = { name: section[1], url: null };
      remotes.push(current);
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    const key = /^url\s*=/.exec(line);
    const value = key ? line.slice(key[0].length).trim() : '';
    if (current && value && !current.url) {
      current.url = value.replace(/^"(.*)"$/, '$1');
    }
  }
  const pick = remotes.find((r) => r.name === 'origin' && r.url) ?? remotes.find((r) => r.url);
  return pick ? pick.url : null;
}

export function sanitizeRemote(remote) {
  const value = String(remote ?? '').trim();
  if (!value || /\s/.test(value)) {
    return null;
  }
  if (value.includes('://')) {
    const url = urlOrNull(value);
    if (!url) {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) {
      return null;
    }
    url.password = '';
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      url.username = '';
    }
    url.search = '';
    url.hash = '';
    const out = url.toString();
    return out.length <= REMOTE_MAX ? out : null;
  }
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)./.exec(value);
  if (scp && !/^[a-zA-Z]$/.test(scp[1])) {
    return value.length <= REMOTE_MAX ? value : null;
  }
  return null;
}

function splitRemote(safe) {
  if (safe.includes('://')) {
    const url = new URL(safe);
    return { host: url.hostname, path: url.pathname };
  }
  const scp = /^(?:[\w.-]+@)?([\w.-]+):/.exec(safe);
  return { host: scp[1], path: safe.slice(scp[0].length) };
}

export function normalizeRemote(remote) {
  const safe = sanitizeRemote(remote);
  if (!safe) {
    return null;
  }
  const { host, path: p } = splitRemote(safe);
  const cleaned = p
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!cleaned) {
    return null;
  }
  return `${host.replace(/^www\./, '')}/${cleaned}`.toLowerCase();
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

export function githubRemote(remote) {
  const safe = sanitizeRemote(remote);
  if (!safe) {
    return null;
  }
  const { host, path: p } = splitRemote(safe);
  if (!GITHUB_HOSTS.has(host.toLowerCase())) {
    return null;
  }
  const m = /^\/*([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/*$/.exec(p);
  if (!m || /^\.+$/.test(m[2])) {
    return null;
  }
  return `https://github.com/${m[1]}/${m[2]}`;
}

export function safeBranch(branch) {
  const value = typeof branch === 'string' ? branch : '';
  if (!/^[\w.\/@+-]{1,200}$/.test(value) || value.includes('..') || value.startsWith('-')) {
    return null;
  }
  return value;
}

function shortRepoName(normalized) {
  if (!normalized) {
    return null;
  }
  const parts = normalized.split('/');
  return parts.length >= 3 ? parts.slice(-2).join('/') : parts.slice(1).join('/');
}

export function repoContext(cwd) {
  const repo = findRepo(cwd);
  if (!repo) {
    const dir = realpathOr(cwd);
    return { kind: 'dir', key: dir, root: dir, remote: null, remoteKey: null, branch: null, worktree: false };
  }
  const rawRemote = readRemoteUrl(repo.commonDir);
  return {
    kind: 'git',
    key: repo.root,
    root: repo.root,
    remote: githubRemote(rawRemote),
    remoteKey: normalizeRemote(rawRemote),
    branch: readBranch(repo.gitDir),
    worktree: repo.worktree,
  };
}

export function repoLabel(ctx) {
  if (ctx.kind === 'dir') {
    return ctx.root;
  }
  return shortRepoName(ctx.remoteKey) ?? path.basename(ctx.root);
}
