import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBoard } from '../src/board.ts';

const deadline = performance.now() + 115_000;
const worker = fileURLToPath(new URL('./fixtures/host-worker.ts', import.meta.url));
const project = 'Project <script type="application/x-glance-fixture">fixture</script>';
const task = 'Task </button><span data-glance-fixture="task">fixture</span>';
const criterion = 'Criterion </p><iframe title="glance-fixture"></iframe>';
const evidenceTitle = 'Evidence <img alt="glance-fixture" onerror="">';
const reviewer = 'Reviewer </h4><script type="application/x-glance-fixture">fixture</script>';
const note = 'Review </article><span data-glance-fixture="note">fixture</span>';
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

function seed(root, locations) {
  const board = openBoard(root);
  try {
    let current = ok(board.initialize({ kind: 'blank', name: project }));
    function change(operation) {
      current = ok(board.change({ boardId: current.snapshot.boardId, expectedVersion: current.version, operation }));
      return current.createdIds;
    }
    change({ type: 'project.edit', fields: { goal: 'Goal </p><span data-glance-fixture="goal">fixture</span>' } });
    const evidenceIds = locations.map((location, index) => change({
      type: 'evidence.add', fields: { title: evidenceTitle + ' ' + (index + 1), scope: 'local', outcome: 'passed', location },
    }).evidenceId);
    const { taskId } = change({ type: 'task.add', fields: {
      title: task, description: 'Description </p><span data-glance-fixture="description">fixture</span>', evidenceIds,
      criteria: [{ requirement: criterion, evidenceIds }],
    } });
    current = ok(board.review({
      boardId: current.snapshot.boardId, expectedVersion: current.version, taskId, confirmed: true, decision: 'accepted',
      reviewer, scope: 'Synthetic safety scope', note,
    }));
    return current;
  } finally { assert.deepEqual(board.close(), { closed: true }); }
}

function htmlEscaped(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function decodeCharacterReferences(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, ref) => {
    if (ref[0] !== '#') return named[ref.toLowerCase()];
    return ref[1].toLowerCase() === 'x' ? String.fromCodePoint(parseInt(ref.slice(2), 16)) : String.fromCodePoint(Number(ref.slice(1)));
  });
}

function assertPrivateExport(html, markdown, locations) {
  assert.match(html, /Private local snapshot/);
  assert.match(markdown, /Private local snapshot/);
  for (const text of [project, task, criterion, evidenceTitle, reviewer, note]) {
    assert(html.includes(htmlEscaped(text)), 'HTML export lost escaped fixture text.');
    assert(decodeCharacterReferences(markdown).includes(text), 'Markdown export lost escaped fixture text.');
    assert(!html.includes(text) && !markdown.includes(text), 'Fixture markup appeared unescaped.');
  }
  for (const location of locations) {
    assert(html.includes(htmlEscaped(location)), 'HTML export lost an evidence location.');
    assert(decodeCharacterReferences(markdown).includes(location), 'Markdown export lost an evidence location.');
  }
  for (const document of [html, markdown]) {
    assert(!/<(?:script|img|iframe)\b|<[a-z][^>]*\son\w+\s*=/i.test(document), 'Injected markup in a private export.');
  }
  for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/gi)) {
    assert(!/^\s*(?:javascript|file|data):/i.test(decodeCharacterReferences(match[1])));
  }
  for (const match of markdown.matchAll(/\]\(\s*<?([^)>\s]+)/g)) {
    assert(!/^\s*(?:javascript|file|data):/i.test(decodeCharacterReferences(match[1])));
  }
}

async function assertSafeDom(page) {
  const actual = await page.evaluate(() => ({
    scripts: [...document.scripts].map((script) => [script.getAttribute('src'), script.type, script.textContent.trim()]),
    injected: document.querySelectorAll('img, iframe, [data-glance-fixture]').length,
    handlers: [...document.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].filter((attribute) => /^on/i.test(attribute.name)).map((attribute) => attribute.name)),
    dangerousDestinations: [...document.querySelectorAll('[href], [src]')].flatMap((element) =>
      ['href', 'src'].filter((name) => /^\s*(?:javascript|file|data):/i.test(element.getAttribute(name) ?? ''))),
  }));
  assert.deepEqual(actual, { scripts: [['/app.js', 'module', '']], injected: 0, handlers: [], dangerousDestinations: [] });
}

let stage = 'preparation';
let fixture;
let host;
let launch;
let context;
let closed;
let hostCleanup;
let browserContextClosed = false;
let failure;
let sentinel;
let sentinelHash;
let sentinelUnchanged;
const screenshots = [];
const downloads = [];
const browserErrors = [];
const requests = { local: 0, outside: 0, outsideSchemes: [] };
let dialogs = 0;
let unexpectedNavigations = 0;
let unexpectedPages = 0;

try {
  const { entry, executablePath } = browserSelection();
  const { chromium } = await import(pathToFileURL(entry).href);
  fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-safety-journey-'));
  const root = join(fixture, 'board');
  const target = join(fixture, 'target');
  mkdirSync(root);
  mkdirSync(target);
  sentinel = join(target, 'sentinel.txt');
  writeFileSync(sentinel, 'KFG-S11 browser sentinel\n', { flag: 'wx' });
  sentinelHash = hash(readFileSync(sentinel));
  const locations = ['javascript:#glance-inert-fixture', pathToFileURL(sentinel).href, 'data:text/plain,glance-inert-fixture'];
  const initial = seed(root, locations);

  stage = 'owned host and sandboxed browser startup';
  host = startFixture(root);
  launch = await bounded(host.ready, 8000, 'Host startup timed out');
  assert.match(launch.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  context = await bounded(chromium.launchPersistentContext(join(fixture, 'chrome-profile'), {
    executablePath, chromiumSandbox: true, headless: true, acceptDownloads: true, serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 }, timeout: 15_000,
  }), 16_000, 'Browser startup timed out');
  context.setDefaultTimeout(4500);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === launch.origin) return route.continue();
    requests.outside++;
    requests.outsideSchemes.push(url.protocol);
    return route.abort();
  });
  assert(context.pages().length <= 1);
  const page = context.pages()[0] ?? await context.newPage();
  context.on('page', (extra) => {
    unexpectedPages++;
    void extra.close().catch(() => {});
  });
  page.on('request', (request) => {
    if (new URL(request.url()).origin === launch.origin) requests.local++;
  });
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss().catch(() => {});
  });
  page.on('framenavigated', (frame) => {
    const url = new URL(frame.url());
    if (frame !== page.mainFrame() || url.origin !== launch.origin || url.pathname !== '/' || url.search) unexpectedNavigations++;
  });
  page.on('pageerror', () => browserErrors.push({ stage, source: 'pageerror' }));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push({ stage, source: 'console-error' });
  });
  await page.goto(launch.launchUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
  const projectHeading = page.locator('#project-name').filter({ hasText: project });
  await projectHeading.waitFor();
  assert.equal(await projectHeading.textContent(), project);
  assert.equal(new URL(page.url()).hash, '');

  stage = 'task, criterion, evidence and history shown as literal text';
  const taskButton = page.locator('#task-list').getByRole('button', { name: task, exact: true });
  await taskButton.click();
  const detail = page.locator('#detail-dialog');
  await detail.waitFor();
  assert.equal(await detail.locator('#detail-title').textContent(), task);
  await detail.getByText(criterion, { exact: true }).waitFor();
  for (const [index, location] of locations.entries()) {
    await detail.getByText(evidenceTitle + ' ' + (index + 1), { exact: true }).waitFor();
    const text = detail.getByText(location, { exact: true });
    await text.waitFor();
    assert(await text.evaluate((element) => element.tagName === 'SPAN' && element.closest('a') === null));
  }
  await detail.getByText('Review history (1)', { exact: true }).click();
  await detail.getByText(note, { exact: true }).waitFor();
  const history = detail.locator('.review-history');
  assert.equal(await history.locator('article > p.muted').textContent(),
    reviewer + ' · ' + initial.snapshot.reviews[0].recordedAt);
  await history.getByText('Original reviewed subject', { exact: true }).click();
  const storedSubject = history.locator('pre');
  await storedSubject.waitFor();
  const stored = JSON.parse(await storedSubject.textContent());
  assert.deepEqual(stored, initial.snapshot.reviews[0].basis);
  await assertSafeDom(page);
  const image = join(fixture, 'literal-task-and-review.png');
  await page.screenshot({ path: image, animations: 'disabled', timeout: 4500 });
  screenshots.push({ path: image, sha256: hash(readFileSync(image)) });

  stage = 'evidence locations in the review form';
  await detail.getByRole('button', { name: 'Review task', exact: true }).click();
  const review = page.locator('#review-dialog');
  await review.waitFor();
  for (const location of locations) {
    const text = review.getByText(location, { exact: true });
    await text.waitFor();
    assert(await text.evaluate((element) => element.tagName === 'SPAN' && element.closest('a') === null));
  }
  assert.equal(await review.getByRole('checkbox').isChecked(), false);
  await assertSafeDom(page);
  await review.getByRole('button', { name: 'Close review' }).click();
  await detail.getByRole('button', { name: 'Close', exact: true }).click();

  stage = 'private HTML and Markdown export downloads';
  const responseEvent = page.waitForResponse((response) =>
    new URL(response.url()).origin === launch.origin && new URL(response.url()).pathname === '/api/export', { timeout: 5000 });
  void responseEvent.catch(() => {});
  await page.getByRole('button', { name: 'Prepare export', exact: true }).click();
  const response = await responseEvent;
  assert.equal(response.status(), 200);
  const pack = await response.json();
  assert.equal(pack.version, initial.version);
  assert.equal(typeof pack.html, 'string');
  assert.equal(typeof pack.markdown, 'string');
  for (const [label, name, key] of [['HTML', 'glance.html', 'html'], ['Markdown', 'glance.md', 'markdown']]) {
    const pending = page.waitForEvent('download', { timeout: 5000 });
    void pending.catch(() => {});
    await page.getByRole('button', { name: 'Download ' + label, exact: true }).click();
    const download = await pending;
    assert.equal(download.suggestedFilename(), name);
    const destination = join(fixture, name);
    await download.saveAs(destination);
    const bytes = readFileSync(destination);
    downloads.push({ path: destination, sha256: hash(bytes) });
    assert.deepEqual(bytes, Buffer.from(pack[key], 'utf8'));
    assert.equal(pack.sha256[key], hash(bytes));
  }
  assertPrivateExport(pack.html, pack.markdown, locations);
  await assertSafeDom(page);

  stage = 'Quit and confirm owned listener closure';
  await page.getByRole('button', { name: 'Quit', exact: true }).click();
  await page.getByText('Shutdown requested', { exact: true }).waitFor();
  closed = await host.verifyExit(launch.origin);
  assert(requests.local > 0);
  assert.equal(requests.outside, 0);
  assert.equal(dialogs, 0);
  assert.equal(unexpectedNavigations, 0);
  assert.equal(unexpectedPages, 0);
  assert.deepEqual(browserErrors, []);
} catch (error) {
  failure = { stage, kind: error instanceof Error ? error.name : 'Error' };
} finally {
  if (context) {
    try {
      await bounded(context.close(), 8000, 'Browser context close timed out');
      browserContextClosed = true;
    } catch { failure ??= { stage: 'browser context closure', kind: 'Error' }; }
  }
  if (host) {
    try { hostCleanup = await host.stopIfNeeded(); }
    catch { failure ??= { stage: 'host fixture closure', kind: 'Error' }; }
  }
  if (sentinelHash !== undefined) {
    try { sentinelUnchanged = hash(readFileSync(sentinel)) === sentinelHash; }
    catch { sentinelUnchanged = false; }
    if (!sentinelUnchanged) failure ??= { stage: 'sentinel preservation', kind: 'AssertionError' };
  }
}
const receipt = {
  status: failure ? 'FAILED' : 'PASSED', failure, fixture, hostPid: host?.pid, hostExit: closed, hostCleanup,
  node: process.version, platform: process.platform,
  browserContextClosed, browserProcessClosure: 'OUTER_OBSERVER_REQUIRED', requests,
  dialogs, unexpectedNavigations, unexpectedPages, browserErrors, sentinelHash, sentinelUnchanged, screenshots, downloads,
};
if (failure) {
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else console.log(JSON.stringify(receipt));
