import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const deadline = performance.now() + 85_000;
const worker = fileURLToPath(new URL('./fixtures/github/host-worker.ts', import.meta.url));
const wait = (promise, label, timeout = 8000) => {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), Math.max(1, Math.min(timeout, deadline - performance.now())));
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
};

function selectedPath(input, type) {
  assert(process.platform === 'win32' && typeof input === 'string' && /^[a-z]:[\\/]/i.test(input));
  const full = win32.normalize(input), actual = realpathSync.native(full);
  assert.equal(actual.toLowerCase(), full.toLowerCase());
  const item = lstatSync(actual);
  assert(type === 'directory' ? item.isDirectory() : item.isFile());
  return actual;
}

async function verifiedClosure(exited, origin) {
  assert.deepEqual(await wait(exited, 'Fixture did not exit'), [0, null]);
  await wait(new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(origin).port) });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Fixture still listening')); });
    socket.once('error', (error) => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(); else reject(error); });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Listener closure uncertain')); });
  }), 'Listener closure unobserved', 1500);
}

export async function runMode(browser, mode, width, exercise) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-github-journey-'));
  console.log(JSON.stringify({ mode, root, retained: true }));
  const child = fork(worker, [root, mode], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  const launch = once(child, 'message');
  let context;
  try {
    context = await browser.newContext({ viewport: { width, height: 820 }, acceptDownloads: true, serviceWorkers: 'block' });
    const [ready] = await wait(Promise.race([launch, exited.then(() => { throw new Error('Fixture exited before launch'); })]), 'Fixture startup expired');
    assert.equal(ready.type, 'ready');
    const { origin } = ready;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const observed = { externalAttempts: 0, dialogs: 0, additionalPages: 0, cspViolations: 0, pageErrors: 0 };
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      observed.externalAttempts++;
      return route.abort();
    });
    await context.exposeBinding('fixtureCspViolation', () => { observed.cspViolations++; });
    await context.addInitScript(() => {
      addEventListener('securitypolicyviolation', () => { void window.fixtureCspViolation(); });
    });
    const page = await context.newPage();
    context.on('page', () => { observed.additionalPages++; });
    page.setDefaultTimeout(6500);
    page.on('pageerror', () => { observed.pageErrors++; });
    page.on('dialog', (dialog) => { observed.dialogs++; void dialog.dismiss(); });
    await page.goto(ready.launchUrl);
    await page.getByLabel('Project name').fill('Fixture board');
    await page.getByRole('button', { name: 'Create blank board' }).click();
    await page.getByRole('heading', { name: 'Fixture board', exact: true }).waitFor();
    await page.locator('#open-github').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement.id === 'github-title');
    try {
      await exercise(page, root);
      await page.getByRole('button', { name: 'Quit', exact: true }).click();
      await verifiedClosure(exited, origin);
    }
    finally { console.log(JSON.stringify({ mode, width, ...observed })); }
    assert.deepEqual(Object.values(observed), [0, 0, 0, 0, 0]);
  } finally {
    try { await context?.close(); }
    finally {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send({ type: 'stop' }, () => {});
        try { await wait(exited, 'Fixture did not stop', 3500); }
        catch { child.kill(); await wait(exited, 'Fixture closure unknown after termination', 2500); }
      }
    }
  }
}

async function cachedClearInterleave(page) {
  await page.getByText('Manage cached observations', { exact: true }).click();
  await page.getByLabel(/Releases \(1\)/).check();
  await page.getByLabel('Clear the selected kinds from this board.').check();
  let intercepted;
  const waiting = new Promise((resolve) => { intercepted = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let clearRequests = 0;
  const origin = new URL(page.url()).origin;
  await page.route(origin + '/api/github/clear-facts', (route) => { clearRequests++; return route.continue(); });
  await page.route(origin + '/api/github/overview', async (route) => { intercepted(); await gate; await route.continue(); }, { times: 1 });
  try {
    await page.getByRole('button', { name: 'Clear selected observations' }).click();
    await wait(waiting, 'Clear freshness request was not intercepted');
    await page.evaluate(async () => {
      const authorization = 'Bearer ' + sessionStorage.getItem('kitflint.glance.session');
      const snapshot = await fetch('/api/board', { headers: { Authorization: authorization } }).then((response) => response.json());
      const reply = await fetch('/api/change', { method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId: snapshot.snapshot.boardId, expectedVersion: snapshot.version,
          operation: { type: 'project.edit', fields: { goal: 'Interleaved local edit' } } }) });
      if (!reply.ok) throw new Error('Interleaved edit failed');
    });
    await page.getByRole('button', { name: 'Refresh board' }).click();
    await page.getByRole('button', { name: 'Clear selected observations' }).waitFor({ state: 'hidden' });
  } finally { release(); }
  await page.waitForLoadState('networkidle');
  assert.equal(clearRequests, 0);
  await page.getByText('Cached observations (1)', { exact: true }).waitFor();
}

async function connected(page, root) {
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('TEST-1234', { exact: true }).waitFor();
  await page.getByText(/If access is pending/).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Create a repository' }).getAttribute('href'), 'https://github.com/new');
  await page.getByRole('button', { name: 'Check again' }).click();
  await page.getByRole('button', { name: 'fixture-org · Organization' }).click();
  await page.getByText(/No accessible repositories on this page/).waitFor();
  await page.getByRole('button', { name: 'Check again' }).click();
  await page.getByRole('button', { name: 'fixture-org · Organization' }).click();
  const confirm = page.getByRole('button', { name: 'Confirm repository' });
  assert(await confirm.isDisabled());
  await page.getByLabel(/Use fixture-org\/private-fixture-repo/).check();
  await confirm.click();
  await page.getByText('Credential verified in this session.').waitFor();
  await page.screenshot({ path: join(root, 'connected.png'), fullPage: true });
  await page.getByRole('button', { name: 'Refresh selected scope' }).click();
  await page.getByLabel(/Fixture issue/).check();
  assert.equal(await page.locator('#github-content img').count(), 0);
  await page.getByRole('button', { name: 'Import selected issues' }).click();
  await page.getByRole('heading', { name: 'Linked issues' }).waitFor();
  await page.getByRole('button', { name: 'Close GitHub' }).click();
  await page.locator('#task-list').getByRole('button', { name: /Fixture issue/ }).click();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  await page.getByLabel('Task title').fill('Local edit');
  await page.locator('#edit-form button[type=submit]').click();
  await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
  if (await page.locator('#detail-dialog').isVisible()) await page.locator('#close-detail').click();
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  await page.getByLabel(/#31 Local edit/).check();
  await page.getByRole('button', { name: 'Refresh selected scope' }).click();
  await page.getByRole('heading', { name: 'Conflict in title' }).waitFor();
  await page.screenshot({ path: join(root, 'conflict.png'), fullPage: true });
  await page.getByRole('button', { name: 'Keep local' }).click();
  await page.getByText('Local edits pending for title.').waitFor();
  await page.getByLabel('Category').selectOption('releases');
  await page.getByRole('button', { name: 'Refresh selected scope' }).click();
  await page.getByText('Cached observations (1)', { exact: true }).waitFor();
  await cachedClearInterleave(page);
  // Pull-request facts carry no title; the review picker must still label them meaningfully.
  await page.getByLabel('Category').selectOption('pull-requests');
  await page.getByRole('button', { name: 'Refresh selected scope' }).click();
  await page.getByText('Cached observations (2)', { exact: true }).waitFor();
  await page.getByLabel('Category').selectOption('pull-request-reviews');
  assert.deepEqual(await page.locator('#github-panel select option', { hasText: '#41' }).allInnerTexts(), ['#41 · open · into main']);
  await page.getByRole('button', { name: 'Disconnect locally' }).click();
  await page.getByText('Local credential cleanup confirmed.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Review or revoke access on GitHub' }).getAttribute('href'),
    'https://github.com/settings/installations');
  await page.getByRole('button', { name: 'Close GitHub' }).click();
  await page.getByRole('button', { name: 'Public report', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare public preview' }).click();
  await page.locator('#public-preview-content').waitFor();
  const published = await page.locator('#public-preview-content').innerText();
  for (const privateValue of ['private-fixture-repo', 'fixture-org', 'Private fixture issue body', 'Local edit', 'v1.0']) {
    assert(!published.includes(privateValue));
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

export async function selectedBrowser() {
  const root = selectedPath(process.env.KFG_PLAYWRIGHT_ROOT, 'directory');
  const executablePath = selectedPath(process.env.KFG_CHROME_EXECUTABLE, 'file');
  assert.equal(basename(executablePath).toLowerCase(), 'chrome.exe');
  for (const [folder, name] of [[root, 'playwright'], [join(dirname(root), 'playwright-core'), 'playwright-core']]) {
    const pkg = JSON.parse(readFileSync(selectedPath(join(folder, 'package.json'), 'file'), 'utf8'));
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, '1.62.1');
  }
  const { chromium } = await import(pathToFileURL(selectedPath(join(root, 'index.mjs'), 'file')).href);
  return chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 12000 });
}
if (import.meta.main) {
  const browser = await selectedBrowser();
  try {
    await runMode(browser, 'offline', 390, async (page) => {
      await page.getByText('GitHub connection is not configured in this build.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Sign in' }).count(), 0);
      await page.getByRole('button', { name: 'Close GitHub' }).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'open-github');
    });
    for (const width of [1440, 390]) await runMode(browser, 'configured', width, connected);
  } finally { await browser.close(); }
  console.log(JSON.stringify({ G12: 'passed', provider: 'synthetic' }));
}
