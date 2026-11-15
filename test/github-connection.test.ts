import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openBoard } from '../src/board.ts';
import type { Initialized } from '../src/board.ts';
import { createGithubConnection, githubErrorResponse } from '../src/github.ts';
import { config, githubFixture, jsonReply, responses } from './fixtures/github/host-worker.ts';

const session = 'synthetic-host-session';
const scope = { kind: 'issues', page: 1, pages: 1, linkedTaskIds: [], pullRequestId: null };
const done = new Set(['succeeded', 'failed', 'cancelled']);
const isCode = (code: string) => (error: unknown) => githubErrorResponse(error).error.code === code;
type Connection = ReturnType<typeof createGithubConnection>;

function ready(board: ReturnType<typeof openBoard>): Initialized {
  const value = board.read();
  assert(!('error' in value) && value.initialized);
  return value;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { release, promise };
}
async function until<T>(read: () => T, check: (value: T) => boolean) {
  const end = performance.now() + 3000;
  do {
    const value = read();
    if (check(value)) { await delay(0); return read(); }
    await delay(5);
  } while (performance.now() < end);
  throw new Error('Synthetic operation did not reach its expected state');
}
function startFixture(name: string, use: (fixture: ReturnType<typeof githubFixture> & {
  board: ReturnType<typeof openBoard>; connection: Connection; root: string; version: () => { boardId: string; expectedVersion: string };
}) => Promise<void>) {
  test(name, { timeout: 15_000 }, async (t) => {
    const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-github-connection-'));
    t.diagnostic('Retained owned Board fixture: ' + root);
    const board = openBoard(root);
    assert(!('error' in board.initialize({ kind: 'blank', name: 'Synthetic connection' })));
    const fixture = githubFixture();
    const connection = createGithubConnection(board, root, config, fixture.dependencies);
    try {
      await use({ ...fixture, connection, board, root, version: () => {
        const current = ready(board);
        return { boardId: current.snapshot.boardId, expectedVersion: current.version };
      } });
    } finally {
      await connection.close();
      assert.deepEqual(board.close(), { closed: true });
    }
  });
}
function statusOf(connection: Connection, operationId: string, state?: string) {
  return until(() => connection.status(session, { operationId }),
    (value) => state ? value.state === state : done.has(value.state));
}
async function choose(connection: Connection, version: () => { boardId: string; expectedVersion: string }) {
  const { operationId } = connection.start(session, version());
  await statusOf(connection, operationId, 'choosing-repository');
  connection.discover(session, { operationId, scope: { kind: 'repositories', installationId: '55', page: 1 } });
  const chooser = await statusOf(connection, operationId, 'choosing-repository');
  assert.equal(chooser.repositories?.[0].id, '1234');
  return operationId;
}

startFixture('G02/G06/G09 device and rediscovery, preview import, partial observations and failure metadata', async ({ connection, control, version }) => {
  control.installations = [];
  const { operationId } = connection.start(session, version());
  const absent = await statusOf(connection, operationId, 'choosing-repository');
  assert.equal(absent.code, 'INSTALLATION_REQUIRED');
  assert.deepEqual(absent.installations, []);
  assert.deepEqual(control.sleeps, [5000, 5000, 10000]);
  assert.equal(new URLSearchParams(control.calls[0].body).get('scope'), 'offline_access');
  assert(!JSON.stringify(absent).includes('fixture_access_do_not_display'));
  assert.throws(() => connection.status('other-host', { operationId }), isCode('PREVIEW_EXPIRED'));
  control.installations = [structuredClone(responses.installation)];
  connection.discover(session, { operationId, scope: { kind: 'installations', page: 1 } });
  await statusOf(connection, operationId, 'choosing-repository');
  control.repositories = [];
  connection.discover(session, { operationId, scope: { kind: 'repositories', installationId: '55', page: 1 } });
  assert.equal((await statusOf(connection, operationId, 'choosing-repository')).code, 'REPOSITORY_UNAVAILABLE');
  assert.throws(() => connection.select(session, { ...version(), operationId, repositoryId: '1234' }), isCode('REPOSITORY_UNAVAILABLE'));
  control.repositories = [structuredClone(responses.repository)];
  connection.discover(session, { operationId, scope: { kind: 'repositories', installationId: '55', page: 1 } });
  await statusOf(connection, operationId, 'choosing-repository');
  connection.select(session, { ...version(), operationId, repositoryId: '1234' });
  assert.equal((await statusOf(connection, operationId)).state, 'succeeded');
  assert.equal(control.writes, 2);
  const refresh = connection.refresh(session, { ...version(), scope });
  const captured = await statusOf(connection, refresh.operationId);
  assert.equal(captured.preview?.issues.length, 2);
  assert.equal(captured.preview?.issues[1] && 'ineligible' in captured.preview.issues[1], true);
  assert.throws(() => connection.importIssues(session, { ...version(), operationId: refresh.operationId, issueIds: ['302'] }), isCode('PREVIEW_EXPIRED'));
  const imported = connection.importIssues(session, { ...version(), operationId: refresh.operationId, issueIds: ['301'] });
  assert.equal(imported.report.acceptance.accepted, 0);
  assert.throws(() => connection.importIssues(session, { ...version(), operationId: refresh.operationId, issueIds: ['301'] }), isCode('PREVIEW_EXPIRED'));
  control.clock += 600001;
  assert.throws(() => connection.status(session, { operationId: refresh.operationId }), isCode('PREVIEW_EXPIRED'));
  control.installations[0].permissions.issues = 'none';
  const calls = control.calls.length;
  const failed = connection.refresh(session, { ...version(), scope });
  assert.equal((await statusOf(connection, failed.operationId)).code, 'PERMISSION_REQUIRED');
  assert.deepEqual(control.calls.slice(calls).map(({ path }) => path), ['/user/installations']);
  const cached = connection.overview(session, {});
  assert.equal(cached.lastAttempt?.outcome, 'failed');
  assert.equal(cached.issues.length, 1);
  assert.equal(cached.collections.length, 1);
  assert.equal(control.opens, control.closes);
});

startFixture('G06 safe authorization failure on denial, expiry, oversized response and unsupported encoding', async ({ connection, control, version }) => {
  const cases = [
    [jsonReply({ error: 'access_denied' }), 'AUTH_DENIED'],
    [jsonReply({ error: 'expired_token' }), 'AUTH_EXPIRED'],
    [jsonReply('x'.repeat(16 * 1024)), 'RESPONSE_LIMIT'],
    [jsonReply({}, 200, { 'content-encoding': 'gzip' }), 'RESPONSE_INVALID'],
  ] as const;
  for (const [reply, code] of cases) {
    control.response = async ({ url }) => url.pathname === '/login/device/code' ? jsonReply(responses.device) : reply;
    const { operationId } = connection.start(session, version());
    assert.equal((await statusOf(connection, operationId)).code, code);
    assert.equal(control.opens, control.closes);
    assert.equal(control.writes, 0);
  }
});

startFixture('G07/G10 disconnect retains native owner until late pending-selection write settles', async ({ connection, control, version }) => {
  const operationId = await choose(connection, version);
  const began = deferred(), write = deferred();
  control.beforeWrite = async (bytes) => {
    assert.equal(JSON.parse(bytes.toString()).state, 'pending-selection');
    began.release();
    await write.promise;
  };
  connection.select(session, { ...version(), operationId, repositoryId: '1234' });
  try {
    await Promise.race([began.promise, delay(2500).then(() => { throw new Error('Pending write did not start'); })]);
    const stopped = connection.disconnect(session, version());
    assert.equal(stopped.localDisconnected, true);
    assert.equal(connection.status(session, { operationId: stopped.operationId }).cleanup, 'unknown');
    assert.equal(connection.disconnect(session, version()).operationId, stopped.operationId);
    assert.throws(() => connection.start(session, version()), isCode('CONNECTION_BUSY'));
    assert.equal(control.opens - control.closes, 1);
    assert.throws(() => connection.status(session, { operationId }), isCode('PREVIEW_EXPIRED'));
    write.release();
    const final = await statusOf(connection, stopped.operationId);
    assert.equal(final.cleanup, 'complete');
    assert.equal(control.writes, 1);
    assert.equal(control.deletes, 1);
    assert.equal(control.storage.size, 0);
    assert.equal(control.opens, control.closes);
  } finally { write.release(); }
});

startFixture('G10 settled cleanup rejection still closes its owner and reports uncertainty', async ({ connection, control, version }) => {
  const operationId = await choose(connection, version);
  const began = deferred(), write = deferred();
  control.beforeWrite = async () => { began.release(); await write.promise; };
  connection.select(session, { ...version(), operationId, repositoryId: '1234' });
  try {
    await Promise.race([began.promise, delay(2500).then(() => { throw new Error('Pending write did not start'); })]);
    control.beforeRemove = async () => { throw new Error('Synthetic remove rejection'); };
    const stopped = connection.disconnect(session, version());
    write.release();
    const final = await statusOf(connection, stopped.operationId);
    assert.equal(final.state, 'failed');
    assert.equal(final.cleanup, 'unknown');
    assert.equal(control.opens, control.closes);
    assert.equal(control.storage.size, 1);
    assert(!JSON.stringify(final).includes('Synthetic remove rejection'));
  } finally { write.release(); }
});

startFixture('G04/G07/G10 raw-copy root mismatch and restart do not delete an unproven credential', async ({ connection, control, dependencies, board, root, version }) => {
  const operationId = await choose(connection, version);
  connection.select(session, { ...version(), operationId, repositoryId: '1234' });
  assert.equal((await statusOf(connection, operationId)).state, 'succeeded');
  const foreign = createGithubConnection(board, root + '-different', config, dependencies);
  try {
    const refresh = foreign.refresh(session, { ...version(), scope });
    assert.equal((await statusOf(foreign, refresh.operationId)).code, 'CREDENTIAL_MISMATCH');
    assert.equal(control.deletes, 0);
  } finally { await foreign.close(); }
  control.beforeRemove = async () => { throw new Error('Synthetic uncertainty'); };
  const first = connection.disconnect(session, version());
  assert.equal((await statusOf(connection, first.operationId)).cleanup, 'unknown');
  control.beforeRemove = undefined;
  const reopened = createGithubConnection(board, root, config, dependencies);
  try {
    const second = reopened.disconnect('new-session', version());
    assert.notEqual(second.operationId, first.operationId);
    const final = await until(() => reopened.status('new-session', { operationId: second.operationId }), (value) => done.has(value.state));
    assert.equal(final.cleanup, 'unknown');
    assert.equal(control.storage.size, 1);
    assert.equal(control.deletes, 0);
  } finally { await reopened.close(); }
});

async function activate(connection: Connection, version: () => { boardId: string; expectedVersion: string }) {
  const operationId = await choose(connection, version);
  connection.select(session, { ...version(), operationId, repositoryId: '1234' });
  assert.equal((await statusOf(connection, operationId)).state, 'succeeded');
}

startFixture('G07 rotation commits a whole pair, ambiguous exchange is never reused, and vault faults stay private', async ({ connection, control, version }) => {
  await activate(connection, version);
  const key = [...control.storage.keys()][0];
  const active = JSON.parse(control.storage.get(key)!.toString());
  const expired = { ...active, accessExpiresAt: new Date(control.clock - 1000).toISOString() };
  const rotate = async (ambiguous: boolean) => {
    control.storage.set(key, Buffer.from(JSON.stringify(expired)));
    control.response = async ({ url, body }) => {
      assert.equal(url.href, 'https://github.com/login/oauth/access_token');
      assert.equal(new URLSearchParams(body).get('grant_type'), 'refresh_token');
      assert.equal(JSON.parse(control.storage.get(key)!.toString()).state, 'rotation-pending');
      if (ambiguous) throw new Error('Private transport detail');
      control.response = undefined;
      return jsonReply({ ...responses.pair, refresh_token: 'rotated_fixture_refresh' });
    };
    const { operationId } = connection.refresh(session, { ...version(), scope });
    return statusOf(connection, operationId);
  };
  assert.equal((await rotate(false)).state, 'succeeded');
  assert.equal(JSON.parse(control.storage.get(key)!.toString()).refreshToken, 'rotated_fixture_refresh');
  const failed = await rotate(true);
  assert.equal(failed.code, 'CREDENTIAL_ROTATION_UNCERTAIN');
  assert(!JSON.stringify(failed).includes('Private transport detail'));
  assert.equal(JSON.parse(control.storage.get(key)!.toString()).state, 'rotation-pending');
  control.response = undefined;
  const calls = control.calls.length;
  const again = connection.refresh(session, { ...version(), scope });
  assert.equal((await statusOf(connection, again.operationId)).code, 'CONNECTION_REQUIRED');
  assert.equal(control.calls.length, calls);
  const faults = [
    { data: Buffer.alloc(2401), code: 'CREDENTIAL_MISMATCH' },
    { data: Buffer.from('{'), code: 'CREDENTIAL_MISMATCH' },
    { data: Buffer.from(JSON.stringify(active)), code: 'CREDENTIAL_UNAVAILABLE',
      read: async () => { throw new Error('Native read fault'); } },
  ];
  for (const fault of faults) {
    control.storage.set(key, fault.data);
    control.beforeRead = fault.read;
    const next = connection.refresh(session, { ...version(), scope });
    assert.equal((await statusOf(connection, next.operationId)).code, fault.code);
    assert.equal(control.calls.length, calls);
  }
});

startFixture('G06/G09 reopening revalidates moved pages and stable renames, removed and transferred access fail closed', async ({ connection, control, dependencies, board, root, version }) => {
  await activate(connection, version);
  const reopened = createGithubConnection(board, root, config, dependencies);
  const requests = control.calls.length;
  assert.equal(reopened.overview(session, {}).credentialState, 'unchecked');
  assert.equal(control.calls.length, requests);
  const renamed = { ...responses.repository, name: 'renamed-fixture' };
  const redirect = 'https://api.github.com/repos/fixture-org/renamed-fixture';
  const mode = { name: 'renamed' };
  const next = (url: URL) => {
    const page = new URL(url);
    page.searchParams.set('page', String(Number(url.searchParams.get('page')) + 1));
    return { link: '<' + page.href + '>; rel="next"' };
  };
  control.response = async ({ url }) => {
    const path = url.pathname, page = url.searchParams.get('page');
    if (path === '/user/installations') {
      if (mode.name === 'removed') return jsonReply({ installations: [] });
      if (mode.name === 'page-cap' || page === '1') return jsonReply({ installations: [] }, 200, next(url));
      return jsonReply({ installations: [responses.installation] });
    }
    if (path === '/user/installations/55/repositories') {
      if (mode.name === 'transfer') return jsonReply({ repositories: [{ ...renamed, id: 1235, visibility: 'public' }] });
      return jsonReply({ repositories: [renamed] });
    }
    if (path === '/repositories/1234') return jsonReply({}, 301, {
      location: mode.name === 'hostile-redirect' ? 'https://different.invalid/repos/fixture-org/renamed-fixture' : redirect,
    });
    if (url.href === redirect) return jsonReply(mode.name === 'different-id' ? { ...renamed, id: 1235 } : renamed);
    assert.equal(path, '/repos/fixture-org/renamed-fixture/issues');
    return jsonReply([], 200, mode.name === 'partial' ? next(url) :
      mode.name === 'hostile-link' ? { link: '<https://different.invalid/issues?page=2>; rel="next"' } : {});
  };
  try {
    for (const [name, code] of [['renamed', null], ['partial', null], ['removed', 'INSTALLATION_REQUIRED'],
      ['transfer', 'REPOSITORY_UNAVAILABLE'], ['different-id', 'DESTINATION_MISMATCH'], ['hostile-redirect', 'DESTINATION_MISMATCH'],
      ['hostile-link', 'RESPONSE_INVALID'], ['page-cap', 'OPERATION_LIMIT']] as const) {
      mode.name = name;
      const previousCalls = control.calls.length;
      const { operationId } = reopened.refresh(session, { ...version(), scope });
      const result = await statusOf(reopened, operationId);
      assert.equal(result.code, code);
      const paths = control.calls.slice(previousCalls).map(({ path }) => path);
      if (name === 'renamed') {
        assert.deepEqual(paths, ['/user/installations', '/user/installations', '/user/installations/55/repositories',
          '/repositories/1234', '/repos/fixture-org/renamed-fixture', '/repos/fixture-org/renamed-fixture/issues']);
        assert.equal(result.preview?.collection.count, 0);
      }
      if (name === 'partial') assert.equal(result.preview?.collection.completeness, 'partial');
      if (name === 'page-cap') assert.equal(paths.length, 10);
      if (['removed', 'transfer', 'different-id', 'hostile-redirect', 'page-cap'].includes(name)) {
        assert(!paths.includes('/repos/fixture-org/renamed-fixture/issues'));
      }
    }
  } finally { await reopened.close(); }
});

startFixture('G09 release and review extras discarded, invalid encoding/large bodies and rate limits return safe results', async ({ connection, control, version }) => {
  await activate(connection, version);
  for (const [kind, pullRequestId] of [['releases', null], ['pull-requests', null], ['pull-request-reviews', '401']] as const) {
    const { operationId } = connection.refresh(session, { ...version(), scope: { ...scope, kind, pullRequestId } });
    assert.equal((await statusOf(connection, operationId)).state, 'succeeded');
  }
  const cached = connection.overview(session, {});
  assert.equal(cached.facts.length, 3);
  assert(!JSON.stringify(cached).includes('Discard this'));
  const cases = [
    [jsonReply({}, 429, { 'retry-after': '17' }), 'RATE_LIMITED'],
    [jsonReply({}, 200, { 'content-encoding': 'deflate' }), 'RESPONSE_INVALID'],
    [jsonReply('x'.repeat(2 * 1024 * 1024)), 'RESPONSE_LIMIT'],
  ] as const;
  for (const [reply, expected] of cases) {
    control.response = async ({ url }) => {
      assert.equal(url.pathname, '/user/installations');
      return reply;
    };
    const { operationId } = connection.refresh(session, { ...version(), scope });
    const result = await statusOf(connection, operationId);
    assert.equal(result.code, expected);
    if (expected === 'RATE_LIMITED') assert.equal(result.nextAllowedAt, new Date(control.clock + 17000).toISOString());
    const failed = connection.overview(session, {});
    assert.deepEqual(failed.facts, cached.facts);
    assert.deepEqual(failed.collections, cached.collections);
    assert.equal(failed.lastAttempt?.outcome, 'failed');
  }
});

startFixture('G09/G10 cancellation before the first page and stale edits fence commits and close the owner', async ({ connection, control, board, version }) => {
  await activate(connection, version);
  for (const mode of ['cancel', 'edit', 'disconnect']) {
    const before = connection.overview(session, {});
    const entered = deferred(), remote = deferred();
    control.response = async () => { entered.release(); await remote.promise; return jsonReply({ installations: [responses.installation] }); };
    const { operationId } = connection.refresh(session, { ...version(), scope });
    let stopped = operationId;
    try {
      await Promise.race([entered.promise, delay(2500).then(() => { throw new Error('Request did not start'); })]);
      if (mode === 'cancel') connection.cancel(session, { operationId });
      if (mode === 'edit') assert(!('error' in board.change({ ...version(), operation: { type: 'project.edit', fields: { goal: 'Independent local edit' } } })));
      if (mode === 'disconnect') stopped = connection.disconnect(session, version()).operationId;
      assert.equal(control.opens - control.closes, 1);
    } finally { remote.release(); }
    const result = await statusOf(connection, stopped);
    if (mode === 'cancel') assert.equal(result.state, 'cancelled');
    if (mode === 'edit') assert.equal(result.code, 'REVISION_CONFLICT');
    if (mode === 'disconnect') assert.equal(result.cleanup, 'complete');
    const after = connection.overview(session, {});
    assert.deepEqual(after.collections, before.collections);
    assert.deepEqual(after.facts, before.facts);
    if (mode === 'cancel') assert.equal(after.lastAttempt?.outcome, 'cancelled');
    if (mode === 'edit') assert.deepEqual(after.lastAttempt, before.lastAttempt);
    assert.equal(control.opens, control.closes);
  }
});
startFixture('G09 elapsed and aggregate byte limits stop the batch before commit', async ({ connection, control, version }) => {
  await activate(connection, version);
  const before = connection.overview(session, {});
  control.response = async () => {
    control.clock += 60001;
    return jsonReply({ installations: [responses.installation] });
  };
  const expired = connection.refresh(session, { ...version(), scope });
  assert.equal((await statusOf(connection, expired.operationId)).code, 'OPERATION_LIMIT');
  control.response = async ({ url }) => {
    const at = Number(url.searchParams.get('page'));
    const next = new URL(url);
    next.searchParams.set('page', String(at + 1));
    return jsonReply({ installations: [], ignored: 'x'.repeat(2 * 1024 * 1024 - 100) }, 200,
      { link: '<' + next.href + '>; rel="next"' });
  };
  const calls = control.calls.length;
  const large = connection.refresh(session, { ...version(), scope });
  assert.equal((await statusOf(connection, large.operationId)).code, 'RESPONSE_LIMIT');
  assert.equal(control.calls.length - calls, 5);
  assert.deepEqual(connection.overview(session, {}).collections, before.collections);
});
startFixture('G10 an idle second adapter fences an in-flight owner and exposes only its own disconnect status', async ({ connection, control, board, root, dependencies, version }) => {
  await activate(connection, version);
  const other = createGithubConnection(board, root, config, { ...dependencies, acquire: async (target) => {
    try { return await dependencies.acquire!(target); }
    catch (error) {
      assert.match(String(error), /fixture owner already held/);
      return acquireBusy();
    }
  } });
  function acquireBusy(): never {
    // Use the real connector's fixed busy refusal without opening another pipe.
    connection.start(session, version());
    throw new Error('Busy owner was not refused');
  }
  const arrived = deferred(), request = deferred();
  control.response = async () => { arrived.release(); await request.promise; return jsonReply({ installations: [] }); };
  const original = connection.refresh(session, { ...version(), scope });
  try {
    await Promise.race([arrived.promise, delay(2500).then(() => { throw new Error('Request did not start'); })]);
    const cleanup = other.disconnect('second-host', version());
    assert.notEqual(cleanup.operationId, original.operationId);
    assert.equal(cleanup.cleanup, 'pending');
    assert.throws(() => connection.status(session, { operationId: cleanup.operationId }), isCode('PREVIEW_EXPIRED'));
    await delay(20);
    assert.equal(other.status('second-host', { operationId: cleanup.operationId }).state, 'stopping');
    request.release();
    const old = await statusOf(connection, original.operationId);
    assert.equal(old.code, 'OPERATION_CANCELLED');
    const final = await until(() => other.status('second-host', { operationId: cleanup.operationId }), (value) => done.has(value.state));
    assert.equal(final.cleanup, 'complete');
    assert.equal(control.opens, control.closes);
    assert.equal(control.storage.size, 0);
  } finally {
    request.release();
    await other.close();
  }
});
