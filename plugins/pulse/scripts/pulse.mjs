#!/usr/bin/env node
import { execute, loginListen } from './lib/commands.mjs';
import { hookMain } from './lib/hooks.mjs';
import { State } from './lib/state.mjs';
import { logError } from './lib/util.mjs';

const BOOLEAN_FLAGS = new Set(['yes', 'json', 'wait', 'no-wait', 'background', 'new-client', 'force']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = inline ?? argv[(i += 1)];
    if (name === 'project') {
      flags.project = [...(flags.project ?? []), value];
    } else {
      flags[name] = value;
    }
  }
  return { positional, flags };
}

async function run(argv, state) {
  const major = Number(process.versions.node.split('.')[0]);
  const args = parseArgs(argv);
  const [command = 'help', sub, value] = args.positional;

  if (command === 'hook') {
    if (major >= 20) {
      await hookMain(sub, value, { state });
    }
    return 0;
  }
  if (major < 20) {
    process.stdout.write(`Pulse needs Node.js 20 or newer (found ${process.versions.node}).\n`);
    return 1;
  }
  if (command === 'login-listen') {
    await loginListen(state);
    return 0;
  }

  const result = await execute({ state, args, options: { interactive: Boolean(process.stdin.isTTY) } });
  if (args.flags.background) {
    return 0;
  }
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: result.code === 0, ...(result.data ?? {}), text: result.lines.join('\n') })}\n`);
  } else {
    process.stdout.write(`${result.lines.join('\n')}\n`);
  }
  return result.code;
}

const state = new State();
run(process.argv.slice(2), state).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    logError(state.home, `pulse ${process.argv[2] === 'hook' ? 'hook' : 'command'} failed`, err);
    process.exitCode = process.argv[2] === 'hook' ? 0 : 1;
  },
);
