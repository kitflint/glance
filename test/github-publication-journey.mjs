import assert from 'node:assert/strict';
import { runMode, selectedBrowser } from './github-journey.mjs';

const localRoute = (page, path) => new URL(path, page.url()).href;
const isPath = (request, path) => new URL(request.url()).pathname === path;
const overviewPath = '/api/github/overview';
const boardPath = '/api/board';
const previewPath = '/api/github/publish-preview';
const confirmPath = '/api/github/publish-confirm';

async function localBoard(page) {
  return page.evaluate(async () => {
    const token = sessionStorage.getItem('kitflint.glance.session');
    const response = await fetch('/api/board', { headers: { Authorization: 'Bearer ' + token } });
    const board = await response.json();
    if (!response.ok || !board.initialized) throw new Error('Fixture board read failed');
    return board;
  });
}

async function advanceTitle(page, board, taskId, title) {
  return page.evaluate(async ({ boardId, expectedVersion, taskId, title }) => {
    const token = sessionStorage.getItem('kitflint.glance.session');
    const response = await fetch('/api/change', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardId, expectedVersion, operation: { type: 'task.edit', id: taskId, fields: { title } } }),
    });
    const saved = await response.json();
    if (!response.ok || saved.committed !== true) throw new Error('Fixture title advance failed');
    return saved;
  }, { boardId: board.snapshot.boardId, expectedVersion: board.version, taskId, title });
}

async function editTitle(page, title, nextTitle) {
  await page.locator('#task-list').getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  await page.getByLabel('Task title').fill(nextTitle);
  const saved = page.waitForResponse((response) => isPath(response.request(), '/api/change'));
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const reply = await saved;
  const board = await reply.json();
  assert(reply.ok() && board.committed === true);
  await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
  if (await page.locator('#detail-dialog').isVisible()) await page.locator('#close-detail').click();
  return board;
}

async function holdLocalReply(page, path) {
  const url = localRoute(page, path);
  const entered = Promise.withResolvers();
  // A route can fail before the caller starts awaiting captured().
  void entered.promise.catch(() => {});
  const released = Promise.withResolvers();
  const done = Promise.withResolvers();
  const handler = async (route) => {
    try {
      const response = await route.fetch({ timeout: 4000, maxRedirects: 0, maxRetries: 0 });
      assert(response.ok());
      const body = await response.body();
      entered.resolve(body);
      await released.promise;
      await route.fulfill({ response, body });
    } catch (error) {
      entered.reject(error);
      throw error;
    } finally {
      done.resolve();
    }
  };
  await page.route(url, handler, { times: 1 });
  return {
    async captured() {
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('No intercepted response for ' + path)), 5500);
      });
      try { return await Promise.race([entered.promise, deadline]); }
      finally { clearTimeout(timer); }
    },
    async release() {
      released.resolve();
      await done.promise;
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    },
    async dispose() {
      released.resolve();
      await page.unroute(url, handler);
    },
  };
}

async function readOrdering(page, panel, openPanel, taskId, previousOverview) {
  const closePanel = () => panel.getByRole('button', { name: 'Close GitHub', exact: true }).click();
  const refreshBoard = () => page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  const selector = panel.getByText('Review GitHub changes', { exact: true });
  const scopedRefresh = panel.getByRole('button', { name: 'Refresh selected scope', exact: true });
  const deliberateRefresh = panel.getByRole('button', { name: 'Refresh saved GitHub state', exact: true });
  const freshness = page.locator('#freshness');
  const checkBoard = async (saved, title) => {
    await page.locator('#task-list').getByRole('button', { name: title, exact: true }).waitFor();
    assert.match(await freshness.innerText(), new RegExp('^Revision ' + saved.snapshot.revision + ' '));
  };
  const checkPanel = async (title) => {
    await selector.waitFor();
    await panel.getByRole('heading', { name: '#51 ' + title, exact: true }).waitFor();
  };

  // A newer overview load wins even if Board identity and version did not change.
  const duplicate = await holdLocalReply(page, overviewPath);
  try {
    await refreshBoard();
    await duplicate.captured();
    await selector.waitFor({ state: 'hidden' });
    await refreshBoard();
    await checkPanel('Mapped update fixture');
    const currentSelector = await selector.elementHandle();
    try {
      await duplicate.release();
      assert(await currentSelector.evaluate((element) => element.isConnected));
    } finally { await currentSelector.dispose(); }
  } finally { await duplicate.dispose(); }

  // Panel lifetime also fences an overview received after closing and reopening.
  const obsolete = await holdLocalReply(page, overviewPath);
  try {
    await refreshBoard();
    await obsolete.captured();
    await closePanel();
    await openPanel();
    await checkPanel('Mapped update fixture');
    const currentSelector = await selector.elementHandle();
    try {
      await obsolete.release();
      assert(await currentSelector.evaluate((element) => element.isConnected));
    } finally { await currentSelector.dispose(); }
  } finally { await obsolete.dispose(); }

  const openMismatched = async (exercise) => {
    await closePanel();
    const url = localRoute(page, overviewPath);
    const staleOverview = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: previousOverview });
    const heldBoard = await holdLocalReply(page, boardPath);
    try {
      await page.route(url, staleOverview, { times: 1 });
      await openPanel();
      const captured = JSON.parse(await heldBoard.captured());
      await selector.waitFor({ state: 'hidden' });
      await exercise(heldBoard, captured);
    } finally {
      try { await heldBoard.dispose(); }
      finally { await page.unroute(url, staleOverview); }
    }
  };

  let latest;
  await openMismatched(async (heldBoard, captured) => {
    latest = await editTitle(page, 'Mapped update fixture', 'Saved during held Board read');
    assert.equal(latest.snapshot.revision, captured.snapshot.revision + 1);
    await checkPanel('Saved during held Board read');
    const currentSelector = await selector.elementHandle();
    try {
      await heldBoard.release();
      await checkBoard(latest, 'Saved during held Board read');
      await checkPanel('Saved during held Board read');
      assert(await currentSelector.evaluate((element) => element.isConnected));
    } finally { await currentSelector.dispose(); }
  });
  await openMismatched(async (heldBoard, captured) => {
    const title = 'Saved before panel reopen';
    assert.equal(captured.version, latest.version);
    const newer = await advanceTitle(page, captured, taskId, title);
    await closePanel();
    await openPanel();
    await checkPanel(title);
    const currentSelector = await selector.elementHandle();
    try {
      await heldBoard.release();
      await checkBoard(newer, title);
      assert(await currentSelector.evaluate((element) => element.isConnected));
    } finally { await currentSelector.dispose(); }
    latest = newer;
  });

  // External adoption uses the matching Board, without recursively loading overview again.
  const reads = { overview: 0, board: 0 };
  const recordRead = (request) => {
    if (isPath(request, overviewPath)) reads.overview++;
    if (isPath(request, boardPath)) reads.board++;
  };
  page.on('request', recordRead);
  try {
    await closePanel();
    latest = await advanceTitle(page, latest, taskId, 'Externally adopted title');
    await openPanel();
    await checkBoard(latest, 'Externally adopted title');
    await checkPanel('Externally adopted title');
    assert.deepEqual(reads, { overview: 1, board: 1 });

    // Save again while overview V is held, so the second read returns V+1.
    await closePanel();
    const observed = await advanceTitle(page, latest, taskId, 'Overview version only');
    const heldOverview = await holdLocalReply(page, overviewPath);
    try {
      await openPanel();
      assert.equal(JSON.parse(await heldOverview.captured()).version, observed.version);
      latest = await advanceTitle(page, observed, taskId, 'Board newer than overview');
      await heldOverview.release();
      await checkBoard(latest, 'Board newer than overview');
      await deliberateRefresh.waitFor();
      assert.equal(await selector.count(), 0);
      assert.equal(await scopedRefresh.count(), 0);
      assert.deepEqual(reads, { overview: 2, board: 2 });
      await deliberateRefresh.click();
      await checkPanel('Board newer than overview');
      assert.deepEqual(reads, { overview: 3, board: 2 });
    } finally { await heldOverview.dispose(); }
  } finally { page.off('request', recordRead); }
}

async function exercise(page) {
  const panel = page.locator('#github-panel');
  await panel.getByRole('button', { name: 'Sign in', exact: true }).click();
  await panel.getByText('TEST-1234', { exact: true }).waitFor();
  await panel.getByText(/If access is pending/).waitFor();
  await panel.getByRole('button', { name: 'Check again' }).click();
  await panel.getByRole('button', { name: 'fixture-org · Organization' }).click();
  await panel.getByText(/No accessible repositories on this page/).waitFor();
  await panel.getByRole('button', { name: 'Check again' }).click();
  await panel.getByRole('button', { name: 'fixture-org · Organization' }).click();
  await panel.getByLabel(/Use fixture-org\/private-fixture-repo/).check();
  await panel.getByRole('button', { name: 'Confirm repository' }).click();
  await panel.getByText('Credential verified in this session.').waitFor();
  await panel.getByRole('button', { name: 'Close GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const hostile = '<img src=x onerror=alert(1)> Publish fixture';
  await page.getByLabel('Task title').fill(hostile);
  await page.getByLabel('Description', { exact: true }).fill('Private draft text omitted on first send');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
  await page.locator('#open-github').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'github-title');

  const requestPreview = async () => {
    await panel.getByText('Review GitHub changes', { exact: true }).click();
    await panel.getByLabel(hostile, { exact: true }).check();
    assert.equal(await panel.getByLabel('Include description').isChecked(), false);
    await panel.getByRole('button', { name: 'Review selected GitHub changes' }).click();
    const preview = panel.getByRole('heading', { name: 'Confirm GitHub publication' });
    await preview.waitFor();
    await page.waitForFunction(() => document.activeElement.id === 'github-publication-preview-heading');
    return preview.locator('..');
  };
  let preview = await requestPreview();
  await preview.getByText(/fixture-org\/private-fixture-repo · private · ID 1234/).waitFor();
  await preview.getByText('Description omitted.', { exact: true }).waitFor();
  assert((await preview.innerText()).includes(hostile));
  assert(!(await preview.innerText()).includes('Private draft text omitted on first send'));
  assert.equal(await preview.locator('img').count(), 0);
  await preview.getByRole('button', { name: 'Discard preview' }).click();
  await preview.waitFor({ state: 'hidden' });
  preview = await requestPreview();
  const publish = preview.getByRole('button', { name: 'Publish confirmed changes' });
  assert(await publish.isDisabled());
  await preview.getByLabel('I confirm sending the displayed fields.').check();
  assert(await publish.isDisabled());
  await preview.getByLabel('I checked the repository for an existing issue.').check();
  await publish.click();
  const result = panel.getByRole('heading', { name: 'GitHub publication results' });
  await result.waitFor();
  await result.locator('..').getByText(/Confirmed .*Issue #51/).waitFor();
  await page.waitForFunction(() => document.activeElement.id === 'github-publication-results-heading');
  await panel.getByRole('heading', { name: 'GitHub publication history' }).waitFor();
  await panel.getByRole('heading', { name: 'Linked issues' }).waitFor();

  const openPanel = async () => {
    await page.locator('#open-github').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement.id === 'github-title');
  };
  const oldRefresh = await panel.getByRole('button', { name: 'Refresh selected scope', exact: true }).evaluateHandle((button) => button.form);
  const oldState = await panel.getByRole('button', { name: 'Save issue state', exact: true }).elementHandle();
  const unexpected = [];
  const previews = [];
  const recordRequest = (request) => {
    if (['/api/github/refresh', '/api/github/issue-state', confirmPath].some((path) => isPath(request, path))) unexpected.push(request);
    if (isPath(request, previewPath)) previews.push(request);
  };
  page.on('request', recordRequest);
  const older = await holdLocalReply(page, overviewPath);
  let previousOverview;
  let saved;
  try {
    await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
    previousOverview = await older.captured();
    await panel.getByText('Review GitHub changes', { exact: true }).waitFor({ state: 'hidden' });
    saved = await editTitle(page, hostile, 'Mapped update fixture');
    await panel.getByRole('heading', { name: '#51 Mapped update fixture', exact: true }).waitFor();
    const currentSelector = await panel.getByText('Review GitHub changes', { exact: true }).elementHandle();
    try {
      await older.release();
      assert(await currentSelector.evaluate((element) => element.isConnected));
    } finally { await currentSelector.dispose(); }
    await oldRefresh.evaluate((form) => {
      if (form.isConnected) throw new Error('Old refresh form is still connected');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await oldState.evaluate((button) => {
      if (button.isConnected) throw new Error('Old issue-state control is still connected');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal((await localBoard(page)).version, saved.version);
    assert.equal(unexpected.length, 0);
    await panel.getByText('Review GitHub changes', { exact: true }).click();
    await panel.getByLabel('Mapped update fixture', { exact: true }).check();
    const mapped = panel.getByRole('group', { name: 'Issue #51', exact: true });
    for (const label of ['Title', 'Description', 'Issue state']) assert.equal(await mapped.getByLabel(label, { exact: true }).isChecked(), false);
    await mapped.getByLabel('Title', { exact: true }).check();
    assert.equal(previews.length, 0);
    await panel.getByRole('button', { name: 'Review selected GitHub changes' }).click();
    const taskId = saved.snapshot.tasks.find(({ title }) => title === 'Mapped update fixture').id;
    const patch = panel.getByRole('heading', { name: 'Confirm GitHub publication' }).locator('..');
    await patch.getByText('Before · ' + hostile, { exact: true }).waitFor();
    await patch.getByText('Send · Mapped update fixture', { exact: true }).waitFor();
    assert.equal(previews.length, 1);
    assert.deepEqual(previews[0].postDataJSON(), { expectedVersion: saved.version, items: [{ taskId, fields: ['title'] }] });
    assert.equal(await patch.getByLabel('I checked the repository for an existing issue.').count(), 0);
    await patch.getByLabel('I confirm sending the displayed fields.').check();
    assert.equal(unexpected.length, 0);
    await patch.getByRole('button', { name: 'Publish confirmed changes' }).click();
    await panel.getByText('Published; refresh to reconcile.', { exact: true }).waitFor();
    assert.equal(unexpected.length, 1);
    assert(isPath(unexpected[0], confirmPath));
    page.off('request', recordRequest);
    await readOrdering(page, panel, openPanel, taskId, previousOverview);
  } finally {
    page.off('request', recordRequest);
    await older.dispose();
    await oldRefresh.dispose();
    await oldState.dispose();
  }

  // Board acceptance invalidates an already-reviewed preview. Keep the confirmed publication in history.
  const staleTitle = 'Board newer than overview';
  // A confirmed send stays merge-pending until GitHub is refreshed; publishing again before that is refused by design.
  await panel.getByLabel('#51 ' + staleTitle, { exact: true }).check();
  const reconciled = page.waitForResponse((response) => isPath(response.request(), '/api/github/refresh'));
  await panel.getByRole('button', { name: 'Refresh selected scope', exact: true }).click();
  assert((await reconciled).ok());
  await panel.getByText('Review GitHub changes', { exact: true }).waitFor();
  assert.equal(await panel.getByText('Pending local change after publication.', { exact: true }).count(), 0);
  await panel.getByText('Review GitHub changes', { exact: true }).click();
  await panel.getByLabel(staleTitle, { exact: true }).check();
  await panel.getByRole('group', { name: 'Issue #51', exact: true }).getByLabel('Title', { exact: true }).check();
  await panel.getByRole('button', { name: 'Review selected GitHub changes' }).click();
  const stalePreview = panel.getByRole('heading', { name: 'Confirm GitHub publication' }).locator('..');
  await stalePreview.getByLabel('I confirm sending the displayed fields.').check();
  const staleConfirm = await stalePreview.getByRole('button', { name: 'Publish confirmed changes' }).elementHandle();
  const invalidated = page.waitForRequest((request) => isPath(request, '/api/github/preview-invalidate'));
  const staleRequests = [];
  const recordConfirm = (request) => { if (isPath(request, confirmPath)) staleRequests.push(request); };
  page.on('request', recordConfirm);
  try {
    const renamed = 'Saved after reviewing preview';
    const fresh = await editTitle(page, staleTitle, renamed);
    await invalidated;
    await stalePreview.waitFor({ state: 'hidden' });
    await panel.getByRole('heading', { name: '#51 ' + renamed, exact: true }).waitFor();
    await staleConfirm.evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal((await localBoard(page)).version, fresh.version);
    assert.equal(staleRequests.length, 0);
    await panel.getByRole('heading', { name: 'GitHub publication history' }).locator('..').getByText(/Confirmed/).first().waitFor();
  } finally {
    page.off('request', recordConfirm);
    await staleConfirm.dispose();
  }

  await panel.getByRole('button', { name: 'Close GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByLabel('Task title').fill('Unknown create fixture');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.locator('#edit-dialog').waitFor({ state: 'hidden' });
  await openPanel();
  await panel.getByText('Review GitHub changes', { exact: true }).click();
  await panel.getByLabel('Unknown create fixture', { exact: true }).check();
  await panel.getByRole('button', { name: 'Review selected GitHub changes' }).click();
  const uncertain = panel.getByRole('heading', { name: 'Confirm GitHub publication' }).locator('..');
  await uncertain.getByLabel('I confirm sending the displayed fields.').check();
  await uncertain.getByLabel('I checked the repository for an existing issue.').check();
  await uncertain.getByRole('button', { name: 'Publish confirmed changes' }).click();
  await panel.getByText(/Outcome unknown/).first().waitFor();
  const history = panel.getByRole('heading', { name: 'Unknown create fixture', exact: true }).locator('..');
  await history.getByLabel('Issue number').fill('52');
  await history.getByRole('button', { name: 'Inspect GitHub issue' }).click();
  const observation = panel.getByRole('heading', { name: 'Confirm GitHub inspection' }).locator('..');
  await observation.getByText(/earlier request’s origin cannot be proven/).waitFor();
  await observation.getByText('Issue #52 · ID 1052', { exact: true }).waitFor();
  assert(await observation.getByRole('button', { name: 'Save confirmed inspection' }).isDisabled());
  await observation.getByLabel('I confirm this GitHub observation.').check();
  await observation.getByRole('button', { name: 'Save confirmed inspection' }).click();
  await history.getByText('Later inspection · linked · #52', { exact: true }).waitFor();
  await history.getByText(/Outcome unknown/).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

const browser = await selectedBrowser();
try {
  for (const width of [1440, 390]) await runMode(browser, 'publication', width, exercise);
} finally { await browser.close(); }
console.log(JSON.stringify({ P25: 'passed', provider: 'synthetic' }));

