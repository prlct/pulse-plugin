#!/usr/bin/env node
import { State } from './lib/state.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  process.stderr.write(`Pulse needs Node.js 20 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}

const writeToStderr = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);
Object.assign(console, { log: writeToStderr, info: writeToStderr, warn: writeToStderr, debug: writeToStderr });

const { serveStdio } = await import('./lib/mcp.mjs');
const { logError } = await import('./lib/util.mjs');
const state = new State();
const CRASH_EXIT_CODE = 1;
const exitAfterLogging = (label) => (err) => {
  logError(state.home, label, err);
  process.exit(CRASH_EXIT_CODE);
};
process.on('uncaughtException', exitAfterLogging('mcp uncaught exception; the server exits'));
process.on('unhandledRejection', exitAfterLogging('mcp unhandled rejection; the server exits'));
await serveStdio({ state, signals: process });
process.exit(0);
