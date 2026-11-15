import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBoard } from '../src/board.ts';

const expectedVersion = '1.62.1';
const deadline = performance.now() + 115_000;
const worker = fileURLToPath(new URL('./fixtures/host-worker.ts', import.meta.url));
const sessionKey = 'kitflint.glance.session';

function localPath(value, kind) {
  assert(process.platform === 'win32' && typeof value === 'string' && /^[a-z]:[\\/]/i.test(value), 'Required local Windows path');
  const normalized = win32.normalize(value);
  const canonical = realpathSync.native(normalized);
  assert.equal(canonical.toLowerCase(), normalized.toLowerCase(), 'Expected canonical local path');
  const stat = lstatSync(canonical);
  assert(kind === 'directory' ? stat.isDirectory() : stat.isFile(), 'Incorrect local path type');
  return canonical;
}

function externalBrowser() {
  const root = localPath(process.env.KFG_PLAYWRIGHT_ROOT, 'directory');
  const playwright = localPath(join(root, 'package.json'), 'file');
  const entry = localPath(join(root, 'index.mjs'), 'file');
  const core = localPath(join(dirname(root), 'playwright-core', 'package.json'), 'file');
  const executablePath = localPath(process.env.KFG_CHROME_EXECUTABLE, 'file');
  assert.equal(basename(executablePath).toLowerCase(), 'chrome.exe');
  for (const [path, name] of [[playwright, 'playwright'], [core, 'playwright-core']]) {
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, expectedVersion);
  }
  return { entry, executablePath };
}

function bounded(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), Math.max(1, Math.min(milliseconds, deadline - performance.now())));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function childHost(root) {
  const child = fork(worker, [root], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ready = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message?.type === 'ready') resolve({ origin: message.origin, launchUrl: message.launchUrl });
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Host closed before bootstrap')));
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    pid: child.pid, ready,
    async verifyExit(origin) {
      const exit = await bounded(exited, 5000, 'Host exit was not observed');
      assert.deepEqual(exit, { code: 0, signal: null });
      await verifyListenerClosed(origin);
      return exit;
    },
    async stopIfNeeded() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (child.connected) child.send({ type: 'stop' }, () => {});
      try {
        await bounded(exited, 3000, 'Host stop did not complete');
      } catch (error) {
        child.kill();
        await bounded(exited, 2000, 'Owned host closure unknown');
        throw error;
      }
    },
  };
}

function verifyListenerClosed(origin) {
  return bounded(new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(origin).port) });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Host listener remained open')); });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(); else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Listener closure unknown')); });
  }), 1200, 'Listener check timed out');
}

function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function openPage(page, url) {
  const callerStage = stage;
  stage = 'navigate to Glance and wait for DOM content';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  stage = 'wait for the Glance headline';
  await page.getByRole('heading', { name: 'Made for human eyes. Built for clear decisions.' }).waitFor();
  stage = 'wait for the launch fragment to clear';
  await page.waitForFunction(() => !location.hash);
  stage = callerStage;
}

async function editProject(page, goal) {
  await page.getByRole('button', { name: 'Edit project', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Edit project' });
  await form.getByLabel('Goal', { exact: true }).fill(goal);
  return form;
}

async function save(dialog) {
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function appendEvidence(page, title, outcome, supersedes) {
  const navigation = page.getByRole('navigation', { name: 'Board views' });
  if (await navigation.getByRole('button', { name: 'Evidence', exact: true }).getAttribute('aria-current') !== 'page') {
    await navigation.getByRole('button', { name: 'Evidence', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Add evidence', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add evidence' });
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByLabel('Outcome', { exact: true }).selectOption(outcome);
  if (supersedes) await dialog.getByLabel('Corrects', { exact: true }).selectOption({ label: supersedes });
  await save(dialog);
  await page.getByText(title, { exact: true }).waitFor();
}

async function observedDownload(page, label, folder, name) {
  const pending = page.waitForEvent('download', { timeout: 4000 });
  void pending.catch(() => {});
  await page.getByRole('button', { name: label, exact: true }).click();
  const download = await pending;
  assert.equal(download.suggestedFilename(), name);
  const path = join(folder, name);
  await download.saveAs(path);
  return readFileSync(path);
}

const pageErrorNames = new Set([
  'Error', 'SyntaxError', 'ReferenceError', 'TypeError', 'RangeError', 'EvalError', 'URIError',
  'SecurityError', 'AbortError',
]);
const startupResponses = new Map([
  ['GET /', undefined],
  ['GET /app.js', undefined],
  ['POST /api/session', undefined],
  ['GET /api/board', undefined],
  ['POST /api/initialize', undefined],
]);
let firstStartupPageError;
let detachStartup;

function safeErrorName(error) {
  try {
    const name = error?.name;
    if (pageErrorNames.has(name)) return name;
  } catch {
    // A property getter may throw even for the caught value.
  }
  return 'Error';
}

function observeStartupPageError(error) {
  if (firstStartupPageError) return;
  firstStartupPageError = { kind: safeErrorName(error) };
  try {
    const stack = error?.stack;
    if (typeof stack !== 'string') return;
    const frame = /\/app\.js:([0-9]{1,6}):([0-9]{1,6})(?=$|[\s)])/.exec(stack);
    if (!frame) return;
    const line = Number(frame[1]);
    const column = Number(frame[2]);
    if (line >= 1 && line <= 999999 && column >= 1 && column <= 999999) {
      firstStartupPageError.location = { line, column };
    }
  } catch {
    // Keep the already sanitized class when the stack cannot be read.
  }
}

function startupFailureStage(operation) {
  const responses = Array.from(startupResponses, ([route, status]) =>
    route + ' ' + (status ?? 'unobserved')).join(', ');
  let summary = operation + ' · startup responses ' + responses;
  if (firstStartupPageError) {
    summary += ' · first startup page error ' + firstStartupPageError.kind;
    const location = firstStartupPageError.location;
    if (location) summary += ' at app.js:' + location.line + ':' + location.column;
  }
  return summary;
}

let stage = 'external browser preflight';
let fixture;
let context;
let primary;
let secondary;
const hosts = [];
const confirmedClosures = [];
const origins = new Set();
let outbound = 0;
let completed = false;
let failure;
try {
  const { entry, executablePath } = externalBrowser();
  const { chromium } = await import(pathToFileURL(entry).href);
  fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-journey-'));
  const boardRoot = join(fixture, 'board');
  const restoreRoot = join(fixture, 'restore');
  mkdirSync(boardRoot);
  mkdirSync(restoreRoot);

  stage = 'start first owned host and sandboxed browser';
  primary = childHost(boardRoot);
  hosts.push(primary);
  const first = await bounded(primary.ready, 8000, 'Host bootstrap timed out');
  origins.add(first.origin);
  context = await chromium.launchPersistentContext(join(fixture, 'chrome-profile'), {
    executablePath, chromiumSandbox: true, headless: true, acceptDownloads: true, serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 }, timeout: 15_000,
  });
  context.setDefaultTimeout(4000);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (origins.has(url.origin)) return route.continue();
    outbound++;
    return route.abort();
  });
  assert(context.pages().length <= 1);
  const page = context.pages()[0] ?? await context.newPage();

  stage = 'create blank board and verify keyboard editing';
  const observeStartupResponse = (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== first.origin || /^[^#]*\?/.test(url.href)) return;
      const route = response.request().method() + ' ' + url.pathname;
      if (!startupResponses.has(route)) return;
      const status = response.status();
      if (Number.isInteger(status) && status >= 100 && status <= 599) startupResponses.set(route, status);
    } catch {
      // An unusable observation must not affect the journey.
    }
  };
  detachStartup = () => {
    page.off('pageerror', observeStartupPageError);
    page.off('response', observeStartupResponse);
    detachStartup = undefined;
  };
  page.on('pageerror', observeStartupPageError);
  page.on('response', observeStartupResponse);

  await openPage(page, first.launchUrl);
  stage = 'verify the launch fragment is cleared';
  assert.equal(new URL(page.url()).hash, '');
  stage = 'fill the blank-board project name';
  await page.getByLabel('Project name', { exact: true }).fill('Journey board');
  stage = 'click Create blank board';
  await page.getByRole('button', { name: 'Create blank board', exact: true }).click();
  stage = 'wait for the created-board heading';
  await page.getByRole('heading', { name: 'Journey board', exact: true }).waitFor();
  stage = 'focus the Edit project button';
  const projectButton = page.getByRole('button', { name: 'Edit project', exact: true });
  await projectButton.focus();
  stage = 'press Enter to open the project editor';
  await page.keyboard.press('Enter');
  stage = 'check initial project-name focus';
  const project = page.getByRole('dialog', { name: 'Edit project' });
  assert(await project.getByLabel('Project name', { exact: true }).evaluate((element) => document.activeElement === element));
  stage = 'press Tab from the project name';
  await page.keyboard.press('Tab');
  stage = 'check goal-field focus';
  assert(await project.getByLabel('Goal', { exact: true }).evaluate((element) => document.activeElement === element));
  stage = 'press Escape to close the project editor';
  await page.keyboard.press('Escape');
  stage = 'wait for the project editor to hide';
  await project.waitFor({ state: 'hidden' });
  stage = 'check focus returns to the Edit project button';
  assert(await projectButton.evaluate((element) => document.activeElement === element));
  detachStartup();

  stage = 'validation feedback and task save';
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const task = page.getByRole('dialog', { name: 'Add task' });
  await task.getByRole('button', { name: 'Save changes', exact: true }).click();
  const validation = task.getByRole('heading', { name: 'Check your entries', exact: true });
  await validation.waitFor();
  assert(await validation.evaluate((element) => document.activeElement === element));
  await task.getByLabel('Task title', { exact: true }).fill('Review the local report');
  await task.getByLabel('Status', { exact: true }).selectOption('In progress');
  await save(task);
  await page.getByRole('button', { name: 'Review the local report', exact: true }).waitFor();

  stage = 'clean tab authentication and stale edit comparison';
  const other = await context.newPage();
  await openPage(other, first.origin);
  await other.getByRole('heading', { name: 'Open the existing Glance tab', exact: true }).waitFor();
  const token = await page.evaluate((key) => sessionStorage.getItem(key), sessionKey);
  assert(typeof token === 'string' && token.length >= 43, 'Session capability missing');
  await other.evaluate(({ key, token }) => sessionStorage.setItem(key, token), { key: sessionKey, token });
  await other.reload();
  await other.getByRole('heading', { name: 'Journey board', exact: true }).waitFor();
  const localDraft = await editProject(page, 'Keep my unsaved goal');
  await save(await editProject(other, 'Saved in the other tab'));
  await localDraft.getByRole('button', { name: 'Save changes', exact: true }).click();
  await localDraft.getByRole('heading', { name: 'This board changed', exact: true }).waitFor();
  await localDraft.getByText('Saved in the other tab', { exact: false }).waitFor();
  page.once('dialog', (dialog) => { void dialog.dismiss(); });
  await page.keyboard.press('Escape');
  assert(await localDraft.isVisible());
  assert.equal(await localDraft.getByLabel('Goal', { exact: true }).inputValue(), 'Keep my unsaved goal');
  await localDraft.getByRole('button', { name: 'Reapply draft', exact: true }).click();
  assert.equal(await localDraft.getByLabel('Goal', { exact: true }).inputValue(), 'Keep my unsaved goal');
  stage = 'save the reapplied project draft';
  await save(localDraft);
  stage = 'wait for the saved project goal in the report';
  await page.locator('#project-goal').filter({ hasText: /^Keep my unsaved goal$/ }).waitFor({ state: 'visible' });
  stage = 'close the second conflict-check tab';
  await other.close();

  stage = 'lost save response, discard draft and release UI hold with an explicit fresh read';
  const responseLoss = await editProject(page, 'Keep my unsaved goal');
  await responseLoss.getByLabel('Stage', { exact: true }).selectOption('Build');
  let committedWithoutReply;
  let saveRequests = 0;
  const countSave = (request) => {
    if (request.url() === first.origin + '/api/change' && request.method() === 'POST') saveRequests++;
  };
  page.on('request', countSave);
  await page.route(first.origin + '/api/change', async (route) => {
    try {
      const result = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 3500 });
      if (result.ok()) {
        const payload = await result.json();
        if (payload.ok === true && payload.committed === true) {
          committedWithoutReply = payload.version;
        }
      }
    } catch {
      // The commit witness remains absent if the forwarded request fails.
    } finally {
      await route.abort('failed');
    }
  }, { times: 1 });
  await responseLoss.getByRole('button', { name: 'Save changes', exact: true }).click();
  await responseLoss.getByRole('heading', { name: 'Check the saved board', exact: true }).waitFor();
  assert(typeof committedWithoutReply === 'string', 'A real commit before response loss was not observed');
  assert.equal(await responseLoss.getByLabel('Stage', { exact: true }).inputValue(), 'Build');
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await responseLoss.getByRole('button', { name: 'Cancel', exact: true }).click();
  await responseLoss.waitFor({ state: 'hidden' });
  await projectButton.click();
  await page.getByText('Refresh the saved board and compare it before opening another edit.', { exact: true }).waitFor();
  const freshRead = page.waitForResponse((result) => new URL(result.url()).pathname === '/api/board');
  void freshRead.catch(() => {});
  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  assert.equal((await (await freshRead).json()).version, committedWithoutReply);
  assert.equal(saveRequests, 1);
  page.off('request', countSave);
  await page.getByText('Review the refreshed board before opening another edit.', { exact: true }).waitFor();
  await projectButton.click();
  const reopenedEditor = page.getByRole('dialog', { name: 'Edit project' });
  assert.equal(await reopenedEditor.getByLabel('Stage', { exact: true }).inputValue(), 'Build');
  await page.keyboard.press('Escape');
  await reopenedEditor.waitFor({ state: 'hidden' });

  stage = 'evidence, immutable exports and restored provenance';
  await appendEvidence(page, 'First reopen failed', 'failed');
  await appendEvidence(page, 'Correction checked', 'passed', 'First reopen failed');
  const packageReply = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/export');
  void packageReply.catch(() => {});
  await page.getByRole('button', { name: 'Prepare export', exact: true }).click();
  const reply = await packageReply;
  assert.equal(reply.status(), 200);
  const pack = await reply.json();
  const formats = [
    ['Download HTML', 'glance.html', 'html'], ['Download Markdown', 'glance.md', 'markdown'],
    ['Download JSON backup', 'glance.json', 'backupJson'],
  ];
  for (const [label, filename, key] of formats) {
    const bytes = await observedDownload(page, label, fixture, filename);
    assert.equal(hash(bytes), pack.sha256[key]);
    assert.equal(bytes.toString('utf8'), pack[key]);
  }
  const revision = pack.version.slice(pack.version.lastIndexOf(':') + 1);
  const metadata = 'Revision ' + revision + ' · ' + pack.version + ' · Exported ' + pack.exportedAt;
  assert(pack.html.includes(metadata));
  const markdownHeader = pack.markdown.slice(0, 2048).split('\n');
  const metadataLine = markdownHeader.find((line) => /^Revision [1-9][0-9]* · /.test(line));
  assert(metadataLine && metadataLine.length <= 256, 'Markdown metadata line missing or oversized');
  const decoded = metadataLine.replace(/&#(45|46|58);/g, (_, code) => String.fromCharCode(Number(code)));
  assert.equal(decoded, metadata);
  const backup = JSON.parse(pack.backupJson);
  assert.equal(backup.exportedAt, pack.exportedAt);
  assert.equal(backup.snapshot.generation + ':' + backup.snapshot.revision, pack.version);
  assert.deepEqual(backup.snapshot.evidence.map((item) => item.outcome), ['failed', 'passed']);
  assert.equal(backup.snapshot.evidence[1].supersedesId, backup.snapshot.evidence[0].id);
  const restored = openBoard(restoreRoot);
  try {
    const result = restored.initialize({ kind: 'import', backup, identity: 'restore' });
    assert(!('error' in result));
    assert.equal(result.snapshot.boardId, pack.boardId);
    assert.notEqual(result.snapshot.generation, backup.snapshot.generation);
    assert.deepEqual(result.snapshot.evidence, backup.snapshot.evidence);
  } finally {
    assert.deepEqual(restored.close(), { closed: true });
  }

  stage = 'quit first host and positively observe process and listener closure';
  await page.getByRole('button', { name: 'Quit', exact: true }).click();
  await page.getByText('Shutdown requested', { exact: true }).waitFor();
  confirmedClosures.push({ pid: primary.pid, ...await primary.verifyExit(first.origin), listenerClosed: true });

  stage = 'reopen exact revision and verify narrow layout';
  secondary = childHost(boardRoot);
  hosts.push(secondary);
  const next = await bounded(secondary.ready, 8000, 'Reopen bootstrap timed out');
  origins.add(next.origin);
  const reopened = await context.newPage();
  await reopened.setViewportSize({ width: 390, height: 844 });
  await page.close();
  const boardReply = reopened.waitForResponse((response) => new URL(response.url()).pathname === '/api/board');
  void boardReply.catch(() => {});
  await openPage(reopened, next.launchUrl);
  const state = await (await boardReply).json();
  assert.equal(state.version, pack.version);
  assert.equal(state.snapshot.project.goal, 'Keep my unsaved goal');
  assert.equal(state.snapshot.tasks[0].title, 'Review the local report');
  await reopened.getByRole('button', { name: 'Table', exact: true }).click();
  const search = reopened.getByRole('searchbox', { name: 'Search tasks' });
  await search.fill('missing title');
  await reopened.getByText('No tasks match these filters.', { exact: true }).waitFor();
  await search.fill('local report');
  await reopened.getByRole('button', { name: 'Review the local report', exact: true }).click();
  const details = reopened.getByRole('dialog', { name: 'Review the local report', exact: true });
  await details.waitFor();
  assert.deepEqual(await reopened.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 390, height: 844 });
  assert(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert(await details.evaluate((element) => element.getBoundingClientRect().width <= innerWidth));
  await reopened.keyboard.press('Escape');
  await details.waitFor({ state: 'hidden' });
  await reopened.getByRole('button', { name: 'Quit', exact: true }).click();
  await reopened.getByText('Shutdown requested', { exact: true }).waitFor();
  confirmedClosures.push({ pid: secondary.pid, ...await secondary.verifyExit(next.origin), listenerClosed: true });
  assert.equal(outbound, 0);
  completed = true;
} catch (error) {
  failure = { stage: detachStartup ? startupFailureStage(stage) : stage, kind: error?.name ?? 'Error' };
} finally {
  detachStartup?.();
  try {
    if (context) await context.close();
  } catch {
    failure ??= { stage: 'browser context closure', kind: 'Error' };
  }
  for (const host of hosts) {
    try { await host.stopIfNeeded(); } catch {
      failure ??= { stage: 'host fixture closure', kind: 'Error' };
    }
  }
  if (fixture && completed && !failure) rmSync(fixture, { recursive: true });
}
if (failure) {
  console.error(JSON.stringify({ status: 'FAILED', ...failure, fixture: fixture ?? null, hostPids: hosts.map((host) => host.pid), confirmedClosures }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'PASSED', confirmedClosures, outbound }));
}
