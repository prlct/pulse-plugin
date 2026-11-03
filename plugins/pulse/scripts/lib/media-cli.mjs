import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { drawScreenshotAnnotations } from './media-annotations.mjs';
import {
  MEDIA_TOOLS,
  MERMAID_BUNDLE,
  RECORDING_NAME,
  SpecError,
  captureOutputs,
  checkDiagramShape,
  checkMediaSize,
  classifyNavigation,
  describeDestination,
  isPinnedMermaid,
  mediaBrowsersDir,
  mediaToolsDir,
  mermaidBundleFile,
  npmCommand,
  parseCaptureSpec,
  screenshotPath,
} from './media.mjs';
import { atomicWrite, ensureDir, parseJson, readTextOrNull, unlessUnreadable, urlOrNull } from './util.mjs';

const DIAGRAM_SOURCE_MAX = 50_000;
const DIAGRAM_VIEWPORT = { width: 1600, height: 1200 };
const DIAGRAM_SCALE = 2;
const DIAGRAM_BACKGROUND = '#f6f3ef';
const DIAGRAM_MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  themeVariables: {
    background: DIAGRAM_BACKGROUND,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: '16px',
    primaryColor: '#ffffff',
    primaryTextColor: '#1d1b18',
    primaryBorderColor: '#d3cbbf',
    secondaryColor: '#ffffff',
    tertiaryColor: '#efeae2',
    lineColor: '#c2185b',
    textColor: '#1d1b18',
    clusterBkg: '#efeae2',
    clusterBorder: '#e2dbd1',
    titleColor: '#1d1b18',
    edgeLabelBackground: DIAGRAM_BACKGROUND,
  },
};
const STEP_TIMEOUT_MS = 15_000;
const USAGE = [
  'Usage:',
  '  node pulse.mjs media setup                      install Playwright and Mermaid into the Pulse folder',
  '  node pulse.mjs media diagram <in.mmd> <out.png>  render a Mermaid diagram to PNG',
  '  node pulse.mjs media capture <spec.json> [--allow-remote]  take screenshots or a screen recording',
  '  --allow-remote lets baseUrl be another server; the page still may not leave it.',
].join('\n');

class MediaError extends Error {}

const toolsDir = mediaToolsDir();
const browsersDir = mediaBrowsersDir();
const mermaidFile = mermaidBundleFile();
const SETUP_HINT = `Run: node "${process.argv[1]}" media setup`;

function installedVersion(name) {
  const manifest = parseJson(readTextOrNull(path.join(toolsDir, 'node_modules', name, 'package.json')) ?? '');
  return manifest.ok ? manifest.value.version : null;
}

const packagesReady = () => Object.entries(MEDIA_TOOLS).every(([name, version]) => installedVersion(name) === version);

const mermaidReady = () => {
  const bytes = unlessUnreadable(() => fs.readFileSync(mermaidFile), null);
  return bytes !== null && isPinnedMermaid(bytes);
};

function requireMermaid() {
  if (!mermaidReady()) {
    throw new MediaError(`Mermaid for diagrams is not installed. ${SETUP_HINT}`);
  }
}

function loadPlaywright() {
  if (!packagesReady()) {
    throw new MediaError(`The media tools are not installed. ${SETUP_HINT}`);
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;
  const playwright = createRequire(path.join(toolsDir, 'package.json'))('playwright');
  if (!fs.existsSync(playwright.chromium.executablePath())) {
    throw new MediaError(`The browser for the media tools is not installed. ${SETUP_HINT}`);
  }
  return playwright;
}

function runToStderr({ command, args, shell }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: toolsDir,
      stdio: ['ignore', 2, 2],
      shell,
      windowsHide: true,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir },
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new MediaError(`${path.basename(command)} ${args[0]} failed with exit code ${code}.`))));
  });
}

async function downloadMermaid() {
  const response = await fetch(MERMAID_BUNDLE.url);
  if (!response.ok) {
    throw new MediaError(`Mermaid ${MERMAID_BUNDLE.version} could not be downloaded from ${MERMAID_BUNDLE.url}: HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MERMAID_BUNDLE.maxBytes || !isPinnedMermaid(bytes)) {
    throw new MediaError(`The Mermaid file from ${MERMAID_BUNDLE.url} does not match the pinned ${MERMAID_BUNDLE.version} build. Nothing was installed.`);
  }
  atomicWrite(mermaidFile, bytes);
}

async function setup() {
  ensureDir(toolsDir);
  if (!packagesReady()) {
    const packages = Object.entries(MEDIA_TOOLS).map(([name, version]) => `${name}@${version}`);
    const installArgs = ['install', '--ignore-scripts', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--prefix', toolsDir, ...packages];
    await runToStderr(npmCommand(installArgs, { exists: fs.existsSync }));
  }
  if (!mermaidReady()) {
    await downloadMermaid();
  }
  await runToStderr({ command: process.execPath, args: [path.join(toolsDir, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], shell: false });
  return { toolsDir, browsersDir, ...MEDIA_TOOLS, mermaid: MERMAID_BUNDLE.version };
}

function producedFile(file) {
  return checkMediaSize(file, fs.statSync(file).size);
}

function removeAndRethrow(file, err) {
  fs.rmSync(file, { force: true });
  throw err;
}

function requireNewPng(file) {
  if (path.extname(file) !== '.png') {
    throw new MediaError('The diagram output must be a .png file.');
  }
  const out = path.resolve(file);
  if (fs.existsSync(out)) {
    throw new MediaError(`${file} already exists. Pick a new output file.`);
  }
  return out;
}

export async function diagram(input, output) {
  if (!input || !output) {
    throw new MediaError(USAGE);
  }
  const source = readTextOrNull(path.resolve(input));
  if (source === null || source.trim() === '' || source.length > DIAGRAM_SOURCE_MAX) {
    throw new MediaError(`${input} must be a readable Mermaid file of at most ${DIAGRAM_SOURCE_MAX} characters.`);
  }
  const out = requireNewPng(output);
  requireMermaid();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: DIAGRAM_VIEWPORT, deviceScaleFactor: DIAGRAM_SCALE, javaScriptEnabled: true });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin:0;padding:24px;background:${DIAGRAM_BACKGROUND};display:inline-block"><div id="diagram"></div></body></html>`);
    await page.addScriptTag({ path: mermaidFile });
    const rendered = await page.evaluate(async ({ text, config }) => {
      try {
        globalThis.mermaid.initialize(config);
        const { svg } = await globalThis.mermaid.render('pulse-diagram', text);
        document.querySelector('#diagram').innerHTML = svg;
        const svgElement = document.querySelector('#diagram svg');
        const viewBox = svgElement.viewBox.baseVal;
        const drawn = viewBox && viewBox.width > 0 && viewBox.height > 0 ? viewBox : svgElement.getBBox();
        svgElement.setAttribute('width', String(drawn.width));
        svgElement.setAttribute('height', String(drawn.height));
        svgElement.style.maxWidth = 'none';
        if (!(drawn.width > 0 && drawn.height > 0)) {
          return { box: { width: 0, height: 0 } };
        }
        const { width, height } = document.body.getBoundingClientRect();
        return { box: { width, height } };
      } catch (err) {
        return { failure: err instanceof Error ? err.message : String(err) };
      }
    }, { text: source, config: DIAGRAM_MERMAID_CONFIG });
    if (rendered.failure) {
      throw new MediaError(`Mermaid could not render ${input}: ${rendered.failure.slice(0, 500)}`);
    }
    checkDiagramShape(rendered.box);
    ensureDir(path.dirname(out));
    try {
      await page.locator('body').screenshot({ path: out, omitBackground: false });
    } catch (err) {
      removeAndRethrow(out, err);
    }
  } finally {
    await browser.close();
  }
  try {
    return { files: [producedFile(out)] };
  } catch (err) {
    return removeAndRethrow(out, err);
  }
}

const STEP_HANDLERS = {
  goto: (page, url) => page.goto(url, { waitUntil: 'load' }),
  click: (page, selector) => page.click(selector),
  fill: (page, { selector, value }) => page.fill(selector, value),
  press: (page, key) => page.keyboard.press(key),
  waitFor: (page, selector) => page.waitForSelector(selector, { state: 'visible' }),
  wait: (page, ms) => page.waitForTimeout(ms),
  screenshot: async (page, { name }, run) => {
    const file = screenshotPath(run.outDir, name);
    run.files.push(file);
    await page.screenshot({ path: file, fullPage: false });
  },
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const messageOf = (err) => (err instanceof Error ? err.message.split('\n')[0] : String(err));

const toError = (err) => (err instanceof Error ? err : new MediaError(String(err)));

const isTopLevelNavigation = (request) => request.isNavigationRequest() && request.frame().parentFrame() === null;

function noteLoadFailure(run, url, err) {
  run.loadFailure = { url: url.slice(0, 200), message: messageOf(err) };
}

function noteDeparture(run, url, isBlocked) {
  run.departure ??= { destination: describeDestination(url), isBlocked };
}

function redirectTarget(response, from) {
  const location = response.headers().location;
  if (!REDIRECT_STATUSES.has(response.status()) || !location) {
    return null;
  }
  return urlOrNull(location, from)?.href ?? location;
}

async function fetchWithoutRedirects(route) {
  try {
    return { response: await route.fetch({ maxRedirects: 0 }) };
  } catch (err) {
    if (err instanceof Error) {
      return { failure: err };
    }
    throw err;
  }
}

export async function guardNavigation(route, origin, run) {
  const request = route.request();
  if (!isTopLevelNavigation(request)) {
    return route.continue();
  }
  if (classifyNavigation(request.url(), origin) === 'leave') {
    noteDeparture(run, request.url(), true);
    return route.abort('blockedbyclient');
  }
  const { response, failure } = await fetchWithoutRedirects(route);
  if (failure) {
    noteLoadFailure(run, request.url(), failure);
    return route.abort('failed');
  }
  const target = redirectTarget(response, request.url());
  if (target && classifyNavigation(target, origin) === 'leave') {
    noteDeparture(run, target, true);
    return route.abort('blockedbyclient');
  }
  return route.fulfill({ response });
}

function watchMainFrame(page, origin, run) {
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && classifyNavigation(frame.url(), origin) === 'leave') {
      noteDeparture(run, frame.url(), false);
    }
  });
}

function requireStayed(origin, run) {
  if (run.routeError) {
    throw new MediaError(`Pulse could not check a page load: ${messageOf(run.routeError)}. It kept no files from this run.`, { cause: run.routeError });
  }
  if (!run.departure) {
    return;
  }
  const { destination, isBlocked } = run.departure;
  throw new MediaError(
    isBlocked
      ? `The page tried to open ${destination}, away from ${origin}. Pulse blocked it and kept no files from this run.`
      : `The page went to ${destination}, away from ${origin}. Pulse stopped the run and kept no files from this run.`,
  );
}

async function runSteps(page, steps, label, origin, run) {
  for (const [index, step] of steps.entries()) {
    try {
      await STEP_HANDLERS[step.kind](page, step.value, run);
    } catch (err) {
      requireStayed(origin, run);
      throw new MediaError(`${label} ${index + 1} (${step.kind}) failed: ${describeStepError(err, run)}`, { cause: err });
    }
    requireStayed(origin, run);
  }
}

function describeStepError(err, run) {
  const { loadFailure } = run;
  run.loadFailure = null;
  return loadFailure ? `${messageOf(err)} Pulse could not load ${loadFailure.url}: ${loadFailure.message}` : messageOf(err);
}

async function guardedContext(browser, spec, run, options) {
  const context = await browser.newContext({ viewport: spec.viewport, serviceWorkers: 'block', ...options });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  const guard = { isClosing: false };
  await context.route('**/*', (route) =>
    guardNavigation(route, spec.baseUrl.origin, run).catch((err) => {
      if (!guard.isClosing) {
        run.routeError ??= err;
      }
    }),
  );
  return { context, guard };
}

async function inContext({ context, guard }, origin, run, work) {
  const page = await context.newPage();
  watchMainFrame(page, origin, run);
  const outcome = await Promise.resolve()
    .then(() => work(page))
    .then(
      (value) => ({ ok: true, value }),
      (err) => ({ ok: false, error: toError(err) }),
    );
  guard.isClosing = true;
  try {
    await context.close();
  } catch (closeError) {
    if (outcome.ok) {
      throw closeError;
    }
    throw new MediaError(`${messageOf(outcome.error)} Closing the browser also failed: ${messageOf(closeError)}`, { cause: outcome.error });
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  requireStayed(origin, run);
  return { page, result: outcome.value };
}

async function signedInState(browser, spec, run) {
  if (spec.signIn.length === 0) {
    return {};
  }
  const signInContext = await guardedContext(browser, spec, run, {});
  const { result } = await inContext(signInContext, spec.baseUrl.origin, run, async (page) => {
    await runSteps(page, spec.signIn, 'Sign-in step', spec.baseUrl.origin, run);
    return signInContext.context.storageState({ indexedDB: true });
  });
  return { storageState: result };
}

async function saveRecording(page, run) {
  const video = page.video();
  if (!video) {
    return;
  }
  const file = path.join(run.outDir, RECORDING_NAME);
  run.files.push(file);
  await video.saveAs(file);
  await video.delete();
}

function refuseOverwrite(spec) {
  const existing = captureOutputs(spec).filter((file) => fs.existsSync(file));
  if (existing.length > 0) {
    throw new MediaError(`${existing.map((file) => path.basename(file)).join(', ')} already in ${spec.outDir}. Use a new, empty outDir.`);
  }
}

async function annotateScreenshots(browser, spec) {
  const annotated = spec.steps.filter((step) => step.kind === 'screenshot' && step.value.annotations.length > 0);
  if (annotated.length === 0) {
    return;
  }
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const pngPrefix = 'data:image/png;base64,';
    for (const { value: { name, annotations } } of annotated) {
      try {
        const file = screenshotPath(spec.outDir, name);
        const png = fs.readFileSync(file, 'base64');
        const rendered = await page.evaluate(drawScreenshotAnnotations, { png, annotations });
        if (!rendered.startsWith(pngPrefix)) {
          throw new MediaError('Chromium did not return a PNG.');
        }
        fs.writeFileSync(file, Buffer.from(rendered.slice(pngPrefix.length), 'base64'));
      } catch (err) {
        throw new MediaError(`Screenshot ${name} could not be annotated: ${messageOf(err)}`, { cause: err });
      }
    }
  } finally {
    await context.close();
  }
}

async function recordRun(chromium, spec, run) {
  const videoDir = spec.record ? fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-video-')) : null;
  const browser = await chromium.launch();
  try {
    const session = await signedInState(browser, spec, run);
    const recorded = await guardedContext(browser, spec, run, {
      ...session,
      ...(videoDir ? { recordVideo: { dir: videoDir, size: spec.viewport } } : {}),
    });
    const { page } = await inContext(recorded, spec.baseUrl.origin, run, (stepsPage) => runSteps(stepsPage, spec.steps, 'Step', spec.baseUrl.origin, run));
    if (videoDir) {
      await saveRecording(page, run);
    }
    await annotateScreenshots(browser, spec);
  } finally {
    await browser.close();
    if (videoDir) {
      fs.rmSync(videoDir, { recursive: true, force: true });
    }
  }
}

const loadChromium = () => loadPlaywright().chromium;

export async function capture(specFile, { allowRemote = false, browserType = loadChromium } = {}) {
  if (!specFile) {
    throw new MediaError(USAGE);
  }
  const parsed = parseJson(readTextOrNull(path.resolve(specFile)) ?? '');
  if (!parsed.ok) {
    throw new MediaError(`${specFile} must be a readable JSON file.`);
  }
  const spec = parseCaptureSpec(parsed.value, { specDir: path.dirname(path.resolve(specFile)), allowRemote });
  refuseOverwrite(spec);
  const chromium = browserType();
  ensureDir(spec.outDir);
  const run = { outDir: spec.outDir, files: [], departure: null, routeError: null, loadFailure: null };
  try {
    await recordRun(chromium, spec, run);
  } catch (err) {
    for (const file of run.files) {
      fs.rmSync(file, { force: true });
    }
    throw err;
  }
  return keepWithinLimits(run.files);
}

function keepWithinLimits(files) {
  const kept = [];
  const dropped = [];
  for (const file of files) {
    try {
      kept.push(producedFile(file));
    } catch (err) {
      if (!(err instanceof SpecError)) {
        throw err;
      }
      fs.rmSync(file, { force: true });
      dropped.push({ path: file, reason: err.message });
    }
  }
  return dropped.length > 0 ? { files: kept, dropped } : { files: kept };
}

const COMMANDS = {
  setup: () => setup(),
  diagram: ([input, output]) => diagram(input, output),
  capture: ([specFile], { allowRemote }) => capture(specFile, { allowRemote }),
};

export async function mediaMain(positional, options = { allowRemote: false }) {
  try {
    const [command, ...rest] = positional;
    if (!command || !Object.hasOwn(COMMANDS, command)) {
      throw new MediaError(USAGE);
    }
    process.stdout.write(`${JSON.stringify(await COMMANDS[command](rest, options))}\n`);
    return 0;
  } catch (err) {
    const isExpected = err instanceof MediaError || err instanceof SpecError;
    process.stderr.write(`${isExpected ? err.message : (err?.stack ?? String(err))}\n`);
    return 1;
  }
}
