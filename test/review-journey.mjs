import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBoard } from '../src/board.ts';

const deadline = performance.now() + 115_000;
const worker = fileURLToPath(new URL('./fixtures/host-worker.ts', import.meta.url));
const taskTitle = 'Review the isolated task';
const interruptionNotice = 'The response was lost. Check the saved review history; this submission cannot be confirmed.';
const hash = (data) => createHash('sha256').update(data).digest('hex');

function localPath(value, kind) {
  assert(process.platform === 'win32' && typeof value === 'string' && /^[a-z]:[\\/]/i.test(value), 'Required local Windows path');
  const normalized = win32.normalize(value);
  const actual = realpathSync.native(normalized);
  assert.equal(actual.toLowerCase(), normalized.toLowerCase(), 'Expected canonical local path');
  const stat = lstatSync(actual);
  assert(kind === 'directory' ? stat.isDirectory() : stat.isFile(), 'Incorrect local path type');
  return actual;
}

function browserSelection() {
  const root = localPath(process.env.KFG_PLAYWRIGHT_ROOT, 'directory');
  const executablePath = localPath(process.env.KFG_CHROME_EXECUTABLE, 'file');
  assert.equal(basename(executablePath).toLowerCase(), 'chrome.exe');
  const entry = localPath(join(root, 'index.mjs'), 'file');
  for (const [folder, name] of [[root, 'playwright'], [join(dirname(root), 'playwright-core'), 'playwright-core']]) {
    const pkg = JSON.parse(readFileSync(localPath(join(folder, 'package.json'), 'file'), 'utf8'));
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, '1.62.1');
  }
  return { executablePath, entry };
}

function bounded(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), Math.max(1, Math.min(ms, deadline - performance.now())));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function fixtureHost(root) {
  const child = fork(worker, [root], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const ready = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message?.type === 'ready') resolve({ origin: message.origin, launchUrl: message.launchUrl });
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Host exited before bootstrap')));
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    pid: child.pid, ready,
    async expectExit(origin) {
      const exit = await bounded(exited, 5000, 'Host exit was not observed');
      assert.deepEqual(exit, { code: 0, signal: null });
      await bounded(new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: Number(new URL(origin).port) });
        socket.once('connect', () => { socket.destroy(); reject(new Error('Host listener remained open')); });
        socket.once('error', (error) => {
          socket.destroy();
          if (error.code === 'ECONNREFUSED') resolve();
          else reject(error);
        });
        socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Listener closure unknown')); });
      }), 1200, 'Listener check timed out');
      return { pid: child.pid, ...exit, listenerClosed: true };
    },
    async stopIfNeeded() {
      if (child.exitCode !== null || child.signalCode !== null) return { ...await exited, forced: false };
      if (child.connected) child.send({ type: 'stop' }, () => {});
      try { return { ...await bounded(exited, 3000, 'Host stop did not complete'), forced: false }; }
      catch {
        child.kill();
        return { ...await bounded(exited, 2000, 'Owned host closure unknown'), forced: true };
      }
    },
  };
}

function ok(result) {
  assert(!('error' in result), JSON.stringify(result));
  return result;
}

function seed(root) {
  const board = openBoard(root);
  try {
    let current = ok(board.initialize({ kind: 'blank', name: 'Human review journey' }));
    const change = (operation) => {
      current = ok(board.change({ boardId: current.snapshot.boardId, expectedVersion: current.version, operation }));
      return current.createdIds;
    };
    const { evidenceId: failed } = change({ type: 'evidence.add', fields: { title: 'Original failed check', scope: 'local', outcome: 'failed' } });
    const { evidenceId: passed } = change({ type: 'evidence.add', fields: {
      title: 'Explicit passed correction', scope: 'local', outcome: 'passed', supersedesId: failed, location: 'notes/checked.txt',
    } });
    const { taskId } = change({ type: 'task.add', fields: {
      title: taskTitle, criteria: [{ requirement: 'Review the saved evidence', evidenceIds: [passed] }],
    } });
    return { taskId, version: current.version };
  } finally { assert.deepEqual(board.close(), { closed: true }); }
}

async function readSaved(page) {
  return page.evaluate(async () => {
    const token = sessionStorage.getItem('kitflint.glance.session');
    const response = await fetch('/api/board', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
    if (!response.ok) throw new Error('Saved board read failed');
    return response.json();
  });
}

function taskDialog(page) {
  return page.getByRole('dialog', { name: taskTitle, exact: true });
}

function reviewDialog(page) {
  return page.getByRole('dialog', { name: 'Review task', exact: true });
}

async function showReview(page) {
  if (!await taskDialog(page).isVisible()) {
    await page.locator('#task-list').getByRole('button', { name: taskTitle, exact: true }).click();
  }
  const trigger = taskDialog(page).getByRole('button', { name: 'Review task', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const review = reviewDialog(page);
  await review.waitFor();
  assert(await review.getByRole('heading', { name: 'Review task', exact: true }).evaluate((node) => document.activeElement === node));
  assert.equal(await review.getByRole('checkbox').isChecked(), false);
  return { review, trigger };
}

async function draft(review, label, decision = 'accepted') {
  await review.getByLabel('Reviewer name').fill('Reviewer ' + label);
  await review.getByLabel('Reviewed scope').fill('Scope ' + label);
  await review.getByLabel('Review note').fill('Draft note ' + label);
  await review.getByLabel('Decision').selectOption(decision);
}

function submit(review) {
  return review.getByRole('button', { name: 'Confirm review', exact: true });
}

function reviewHistoryCount(board) {
  return board.snapshot.reviews.length;
}

async function editGoal(page, prior, goal) {
  return page.evaluate(async ({ prior, goal }) => {
    const token = sessionStorage.getItem('kitflint.glance.session');
    const response = await fetch('/api/change', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardId: prior.snapshot.boardId, expectedVersion: prior.version,
        operation: { type: 'project.edit', fields: { goal } } }),
    });
    if (!response.ok) throw new Error('Parallel edit did not commit');
    return response.json();
  }, { prior, goal });
}

let fixture;
let context;
let host;
let bootstrap;
let hostExit;
let hostCleanup;
let browserClosed = false;
let outbound = 0;
let stage = 'fixture preparation';
let failure;
const observations = [];
const screenshots = [];
const browserErrors = [];

try {
  const { entry, executablePath } = browserSelection();
  const { chromium } = await import(pathToFileURL(entry).href);
  fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-review-journey-'));
  const root = join(fixture, 'board');
  mkdirSync(root);
  const initial = seed(root);
  stage = 'start owned host and browser';
  host = fixtureHost(root);
  bootstrap = await bounded(host.ready, 8000, 'Host bootstrap timed out');
  context = await bounded(chromium.launchPersistentContext(join(fixture, 'chrome-profile'), {
    executablePath, chromiumSandbox: true, headless: true, acceptDownloads: true, serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 }, timeout: 15_000,
  }), 16_000, 'Browser startup timed out');
  context.setDefaultTimeout(4500);
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === bootstrap.origin) return route.continue();
    outbound++;
    return route.abort();
  });
  assert(context.pages().length <= 1);
  const page = context.pages()[0] ?? await context.newPage();
  const allowedErrors = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AbortError', 'SecurityError']);
  const consoleCodes = ['net::ERR_FAILED', 'net::ERR_ABORTED', 'net::ERR_CONNECTION_REFUSED', '409 (Conflict)'];
  page.on('pageerror', (error) => {
    browserErrors.push({ source: 'pageerror', stage, kind: allowedErrors.has(error.name) ? error.name : 'Error' });
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const code = consoleCodes.find((code) => message.text().includes(code));
    browserErrors.push({ source: 'console', stage, code: code ?? 'OTHER_CONSOLE_ERROR' });
  });
  let reviewPosts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/review') reviewPosts++;
  });
  await page.goto(bootstrap.launchUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
  await page.getByRole('heading', { name: 'Human review journey', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '');

  stage = 'keyboard review opening, unchecked confirmation and cancel';
  let { review, trigger } = await showReview(page);
  assert.match(await review.locator('#review-version').textContent(), new RegExp(initial.version));
  await review.getByText('Original failed check', { exact: true }).waitFor();
  await review.getByText('Explicit passed correction', { exact: true }).waitFor();
  await review.getByText('Review the saved evidence', { exact: false }).waitFor();
  await draft(review, 'cancel');
  await submit(review).click();
  assert.equal(reviewPosts, 0);
  await page.keyboard.press('Escape');
  await review.waitFor({ state: 'hidden' });
  assert(await trigger.evaluate((node) => document.activeElement === node));
  assert.equal((await readSaved(page)).version, initial.version);

  stage = 'confirmed acceptance and local review history';
  ({ review } = await showReview(page));
  await draft(review, 'accept');
  const formImage = join(fixture, 'review-form.png');
  await page.screenshot({ path: formImage, animations: 'disabled', timeout: 4500 });
  screenshots.push({ path: formImage, sha256: hash(readFileSync(formImage)) });
  await review.getByRole('checkbox').check();
  await submit(review).click();
  await review.waitFor({ state: 'hidden' });
  const accepted = await readSaved(page);
  assert.equal(accepted.report.acceptance.accepted, 1);
  assert.equal(accepted.snapshot.reviews[0].scope, 'Scope accept');
  const acceptedPill = taskDialog(page).locator('.pill.review-accepted');
  await acceptedPill.waitFor();
  assert.equal(await acceptedPill.textContent(), 'Accepted for stated scope');
  await taskDialog(page).getByText('Review history (1)', { exact: true }).click();
  await taskDialog(page).getByText('Draft note accept', { exact: true }).waitFor();
  await taskDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#task-list .pill.review-accepted').waitFor();
  const acceptedImage = join(fixture, 'accepted-board.png');
  await page.screenshot({ path: acceptedImage, animations: 'disabled', timeout: 4500 });
  screenshots.push({ path: acceptedImage, sha256: hash(readFileSync(acceptedImage)) });
  observations.push({ case: 'cancel-keyboard-confirmed-history', revision: accepted.snapshot.revision });

  stage = 'version conflict preserves review draft and shows stale state';
  ({ review } = await showReview(page));
  await draft(review, 'conflict');
  await review.getByRole('checkbox').check();
  const edited = await editGoal(page, accepted, 'A newer saved goal');
  assert.equal(edited.report.acceptance.stale, 1);
  await submit(review).click();
  await review.getByText('The board changed.', { exact: false }).waitFor();
  assert.equal(await review.getByLabel('Review note').inputValue(), 'Draft note conflict');
  assert(await submit(review).isDisabled());
  assert.equal(await review.getByRole('checkbox').isChecked(), false);
  assert.equal(await review.getByRole('button', { name: 'Reapply draft' }).count(), 0);
  await review.getByRole('button', { name: 'Close review' }).click();
  await review.waitFor({ state: 'hidden' });
  const stalePill = taskDialog(page).locator('.pill.review-stale');
  await stalePill.waitFor();
  assert.equal(await stalePill.textContent(), 'Stale review');
  assert.equal(reviewHistoryCount(await readSaved(page)), 2);
  observations.push({ case: 'conflict-and-stale', revision: edited.snapshot.revision });

  for (const mode of ['lost-after-save', 'aborted-before-host']) {
    stage = mode;
    const before = await readSaved(page);
    const posts = reviewPosts;
    ({ review } = await showReview(page));
    await draft(review, mode);
    await review.getByRole('checkbox').check();
    let intercepted = 0;
    let savedByHost;
    const matcher = '**/api/review';
    const interrupt = async (route) => {
      intercepted++;
      try {
        if (mode === 'lost-after-save') {
          const response = await route.fetch({ maxRetries: 0, timeout: 4500 });
          assert.equal(response.status(), 200);
          savedByHost = await response.json();
        }
      } finally { await route.abort('failed'); }
    };
    await page.route(matcher, interrupt);
    try {
      await submit(review).click();
      await review.getByText(interruptionNotice, { exact: false }).waitFor();
      assert.equal(await review.getByLabel('Review note').inputValue(), 'Draft note ' + mode);
      assert(await submit(review).isDisabled());
      await review.getByRole('button', { name: 'Read saved review history' }).click();
      const history = review.locator('#review-saved-history');
      await history.getByRole('heading', { name: 'Saved review history' }).waitFor();
      await review.getByText(interruptionNotice, { exact: false }).waitFor();
      if (mode === 'lost-after-save') {
        assert.equal(savedByHost?.committed, true);
        await history.getByText('Draft note ' + mode, { exact: true }).waitFor();
        assert.equal(await review.getByText('No change is visible at this read.', { exact: false }).count(), 0);
      } else {
        await review.getByText('No change is visible at this read.', { exact: false }).waitFor();
        assert.equal(await history.getByText('Draft note ' + mode, { exact: true }).count(), 0);
      }
      assert.equal(await review.getByLabel('Review note').inputValue(), 'Draft note ' + mode);
      assert(await submit(review).isDisabled());
      assert.equal(await review.getByRole('button', { name: 'Reapply draft' }).count(), 0);
      assert.equal(intercepted, 1);
      assert.equal(reviewPosts - posts, 1);
      const fresh = await readSaved(page);
      assert.equal(fresh.snapshot.revision, before.snapshot.revision + (mode === 'lost-after-save' ? 1 : 0));
      assert.equal(reviewHistoryCount(fresh), reviewHistoryCount(before) + (mode === 'lost-after-save' ? 1 : 0));
      if (mode !== 'lost-after-save') assert.equal(fresh.version, before.version);
      await review.getByRole('button', { name: 'Close review' }).click();
      await review.waitFor({ state: 'hidden' });
      ({ review } = await showReview(page));
      assert.equal(await review.getByLabel('Review note').inputValue(), '');
      assert.match(await review.locator('#review-version').textContent(), new RegExp(fresh.version));
      await page.keyboard.press('Escape');
      await review.waitFor({ state: 'hidden' });
      observations.push({ case: mode, requestCount: intercepted, before: before.version, after: fresh.version });
    } finally { await page.unroute(matcher, interrupt); }
  }

  stage = 'download current archive from Review';
  await taskDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('navigation', { name: 'Board views' }).getByRole('button', { name: 'Review', exact: true }).click();
  const downloadEvent = page.waitForEvent('download', { timeout: 5000 });
  void downloadEvent.catch(() => {});
  await page.getByRole('button', { name: 'Download review archive' }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'glance-review-archive.json');
  const destination = join(fixture, download.suggestedFilename());
  await download.saveAs(destination);
  const file = readFileSync(destination);
  const savedBackup = JSON.parse(file.toString('utf8'));
  const fresh = await readSaved(page);
  assert.deepEqual(savedBackup.snapshot, fresh.snapshot);
  await page.locator('#review-backup-status').filter({ hasText: hash(file) }).waitFor();
  await page.locator('#review-backup-status').filter({ hasText: hash(JSON.stringify(savedBackup.snapshot)) }).waitFor();

  stage = 'Quit and observe host and listener closure';
  await page.getByRole('button', { name: 'Quit', exact: true }).click();
  await page.getByText('Shutdown requested', { exact: true }).waitFor();
  hostExit = await host.expectExit(bootstrap.origin);
  assert.equal(outbound, 0);
  const unexpectedErrors = browserErrors.filter((item) => {
    if (item.source === 'pageerror') return true;
    const expectedConflict = item.stage === 'version conflict preserves review draft and shows stale state' && item.code === '409 (Conflict)';
    const expectedInterruption = ['lost-after-save', 'aborted-before-host'].includes(item.stage) &&
      ['net::ERR_FAILED', 'net::ERR_ABORTED'].includes(item.code);
    return !expectedConflict && !expectedInterruption;
  });
  assert.deepEqual(unexpectedErrors, []);
} catch (error) {
  failure = { stage, kind: error?.name ?? 'Error' };
} finally {
  if (context) {
    try {
      await bounded(context.close(), 8000, 'Browser context closure timed out');
      browserClosed = true;
    } catch { failure ??= { stage: 'browser context closure', kind: 'Error' }; }
  }
  if (host) {
    try {
      hostCleanup = await host.stopIfNeeded();
      if (!hostExit && bootstrap && hostCleanup.code === 0 && hostCleanup.signal === null && !hostCleanup.forced) {
        hostExit = await host.expectExit(bootstrap.origin);
      }
    } catch { failure ??= { stage: 'host fixture closure', kind: 'Error' }; }
  }
}
const receipt = { status: failure ? 'FAILED' : 'PASSED', failure, fixture, hostPid: host?.pid, hostExit, hostCleanup,
  browserContextClosed: browserClosed, browserProcessClosure: 'OUTER_OBSERVER_REQUIRED', outbound, observations, screenshots, browserErrors };
if (failure) {
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(receipt));
}
