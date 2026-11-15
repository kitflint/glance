import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard, publicationDestination, publicationValues } from '../src/board.ts';
import type { Failure, Initialized, PublicationIntent, PublicationOutcome, PublicationField } from '../src/board.ts';

const { connectionEpoch, repository, issue } = JSON.parse(readFileSync(new URL('./fixtures/github/board-v3.json', import.meta.url), 'utf8'));
const at = '2026-11-13T05:00:00Z';
type Board = ReturnType<typeof openBoard>;

function ok<T extends object>(value: T | Failure): T {
  assert(!('error' in value), JSON.stringify(value));
  return value as T;
}
function current(board: Board): Initialized {
  const value = ok(board.read());
  assert(value.initialized);
  return value;
}
function cmd(board: Board, kind: 'change' | 'github' | 'publication', operation: object) {
  const snapshot = current(board);
  return board[kind]({ boardId: snapshot.snapshot.boardId, expectedVersion: snapshot.version, operation });
}
function scoped(name: string, body: (board: Board, open: () => Board) => void) {
  test(name, { timeout: 15000 }, (t) => {
    const opened: Board[] = [];
    const open = () => {
      const path = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-publication-board-'));
      t.diagnostic('Retained owned Board fixture: ' + path);
      const board = openBoard(path);
      opened.push(board);
      return board;
    };
    try { body(open(), open); }
    finally { for (const board of opened.reverse()) assert.deepEqual(board.close(), { closed: true }); }
  });
}
function ready(board: Board, linked = false) {
  ok(board.initialize({ kind: 'blank', name: 'Private publication fixture' }));
  ok(cmd(board, 'github', { type: 'prepare' }));
  ok(cmd(board, 'github', { type: 'select', repository, connectionEpoch }));
  return linked ? ok(cmd(board, 'github', { type: 'import', repositoryId: repository.id, connectionEpoch, issues: [issue] })).createdIds.taskIds![0]
    : ok(cmd(board, 'change', { type: 'task.add', fields: { title: 'Local A', description: 'Private description' } })).createdIds.taskId!;
}
function makeIntent(board: Board, taskId: string, fields: PublicationField[] = ['title']): PublicationIntent {
  const { snapshot } = current(board);
  assert(snapshot.schemaVersion === 3 || snapshot.schemaVersion === 4);
  const task = snapshot.tasks.find((value) => value.id === taskId)!;
  const mapping = snapshot.github.issues.find((entry) => entry.localTaskId === taskId);
  return { id: randomUUID(), batchId: randomUUID(), origin: { boardId: snapshot.boardId, generation: snapshot.generation,
    revision: snapshot.revision, connectionEpoch: snapshot.github.connectionEpoch, taskId },
    repository: publicationDestination(repository), action: mapping ? 'update' : 'create',
    issue: mapping ? { id: mapping.issueId, number: mapping.number } : null, fields,
    before: mapping ? publicationValues(mapping.remote, fields) : null,
    proposed: publicationValues({ title: task.title, body: task.description, state: mapping?.localIssueState ?? 'open' }, fields), preparedAt: at };
}
function history(board: Board) {
  const { snapshot } = current(board);
  assert(snapshot.schemaVersion === 4);
  return snapshot;
}
function outcome(kind: PublicationOutcome['kind'], identity: PublicationOutcome['issue']): PublicationOutcome {
  return { kind, at, code: kind === 'confirmed' ? 'VERIFIED' : 'NETWORK_FAILED',
    httpStatus: kind === 'confirmed' ? 200 : null, issue: identity,
    remoteUpdatedAt: kind === 'confirmed' ? at : null, observedSha256: kind === 'confirmed' ? 'a'.repeat(64) : null,
    matched: kind === 'confirmed' ? true : null };
}
function attempt(board: Board, intent: PublicationIntent) {
  ok(cmd(board, 'publication', { type: 'prepare-intents', intents: [intent] }));
  ok(cmd(board, 'publication', { type: 'mark-attempted', intentId: intent.id, at }));
}
function edit(board: Board, taskId: string, title: string) {
  ok(cmd(board, 'change', { type: 'task.edit', id: taskId, fields: { title } }));
}
function inspect(board: Board, intentId: string, remote = issue.values) {
  return cmd(board, 'publication', { type: 'reconcile', intentId, at, issue: { id: issue.issueId, number: issue.number },
    remote, remoteUpdatedAt: at });
}
function refresh(board: Board, remote = issue.values) {
  return cmd(board, 'github', { type: 'refresh', repositoryId: repository.id, connectionEpoch, facts: [],
    issues: [{ issueId: issue.issueId, number: issue.number, remoteUpdatedAt: at, values: remote }],
    collection: { kind: 'issues', pullRequestId: null, page: 1, pagesFetched: 1, count: 1, observedAt: at, completeness: 'complete-for-scope' },
    attempt: { at, outcome: 'success', code: null } });
}

scoped('P01/P02 deliberate promotion and strict prepared record inputs', (board) => {
  const taskId = ready(board);
  const before = current(board);
  assert.equal(before.snapshot.schemaVersion, 3);
  const intent = makeIntent(board, taskId);
  for (const bad of [{ ...intent, secret: true }, { ...intent, fields: ['title', 'title'] }, { ...intent, fields: ['state'] },
    { ...intent, proposed: { title: 'a\u0000b' } }, { ...intent, proposed: { title: 'x'.repeat(201) } }]) {
    assert('error' in cmd(board, 'publication', { type: 'prepare-intents', intents: [bad] }));
    assert.equal(current(board).version, before.version);
  }
  ok(cmd(board, 'publication', { type: 'prepare-intents', intents: [intent] }));
  assert.deepEqual(history(board).publication.records[0], { intent, associationTaskId: taskId, attemptedAt: null,
    outcome: null, reconciliation: null, mergePendingFields: [] });
});

scoped('P03 capacity stops the next prepare without losing space for its prior settlement', (board) => {
  const taskId = ready(board);
  ok(cmd(board, 'change', { type: 'task.edit', id: taskId, fields: { description: '🧪'.repeat(8000) } }));
  const ids = [];
  let refused = false;
  for (let n = 0; n < 21; n++) {
    const intent = makeIntent(board, taskId, ['title', 'body']);
    const version = current(board).version;
    const result = cmd(board, 'publication', { type: 'prepare-intents', intents: [intent] });
    if ('error' in result) { assert.equal(result.error.code, 'LIMIT_REACHED'); assert.equal(current(board).version, version); refused = true; break; }
    ids.push(intent.id);
  }
  assert(refused && ids.length > 0 && ids.length < 20);
  ok(cmd(board, 'change', { type: 'project.edit', fields: { goal: 'An ordinary edit' } }));
  const result = cmd(board, 'publication', { type: 'settle-outcome', intentId: ids[0], outcome: {
    ...outcome('not-sent', null), code: 'PRE_SEND_REFUSED',
  } });
  assert(!('error' in result));
  assert.equal(history(board).publication.records.length, ids.length);
});

scoped('P04/P12/P20 backup preserves history, remaps association and keeps creation protection after retirement', (board, open) => {
  const taskId = ready(board);
  const intent = makeIntent(board, taskId);
  attempt(board, intent);
  ok(cmd(board, 'publication', { type: 'settle-outcome', intentId: intent.id, outcome: outcome('unknown', null) }));
  const archive = { type: 'retire', recordIds: [intent.id], backupSha256: 'b'.repeat(64), at };
  assert('error' in cmd(board, 'publication', archive));
  assert('error' in cmd(board, 'publication', { type: 'prepare-intents', intents: [makeIntent(board, taskId)] }));
  ok(inspect(board, intent.id));
  assert.equal(history(board).publication.records[0].outcome?.kind, 'unknown');
  assert.equal(history(board).publication.records[0].reconciliation?.kind, 'linked');
  const receipt = history(board).publication.records[0].reconciliation;
  ok(cmd(board, 'github', { type: 'unlink', taskId }));
  ok(inspect(board, intent.id));
  assert.deepEqual(history(board).publication.records[0].reconciliation, receipt);
  const backup = ok(board.exportCurrentBackup(current(board).version));
  ok(cmd(board, 'publication', { ...archive, backupSha256: backup.sha256 }));
  ok(cmd(board, 'github', { type: 'unlink', taskId }));
  assert('error' in cmd(board, 'publication', { type: 'prepare-intents', intents: [makeIntent(board, taskId)] }));
  ok(cmd(board, 'github', { type: 'disconnect' }));
  const reviewed = current(board);
  ok(board.review({ boardId: reviewed.snapshot.boardId, expectedVersion: reviewed.version, taskId,
    decision: 'changes-requested', confirmed: true, reviewer: 'Fixture reviewer', scope: 'Review scope', note: 'Preserve the review.' }));
  const blob = JSON.parse(ok(board.exportCurrentBackup(current(board).version)).backupJson);
  for (const identity of ['new', 'restore', 'continue']) {
    const copy = open();
    ok(copy.initialize({ kind: 'import', backup: blob, identity, ...(identity === 'continue' ? { preserveHistoryConfirmed: true } : {}) }));
    const saved = history(copy);
    assert.equal(saved.github.selection, 'disconnected');
    assert.equal(saved.publication.creationLinks[0].intentId, intent.id);
    assert.equal(saved.publication.creationLinks[0].associationTaskId, saved.tasks[0].id);
    assert.notEqual(saved.generation, intent.origin.generation);
    assert('error' in cmd(copy, 'publication', { type: 'mark-attempted', intentId: intent.id, at }));
  }
});

scoped('P19/P23 confirmed anchor preserves the edit back and rejects retirement before refresh', (board) => {
  const taskId = ready(board, true);
  const original = issue.values.title;
  edit(board, taskId, 'Proposed B');
  const intent = makeIntent(board, taskId);
  attempt(board, intent);
  ok(cmd(board, 'publication', { type: 'settle-outcome', intentId: intent.id, outcome: outcome('confirmed', intent.issue) }));
  edit(board, taskId, original);
  assert.deepEqual(history(board).publication.records[0].mergePendingFields, ['title']);
  assert('error' in cmd(board, 'publication', { type: 'retire', recordIds: [intent.id], backupSha256: 'b'.repeat(64), at }));
  ok(refresh(board, { ...issue.values, title: 'Proposed B' }));
  assert.equal(history(board).tasks[0].title, original);
  assert.equal(history(board).github.issues[0].common.title, 'Proposed B');
  assert.deepEqual(history(board).publication.records[0].mergePendingFields, []);
});

scoped('P19/P23 unresolved updates hold refresh and reconciliation leaves unselected local values intact', (board) => {
  const taskId = ready(board, true);
  edit(board, taskId, 'Proposed B');
  const intent = makeIntent(board, taskId);
  attempt(board, intent);
  ok(cmd(board, 'publication', { type: 'settle-outcome', intentId: intent.id, outcome: outcome('unknown', intent.issue) }));
  edit(board, taskId, 'Newer A');
  assert('error' in cmd(board, 'publication', { type: 'prepare-intents', intents: [makeIntent(board, taskId)] }));
  const changed = { ...issue.values, title: 'Remote C', body: 'Fresh remote body', state: 'closed' };
  assert('error' in refresh(board, changed));
  assert('error' in cmd(board, 'publication', { type: 'reconcile', intentId: intent.id, at,
    issue: { id: '999', number: issue.number }, remote: changed, remoteUpdatedAt: at }));
  ok(inspect(board, intent.id, changed));
  const saved = history(board);
  assert.equal(saved.tasks[0].title, 'Newer A');
  assert.equal(saved.tasks[0].description, issue.values.body);
  assert.equal(saved.github.issues[0].localIssueState, issue.values.state);
  assert.equal(saved.github.issues[0].common.body, issue.values.body);
  assert.deepEqual(saved.github.issues[0].conflictFields, ['title']);
  assert.equal(saved.publication.records[0].outcome?.kind, 'unknown');
  assert.equal(saved.publication.records[0].reconciliation?.kind, 'observed-conflict');
  assert('error' in inspect(board, intent.id, changed));
  ok(refresh(board, changed));
  assert.equal(history(board).tasks[0].description, changed.body);
  assert.equal(history(board).tasks[0].title, 'Newer A');
});

scoped('P22 generic public output excludes publication and keeps acceptance independent', (board) => {
  const taskId = ready(board);
  const intent = makeIntent(board, taskId, ['title', 'body']);
  attempt(board, intent);
  const saved = current(board);
  const exported = ok(board.preparePublicReport({ expectedVersion: saved.version,
    labels: { project: null, tasks: [], milestones: [], workstreams: [] } }));
  assert(!JSON.stringify(exported).includes(intent.id));
  assert(!JSON.stringify(exported).includes('Private description'));
  assert.equal(saved.report.acceptance.accepted, 0);
});

scoped('P19/P23 closed remote state survives reattachment of both unknown and confirmed unlinked updates', (board) => {
  const taskId = ready(board, true);
  edit(board, taskId, 'Local proposal');
  const intent = makeIntent(board, taskId);
  attempt(board, intent);
  ok(cmd(board, 'github', { type: 'unlink', taskId }));
  ok(cmd(board, 'publication', { type: 'settle-outcome', intentId: intent.id, outcome: outcome('confirmed', intent.issue) }));
  assert.deepEqual(history(board).publication.records[0].mergePendingFields, []);
  const closed = { ...issue.values, title: 'Remote closed', state: 'closed' };
  ok(inspect(board, intent.id, closed));
  assert.equal(history(board).tasks[0].title, 'Local proposal');
  assert.equal(history(board).github.issues[0].localIssueState, 'closed');
  assert.equal(history(board).publication.records[0].outcome?.kind, 'confirmed');
  assert.equal(history(board).publication.records[0].reconciliation, null);
  edit(board, taskId, 'Newer local proposal');
  const unknown = makeIntent(board, taskId);
  attempt(board, unknown);
  ok(cmd(board, 'publication', { type: 'settle-outcome', intentId: unknown.id, outcome: outcome('unknown', unknown.issue) }));
  ok(cmd(board, 'github', { type: 'unlink', taskId }));
  ok(inspect(board, unknown.id, closed));
  assert.equal(history(board).tasks[0].title, 'Newer local proposal');
  assert.equal(history(board).github.issues[0].localIssueState, 'closed');
  assert.equal(history(board).publication.records[1].reconciliation?.kind, 'observed-conflict');
});

scoped('P20 compact marker capacity refuses retirement atomically and orphan inspection preserves historical identity', (board, open) => {
  const taskId = ready(board);
  const intent = makeIntent(board, taskId);
  attempt(board, intent);
  ok(cmd(board, 'publication', { type: 'settle-outcome', intentId: intent.id, outcome: outcome('unknown', null) }));
  const payload = JSON.parse(ok(board.exportCurrentBackup(current(board).version)).backupJson);
  const backup = structuredClone(payload);
  backup.snapshot.publication.records[0].associationTaskId = null;
  backup.snapshot.tasks = [];
  const restored = open();
  ok(restored.initialize({ kind: 'import', backup, identity: 'restore' }));
  ok(cmd(restored, 'github', { type: 'select', repository, connectionEpoch }));
  ok(inspect(restored, intent.id));
  assert.equal(history(restored).publication.records[0].associationTaskId, null);
  assert.equal(history(restored).github.issues.length, 0);
  assert.equal(history(restored).publication.records[0].reconciliation?.issue.number, issue.number);
  const full = structuredClone(payload);
  full.snapshot.publication.creationLinks = Array.from({ length: 100 }, (_, n) => ({
    intentId: randomUUID(), associationTaskId: null, repositoryId: repository.id, issue: { id: String(700 + n), number: 700 + n },
  }));
  const capped = open();
  ok(capped.initialize({ kind: 'import', backup: full, identity: 'restore' }));
  ok(cmd(capped, 'github', { type: 'select', repository, connectionEpoch }));
  ok(inspect(capped, intent.id));
  const before = current(capped).version;
  const archive = cmd(capped, 'publication', { type: 'retire', recordIds: [intent.id], backupSha256: 'b'.repeat(64), at });
  assert('error' in archive);
  assert.equal(archive.error.code, 'LIMIT_REACHED');
  assert.equal(current(capped).version, before);
  assert.equal(history(capped).publication.records[0].intent.id, intent.id);
});

scoped('P23 confirmed anchor reports conflict when fresh remote and local both diverge', (board) => {
  const task = ready(board, true);
  edit(board, task, 'Proposed B');
  const intent = makeIntent(board, task);
  attempt(board, intent);
  ok(cmd(board, 'publication', { type: 'settle-outcome', intentId: intent.id, outcome: outcome('confirmed', intent.issue) }));
  edit(board, task, 'Local D');
  ok(refresh(board, { ...issue.values, title: 'Remote C' }));
  assert.deepEqual(history(board).github.issues[0].conflictFields, ['title']);
  assert.equal(history(board).tasks[0].title, 'Local D');
  assert.equal(history(board).github.issues[0].common.title, 'Proposed B');
  assert.deepEqual(history(board).publication.records[0].mergePendingFields, []);
  assert('error' in cmd(board, 'publication', { type: 'retire', recordIds: [intent.id], backupSha256: 'b'.repeat(64), at }));
  edit(board, task, 'Remote C');
  assert.deepEqual(history(board).github.issues[0].conflictFields, []);
  assert.equal(history(board).github.issues[0].common.title, 'Remote C');
});

scoped('P23 unselected pending anchor survives another field inspection until explicit refresh', (board, open) => {
  const task = ready(board, true);
  edit(board, task, 'Confirmed title');
  const title = makeIntent(board, task);
  attempt(board, title);
  ok(cmd(board, 'publication', { type: 'settle-outcome', intentId: title.id, outcome: outcome('confirmed', title.issue) }));
  const backup = JSON.parse(ok(board.exportCurrentBackup(current(board).version)).backupJson);
  const base = structuredClone(title);
  base.id = randomUUID();
  base.fields = ['body'];
  base.proposed = { body: 'Intended body' };
  base.before = { body: issue.values.body };
  backup.snapshot.publication.records.push({ intent: base, associationTaskId: task, attemptedAt: at,
    outcome: outcome('unknown', base.issue), reconciliation: null, mergePendingFields: [] });
  const restored = open();
  ok(restored.initialize({ kind: 'import', backup, identity: 'restore' }));
  ok(cmd(restored, 'github', { type: 'select', repository, connectionEpoch }));
  const before = history(restored);
  ok(inspect(restored, base.id, { ...issue.values, title: 'Remote title', body: 'Other body', state: 'closed' }));
  const inspected = history(restored);
  assert.deepEqual(inspected.publication.records[0].mergePendingFields, ['title']);
  assert.equal(inspected.tasks[0].title, before.tasks[0].title);
  assert.equal(inspected.tasks[0].description, before.tasks[0].description);
  assert.equal(inspected.github.issues[0].common.title, before.github.issues[0].common.title);
  assert.equal(inspected.github.issues[0].localIssueState, before.github.issues[0].localIssueState);
  assert.deepEqual(inspected.reviews, before.reviews);
  assert('error' in cmd(restored, 'github', { type: 'resolve', taskId: task, field: 'title', choice: 'remote',
    remoteUpdatedAt: at, observedValue: 'Remote title' }));
  ok(refresh(restored, { ...issue.values, title: 'Remote title', body: 'Other body', state: 'closed' }));
  const refreshed = history(restored);
  assert.deepEqual(refreshed.publication.records[0].mergePendingFields, []);
  assert.equal(refreshed.tasks[0].title, 'Remote title');
  assert.equal(refreshed.github.issues[0].localIssueState, 'closed');
});

scoped('C1 conflicting selected title consumes the stale anchor and preserves the unrelated body anchor', (board, open) => {
  const task = ready(board, true);
  const titleB = 'Confirmed B', titleC = 'Observed C', titleD = 'Intended D';
  const anchoredBody = 'Confirmed body';
  const titleA = issue.values.title;
  const bodyA = issue.values.body;
  ok(cmd(board, 'change', { type: 'task.edit', id: task, fields: { title: titleB, description: anchoredBody } }));
  const earlier = makeIntent(board, task, ['title', 'body']);
  attempt(board, earlier);
  ok(cmd(board, 'publication', { type: 'settle-outcome', intentId: earlier.id, outcome: outcome('confirmed', earlier.issue) }));
  const evidence = ok(cmd(board, 'change', { type: 'evidence.add', fields: { title: 'C1 review evidence', scope: 'unit', outcome: 'passed' } }));
  ok(cmd(board, 'change', { type: 'criterion.add', taskId: task, requirement: 'Inspect before resolving the conflict',
    evidenceIds: [evidence.createdIds.evidenceId!] }));

  const backup = JSON.parse(ok(board.exportCurrentBackup(current(board).version)).backupJson);
  const later: PublicationIntent = { ...structuredClone(earlier), id: randomUUID(), batchId: randomUUID(),
    fields: ['title'], before: { title: titleA }, proposed: { title: titleD } };
  backup.snapshot.publication.records.push({ intent: later, associationTaskId: task, attemptedAt: at,
    outcome: outcome('unknown', later.issue), reconciliation: null, mergePendingFields: [] });

  const restored = open();
  ok(restored.initialize({ kind: 'import', backup, identity: 'restore' }));
  ok(cmd(restored, 'github', { type: 'select', repository, connectionEpoch }));
  const readyForReview = current(restored);
  ok(restored.review({ boardId: readyForReview.snapshot.boardId, expectedVersion: readyForReview.version, taskId: task,
    decision: 'accepted', confirmed: true, reviewer: 'C1 fixture reviewer', scope: 'Reviewed local text', note: 'Preserve this accepted review during inspection.' }));
  const before = history(restored);
  const beforeAcceptance = current(restored).report.acceptance;
  assert.equal(beforeAcceptance.accepted, 1);
  assert.equal(before.reviews.length, 1);
  assert.deepEqual(before.publication.records[0].mergePendingFields, ['title', 'body']);

  const remote = { ...issue.values, title: titleC, body: anchoredBody };
  ok(inspect(restored, later.id, remote));
  const inspected = history(restored);
  assert.equal(inspected.tasks[0].title, titleB);
  assert.equal(inspected.tasks[0].description, anchoredBody);
  assert.deepEqual(inspected.github.issues[0].remote, remote);
  assert.equal(inspected.github.issues[0].common.title, titleD);
  assert.equal(inspected.github.issues[0].common.body, bodyA);
  assert.deepEqual(inspected.github.issues[0].conflictFields, ['title']);
  assert.deepEqual(inspected.publication.records[0], { ...before.publication.records[0], mergePendingFields: ['body'] });
  const observation = inspected.publication.records[1].reconciliation;
  assert.equal(observation?.kind, 'observed-conflict');
  assert.deepEqual(inspected.publication.records[1], { ...before.publication.records[1], reconciliation: observation });
  assert.deepEqual(inspected.reviews, before.reviews);
  assert.deepEqual(current(restored).report.acceptance, beforeAcceptance);

  ok(refresh(restored, remote));
  const refreshed = history(restored);
  assert.equal(refreshed.tasks[0].title, titleB);
  assert.equal(refreshed.tasks[0].description, anchoredBody);
  assert.equal(refreshed.github.issues[0].common.title, titleD);
  assert.equal(refreshed.github.issues[0].common.body, anchoredBody);
  assert.deepEqual(refreshed.github.issues[0].conflictFields, ['title']);
  assert.deepEqual(refreshed.publication.records[0], { ...before.publication.records[0], mergePendingFields: [] });
  assert.deepEqual(refreshed.publication.records[1], inspected.publication.records[1]);
  assert.deepEqual(refreshed.reviews, before.reviews);
  assert.deepEqual(current(restored).report.acceptance, beforeAcceptance);

  ok(cmd(restored, 'github', { type: 'resolve', taskId: task, field: 'title', choice: 'remote',
    remoteUpdatedAt: at, observedValue: titleC }));
  const resolved = history(restored);
  assert.equal(resolved.tasks[0].title, titleC);
  assert.deepEqual(resolved.github.issues[0].conflictFields, []);
  assert.deepEqual(resolved.publication.records, refreshed.publication.records);
  assert.equal(current(restored).report.acceptance.accepted, 0);
  assert.equal(current(restored).report.acceptance.stale, 1);
});

