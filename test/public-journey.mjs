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
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function localPath(value, kind) {
  assert(process.platform === 'win32' && typeof value === 'string' && /^[a-z]:[\\/]/i.test(value));
  const normalized = win32.normalize(value);
  const resolved = realpathSync.native(normalized);
  assert.equal(resolved.toLowerCase(), normalized.toLowerCase());
  const stat = lstatSync(resolved);
  assert(kind === 'directory' ? stat.isDirectory() : stat.isFile());
  return resolved;
}

function browserSelection() {
  const root = localPath(process.env.KFG_PLAYWRIGHT_ROOT, 'directory');
  const executablePath = localPath(process.env.KFG_CHROME_EXECUTABLE, 'file');
  assert.equal(basename(executablePath).toLowerCase(), 'chrome.exe');
  for (const [folder, name] of [[root, 'playwright'], [join(dirname(root), 'playwright-core'), 'playwright-core']]) {
    const pkg = JSON.parse(readFileSync(localPath(join(folder, 'package.json'), 'file'), 'utf8'));
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, '1.62.1');
  }
  return { entry: localPath(join(root, 'index.mjs'), 'file'), executablePath };
}

function bounded(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), Math.max(1, Math.min(ms, deadline - performance.now())));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function startFixture(root) {
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
    async verifyExit(origin) {
      const exit = await bounded(exited, 5000, 'Host exit not observed');
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
      }), 1200, 'Listener closure not observed');
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


const privateMarker = 'KFG_PRIVATE_JOURNEY_';
const hostile = 'Public </script><img alt="glance-fixture" onerror=""> [Ω](https://fixture.invalid)';
const authored = 'Chosen project label';
const receipt = {
  status: 'FAILED', observations: [], screenshots: [], downloads: [], failures: [],
  requests: { local: 0, offlineDocument: 0, outside: 0 },
  dialogs: 0, unexpectedPages: 0, cspViolations: [], browserErrors: [],
  browserContextClosed: false, browserProcessClosure: 'OUTER_OBSERVER_REQUIRED',
};
let stage = 'initialization';
let host;
let context;
let allowedFile;
let expectedExtraPage = false;

function seed(root) {
  const board = openBoard(root);
  try {
    let saved = ok(board.initialize({ kind: 'sample' }));
    const change = (operation) => {
      saved = ok(board.change({ boardId: saved.snapshot.boardId, expectedVersion: saved.version, operation }));
      return saved.createdIds;
    };
    const review = (taskId, decision) => {
      saved = ok(board.review({ boardId: saved.snapshot.boardId, expectedVersion: saved.version, taskId, decision,
        confirmed: true, reviewer: privateMarker + 'REVIEWER', scope: privateMarker + 'SCOPE', note: privateMarker + 'NOTE' }));
    };
    const { tasks, project } = saved.snapshot;
    change({ type: 'project.edit', fields: { name: privateMarker + 'PROJECT', goal: privateMarker + 'GOAL',
      stage: 'Release', nextActions: [privateMarker + 'NEXT'], focusTaskId: project.focusTaskId } });
    const { evidenceId } = change({ type: 'evidence.add', fields: { title: privateMarker + 'EVIDENCE',
      scope: 'unit', outcome: 'passed', location: privateMarker + 'LOCATION' } });
    change({ type: 'task.edit', id: tasks[0].id, fields: { title: privateMarker + 'FIRST', description: privateMarker + 'DESCRIPTION',
      owner: privateMarker + 'OWNER', evidenceIds: [evidenceId] } });
    change({ type: 'criterion.edit', taskId: tasks[0].id, id: tasks[0].criteria[0].id,
      fields: { requirement: privateMarker + 'CRITERION', evidenceIds: [evidenceId] } });
    review(tasks[0].id, 'accepted');
    change({ type: 'task.edit', id: tasks[1].id, fields: { title: privateMarker + 'SECOND' } });
    review(tasks[1].id, 'changes-requested');
    const { taskId } = change({ type: 'task.add', fields: { title: privateMarker + 'THIRD',
      criteria: [{ requirement: privateMarker + 'STALE_CRITERION', evidenceIds: [evidenceId] }] } });
    review(taskId, 'accepted');
    change({ type: 'task.edit', id: taskId, fields: { title: privateMarker + 'STALE_TASK' } });
    return { revision: saved.snapshot.revision, privateIds: [saved.version, saved.snapshot.boardId, saved.snapshot.generation,
      ...saved.snapshot.tasks.map((task) => task.id), evidenceId] };
  } finally {
    assert.deepEqual(board.close(), { closed: true });
  }
}

function advance(root) {
  const board = openBoard(root);
  try {
    const saved = ok(board.read());
    assert(saved.initialized);
    const result = ok(board.change({ boardId: saved.snapshot.boardId, expectedVersion: saved.version,
      operation: { type: 'project.edit', fields: { nextActions: [privateMarker + 'LATER'] } } }));
    assert.equal(result.snapshot.revision, saved.snapshot.revision + 1);
    return result.snapshot.revision;
  } finally { assert.deepEqual(board.close(), { closed: true }); }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(check, label) {
  const end = Math.min(deadline, performance.now() + 5000);
  while (!(await check())) {
    if (performance.now() >= end) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function safeDom(page) {
  const state = await page.evaluate(() => ({
    injected: document.querySelectorAll('img, iframe, [data-glance-fixture]').length,
    handlers: [...document.querySelectorAll('*')].some((node) => [...node.attributes].some(({ name }) => /^on/i.test(name))),
    foreignScripts: [...document.scripts].some((script) => script.type !== 'application/json' &&
      script.textContent.includes('glance-fixture')),
  }));
  assert.deepEqual(state, { injected: 0, handlers: false, foreignScripts: false });
}

async function shot(page, fixture, name) {
  const path = join(fixture, name);
  await page.screenshot({ path, timeout: 5000, animations: 'disabled' });
  receipt.screenshots.push({ path, sha256: hash(readFileSync(path)) });
}

try {
  const fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-public-journey-'));
  receipt.fixture = fixture;
  const root = join(fixture, 'board');
  mkdirSync(root);
  const initial = seed(root);
  const { entry, executablePath } = browserSelection();
  const { chromium } = await import(pathToFileURL(entry).href);
  stage = 'sandboxed Chrome and owned local host';
  host = startFixture(root);
  receipt.hostPid = host.pid;
  const launch = await bounded(host.ready, 8000, 'Host startup timed out');
  assert.match(launch.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const localUrl = launch.origin + '/';
  context = await bounded(chromium.launchPersistentContext(join(fixture, 'chrome-profile'), {
    executablePath, chromiumSandbox: true, headless: true, acceptDownloads: true, serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 }, timeout: 15_000,
  }), 16_000, 'Browser startup timed out');
  context.setDefaultTimeout(4500);
  await context.addInitScript(() => {
    globalThis.glanceCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.glanceCspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI });
    });
  });
  const routeUrl = async (route) => {
    const url = route.request().url();
    if (new URL(url).origin === launch.origin) {
      receipt.requests.local++;
      await route.continue();
    } else if (allowedFile && url === allowedFile && route.request().isNavigationRequest()) {
      receipt.requests.offlineDocument++;
      await route.continue();
    } else {
      receipt.requests.outside++;
      await route.abort();
    }
  };
  await context.route('**/*', routeUrl);
  const watch = (page) => {
    page.on('dialog', (dialog) => {
      receipt.dialogs++;
      void dialog.dismiss().catch(() => {});
    });
    page.on('pageerror', (error) => receipt.browserErrors.push(error.name));
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) receipt.cspViolations.push('console');
    });
    page.on('request', (request) => {
      if (!request.isNavigationRequest()) return;
      const url = request.url();
      if (url !== localUrl && url !== launch.launchUrl && url !== allowedFile) receipt.requests.outside++;
    });
  };
  assert(context.pages().length <= 1);
  const page = context.pages()[0] ?? await context.newPage();
  watch(page);
  context.on('page', (opened) => {
    if (expectedExtraPage) watch(opened);
    else {
      receipt.unexpectedPages++;
      void opened.close().catch(() => {});
    }
  });
  let downloads = 0;
  page.on('download', () => downloads++);
  let freshReads = 0;
  const boardUrl = launch.origin + '/api/board';
  const reportUrl = launch.origin + '/api/public-report';
  page.on('request', (request) => { if (request.url() === boardUrl) freshReads++; });
  await page.goto(launch.launchUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
  await page.locator('#project-name').waitFor();
  stage = 'local truthful headings and review badge colors';
  await page.getByRole('heading', { name: 'Owner-recorded next actions', exact: true }).waitFor();
  const localTasks = page.locator('#task-list');
  for (const [state, color] of [
    ['accepted', 'rgb(231, 242, 233)'], ['stale', 'rgb(255, 240, 212)'], ['changes-requested', 'rgb(255, 240, 212)'],
  ]) {
    const badge = localTasks.locator('.pill.review-' + state);
    assert.equal(await badge.evaluate((node) => getComputedStyle(node).backgroundColor), color);
  }
  await localTasks.getByRole('button', { name: privateMarker + 'FIRST', exact: true }).click();
  const localDetail = page.getByRole('dialog');
  await localDetail.getByRole('heading', { name: 'Depends on this task', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await localDetail.waitFor({ state: 'hidden' });
  receipt.observations.push('local-next-actions-dependents-and-semantic-review-colors');
  await page.getByRole('button', { name: 'Public report', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Public report', exact: true });
  const preview = panel.getByRole('region', { name: 'Public preview' });
  const prepare = panel.getByRole('button', { name: 'Prepare public preview' });
  const projectLabel = panel.getByRole('textbox', { name: 'Project readiness' });
  const checkbox = panel.locator('#confirm-public-report');
  const status = panel.getByRole('status');
  const htmlButton = panel.getByRole('button', { name: 'Download public HTML' });

  async function preparePreview() {
    const response = page.waitForResponse((response) => response.url() === reportUrl && response.ok(), { timeout: 5000 });
    await prepare.click();
    const payload = await (await response).json();
    await preview.waitFor();
    assert.equal(await checkbox.isChecked(), false);
    assert(await htmlButton.isDisabled());
    return payload;
  }

  async function confirmPreview() {
    const before = freshReads;
    await checkbox.click();
    await waitFor(() => checkbox.isChecked(), 'Confirmation did not complete after a saved-board read');
    assert.equal(freshReads, before + 1);
    assert(await htmlButton.isEnabled());
  }

  stage = 'generic preview and complete public disclosure';
  let pack = await preparePreview();
  assert.equal(pack.report.project.label, 'Project readiness');
  assert.equal(pack.report.captured.revision, initial.revision);
  assert.equal(pack.report.tasks[0].label, 'Task 1');
  await preview.getByText('Public data', { exact: true }).click();
  assert.equal(await preview.locator('pre').textContent(), pack.publicJson);
  assert(!(await preview.innerText()).includes(privateMarker));
  assert.equal(downloads, 0);
  receipt.observations.push('generic-unchecked-full-disclosure');

  stage = 'current names, editing, reset and draft invalidation';
  await panel.getByRole('button', { name: 'Use current names' }).click();
  assert.equal(await projectLabel.inputValue(), privateMarker + 'PROJECT');
  assert.equal(await preview.isVisible(), false);
  await projectLabel.fill(authored);
  pack = await preparePreview();
  assert.equal(pack.report.project.label, authored);
  assert.equal(pack.report.tasks[0].label, privateMarker + 'FIRST');
  await confirmPreview();
  await projectLabel.fill('Different public label');
  assert.equal(await preview.isVisible(), false);
  assert.equal(await checkbox.isChecked(), false);
  await panel.getByRole('button', { name: 'Use generic labels' }).click();
  assert.equal(await projectLabel.inputValue(), '');
  pack = await preparePreview();
  assert.equal(pack.report.tasks[0].label, 'Task 1');
  receipt.observations.push('name-opt-in-edit-reset-and-confirmation-cleared');

  stage = 'delayed prepare discarded even after changing back';
  const intercepted = deferred();
  const release = deferred();
  const delivered = deferred();
  const delay = async (route) => {
    try {
      const response = await route.fetch({ timeout: 5000 });
      intercepted.resolve();
      await bounded(release.promise, 5000, 'Delayed response was not released');
      await route.fulfill({ response });
    } finally { delivered.resolve(); }
  };
  await page.route(reportUrl, delay);
  try {
    await prepare.click();
    await bounded(intercepted.promise, 5000, 'Prepare interception did not arrive');
    await projectLabel.fill(authored);
    await projectLabel.fill('');
    const oldResponse = page.waitForResponse((response) => response.url() === reportUrl, { timeout: 5000 });
    release.resolve();
    await bounded(delivered.promise, 5000, 'Delayed response delivery did not finish');
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await preview.isVisible(), false);
    assert.equal(await checkbox.isChecked(), false);
  } finally {
    release.resolve();
    await page.unroute(reportUrl, delay);
  }
  receipt.observations.push('old-prepare-response-discarded');

  stage = 'failed freshness read blocks confirmation';
  pack = await preparePreview();
  const unavailable = (route) => route.abort('failed');
  await page.route(boardUrl, unavailable);
  try {
    const before = freshReads;
    await checkbox.click();
    await waitFor(() => status.textContent().then((text) => /Could not verify/.test(text)), 'Freshness failure not shown');
    assert.equal(freshReads, before + 1);
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await preview.isVisible(), false);
    assert.equal(downloads, 0);
  } finally { await page.unroute(boardUrl, unavailable); }
  receipt.observations.push('failed-freshness-no-download');

  stage = 'malformed same-version read blocks an already confirmed download';
  pack = await preparePreview();
  await confirmPreview();
  const malformed = async (route) => {
    const actual = await route.fetch({ timeout: 5000 });
    const fresh = await actual.json();
    assert.equal(fresh.version, pack.version);
    const snapshot = { ...fresh.snapshot, project: {}, tasks: [], milestones: [], workstreams: [] };
    await route.fulfill({ response: actual, json: { ...fresh, snapshot, report: { counts: {}, acceptance: {}, taskReviews: [] } } });
  };
  await page.route(boardUrl, malformed);
  try {
    const before = freshReads;
    await htmlButton.click();
    await waitFor(() => status.textContent().then((text) => /Could not verify/.test(text)), 'Malformed read did not block download');
    assert.equal(freshReads, before + 1);
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await preview.isVisible(), false);
    assert.equal(downloads, 0);
  } finally { await page.unroute(boardUrl, malformed); }
  receipt.observations.push('malformed-same-version-no-download');

  stage = 'a concurrent saved revision invalidates confirmation';
  pack = await preparePreview();
  await confirmPreview();
  const revision = advance(root);
  const beforeConflict = freshReads;
  await htmlButton.click();
  await waitFor(() => status.textContent().then((text) => /saved board changed/.test(text)), 'Saved revision mismatch not shown');
  assert.equal(freshReads, beforeConflict + 1);
  assert.equal(downloads, 0);
  assert.equal(await checkbox.isChecked(), false);
  assert.equal(await preview.isVisible(), false);
  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  await waitFor(() => page.locator('#freshness').textContent().then((text) => text.includes('Revision ' + revision + ' ·')), 'Refresh did not display the new revision');
  receipt.observations.push('concurrent-revision-no-download');

  stage = 'exact public downloads and literal preview';
  await panel.locator('details[data-group="tasks"] > summary').click();
  await panel.getByRole('textbox', { name: 'Task 1', exact: true }).fill(hostile);
  pack = await preparePreview();
  assert.equal(pack.report.tasks[0].label, hostile);
  assert.equal(await preview.locator('summary').filter({ hasText: 't1 · ' + hostile }).count(), 1);
  assert.equal(await preview.locator('dt').filter({ hasText: /^Current focus$/ }).locator('xpath=following-sibling::dd[1]').textContent(), 't1 · ' + hostile);
  await safeDom(page);
  await confirmPreview();
  for (const [label, filename, key] of [
    ['HTML', 'glance-public.html', 'html'], ['Markdown', 'glance-public.md', 'markdown'], ['JSON', 'glance-public.json', 'publicJson'],
  ]) {
    const before = freshReads;
    const pending = page.waitForEvent('download', { timeout: 5000 });
    await panel.getByRole('button', { name: 'Download public ' + label }).click();
    const download = await pending;
    assert.equal(download.suggestedFilename(), filename);
    const path = join(fixture, filename);
    await download.saveAs(path);
    const bytes = readFileSync(path);
    assert.deepEqual(bytes, Buffer.from(pack[key], 'utf8'));
    assert.equal(hash(bytes), pack.sha256[key]);
    assert.equal(freshReads, before + 1);
    assert(!(bytes.toString().includes(privateMarker)));
    for (const value of initial.privateIds) assert(!(bytes.toString().includes(value)));
    receipt.downloads.push({ path, sha256: hash(bytes) });
    await waitFor(() => status.textContent().then((text) => text.includes('Download initiated for ' + filename)), 'Download status missing');
  }
  assert.equal(downloads, 3);
  receipt.observations.push('exact-three-downloads-with-per-file-freshness');

  stage = 'offline dashboard, semantic badges and keyboard navigation';
  allowedFile = pathToFileURL(join(fixture, 'glance-public.html')).href;
  expectedExtraPage = true;
  const offline = await context.newPage();
  expectedExtraPage = false;
  await offline.goto(allowedFile, { waitUntil: 'load', timeout: 8000 });
  await offline.getByRole('heading', { name: 'Made for human eyes. Built for clear decisions.' }).waitFor();
  const cards = offline.locator('#task-results');
  const search = offline.getByRole('searchbox', { name: 'Search tasks' });
  const first = cards.getByRole('button', { name: 't1 · ' + hostile, exact: true });
  await first.waitFor();
  assert.equal(await offline.locator('#summary > div').count(), 4);
  assert.equal(await offline.locator('header').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(35, 35, 35)');
  assert.equal(await offline.locator('.focus').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 244, 218)');
  const accepted = cards.locator('.pill.accepted');
  assert.equal(await accepted.evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(231, 242, 233)');
  assert.equal(await cards.locator('.pill.stale').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 240, 212)');
  assert.equal(await cards.locator('.pill.changes-requested').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 240, 212)');
  await safeDom(offline);
  await shot(offline, fixture, 'public-desktop.png');
  stage = 'offline search and workflow filter';
  await search.fill('Task 2');
  assert.equal(await cards.getByRole('button').count(), 1);
  await offline.locator('#status-filter').selectOption('In progress');
  await cards.getByText('No tasks match these filters.').waitFor();
  await offline.getByRole('button', { name: 'Clear filters', exact: true }).click();
  stage = 'offline human review filter';
  await offline.locator('#review-filter').selectOption('accepted');
  assert.equal(await cards.getByRole('button').count(), 1);
  await offline.getByRole('button', { name: 'Clear filters', exact: true }).click();
  stage = 'offline table and cards';
  await offline.getByRole('button', { name: 'Table', exact: true }).click();
  assert.equal(await cards.getByRole('row').count(), 4);
  await offline.getByRole('button', { name: 'Cards', exact: true }).click();
  stage = 'offline keyboard detail and focus return';
  const second = cards.getByRole('button', { name: 't2 · Task 2', exact: true });
  await second.focus();
  await offline.keyboard.press('Enter');
  const detail = offline.getByRole('dialog');
  await detail.getByRole('heading', { name: 'Prerequisites' }).waitFor();
  await detail.getByRole('button', { name: 't1 · ' + hostile, exact: true }).click();
  await detail.getByRole('heading', { name: 't1 · ' + hostile, exact: true }).waitFor();
  await detail.getByRole('heading', { name: 'Depends on this task' }).waitFor();
  await shot(offline, fixture, 'public-detail.png');
  await offline.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
  assert(await second.evaluate((node) => document.activeElement === node));
  stage = 'offline Journey view';
  const views = offline.getByRole('navigation', { name: 'Report views' });
  await views.getByRole('button', { name: 'Journey', exact: true }).click();
  await offline.getByRole('heading', { name: 'Workstream membership' }).waitFor();
  stage = 'offline Review view';
  await views.getByRole('button', { name: 'Review', exact: true }).click();
  await offline.getByRole('heading', { name: 'Accepted · 1' }).waitFor();
  await offline.getByRole('heading', { name: 'Stale · 1' }).waitFor();
  stage = 'offline Evidence view';
  await views.getByRole('button', { name: 'Evidence', exact: true }).click();
  await offline.getByText('Evidence references are unique within each task.', { exact: false }).waitFor();
  stage = 'offline Full report view';
  await views.getByRole('button', { name: 'Full report', exact: true }).click();
  await offline.locator('#full').getByRole('columnheader', { name: 'Prerequisites' }).waitFor();
  stage = 'offline workstream filter';
  await views.getByRole('button', { name: 'Overview', exact: true }).click();
  await offline.locator('#workstream-links').getByRole('button', { name: 'Unassigned', exact: true }).click();
  assert.equal(await cards.getByRole('button').count(), 1);
  await offline.getByRole('button', { name: 'Clear filters', exact: true }).click();
  stage = 'offline narrow layout';
  await offline.setViewportSize({ width: 390, height: 844 });
  await first.waitFor();
  assert(await offline.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot(offline, fixture, 'public-narrow.png');
  stage = 'final CSP collection';
  for (const tab of [page, offline]) receipt.cspViolations.push(...await tab.evaluate(() => globalThis.glanceCspViolations));
  await offline.close();
  receipt.observations.push('offline-dashboard-desktop-narrow-keyboard-csp');

  stage = 'host Quit and listener closure';
  await page.getByRole('button', { name: 'Quit', exact: true }).click();
  await page.getByRole('heading', { name: 'Shutdown requested' }).waitFor();
  receipt.hostExit = await host.verifyExit(launch.origin);
  assert(receipt.requests.local > 0);
  assert.equal(receipt.requests.outside, 0);
  assert.equal(receipt.dialogs, 0);
  assert.equal(receipt.unexpectedPages, 0);
  assert.deepEqual(receipt.cspViolations, []);
  assert.deepEqual(receipt.browserErrors, []);
  receipt.status = 'PASSED';
} catch (error) {
  receipt.failures.push({ stage, kind: error instanceof Error ? error.name : 'Error' });
} finally {
  if (context) {
    try {
      await bounded(context.close(), 8000, 'Browser context close timed out');
      receipt.browserContextClosed = true;
    } catch { receipt.failures.push({ stage: 'browser context closure', kind: 'Error' }); }
  }
  if (host) {
    try { receipt.hostCleanup = await host.stopIfNeeded(); }
    catch { receipt.failures.push({ stage: 'host cleanup', kind: 'Error' }); }
  }
}
if (receipt.failures.length || receipt.status !== 'PASSED') {
  receipt.status = 'FAILED';
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else console.log(JSON.stringify(receipt));
