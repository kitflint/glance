import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { openBoard, openBoardReader } from '../src/board.ts';
import type { Failure, Initialized, Snapshot } from '../src/board.ts';
import { startHost } from '../src/host.ts';
import { createGlanceMcpServer } from '../src/mcp.ts';

type Board = ReturnType<typeof openBoard>;
type V2 = Extract<Snapshot, { schemaVersion: 2 }>;
type Entry = V2['reviews'][number];
type Backup = { format: string; version: number; exportedAt: string; snapshot: Snapshot };

const now = '2026-11-13T00:00:00.000Z';
const snapshotLimit = 2 * 1024 * 1024;
const fileDeadline = AbortSignal.timeout(60_000);

function reviewTest(name: string, exercise: (fixture: () => { root: string; board: Board }) => void | Promise<void>) {
  test(name, { timeout: 60_000, signal: fileDeadline }, async (t) => {
    const boards: Board[] = [];
    try {
      await exercise(() => {
        const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-review-'));
        t.diagnostic('Retained Glance review fixture: ' + root);
        const board = openBoard(root);
        boards.push(board);
        return { root, board };
      });
    } finally {
      for (const board of boards.reverse()) {
        const closed = board.close();
        assert('closed' in closed || closed.error.code === 'CLOSED');
      }
    }
  });
}

function ok<T extends object>(result: T | Failure): T {
  assert(!('error' in result), JSON.stringify(result));
  return result as T;
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), label + ' must be a record.');
  return value as Record<string, unknown>;
}

function code(result: object, expected: Failure['error']['code']) {
  assert('error' in result);
  assert.equal((result as Failure).error.code, expected);
}

function saved(board: Board): Initialized {
  const value = ok(board.read());
  assert(value.initialized);
  return value;
}

function v2(board: Initialized): V2 {
  assert.equal(board.snapshot.schemaVersion, 2);
  return board.snapshot as V2;
}

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function files(root: string) {
  return readdirSync(root).sort().map((name) => [name, sha(readFileSync(join(root, name)))]);
}

function blank(board: Board) {
  return ok(board.initialize({ kind: 'blank', name: 'Local review fixture' }));
}

function change(board: Board, prior: Initialized, operation: object) {
  return ok(board.change({ boardId: prior.snapshot.boardId, expectedVersion: prior.version, operation }));
}

function reviewCommand(prior: Initialized, taskId: string, decision = 'accepted', extra = {}) {
  return {
    boardId: prior.snapshot.boardId, expectedVersion: prior.version, taskId, decision, confirmed: true,
    reviewer: 'Local reviewer', scope: 'Local fixture scope', note: 'Reviewed the saved subject.', ...extra,
  };
}

function accept(board: Board, prior: Initialized, taskId: string, extra = {}) {
  return ok(board.review(reviewCommand(prior, taskId, 'accepted', extra)));
}

function taskWithProof(board: Board, prior: Initialized, fields = {}) {
  const failed = change(board, prior, {
    type: 'evidence.add', fields: { title: 'Failed observation', scope: 'unit', outcome: 'failed' },
  });
  const corrected = change(board, failed, {
    type: 'evidence.add', fields: {
      title: 'Passed correction', scope: 'unit', outcome: 'passed', supersedesId: failed.createdIds.evidenceId,
    },
  });
  return change(board, corrected, { type: 'task.add', fields: {
    title: 'Review this task', criteria: [{ requirement: 'Inspect the evidence', evidenceIds: [corrected.createdIds.evidenceId] }],
    ...fields,
  } });
}

function state(result: Initialized, taskId: string) {
  return result.report.taskReviews.find((item) => item.taskId === taskId)!;
}

function currentBackup(board: Board, from: Initialized) {
  const result = ok(board.exportCurrentBackup(from.version));
  assert.deepEqual(Object.keys(result).sort(), ['backupJson', 'boardId', 'sha256', 'snapshotSha256', 'version']);
  assert.equal(result.sha256, sha(result.backupJson));
  assert.equal(result.snapshotSha256, sha(JSON.stringify(from.snapshot)));
  const backup = JSON.parse(result.backupJson) as Backup;
  assert.deepEqual(backup.snapshot, from.snapshot);
  return { result, backup };
}

function readRow(root: string, slot: number) {
  const db = new DatabaseSync(join(root, 'glance.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT document, sha256 FROM state WHERE slot = ?').get(slot); }
  finally { db.close(); }
}

function replaceCurrent(root: string, document: string) {
  const db = new DatabaseSync(join(root, 'glance.sqlite'));
  try { db.prepare('UPDATE state SET document = ?, sha256 = ? WHERE slot = 1').run(document, sha(document)); }
  finally { db.close(); }
}

function largeTasks(count: number, text: string): Snapshot['tasks'] {
  return Array.from({ length: count }, (_, index) => ({
    id: 't_' + randomUUID(), title: 'Task ' + index, description: text, owner: '',
    priority: 'P1', status: 'Planned', milestoneId: null, workstreamId: null,
    prerequisites: [], criteria: [], blockers: [], evidenceIds: [],
  }));
}

function padSnapshot(snapshot: Snapshot, byteTarget: number): Snapshot['tasks'][number] {
  const padding = largeTasks(2, '');
  snapshot.tasks.push(...padding);
  let remaining = byteTarget - Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  assert(remaining >= 0 && remaining <= 32000);
  for (const task of padding) {
    const size = Math.min(remaining, 16000);
    task.description = 'y'.repeat(size);
    remaining -= size;
  }
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot), 'utf8'), byteTarget);
  return padding.at(-1)!;
}

reviewTest('H01 maximum-byte v1 reads and backups preserve shape and original raw predecessor', (fixture) => {
  const { root, board } = fixture();
  const original = blank(board);
  assert.deepEqual(board.close(), { closed: true });
  const { reviews, reviewArchive, ...common } = v2(original);
  const legacy: Snapshot = { ...common, schemaVersion: 1, tasks: largeTasks(132, 'x'.repeat(16000)) };
  while (Buffer.byteLength(JSON.stringify(legacy), 'utf8') > snapshotLimit - 1024) legacy.tasks.pop();
  const last = padSnapshot(legacy, snapshotLimit);
  const raw = JSON.stringify(legacy);
  assert.equal(Buffer.byteLength(raw, 'utf8'), snapshotLimit);
  replaceCurrent(root, raw);
  const reader = openBoardReader(root);
  const before = files(root);
  try {
    const observed = ok(reader.read());
    assert(observed.initialized);
    assert.deepEqual(observed.snapshot, legacy);
    assert.equal(observed.report.acceptance.accepted, 0);
    assert.equal(observed.report.taskReviews.length, legacy.tasks.length);
  } finally { assert.deepEqual(reader.close(), { closed: true }); }
  assert.deepEqual(files(root), before);

  const reopened = openBoard(root);
  try {
    const prior = saved(reopened);
    assert.deepEqual(prior.snapshot, legacy);
    const { backup } = currentBackup(reopened, prior);
    assert.equal(backup.version, 1);
    assert(!Object.hasOwn(backup.snapshot, 'reviews') && !Object.hasOwn(backup.snapshot, 'reviewArchive'));
    const noOp = change(reopened, prior, { type: 'project.edit', fields: { goal: '' } });
    assert.equal(noOp.committed, false);
    assert.equal(noOp.snapshot.schemaVersion, 1);
    code(reopened.review(reviewCommand(prior, last.id, 'changes-requested')), 'LIMIT_REACHED');
    code(reopened.change({ boardId: legacy.boardId, expectedVersion: prior.version,
      operation: { type: 'project.edit', fields: { name: 'X'.repeat(legacy.project.name.length) } } }), 'LIMIT_REACHED');
    assert.deepEqual(files(root), before);
    assert.equal(saved(reopened).snapshot.schemaVersion, 1);
    currentBackup(reopened, prior);
    const next = change(reopened, prior, { type: 'task.edit', id: legacy.tasks[0].id, fields: { description: '' } });
    assert.equal(next.snapshot.schemaVersion, 2);
    assert.equal(readRow(root, 2)?.document, raw);
    assert.equal(readRow(root, 2)?.sha256, sha(raw));
    const recovery = ok(reopened.recoverySnapshot());
    assert(recovery.available);
    assert.deepEqual((JSON.parse(recovery.backupJson) as Backup).snapshot, legacy);
    const { board: destination, root: empty } = fixture();
    code(destination.initialize({ kind: 'import', identity: 'restore', backup }), 'LIMIT_REACHED');
    assert.deepEqual(files(empty), []);
  } finally { assert.deepEqual(reopened.close(), { closed: true }); }
});

reviewTest('H01b first fitting human review upgrades legacy storage and preserves the raw v1 predecessor', (fixture) => {
  const { board } = fixture();
  const task = taskWithProof(board, blank(board));
  const id = task.createdIds.taskId!;
  const { reviews, reviewArchive, ...common } = v2(task);
  // Install the legacy snapshot as revision one of a synthetic database.
  const { board: blankSource, root: legacyRoot } = fixture();
  const first = blank(blankSource);
  assert.deepEqual(blankSource.close(), { closed: true });
  const historical: Snapshot = {
    ...common, schemaVersion: 1, boardId: first.snapshot.boardId, generation: first.snapshot.generation, revision: 1,
  };
  const raw = JSON.stringify(historical);
  replaceCurrent(legacyRoot, raw);
  const reopened = openBoard(legacyRoot);
  try {
    const prior = saved(reopened);
    assert.deepEqual(prior.snapshot, historical);
    const next = accept(reopened, prior, id);
    assert.equal(next.snapshot.schemaVersion, 2);
    assert.equal(next.report.acceptance.accepted, 1);
    assert.equal(next.snapshot.revision, prior.snapshot.revision + 1);
    assert.equal(readRow(legacyRoot, 2)?.document, raw);
  } finally { assert.deepEqual(reopened.close(), { closed: true }); }
});

reviewTest('H02 explicit scoped acceptance persists with captured proof, counts and immediate history links', (fixture) => {
  const { board, root } = fixture();
  const group = change(board, blank(board), { type: 'milestone.add', title: 'Milestone' });
  const task = taskWithProof(board, group, { milestoneId: group.createdIds.milestoneId, status: 'In progress' });
  const id = task.createdIds.taskId!;
  const first = accept(board, task, id);
  const again = accept(board, first, id, { scope: 'Second stated scope' });
  const [review, repeat] = v2(again).reviews;
  assert.equal(first.committed, true);
  assert.equal(again.committed, true);
  assert.equal(review.id, first.createdIds.reviewId);
  assert.equal(review.previousReviewId, null);
  assert.equal(repeat.previousReviewId, review.id);
  assert.equal(repeat.scope, 'Second stated scope');
  assert.deepEqual(review.basis?.evidence.map(({ outcome }) => outcome), ['failed', 'passed']);
  assert.equal(review.basisSha256, sha(JSON.stringify(review.basis)));
  assert.deepEqual(again.report.acceptance, { available: true, accepted: 1, stale: 0, changesRequested: 0 });
  assert.deepEqual(state(again, id), { taskId: id, state: 'accepted', latestReviewId: repeat.id, historicalCount: 2 });
  assert.equal(again.report.counts.open, 0);
  assert.equal(again.report.counts.inProgress, 1);
  assert.deepEqual(again.report.milestones, [{ id: group.createdIds.milestoneId, totalTasks: 1, openTasks: 0 }]);
  assert.deepEqual(board.close(), { closed: true });
  const reopened = openBoard(root);
  try { assert.deepEqual(saved(reopened), { initialized: true, snapshot: again.snapshot, report: again.report, version: again.version }); }
  finally { assert.deepEqual(reopened.close(), { closed: true }); }
});

reviewTest('H03 forged review envelopes and ordinary acceptance writes leave files unchanged', (fixture) => {
  const { root, board } = fixture();
  const task = taskWithProof(board, blank(board));
  const id = task.createdIds.taskId!;
  const command = reviewCommand(task, id);
  const before = files(root);
  const { confirmed, ...unconfirmed } = command;
  for (const input of [unconfirmed, { ...command, confirmed: false }, { ...command, id: 'r_' + randomUUID() },
    { ...command, recordedAt: now }, { ...command, basisSha256: 'f'.repeat(64) },
    { ...command, generation: randomUUID() }, { ...command, taskId: 't_' + randomUUID() }]) {
    code(board.review(input), 'INVALID_INPUT');
  }
  for (const operation of [{ type: 'review', ...command }, { type: 'task.edit', id, fields: { accepted: true } },
    { type: 'task.edit', id, fields: { status: 'Accepted' } }]) {
    code(board.change({ boardId: task.snapshot.boardId, expectedVersion: task.version, operation }), 'INVALID_INPUT');
  }
  assert.deepEqual(files(root), before);
  assert.equal(saved(board).version, task.version);
});

reviewTest('H04 ineligible acceptance refuses criteria, evidence, blockers and prerequisites; changes can still be requested', (fixture) => {
  const { root, board } = fixture();
  let current: Initialized = blank(board);
  const addTask = (fields: object) => {
    const next = change(board, current, { type: 'task.add', fields: { title: 'Eligibility fixture', ...fields } });
    current = next;
    return next.createdIds.taskId!;
  };
  const noCriteria = addTask({});
  const noProof = addTask({ criteria: [{ requirement: 'No linked proof' }] });
  const proof = taskWithProof(board, current);
  current = proof;
  const passed = proof.snapshot.evidence.at(-1)!.id;
  const criterion = { requirement: 'Pass', evidenceIds: [passed] };
  const taskLevelOnly = addTask({ criteria: [{ requirement: 'Task-level evidence alone' }], evidenceIds: [passed] });
  const blocked = addTask({ criteria: [criterion], blockers: ['Unresolved'] });
  const dependent = addTask({ criteria: [criterion], prerequisites: [proof.createdIds.taskId] });
  const invalid = [noCriteria, noProof, taskLevelOnly, blocked, dependent];
  for (const outcome of ['failed', 'unknown', 'not-run']) {
    const record = change(board, current, { type: 'evidence.add', fields: { title: outcome, scope: 'unit', outcome } });
    current = record;
    invalid.push(addTask({ criteria: [{ requirement: 'Mixed evidence', evidenceIds: [passed, record.createdIds.evidenceId] }] }));
  }
  const before = files(root);
  for (const id of invalid) code(board.review(reviewCommand(current, id)), 'INVALID_INPUT');
  assert.deepEqual(files(root), before);
  const acceptedPrerequisite = accept(board, current, proof.createdIds.taskId!);
  const request = ok(board.review(reviewCommand(acceptedPrerequisite, noCriteria, 'changes-requested')));
  assert.equal(state(request, noCriteria).state, 'changes-requested');
  assert.equal(v2(request).reviews.at(-1)?.basis?.task.criteria.length, 0);
  const dependentRequest = ok(board.review(reviewCommand(request, dependent, 'changes-requested')));
  assert.equal(state(dependentRequest, dependent).state, 'changes-requested');
  assert.equal(v2(dependentRequest).reviews.at(-1)?.basis?.prerequisites[0].reviewId, acceptedPrerequisite.createdIds.reviewId);
  const unavailablePrerequisite = ok(board.review(reviewCommand(dependentRequest, proof.createdIds.taskId!, 'changes-requested')));
  const unresolvedRequest = ok(board.review(reviewCommand(unavailablePrerequisite, dependent, 'changes-requested')));
  assert.equal(state(unresolvedRequest, dependent).state, 'changes-requested');
  assert.equal(v2(unresolvedRequest).reviews.at(-1)?.basis?.prerequisites[0].reviewId, null);
});

reviewTest('H05 relevant task, criterion, project goal, group and evidence changes invalidate without reactivation', (fixture) => {
  for (const kind of ['task', 'criterion', 'goal', 'group', 'evidence'] as const) {
    const { board } = fixture();
    const group = change(board, blank(board), { type: 'milestone.add', title: 'Before group' });
    const added = taskWithProof(board, group, { milestoneId: group.createdIds.milestoneId });
    const task = added.snapshot.tasks[0];
    const accepted = accept(board, added, task.id);
    const operations = {
      task: { type: 'task.edit', id: task.id, fields: { title: 'Revised title' } },
      criterion: { type: 'criterion.edit', taskId: task.id, id: task.criteria[0].id, fields: { requirement: 'Revised proof' } },
      goal: { type: 'project.edit', fields: { goal: 'Different goal' } },
      group: { type: 'milestone.edit', id: group.createdIds.milestoneId, title: 'After group' },
      evidence: { type: 'evidence.add', fields: {
        title: 'Later correction', outcome: 'passed', scope: 'unit', supersedesId: added.snapshot.evidence.at(-1)!.id,
      } },
    };
    const changed = change(board, accepted, operations[kind]);
    const [old, stale] = v2(changed).reviews;
    assert.equal(state(changed, task.id).state, 'stale', kind);
    assert.deepEqual(stale, {
      id: stale.id, taskId: task.id, generation: old.generation, recordedAt: stale.recordedAt,
      decision: 'stale', reviewer: '', scope: old.scope, note: 'Reviewed work or prerequisite acceptance changed.',
      basis: null, basisSha256: old.basisSha256, previousReviewId: old.id,
    });
    assert.equal(old.basis?.task.criteria[0].requirement, task.criteria[0].requirement);
    if (kind === 'evidence') {
      code(board.review(reviewCommand(changed, task.id)), 'INVALID_INPUT');
      const corrected = change(board, changed, { type: 'criterion.edit', taskId: task.id, id: task.criteria[0].id,
        fields: { evidenceIds: [changed.createdIds.evidenceId] } });
      assert.equal(state(corrected, task.id).state, 'stale');
      assert.equal(accept(board, corrected, task.id).report.acceptance.accepted, 1);
    }
    if (kind === 'goal') {
      const reverted = change(board, changed, { type: 'project.edit', fields: { goal: '' } });
      assert.equal(state(reverted, task.id).state, 'stale');
      assert.equal(v2(reverted).reviews.length, 2);
      assert.equal(v2(accept(board, reverted, task.id)).reviews.at(-1)?.previousReviewId, stale.id);
    }
  }
});

reviewTest('H06 unrelated edits, non-goal project edits, unlinked evidence and no-ops preserve acceptance', (fixture) => {
  const { board } = fixture();
  const task = taskWithProof(board, blank(board));
  const id = task.createdIds.taskId!;
  let current = accept(board, task, id);
  const reviewId = current.createdIds.reviewId;
  const other = change(board, current, { type: 'task.add', fields: { title: 'Other task' } });
  current = change(board, other, { type: 'task.edit', id: other.createdIds.taskId, fields: { title: 'Edited other task' } });
  current = change(board, current, { type: 'project.edit', fields: {
    name: 'Renamed project', stage: 'Build', focusTaskId: other.createdIds.taskId, nextActions: ['Look ahead'],
  } });
  current = change(board, current, { type: 'evidence.add', fields: { title: 'Unlinked', scope: 'unit', outcome: 'failed' } });
  const noOp = change(board, current, { type: 'project.edit', fields: { stage: 'Build' } });
  assert.equal(noOp.version, current.version);
  assert.equal(noOp.committed, false);
  assert.equal(v2(noOp).reviews.length, 1);
  assert.deepEqual(state(noOp, id), { taskId: id, state: 'accepted', latestReviewId: reviewId, historicalCount: 1 });
});

reviewTest('H07 prerequisite changes, reacceptance and requests for changes invalidate dependents in prerequisite order', (fixture) => {
  const { board } = fixture();
  const a = taskWithProof(board, blank(board), { title: 'Prerequisite A' });
  const aid = a.createdIds.taskId!;
  const ar = accept(board, a, aid);
  const b = taskWithProof(board, ar, { title: 'Dependent B', prerequisites: [aid] });
  const bid = b.createdIds.taskId!;
  const br = accept(board, b, bid);
  const c = taskWithProof(board, br, { title: 'Dependent C', prerequisites: [bid] });
  const cid = c.createdIds.taskId!;
  const cr = accept(board, c, cid);
  const reaccepted = accept(board, cr, aid);
  assert.deepEqual(v2(reaccepted).reviews.slice(-2).map(({ taskId, decision }) => [taskId, decision]),
    [[bid, 'stale'], [cid, 'stale']]);
  assert.equal(reaccepted.report.acceptance.accepted, 1);
  const both = accept(board, accept(board, reaccepted, bid), cid);
  const requested = ok(board.review(reviewCommand(both, aid, 'changes-requested')));
  assert.deepEqual(v2(requested).reviews.slice(-3).map(({ taskId, decision }) => [taskId, decision]),
    [[aid, 'changes-requested'], [bid, 'stale'], [cid, 'stale']]);
  assert.equal(requested.report.acceptance.accepted, 0);
  assert.equal(requested.report.acceptance.changesRequested, 1);
  const rebuilt = accept(board, accept(board, accept(board, requested, aid), bid), cid);
  const edited = change(board, rebuilt, { type: 'task.edit', id: aid, fields: { title: 'Changed prerequisite' } });
  assert.deepEqual(v2(edited).reviews.slice(-3).map(({ taskId, decision }) => [taskId, decision]),
    [[aid, 'stale'], [bid, 'stale'], [cid, 'stale']]);
});

reviewTest('H08 full review subjects and failed evidence survive private export, restore and copy', (fixture) => {
  const { board } = fixture();
  const task = taskWithProof(board, blank(board));
  const id = task.createdIds.taskId!;
  const initial = accept(board, task, id, { reviewer: '<script>reviewer</script>', note: '[unsafe](javascript:alert(1))' });
  const oldReview = v2(initial).reviews[0];
  const bundle = ok(board.exportSnapshot(initial.version));
  assert.match(bundle.html, /Accepted for stated scope: 1/);
  assert.match(bundle.markdown, /Accepted for stated scope&#58; 1/);
  assert(bundle.html.includes('&lt;script&gt;reviewer&lt;/script&gt;') && !bundle.html.includes('<script>'));
  assert(!bundle.markdown.includes('](javascript:'));
  assert.equal(bundle.version, initial.version);
  assert.deepEqual((JSON.parse(bundle.backupJson) as Backup).snapshot, initial.snapshot);
  const { backup } = currentBackup(board, initial);

  for (const identity of ['restore', 'new']) {
    const { board: other } = fixture();
    const imported = ok(other.initialize({ kind: 'import', backup, identity }));
    const snap = v2(imported);
    const importedTask = snap.tasks[0];
    assert.notEqual(snap.generation, initial.snapshot.generation);
    assert.deepEqual(snap.evidence.map(({ outcome }) => outcome), ['failed', 'passed']);
    assert.equal(snap.evidence[1].supersedesId, snap.evidence[0].id);
    assert.deepEqual(snap.reviews, [{ ...oldReview, taskId: importedTask.id }]);
    if (identity === 'restore') assert.equal(importedTask.id, id);
    else assert.notEqual(importedTask.id, id);
    assert.equal(state(imported, importedTask.id).state, 'unreviewed');
    assert.equal(state(imported, importedTask.id).historicalCount, 1);
    assert.equal(imported.report.acceptance.accepted, 0);
    assert.match(ok(other.exportSnapshot(imported.version)).html, /Prior generation/);
    const reviewed = accept(other, imported, importedTask.id);
    assert.equal(v2(reviewed).reviews.at(-1)?.previousReviewId, oldReview.id);
  }
});

async function authenticated(root: string) {
  const host = await startHost(root);
  const launchCode = new URLSearchParams(new URL(host.launchUrl).hash.slice(1)).get('launch');
  async function exchange(path: string, body?: unknown, extra: Record<string, string> = {}) {
    return fetch(host.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: host.origin, 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(6500),
    });
  }
  try {
    const session = await exchange('/api/session', { launchCode });
    assert.equal(session.status, 200);
    const { token } = await session.json() as { token: string };
    assert(token);
    const headers = { Authorization: 'Bearer ' + token };
    return { host, headers, exchange, call: (path: string, body?: unknown) => exchange(path, body, headers) };
  } catch (error) {
    await host.stop();
    throw error;
  }
}

reviewTest('H09 concurrent authenticated review and edit share one revision fence', async (fixture) => {
  const { board, root } = fixture();
  const prior = taskWithProof(board, blank(board));
  const taskId = prior.createdIds.taskId!;
  assert.deepEqual(board.close(), { closed: true });
  const session = await authenticated(root);
  try {
    const review = reviewCommand(prior, taskId);
    const edit = { boardId: prior.snapshot.boardId, expectedVersion: prior.version, operation: { type: 'project.edit', fields: { goal: 'Parallel edit' } } };
    const responses = await Promise.all([session.call('/api/review', review), session.call('/api/change', edit)]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    const [reviewReply, changeReply] = await Promise.all(responses.map((response) => response.json()));
    const conflict = responseRecord(responses[0].status === 409 ? reviewReply : changeReply, 'Conflict response');
    assert.equal(responseRecord(conflict.error, 'Conflict error').code, 'REVISION_CONFLICT');
    const current = responseRecord(await (await session.call('/api/board')).json(), 'Current board');
    const snapshot = responseRecord(current.snapshot, 'Current snapshot');
    assert.equal(snapshot.revision, prior.snapshot.revision + 1);
    const conflictCurrent = responseRecord(conflict.current, 'Conflict current board');
    assert(typeof current.version === 'string' && typeof conflictCurrent.version === 'string', 'Expected board versions.');
    assert.equal(conflictCurrent.version, current.version);
    assert(Array.isArray(snapshot.reviews), 'Expected saved reviews.');
    assert.equal(snapshot.reviews.length, responses[0].status === 200 ? 1 : 0);
    assert.equal(responseRecord(snapshot.project, 'Current project').goal, responses[1].status === 200 ? 'Parallel edit' : '');
    assert.equal((await session.call('/api/review', review)).status, 409);
  } finally { await session.host.stop(); }
});

reviewTest('H10 review and backup host routes enforce Origin, bearer, shape, recovery and quit', async (fixture) => {
  const { board, root } = fixture();
  const prior = taskWithProof(board, blank(board));
  const command = reviewCommand(prior, prior.createdIds.taskId!);
  assert.deepEqual(board.close(), { closed: true });
  const before = files(root);
  const session = await authenticated(root);
  try {
    for (const [route, data] of [['/api/review', command], ['/api/backup', { expectedVersion: prior.version }]] as const) {
      assert.equal((await session.exchange(route, data)).status, 401);
      assert.equal((await session.exchange(route, data, { ...session.headers, Origin: 'http://example.invalid' })).status, 403);
      assert.equal((await session.exchange(route, data, { ...session.headers, 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await session.call(route + '?token=unused', data)).status, 404);
      assert.equal((await session.call(route, { ...data, extra: true })).status, 400);
    }
    assert.deepEqual(files(root), before);
    assert.equal((await session.call('/api/quit', {})).status, 202);
    await session.host.closedPromise;
    await assert.rejects(session.call('/api/review', command));
    await assert.rejects(session.call('/api/backup', { expectedVersion: prior.version }));
  } finally { await session.host.stop(); }

  replaceCurrent(root, '{}');
  const recovery = await authenticated(root);
  try {
    assert.equal((await recovery.call('/api/board')).status, 503);
    assert.equal((await recovery.call('/api/review', command)).status, 503);
    assert.equal((await recovery.call('/api/backup', { expectedVersion: prior.version })).status, 503);
  } finally { await recovery.host.stop(); }
});

reviewTest('H11 MCP reports compact current review metadata and refuses review writes', async (fixture) => {
  const { board } = fixture();
  const task = taskWithProof(board, blank(board));
  const taskId = task.createdIds.taskId!;
  const accepted = accept(board, task, taskId);
  const { basis, ...metadata } = v2(accepted).reviews[0];
  for (const allowWrites of [false, true]) {
    const [left, right] = InMemoryTransport.createLinkedPair();
    const server = createGlanceMcpServer(board, allowWrites ? board.change.bind(board) : undefined);
    const client = new Client({ name: 'review-fixture', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    try {
      await server.connect(right);
      await client.connect(left, { timeout: 5000 });
      const { tools } = await client.listTools(undefined, { timeout: 5000 });
      assert.equal(tools.length, allowWrites ? 8 : 7);
      assert(!tools.some(({ name }) => name.includes('review') || name.includes('backup')));
      const call = (name: string, args = {}) => client.callTool({ name, arguments: args }, { timeout: 5000 });
      const overview = responseRecord((await call('glance_read_overview')).structuredContent, 'MCP overview');
      const { taskReviews, ...compact } = accepted.report;
      assert.deepEqual(overview.report, compact);
      const listed = responseRecord((await call('glance_list_tasks')).structuredContent, 'MCP task list');
      assert(Array.isArray(listed.items), 'Expected MCP task list items.');
      assert.equal(responseRecord(listed.items[0], 'MCP first task').reviewState, 'accepted');
      const detail = responseRecord(
        (await call('glance_read_task', { id: taskId, expectedVersion: accepted.version })).structuredContent, 'MCP task detail');
      assert.deepEqual(detail.review, { state: 'accepted', latest: metadata, historicalCount: 1 });
      for (const [name, args] of [
        ['glance_review_task', reviewCommand(accepted, taskId)],
        ['glance_update_board', { boardId: accepted.snapshot.boardId, expectedVersion: accepted.version, operation: { type: 'review', taskId } }],
        ['glance_update_board', { boardId: accepted.snapshot.boardId, expectedVersion: accepted.version,
          operation: { type: 'task.edit', id: taskId, fields: { accepted: true } } }],
        ['glance_update_board', { boardId: accepted.snapshot.boardId, expectedVersion: accepted.version, reviews: [],
          operation: { type: 'task.edit', id: taskId, fields: { title: 'Forged' } } }],
      ] as const) {
        const result = await call(name, args).catch((error: unknown) => {
          assert(error instanceof Error && /not found|invalid|unknown/i.test(error.message));
          return undefined;
        });
        if (result) assert.equal(result.isError, true);
      }
      assert.equal(saved(board).version, accepted.version);
    } finally {
      try { await client.close(); } finally { await server.close(); }
    }
  }
});

function withHistoricalRecords(source: V2, count: number): V2 {
  const old = source.reviews[0];
  const records: Entry[] = [];
  for (let i = 0; i < count; i++) records.push({
    ...old, id: 'r_' + randomUUID(), previousReviewId: records.at(-1)?.id ?? null,
  });
  return { ...source, reviews: records };
}

reviewTest('H12 count-exhausted history refuses atomically and remains exportable through two continued cycles', (fixture) => {
  const { board } = fixture();
  const task = taskWithProof(board, blank(board));
  const id = task.createdIds.taskId!;
  const compact = change(board, task, { type: 'task.add', fields: { title: 'Archive history' } });
  const historyId = compact.createdIds.taskId!;
  const reviewed = ok(board.review(reviewCommand(compact, historyId, 'changes-requested', {
    reviewer: 'R', scope: 'S', note: 'N',
  })));
  const { board: full, root: archiveRoot } = fixture();
  const fullBackup = { ...currentBackup(board, reviewed).backup, snapshot: withHistoricalRecords(v2(reviewed), 2000) };
  assert(Buffer.byteLength(JSON.stringify(fullBackup.snapshot)) < snapshotLimit);
  const capacity = ok(full.initialize({ kind: 'import', identity: 'restore', backup: fullBackup }));
  assert.equal(state(capacity, historyId).state, 'unreviewed');
  assert.equal(state(capacity, historyId).historicalCount, 2000);
  const before = files(archiveRoot);
  code(full.review(reviewCommand(capacity, id)), 'LIMIT_REACHED');
  assert.deepEqual(files(archiveRoot), before);
  assert.deepEqual(saved(full), capacity);
  const fullSnapshot = v2(capacity);
  const validReview = v2(accept(board, reviewed, id)).reviews.at(-1)!;
  const simulated = structuredClone(fullSnapshot);
  simulated.reviews = [...simulated.reviews.slice(0, -1), {
    ...validReview, generation: simulated.generation, previousReviewId: null,
  }];
  const { root: invalidationRoot, board: invalidationBoard } = fixture();
  const filled = ok(invalidationBoard.initialize({ kind: 'import', identity: 'restore',
    backup: { ...fullBackup, snapshot: simulated } }));
  assert.deepEqual(invalidationBoard.close(), { closed: true });
  const current = v2(filled);
  current.reviews.at(-1)!.generation = current.generation;
  replaceCurrent(invalidationRoot, JSON.stringify(current));
  const exact = openBoard(invalidationRoot);
  try {
    const accepted = saved(exact);
    assert.equal(accepted.report.acceptance.accepted, 1);
    const filesBefore = files(invalidationRoot);
    code(exact.change({ boardId: current.boardId, expectedVersion: accepted.version,
      operation: { type: 'project.edit', fields: { goal: 'Would append stale history' } } }), 'LIMIT_REACHED');
    assert.deepEqual(saved(exact), accepted);
    assert.deepEqual(files(invalidationRoot), filesBefore);
  } finally { assert.deepEqual(exact.close(), { closed: true }); }

  const retained = currentBackup(full, capacity);
  const originalBytes = retained.result.backupJson;
  const backupFile = join(fixture().root, 'retained-current-backup.json');
  writeFileSync(backupFile, originalBytes, { flag: 'wx' });

  const { board: continued } = fixture();
  const one = ok(continued.initialize({ kind: 'import', identity: 'continue', preserveHistoryConfirmed: true, backup: retained.backup }));
  const first = v2(one);
  assert.equal(first.boardId, capacity.snapshot.boardId);
  assert.equal(first.revision, 1);
  assert.notEqual(first.generation, capacity.snapshot.generation);
  assert.deepEqual(first.tasks, capacity.snapshot.tasks);
  assert.deepEqual(first.evidence, capacity.snapshot.evidence);
  assert.deepEqual(first.reviews, []);
  assert.deepEqual(first.reviewArchive, {
    boardId: capacity.snapshot.boardId, generation: capacity.snapshot.generation, revision: capacity.snapshot.revision,
    snapshotSha256: retained.result.snapshotSha256, reviewCount: 2000, continuedAt: first.reviewArchive?.continuedAt,
  });
  assert.equal(one.report.acceptance.accepted, 0);
  const newReview = accept(continued, one, id);
  assert.equal(v2(newReview).reviews[0].previousReviewId, null);
  const secondBackup = currentBackup(continued, newReview);
  const { board: twice } = fixture();
  const two = ok(twice.initialize({ kind: 'import', identity: 'continue', preserveHistoryConfirmed: true, backup: secondBackup.backup }));
  assert.equal(v2(two).reviewArchive?.snapshotSha256, secondBackup.result.snapshotSha256);
  assert.equal(v2(two).reviewArchive?.generation, first.generation);
  assert.equal(v2(two).reviews.length, 0);
  assert.equal(v2(two).evidence[0].outcome, 'failed');
  assert.equal(v2(newReview).reviewArchive?.snapshotSha256, retained.result.snapshotSha256);
  assert.deepEqual(files(archiveRoot), before);
  assert.equal(JSON.stringify(retained.backup), originalBytes);
  assert.equal(sha(readFileSync(backupFile)), retained.result.sha256);
});

reviewTest('H13 continuation and captured-basis validation refuse malformed inputs and an occupied destination', (fixture) => {
  const { board } = fixture();
  const task = taskWithProof(board, blank(board));
  const reviewed = accept(board, task, task.createdIds.taskId!);
  const { backup } = currentBackup(board, reviewed);
  const original = v2(reviewed);
  const archive = {
    boardId: original.boardId, generation: original.generation, revision: original.revision,
    snapshotSha256: 'b'.repeat(64), reviewCount: 1, continuedAt: now,
  };
  const { reviews, reviewArchive, ...common } = original;
  const continuation = { kind: 'import', identity: 'continue', preserveHistoryConfirmed: true, backup };
  const { board: empty, root } = fixture();
  for (const input of [
    { kind: 'import', identity: 'continue', backup },
    { ...continuation, preserveHistoryConfirmed: false },
    { ...continuation, identity: 'restore' },
    { ...continuation, backup: { ...backup, snapshot: { ...common, schemaVersion: 1 } } },
    { ...continuation, backup: { ...backup, snapshot: { ...original, reviews: [] } } },
    { ...continuation, backup: { ...backup, snapshot: { ...original, reviewArchive: { ...archive, extra: true } } } },
    { ...continuation, backup: { ...backup, snapshot: { ...original, reviewArchive: { ...archive, snapshotSha256: 'bad' } } } },
    { ...continuation, backup: { ...backup, snapshot: { ...original, reviews: [{ ...reviews[0], basisSha256: '0'.repeat(64) }] } } },
  ]) {
    code(empty.initialize(input), 'INVALID_INPUT');
    assert.deepEqual(files(root), []);
  }
  code(empty.initialize({ ...continuation, backup: { ...backup, snapshot: { ...original, schemaVersion: 9 } } }), 'UNSUPPORTED_VERSION');
  assert.deepEqual(files(root), []);
  const existing = blank(empty);
  const before = files(root);
  code(empty.initialize(continuation), 'ALREADY_EXISTS');
  assert.deepEqual(saved(empty), existing);
  assert.deepEqual(files(root), before);
});

reviewTest('H14 v2 snapshot byte cap refuses a review that cannot fit without pruning', (fixture) => {
  const { board } = fixture();
  const task = taskWithProof(board, blank(board));
  const { backup } = currentBackup(board, task);
  const snapshot = { ...v2(task), tasks: [...v2(task).tasks, ...largeTasks(131, 'x'.repeat(16000))] };
  while (Buffer.byteLength(JSON.stringify(snapshot)) > snapshotLimit - 1024) snapshot.tasks.pop();
  padSnapshot(snapshot, snapshotLimit - 128);
  const { board: target, root } = fixture();
  const imported = ok(target.initialize({ kind: 'import', identity: 'restore', backup: { ...backup, snapshot } }));
  assert.equal(Buffer.byteLength(JSON.stringify(imported.snapshot)), snapshotLimit - 128);
  const before = files(root);
  code(target.review(reviewCommand(imported, imported.snapshot.tasks[0].id, 'accepted',
    { note: 'x'.repeat(2000) })), 'LIMIT_REACHED');
  assert.deepEqual(saved(target), imported);
  assert.deepEqual(files(root), before);
  currentBackup(target, imported);
});

reviewTest('H15 combined private export can overflow while authenticated current backup stays complete', async (fixture) => {
  const { board } = fixture();
  const task = taskWithProof(board, blank(board));
  const reviewed = accept(board, task, task.createdIds.taskId!);
  const { backup } = currentBackup(board, reviewed);
  const snapshot = { ...v2(reviewed), tasks: [...reviewed.snapshot.tasks, ...largeTasks(113, '&'.repeat(16000))] };
  assert(Buffer.byteLength(JSON.stringify(snapshot)) < snapshotLimit);
  const { board: target, root } = fixture();
  const large = ok(target.initialize({ kind: 'import', identity: 'restore', backup: { ...backup, snapshot } }));
  assert.deepEqual(target.close(), { closed: true });
  const before = files(root);
  const session = await authenticated(root);
  try {
    const stale = await session.call('/api/backup', { expectedVersion: reviewed.version });
    assert.equal(stale.status, 409);
    const staleResponse = responseRecord(await stale.json(), 'Stale backup response');
    assert.equal(responseRecord(staleResponse.current, 'Stale backup current board').version, large.version);
    const combined = await session.call('/api/export', { expectedVersion: large.version });
    assert.equal(combined.status, 413);
    const exportResponse = responseRecord(await combined.json(), 'Combined export response');
    assert.equal(responseRecord(exportResponse.error, 'Combined export error').code, 'LIMIT_REACHED');
    const response = await session.call('/api/backup', { expectedVersion: large.version });
    assert.equal(response.status, 200);
    const result = responseRecord(await response.json(), 'Current backup response');
    assert.deepEqual(Object.keys(result).sort(), ['backupJson', 'boardId', 'ok', 'sha256', 'snapshotSha256', 'version']);
    const { backupJson, boardId, version, sha256, snapshotSha256 } = result;
    assert(typeof backupJson === 'string' && typeof boardId === 'string' && typeof version === 'string' &&
      typeof sha256 === 'string' && typeof snapshotSha256 === 'string', 'Expected string backup metadata and JSON.');
    assert.equal(version, large.version);
    assert.equal(sha256, sha(backupJson));
    assert.equal(snapshotSha256, sha(JSON.stringify(large.snapshot)));
    assert.deepEqual(responseRecord(JSON.parse(backupJson), 'Decoded backup').snapshot, large.snapshot);
  } finally { await session.host.stop(); }
  assert.deepEqual(files(root), before);
});
