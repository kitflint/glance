import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openBoard } from '../src/board.ts';
import { createGithubConnection, githubErrorResponse } from '../src/github.ts';
import { startHost } from '../src/host.ts';
import { config, githubFixture, jsonReply, responses } from './fixtures/github/host-worker.ts';

const session = 'publication-fixture';
type Connection = ReturnType<typeof createGithubConnection>;
type Board = ReturnType<typeof openBoard>;
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
function snapshot(board: Board) {
  const ready = board.read();
  assert(!('error' in ready) && ready.initialized);
  return ready;
}
function identity(board: Board) {
  const ready = snapshot(board);
  return { boardId: ready.snapshot.boardId, expectedVersion: ready.version };
}
async function waitStatus(connection: Connection, operationId: string, expected?: string) {
  const until = performance.now() + 5000;
  do {
    const status = connection.status(session, { operationId });
    if (expected ? status.state === expected : terminal.has(status.state)) {
      await delay(0);
      return connection.status(session, { operationId });
    }
    await delay(5);
  } while (performance.now() < until);
  throw new Error('Publication fixture deadline');
}
function add(board: Board, title = 'Local publication title') {
  const value = board.change({ ...identity(board), operation: { type: 'task.add', fields: { title, description: 'Private text' } } });
  assert(!('error' in value));
  return value.createdIds.taskId!;
}
function edit(board: Board, taskId: string, title: string) {
  const value = board.change({ ...identity(board), operation: { type: 'task.edit', id: taskId, fields: { title } } });
  assert(!('error' in value));
}
async function preview(connection: Connection, board: Board, taskIds: string[]) {
  const begin = connection.publishPreview(session, { expectedVersion: snapshot(board).version,
    items: taskIds.map((taskId) => ({ taskId, fields: ['title'] })) });
  return waitStatus(connection, begin.operationId);
}
async function send(connection: Connection, board: Board, operationId: string, create = true) {
  const confirmation = connection.publishConfirm(session, { operationId, expectedVersion: snapshot(board).version, confirmed: true,
    ...(create ? { existingIssuesChecked: true } : {}) });
  const done = await waitStatus(connection, confirmation.operationId);
  assert(done.publication?.kind === 'publishing');
  return done;
}
function testConnection(name: string, exercise: (input: ReturnType<typeof githubFixture> & { board: Board; connection: Connection }) => Promise<void>,
  wrap?: (board: Board) => Parameters<typeof createGithubConnection>[0]) {
  test(name, { timeout: 20000 }, async (t) => {
    const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-publication-connection-'));
    t.diagnostic('Retained owned Board fixture: ' + root);
    const board = openBoard(root);
    const fixture = githubFixture();
    fixture.control.publication = true;
    fixture.control.repositories[0].permissions.push = true;
    const connection = createGithubConnection(wrap?.(board) ?? board, root, config, fixture.dependencies);
    try {
      assert(!('error' in board.initialize({ kind: 'blank', name: 'Publication fixture' })));
      const auth = connection.start(session, identity(board));
      await waitStatus(connection, auth.operationId, 'choosing-repository');
      connection.discover(session, { operationId: auth.operationId, scope: { kind: 'repositories', installationId: '55', page: 1 } });
      await waitStatus(connection, auth.operationId, 'choosing-repository');
      connection.select(session, { ...identity(board), operationId: auth.operationId, repositoryId: '1234' });
      assert.equal((await waitStatus(connection, auth.operationId)).state, 'succeeded');
      await exercise({ ...fixture, board, connection });
    } finally { await connection.close(); assert.deepEqual(board.close(), { closed: true }); }
  });
}
const mutations = (control: ReturnType<typeof githubFixture>['control']) =>
  control.calls.filter(({ method, path }) => method === 'PATCH' || (method === 'POST' && path.startsWith('/repos/')));

testConnection('P05 missing, unchecked, uninspected, invalidated and stale previews never send', async ({ board, control, connection }) => {
  const task = add(board);
  let reviewed = await preview(connection, board, [task]);
  assert(reviewed.publication?.kind === 'publish-preview');
  const args = { expectedVersion: snapshot(board).version, operationId: reviewed.operationId };
  assert.throws(() => connection.publishConfirm(session, { ...args, confirmed: true }));
  assert.throws(() => connection.publishConfirm(session, { ...args, confirmed: false, existingIssuesChecked: true }));
  assert.throws(() => connection.publishConfirm('other', { ...args, confirmed: true, existingIssuesChecked: true }));
  connection.previewInvalidate(session, { operationId: reviewed.operationId });
  assert.throws(() => connection.publishConfirm(session, { ...args, confirmed: true, existingIssuesChecked: true }));
  reviewed = await preview(connection, board, [task]);
  edit(board, task, 'Newer title');
  assert.throws(() => connection.publishConfirm(session, { operationId: reviewed.operationId, expectedVersion: snapshot(board).version,
    confirmed: true, existingIssuesChecked: true }));
  assert.equal(mutations(control).length, 0);
});

testConnection('P06/P09/P11 exact create and update payloads, durable marker and complete readback', async ({ board, control, connection }) => {
  const task = add(board);
  control.publicationReply = async ({ method, body }) => {
    const saved = snapshot(board).snapshot;
    assert(saved.schemaVersion === 4);
    assert(saved.publication.records.at(-1)?.attemptedAt);
    assert.equal(saved.publication.records.at(-1)?.outcome, null);
    const fields = JSON.parse(body!);
    const issue = { id: 1051, number: 51, title: fields.title, body: '', state: 'open',
      updated_at: '2026-11-13T03:00:00Z' };
    control.createdIssues.set(51, issue);
    return jsonReply(issue, method === 'POST' ? 201 : 200);
  };
  const first = await preview(connection, board, [task]);
  const created = await send(connection, board, first.operationId);
  assert(created.publication?.kind === 'publishing');
  assert.deepEqual(created.publication.results.map((row) => [row.outcome.kind, row.attached]), [['confirmed', true]]);
  const local = snapshot(board).snapshot;
  assert(local.schemaVersion === 4);
  assert.equal(local.github.issues[0].remote.body, '');
  assert.equal(local.github.issues[0].localIssueState, 'open');
  assert.equal(local.tasks[0].description, 'Private text');
  edit(board, task, 'Updated title');
  const second = await preview(connection, board, [task]);
  assert.equal((await send(connection, board, second.operationId, false)).state, 'succeeded');
  assert.deepEqual(mutations(control).map(({ method, path, body }) => [method, path, body]), [
    ['POST', '/repos/fixture-org/private-fixture-repo/issues', '{"title":"Local publication title"}'],
    ['PATCH', '/repos/fixture-org/private-fixture-repo/issues/51', '{"title":"Updated title"}'],
  ]);
  const final = snapshot(board).snapshot;
  assert(final.schemaVersion === 4);
  assert.equal(final.github.issues[0].remote.title, 'Local publication title');
  assert.deepEqual(final.publication.records[1].mergePendingFields, ['title']);
});

testConnection('P07/P08 reduced privilege and changed destination refuse mutations while reading still works', async ({ board, control, connection }) => {
  const task = add(board);
  control.repositories[0].permissions.push = false;
  assert.equal((await preview(connection, board, [task])).code, 'PERMISSION_REQUIRED');
  const refresh = connection.refresh(session, { ...identity(board),
    scope: { kind: 'issues', page: 1, pages: 1, linkedTaskIds: [], pullRequestId: null } });
  assert.equal((await waitStatus(connection, refresh.operationId)).state, 'succeeded');
  control.repositories[0].permissions.push = true;
  const reviewed = await preview(connection, board, [task]);
  control.repository.visibility = 'public';
  const refused = await send(connection, board, reviewed.operationId);
  assert.equal(refused.code, 'DESTINATION_MISMATCH');
  assert.equal(mutations(control).length, 0);
});

for (const type of ['prepare-intents', 'mark-attempted']) {
  let calls = 0;
  testConnection('P10 lost local commit at ' + type + ' sends zero requests and never retries', async ({ board, control, connection }) => {
    const task = add(board);
    const reviewed = await preview(connection, board, [task]);
    assert.equal((await send(connection, board, reviewed.operationId)).state, 'failed');
    assert.equal(calls, 1);
    assert.equal(mutations(control).length, 0);
  }, (board) => ({
    read: () => board.read(), github: (input) => board.github(input), exportCurrentBackup: (version) => board.exportCurrentBackup(version),
    publication(input) {
      assert(typeof input === 'object' && input !== null && 'operation' in input);
      const op = input.operation;
      assert(typeof op === 'object' && op !== null && 'type' in op);
      if (op.type !== type) return board.publication(input);
      calls++;
      const written = board.publication(input);
      assert(!('error' in written) && written.committed);
      return { error: { code: 'IO_OUTCOME_UNKNOWN', message: 'Synthetic lost local commit result.' } };
    },
  }));
}

testConnection('P12/P20 lost create response blocks duplicate and allows one inspection then protected retirement', async ({ board, control, connection }) => {
  const task = add(board);
  control.createdIssues.set(51, { ...responses.issue, id: 1051, number: 51, title: 'Observed issue' });
  control.publicationReply = async () => { throw new Error('Synthetic lost response'); };
  const reviewed = await preview(connection, board, [task]);
  assert.equal((await send(connection, board, reviewed.operationId)).state, 'failed');
  assert.throws(() => connection.publishPreview(session, { expectedVersion: snapshot(board).version,
    items: [{ taskId: task, fields: ['title'] }] }));
  const durable = snapshot(board).snapshot;
  assert(durable.schemaVersion === 4);
  const intentId = durable.publication.records[0].intent.id;
  assert.throws(() => connection.publicationRetirePreview(session, { expectedVersion: snapshot(board).version, intentIds: [intentId] }));
  const inspect = connection.reconcilePreview(session, { expectedVersion: snapshot(board).version, intentId, issueNumber: 51 });
  assert.equal((await waitStatus(connection, inspect.operationId)).state, 'succeeded');
  const confirm = { expectedVersion: snapshot(board).version, operationId: inspect.operationId, confirmed: true };
  const linked = connection.reconcileConfirm(session, confirm);
  assert(linked.snapshot.schemaVersion === 4);
  assert.equal(linked.snapshot.publication.records[0].outcome?.kind, 'unknown');
  assert.equal(linked.snapshot.publication.records[0].reconciliation?.issue.number, 51);
  assert.throws(() => connection.reconcileConfirm(session, { ...confirm, expectedVersion: snapshot(board).version }));
  const archive = connection.publicationRetirePreview(session, { expectedVersion: snapshot(board).version, intentIds: [intentId] });
  assert(JSON.parse(archive.backupJson).snapshot.publication.records.length);
  const archiveArgs = { expectedVersion: archive.version, operationId: archive.operationId, confirmed: true, backupSavedConfirmed: true };
  assert.throws(() => connection.publicationRetireConfirm(session, { ...archiveArgs, backupSha256: 'a'.repeat(64) }));
  const retired = connection.publicationRetireConfirm(session, { ...archiveArgs, backupSha256: archive.backupSha256 });
  assert(retired.snapshot.schemaVersion === 4);
  assert.equal(retired.snapshot.publication.creationLinks[0].issue.number, 51);
  assert.equal(mutations(control).length, 1);
});

testConnection('P13/P15 late admitted reply after local edit records known identity and stops later items', async ({ board, control, connection }) => {
  const tasks = [add(board, 'First'), add(board, 'Second'), add(board, 'Third')];
  control.publicationReply = async () => {
    edit(board, tasks[0], 'Newer local');
    return jsonReply({ ...responses.issue, id: 1051, number: 51, title: 'First' }, 201);
  };
  const reviewed = await preview(connection, board, tasks);
  const final = await send(connection, board, reviewed.operationId);
  assert(final.publication?.kind === 'publishing');
  assert.deepEqual(final.publication.results.map((row) => row.outcome.kind), ['unknown', 'not-sent', 'not-sent']);
  assert.equal(final.publication.results[0].outcome.issue?.number, 51);
  assert.equal(mutations(control).length, 1);
  assert(!control.calls.some((row) => row.path.endsWith('/issues/51')));
  assert.equal(snapshot(board).snapshot.tasks[0].title, 'Newer local');
});

testConnection('P15/P16 batch preserves confirmed item, distinguishes rejection, and never follows mutation redirects', async ({ board, control, connection }) => {
  const tasks = [add(board, 'First'), add(board, 'Second'), add(board, 'Third')];
  let writes = 0;
  control.publicationReply = async () => {
    if (++writes === 2) return jsonReply({}, 429, { 'retry-after': '17' });
    const issue = { ...responses.issue, id: 1051, number: 51, title: 'First', body: '' };
    control.createdIssues.set(51, issue);
    return jsonReply(issue, 201);
  };
  const reviewed = await preview(connection, board, tasks);
  const final = await send(connection, board, reviewed.operationId);
  assert(final.publication?.kind === 'publishing');
  assert.deepEqual(final.publication.results.map((row) => row.outcome.kind), ['confirmed', 'rejected', 'not-sent']);
  assert.equal(final.publication.results[1].outcome.code, 'RATE_LIMITED');
  assert(final.nextAllowedAt);
  assert.equal(mutations(control).length, 2);
  assert(control.sleeps.includes(1000));
  control.publicationReply = async () => jsonReply({}, 307, { location: 'https://different.invalid/' });
  const rerouted = await preview(connection, board, [tasks[2]]);
  const stopped = await send(connection, board, rerouted.operationId);
  assert(stopped.publication?.kind === 'publishing');
  assert.equal(stopped.publication.results[0].outcome.kind, 'unknown');
  assert.equal(mutations(control).length, 3);
});

testConnection('P17/P18 mismatch and elapsed operation bounds preserve intent with no corrective requests', async ({ board, control, connection }) => {
  const tasks = [add(board, 'First'), add(board, 'Second')];
  control.publicationReply = async () => {
    const issue = { ...responses.issue, id: 1051, number: 51, title: 'Different value', body: '' };
    control.createdIssues.set(51, issue);
    return jsonReply(issue, 201);
  };
  const first = await preview(connection, board, [tasks[0]]);
  const conflicted = await send(connection, board, first.operationId);
  assert(conflicted.publication?.kind === 'publishing');
  assert.equal(conflicted.publication.results[0].outcome.kind, 'conflict');
  assert.equal(mutations(control).length, 1);
  const second = await preview(connection, board, [tasks[1]]);
  control.publicationReply = async () => { control.clock += 60001; return jsonReply({}, 500); };
  const bounded = await send(connection, board, second.operationId);
  assert(bounded.publication?.kind === 'publishing');
  assert.equal(bounded.publication.results[0].outcome.code, 'OPERATION_LIMIT');
  assert.equal(mutations(control).length, 2);
});


testConnection('P14 in-flight readback may settle after cancel, with no subsequent requests', async ({ board, control, connection }) => {
  const ids = [add(board, 'First'), add(board, 'Second')];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const reviewed = await preview(connection, board, ids);
  control.publicationReply = async () => {
    const issue = { ...responses.issue, id: 1051, number: 51, title: 'First', body: '' };
    control.createdIssues.set(51, issue);
    control.response = async (input) => {
      assert(input.url.pathname.endsWith('/issues/51'));
      entered();
      await gate;
      return jsonReply(issue);
    };
    return jsonReply(issue, 201);
  };
  const dispatch = connection.publishConfirm(session, { expectedVersion: snapshot(board).version, operationId: reviewed.operationId,
    confirmed: true, existingIssuesChecked: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Readback was not entered')), 4000);
    })]);
    const count = control.calls.length;
    connection.cancel(session, { operationId: dispatch.operationId });
    release();
    const result = await waitStatus(connection, dispatch.operationId);
    assert(result.publication?.kind === 'publishing');
    assert.equal(control.calls.length, count);
    assert.equal(mutations(control).length, 1);
    assert.equal(result.publication.results[1].outcome.kind, 'not-sent');
  } finally { clearTimeout(timer); release(); }
});


testConnection('P13 disconnect after transport entry preserves the late identity without starting readback', async ({ board, control, connection }) => {
  const task = add(board);
  const other = add(board, 'Must not send');
  let entered!: () => void, release!: () => void;
  const inFlight = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  control.publicationReply = async () => {
    entered();
    await hold;
    return jsonReply({ ...responses.issue, id: 1051, number: 51 }, 201);
  };
  const previewed = await preview(connection, board, [task, other]);
  connection.publishConfirm(session, { expectedVersion: snapshot(board).version, operationId: previewed.operationId,
    confirmed: true, existingIssuesChecked: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([inFlight, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Mutation did not enter')), 4000);
    })]);
    const disconnected = connection.disconnect(session, identity(board));
    release();
    const cleaned = await waitStatus(connection, disconnected.operationId);
    assert.equal(cleaned.cleanup, 'complete');
    const saved = snapshot(board).snapshot;
    assert(saved.schemaVersion === 4);
    assert.equal(saved.github.selection, 'disconnected');
    assert.deepEqual(saved.publication.records.map(({ outcome }) => outcome?.kind), ['unknown', 'not-sent']);
    assert.equal(saved.publication.records[0].outcome?.issue?.id, '1051');
    assert.equal(mutations(control).length, 1);
    assert(!control.calls.some(({ path }) => path.endsWith('/issues/51')));
  } finally { clearTimeout(timer); release(); }
});

testConnection('P17 failed readback preserves accepted response identity with an unknown outcome', async ({ board, control, connection }) => {
  const task = add(board);
  const reviewed = await preview(connection, board, [task]);
  control.publicationReply = async () => jsonReply({ ...responses.issue, id: 1051, number: 51 }, 201);
  const result = await send(connection, board, reviewed.operationId);
  assert(result.publication?.kind === 'publishing');
  const row = result.publication.results[0];
  assert.equal(row.outcome.kind, 'unknown');
  assert.equal(row.outcome.code, 'READBACK_FAILED');
  assert.deepEqual(row.outcome.issue, { id: '1051', number: 51 });
  assert.equal(row.recorded, true);
  assert.equal(mutations(control).length, 1);
  assert.equal(control.calls.filter(({ path }) => path.endsWith('/issues/51')).length, 1);
});


testConnection('P08 mapped issue complete remote baseline refuses before transport', async ({ board, control, connection }) => {
  const task = add(board);
  const created = await preview(connection, board, [task]);
  assert.equal((await send(connection, board, created.operationId)).state, 'succeeded');
  edit(board, task, 'Update title');
  const reviewed = await preview(connection, board, [task]);
  const prior = control.createdIssues.get(51);
  assert(prior);
  prior.body = 'Remote-only body change';
  const final = await send(connection, board, reviewed.operationId, false);
  assert(final.publication?.kind === 'publishing');
  assert.equal(final.publication.results[0].outcome.kind, 'not-sent');
  assert.equal(final.publication.results[0].outcome.code, 'DESTINATION_CHANGED');
  assert.equal(mutations(control).length, 1);
});

testConnection('P19 wrong repository and stale inspection cannot attach known issue', async ({ board, control, connection }) => {
  const task = add(board);
  control.createdIssues.set(51, { ...responses.issue, id: 1051, number: 51 });
  control.publicationReply = async () => { throw new Error('Synthetic lost response'); };
  const reviewed = await preview(connection, board, [task]);
  await send(connection, board, reviewed.operationId);
  const local = snapshot(board).snapshot;
  assert(local.schemaVersion === 4);
  const intentId = local.publication.records[0].intent.id;
  control.repository.visibility = 'public';
  let inspect = connection.reconcilePreview(session, { expectedVersion: snapshot(board).version, intentId, issueNumber: 51 });
  assert.equal((await waitStatus(connection, inspect.operationId)).code, 'DESTINATION_MISMATCH');
  control.repository.visibility = 'private';
  inspect = connection.reconcilePreview(session, { expectedVersion: snapshot(board).version, intentId, issueNumber: 51 });
  assert.equal((await waitStatus(connection, inspect.operationId)).state, 'succeeded');
  edit(board, task, 'Newer local');
  assert.throws(() => connection.reconcileConfirm(session, { expectedVersion: snapshot(board).version,
    operationId: inspect.operationId, confirmed: true }));
  assert.equal(mutations(control).length, 1);
});


testConnection('P18 request allowance refuses the third PATCH while leaving two confirmed readbacks', async ({ board, control, connection }) => {
  const tasks = [add(board, 'First'), add(board, 'Second'), add(board, 'Third')];
  const create = await preview(connection, board, tasks);
  assert.equal((await send(connection, board, create.operationId)).state, 'succeeded');
  for (let i = 0; i < tasks.length; i++) edit(board, tasks[i], 'Updated ' + i);
  const update = await preview(connection, board, tasks);
  const calls = control.calls.length;
  const writes = mutations(control).length;
  const result = await send(connection, board, update.operationId, false);
  assert(result.publication?.kind === 'publishing');
  assert.deepEqual(result.publication.results.map((row) => row.outcome.kind), ['confirmed', 'confirmed', 'not-sent']);
  assert.equal(result.publication.results[2].outcome.code, 'OPERATION_LIMIT');
  assert.equal(control.calls.length - calls, 19);
  assert.equal(mutations(control).length - writes, 2);
});


testConnection('C1 malformed successful creates retain only a validated non-PR identity and stop the batch', async ({ board, control, connection }) => {
  const variants = [
    { title: 'Oversized body', reply: jsonReply({ ...responses.issue, id: 1051, number: 51, body: 'x'.repeat(16001) }, 201),
      identity: { id: '1051', number: 51 } },
    { title: 'Invalid identity', reply: jsonReply({ ...responses.issue, id: 0, number: 51 }, 201), identity: null },
    { title: 'Pull request shape', reply: jsonReply({ ...responses.issue, id: 1051, number: 51, pull_request: {} }, 201), identity: null },
    { title: 'Malformed JSON', reply: { ...jsonReply(null, 201), body: Buffer.from('{"id":1051,') }, identity: null },
  ];
  for (const sample of variants) {
    const task = add(board, sample.title);
    const later = add(board, sample.title + ' later');
    const reviewed = await preview(connection, board, [task, later]);
    assert.equal(reviewed.state, 'succeeded');
    const previousCalls = control.calls.length;
    const previousWrites = mutations(control).length;
    control.publicationReply = async () => sample.reply;
    const final = await send(connection, board, reviewed.operationId);
    assert(final.publication?.kind === 'publishing');
    assert.equal(final.state, 'failed');
    assert.deepEqual(final.publication.results.map(({ outcome }) => outcome.kind), ['unknown', 'not-sent']);
    assert.deepEqual(final.publication.results[0].outcome.issue, sample.identity);
    assert.equal(final.publication.results[0].outcome.code, 'INVALID_RESPONSE');
    assert.equal(final.publication.results[0].outcome.httpStatus, 201);
    assert.equal(final.publication.results[0].recorded, true);
    assert.equal(mutations(control).length - previousWrites, 1);
    assert(!control.calls.slice(previousCalls).some(({ method, path }) => method === 'GET' && /\/issues\/\d+$/.test(path)));
    const saved = snapshot(board).snapshot;
    assert(saved.schemaVersion === 4);
    const record = saved.publication.records.find((item) => item.associationTaskId === task);
    assert(record?.outcome);
    assert.deepEqual(record.outcome.issue, sample.identity);
    assert.equal(record.outcome.kind, 'unknown');
    assert.equal(record.outcome.code, 'INVALID_RESPONSE');
  }
});

testConnection('C1 mismatched successful update retains its original target and never reads the returned issue', async ({ board, control, connection }) => {
  const task = add(board);
  const created = await preview(connection, board, [task]);
  assert.equal((await send(connection, board, created.operationId)).state, 'succeeded');
  edit(board, task, 'Updated title');
  const reviewed = await preview(connection, board, [task]);
  assert.equal(reviewed.state, 'succeeded');
  const previousCalls = control.calls.length;
  control.publicationReply = async () => jsonReply({ ...responses.issue, id: 1052, number: 52, title: 'Updated title' });
  const final = await send(connection, board, reviewed.operationId, false);
  assert(final.publication?.kind === 'publishing');
  assert.equal(final.state, 'failed');
  const result = final.publication.results[0];
  assert.equal(result.outcome.kind, 'unknown');
  assert.equal(result.outcome.code, 'INVALID_RESPONSE');
  assert.equal(result.outcome.httpStatus, 200);
  assert.deepEqual(result.outcome.issue, { id: '1051', number: 51 });
  const calls = control.calls.slice(previousCalls).filter(({ path }) => /\/issues\/\d+$/.test(path));
  assert.deepEqual(calls.map(({ method, path }) => [method, path.split('/').at(-1)]), [['GET', '51'], ['PATCH', '51']]);
  const saved = snapshot(board).snapshot;
  assert(saved.schemaVersion === 4);
  assert.deepEqual(saved.publication.records.at(-1)?.outcome?.issue, { id: '1051', number: 51 });
  assert.deepEqual(saved.github.issues.map(({ issueId, number }) => ({ id: issueId, number })), [{ id: '1051', number: 51 }]);
});

test('P24 publishing routes reuse host authentication, method, origin and closed inputs', { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-publication-http-'));
  t.diagnostic('Retained owned host fixture: ' + root);
  const fixture = githubFixture();
  const host = await startHost(root, { githubConfig: config, githubDependencies: fixture.dependencies });
  try {
    const origin = host.origin;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(origin + path, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(4500) });
    const route = '/api/github/publish-preview';
    assert.equal((await fetch(origin + route)).status, 405);
    assert.equal((await post(route, {}, { Origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await post(route, {}, { Origin: origin })).status, 401);
    const launchCode = new URLSearchParams(new URL(host.launchUrl).hash.slice(1)).get('launch');
    const login = await post('/api/session', { launchCode }, { Origin: origin });
    assert.equal(login.status, 200);
    const loginReply = await login.json();
    assert(loginReply !== null && typeof loginReply === 'object' && !Array.isArray(loginReply));
    assert('token' in loginReply && typeof loginReply.token === 'string');
    const { token } = loginReply;
    const headers = { Origin: origin, Authorization: 'Bearer ' + token };
    const start = await post('/api/initialize', { kind: 'blank', name: 'Publication HTTP fixture' }, headers);
    assert.equal(start.status, 200);
    const saved = await start.json();
    assert(saved !== null && typeof saved === 'object' && !Array.isArray(saved));
    assert('version' in saved && typeof saved.version === 'string');
    assert.equal((await post(route, { expectedVersion: saved.version, items: [], url: 'https://foreign.invalid/' }, headers)).status, 400);
    assert.equal((await post('/api/github/publish-confirm', { expectedVersion: saved.version, operationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      confirmed: 'true' }, headers)).status, 400);
    assert.equal(mutations(fixture.control).length, 0);
    assert.equal((await post('/api/quit', {}, headers)).status, 202);
    await host.closedPromise;
  } finally { await host.stop(); }
});

