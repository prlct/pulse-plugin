import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runUnlessBusy } from './state.mjs';
import { compareVersions } from './updates.mjs';
import { isUnreadablePath } from './util.mjs';

const CACHE_FILE = 'report-cli.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_SHELL_TIMEOUT_MS = 3_000;
const LOGIN_SHELL_OUTPUT_MAX = 64 * 1024;
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash'];
const BINARIES = { claude: 'claude', codex: 'codex' };
const APP_CLIS = {
  claude: (homeDir) => [path.join(homeDir, '.claude', 'local', 'claude')],
  codex: () => [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ],
};

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) {
      return false;
    }
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (err) {
    if (isUnreadablePath(err)) {
      return false;
    }
    throw err;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if (isUnreadablePath(err)) {
      return [];
    }
    throw err;
  }
}

function askLoginShell(shell, bin, env) {
  return new Promise((resolve, reject) => {
    let output = '';
    let timer = null;
    let settled = false;
    const child = spawn(shell, ['-ilc', `command -v ${bin}`], {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const done = (value, timedOut = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.unref();
      if (timedOut && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (err) {
          if (err.code !== 'ESRCH') {
            reject(err);
            return;
          }
        }
      }
      resolve(value);
    };
    timer = setTimeout(() => done('', true), LOGIN_SHELL_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-LOGIN_SHELL_OUTPUT_MAX);
    });
    child.on('error', () => done(''));
    child.on('exit', () => {
      clearTimeout(timer);
      setImmediate(() => done(output));
    });
    child.on('close', () => done(output));
  });
}

export const buildSystem = (env) => ({
  env,
  homeDir: os.homedir(),
  execPath: process.execPath,
  isExecutable: isExecutableFile,
  listDir,
  askLoginShell,
});

const inDirs = (dirs, bin) => dirs.filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, bin));

function nvmCandidates(system, bin) {
  const root = path.join(system.homeDir, '.nvm', 'versions', 'node');
  const versions = system
    .listDir(root)
    .filter((name) => compareVersions(name.replace(/^v/, ''), '0.0.0') !== null)
    .sort((a, b) => compareVersions(b.replace(/^v/, ''), a.replace(/^v/, '')));
  return versions.map((version) => path.join(root, version, 'bin', bin));
}

function knownCandidates(system, host, bin) {
  const home = system.homeDir;
  const dirs = [
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return [...nvmCandidates(system, bin), ...inDirs(dirs, bin), ...APP_CLIS[host](home)];
}

async function fromLoginShell(system, bin) {
  const shell = [system.env.SHELL, ...FALLBACK_SHELLS].find(
    (candidate) => typeof candidate === 'string' && path.isAbsolute(candidate) && system.isExecutable(candidate),
  );
  if (!shell) {
    return null;
  }
  const lines = (await system.askLoginShell(shell, bin, system.env))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const found = lines.at(-1);
  return found && path.isAbsolute(found) && system.isExecutable(found) ? found : null;
}

export async function locateCli(host, system) {
  const bin = BINARIES[host];
  const fromPath = inDirs(String(system.env.PATH ?? '').split(path.delimiter), bin).find(system.isExecutable);
  if (fromPath) {
    return fromPath;
  }
  const nextToNode = path.join(path.dirname(system.execPath), bin);
  if (system.isExecutable(nextToNode)) {
    return nextToNode;
  }
  return (await fromLoginShell(system, bin)) ?? knownCandidates(system, host, bin).find(system.isExecutable) ?? null;
}

export async function findReportCli(state, host, system, now = Date.now()) {
  const cached = state.read(CACHE_FILE, {})?.[host];
  if (
    typeof cached?.path === 'string' &&
    Number.isFinite(cached.at) &&
    now >= cached.at &&
    now - cached.at < CACHE_TTL_MS &&
    system.isExecutable(cached.path)
  ) {
    return cached.path;
  }
  const found = await locateCli(host, system);
  if (found) {
    await runUnlessBusy(state, 'the report command path was not cached; the next report looks it up again', () =>
      state.update(CACHE_FILE, (all) => ({ ...all, [host]: { path: found, at: now } })),
    );
  }
  return found;
}

export function buildChildPath(cliPath, system) {
  const dirs = [path.dirname(cliPath), path.dirname(system.execPath)];
  return [
    ...new Set([
      ...dirs,
      ...String(system.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean),
    ]),
  ].join(path.delimiter);
}
