import crypto from 'node:crypto';
import path from 'node:path';

import { homeDir, quoteForCmd, urlOrNull } from './util.mjs';

export const MEDIA_TOOLS = { playwright: '1.63.0' };
export const MERMAID_BUNDLE = {
  version: '12.2.0',
  url: 'https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.min.js',
  sha256: 'a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f',
  maxBytes: 10 * 1024 * 1024,
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_WAIT_MS = 10_000;
const STEPS_MAX = 100;
const SELECTOR_MAX = 500;
const FILL_VALUE_MAX = 2000;
const VIEWPORT_DEFAULT = { width: 1280, height: 800 };
const VIEWPORT_LIMITS = { width: [320, 3840], height: [240, 2160] };
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SCREENSHOT_NAME = /^[a-z0-9-]{1,60}$/;
const KEY_NAME = /^[A-Za-z0-9+]{1,40}$/;
const SPEC_KEYS = new Set(['baseUrl', 'outDir', 'viewport', 'record', 'signIn', 'steps']);
const ERROR_PAGE_PROTOCOL = 'chrome-error:';
const BLANK_PAGE = 'about:blank';

export const mediaToolsDir = (env = process.env) => path.join(homeDir(env), 'media-tools');

export const mediaBrowsersDir = (env = process.env) => path.join(mediaToolsDir(env), 'browsers');

export const mermaidBundleFile = (env = process.env) => path.join(mediaToolsDir(env), `mermaid-${MERMAID_BUNDLE.version}.min.js`);

export const isPinnedMermaid = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex') === MERMAID_BUNDLE.sha256;

export const RECORDING_NAME = 'recording.webm';

export function npmCommand(args, { platform = process.platform, execPath = process.execPath, exists }) {
  if (platform !== 'win32') {
    return { command: 'npm', args, shell: false };
  }
  const npmCli = path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (exists(npmCli)) {
    return { command: execPath, args: [npmCli, ...args], shell: false };
  }
  return { command: 'npm.cmd', args: args.map(quoteForCmd), shell: true };
}

export class SpecError extends Error {}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function requireText(value, label, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new SpecError(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

const isLoopbackUrl = (url) => LOOPBACK_HOSTS.has(url.hostname);

function parseBaseUrl(value, allowRemote) {
  const url = urlOrNull(requireText(value, 'baseUrl', 2000));
  if (!url) {
    throw new SpecError('baseUrl must be a full URL, for example http://localhost:3000.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SpecError('baseUrl must start with http:// or https://.');
  }
  if (!allowRemote && !isLoopbackUrl(url)) {
    throw new SpecError('baseUrl must be on this computer (localhost, 127.0.0.1 or [::1]). Pass --allow-remote only when the user asked to capture another server.');
  }
  return url;
}

function parseViewport(value) {
  if (value === undefined) {
    return VIEWPORT_DEFAULT;
  }
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== 'width' && key !== 'height')) {
    throw new SpecError('viewport must be { "width": number, "height": number }.');
  }
  for (const [side, [min, max]] of Object.entries(VIEWPORT_LIMITS)) {
    if (!Number.isInteger(value[side]) || value[side] < min || value[side] > max) {
      throw new SpecError(`viewport.${side} must be a whole number from ${min} to ${max}.`);
    }
  }
  return { width: value.width, height: value.height };
}

const STEP_PARSERS = {
  goto: (value, { baseUrl }) => {
    const target = urlOrNull(requireText(value, 'goto', 2000), baseUrl);
    if (!target || target.origin !== baseUrl.origin) {
      throw new SpecError(`goto ${value} leaves ${baseUrl.origin}. Use paths on baseUrl only.`);
    }
    return target.href;
  },
  click: (value) => requireText(value, 'click', SELECTOR_MAX),
  fill: (value) => {
    if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'selector,value') {
      throw new SpecError('fill must be { "selector": string, "value": string }.');
    }
    if (typeof value.value !== 'string' || value.value.length > FILL_VALUE_MAX) {
      throw new SpecError(`fill.value must be a string of at most ${FILL_VALUE_MAX} characters.`);
    }
    return { selector: requireText(value.selector, 'fill.selector', SELECTOR_MAX), value: value.value };
  },
  press: (value) => {
    if (typeof value !== 'string' || !KEY_NAME.test(value)) {
      throw new SpecError('press must be a key name such as Enter, Tab or Control+A.');
    }
    return value;
  },
  waitFor: (value) => requireText(value, 'waitFor', SELECTOR_MAX),
  wait: (value) => {
    if (!Number.isInteger(value) || value < 0 || value > MAX_WAIT_MS) {
      throw new SpecError(`wait must be a whole number of milliseconds from 0 to ${MAX_WAIT_MS}.`);
    }
    return value;
  },
  screenshot: (value, { names }) => {
    if (typeof value !== 'string' || !SCREENSHOT_NAME.test(value)) {
      throw new SpecError('screenshot must be a name of lowercase letters, digits and dashes.');
    }
    if (names.has(value)) {
      throw new SpecError(`screenshot name ${value} is used twice.`);
    }
    names.add(value);
    return value;
  },
};

export const STEP_KINDS = Object.keys(STEP_PARSERS);

function parseStep(step, label, context) {
  const keys = isPlainObject(step) ? Object.keys(step) : [];
  if (keys.length !== 1 || !Object.hasOwn(STEP_PARSERS, keys[0])) {
    throw new SpecError(`${label} must have exactly one of: ${STEP_KINDS.join(', ')}.`);
  }
  const [kind] = keys;
  return { kind, value: STEP_PARSERS[kind](step[kind], context) };
}

function parseSignIn(value, context) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SpecError('signIn must be a list of steps.');
  }
  const steps = value.map((step, index) => parseStep(step, `signIn[${index}]`, context));
  if (steps.some((step) => step.kind === 'screenshot')) {
    throw new SpecError('signIn takes no screenshots: it runs before the recording starts. Move screenshot steps to steps.');
  }
  return steps;
}

export function parseCaptureSpec(raw, { specDir, allowRemote = false }) {
  if (!isPlainObject(raw)) {
    throw new SpecError('The capture spec must be a JSON object.');
  }
  const unknown = Object.keys(raw).filter((key) => !SPEC_KEYS.has(key));
  if (unknown.length > 0) {
    throw new SpecError(`Unknown keys in the capture spec: ${unknown.join(', ')}.`);
  }
  if (raw.record !== undefined && typeof raw.record !== 'boolean') {
    throw new SpecError('record must be true or false.');
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length + (Array.isArray(raw.signIn) ? raw.signIn.length : 0) > STEPS_MAX) {
    throw new SpecError(`steps must be a list of 1 to ${STEPS_MAX} steps, signIn included.`);
  }
  const baseUrl = parseBaseUrl(raw.baseUrl, allowRemote);
  const context = { baseUrl, names: new Set() };
  const signIn = parseSignIn(raw.signIn, context);
  const steps = raw.steps.map((step, index) => parseStep(step, `steps[${index}]`, context));
  if (!raw.record && context.names.size === 0) {
    throw new SpecError('The spec makes nothing: add a screenshot step or set record to true.');
  }
  return {
    baseUrl,
    outDir: path.resolve(specDir, requireText(raw.outDir, 'outDir', 1000)),
    viewport: parseViewport(raw.viewport),
    record: raw.record === true,
    signIn,
    steps,
  };
}

export function classifyNavigation(url, allowedOrigin) {
  if (url === BLANK_PAGE) {
    return 'stay';
  }
  const parsed = urlOrNull(url);
  if (parsed?.protocol === ERROR_PAGE_PROTOCOL) {
    return 'error-page';
  }
  return parsed?.origin === allowedOrigin ? 'stay' : 'leave';
}

export const describeDestination = (url) => {
  const parsed = urlOrNull(url);
  return parsed && parsed.origin !== 'null' ? parsed.origin : url.slice(0, 200);
};

export const captureOutputs = (spec) => [
  ...spec.steps.filter((step) => step.kind === 'screenshot').map((step) => path.join(spec.outDir, `${step.value}.png`)),
  ...(spec.record ? [path.join(spec.outDir, RECORDING_NAME)] : []),
];

export const MEDIA_TYPES = {
  '.png': { mime: 'image/png', maxBytes: MAX_IMAGE_BYTES },
  '.webm': { mime: 'video/webm', maxBytes: MAX_VIDEO_BYTES },
};

export const DIAGRAM_ASPECT = { min: 0.6, max: 2.5 };

const DIAGRAM_SHAPE_FIXES = {
  wide: 'switch flowchart LR to flowchart TB',
  tall: 'switch flowchart TB or TD to flowchart LR',
};

const isPositiveSize = (value) => Number.isFinite(value) && value > 0;

export function checkDiagramShape({ width, height }) {
  if (!isPositiveSize(width) || !isPositiveSize(height)) {
    throw new SpecError('Mermaid drew an empty diagram, so its size could not be measured. No PNG was written. Check that the source declares a diagram type and at least one node.');
  }
  const ratio = width / height;
  if (ratio >= DIAGRAM_ASPECT.min && ratio <= DIAGRAM_ASPECT.max) {
    return ratio;
  }
  const shape = ratio > DIAGRAM_ASPECT.max ? 'wide' : 'tall';
  const limit = shape === 'wide' ? `wider than ${DIAGRAM_ASPECT.max}:1` : `narrower than ${DIAGRAM_ASPECT.min}:1`;
  throw new SpecError(
    `The diagram is ${Math.round(width)}x${Math.round(height)} (${ratio.toFixed(2)}:1), ${limit}, so it is unreadable in the Pulse feed. No PNG was written. Fix the source and run it again: ${DIAGRAM_SHAPE_FIXES[shape]}, split it into two diagrams, or keep about 10 nodes.`,
  );
}

export function checkMediaSize(file, bytes) {
  const type = MEDIA_TYPES[path.extname(file)];
  if (bytes > type.maxBytes) {
    throw new SpecError(`${path.basename(file)} is ${bytes} bytes, more than Pulse accepts (${type.maxBytes}). Use a smaller viewport or fewer steps.`);
  }
  return { path: file, mime: type.mime, bytes };
}
