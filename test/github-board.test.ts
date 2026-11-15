import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { hasGithub, openBoard } from '../src/board.ts';
import type { Failure, Initialized } from '../src/board.ts';

const { connectionEpoch, repository, issue } = JSON.parse(readFileSync(new URL('./fixtures/github/board-v3.json', import.meta.url), 'utf8'));
const observedAt = '2026-11-13T05:00:00Z';
type Board = ReturnType<typeof openBoard>;

function ok<T extends object>(value: T | Failure): T {
  assert(!('error' in value), JSON.stringify(value));
  return value as T;
}
function initialized(board: Board): Initialized {
  const value = ok(board.read());
  assert(value.initialized);
  return value;
}
function github(board: Board, operation: object, from = initialized(board)) {
  return board.github({ boardId: from.snapshot.boardId, expectedVersion: from.version, operation });
}
function state(board: Board) {
  const { snapshot } = initialized(board);
  assert(snapshot.schemaVersion === 3);
  assert(hasGithub(snapshot));
  return snapshot.github;
}
function selected(board: Board) {
  ok(board.initialize({ kind: 'blank', name: 'GitHub board fixture' }));
  ok(github(board, { type: 'prepare' }));
  ok(github(board, { type: 'select', repository, connectionEpoch }));
  return { connectionEpoch, repositoryId: repository.id };
}
function refresh(board: Board, issues: object[]) {
  return github(board, { type: 'refresh', connectionEpoch, repositoryId: repository.id, issues, facts: [],
    collection: { kind: 'issues', pullRequestId: null, page: 1, pagesFetched: 1, count: issues.length,
      observedAt, completeness: 'complete-for-scope' },
    attempt: { at: observedAt, outcome: 'success', code: null } });
}
function fixture(name: string, use: (open: () => Board) => void) {
  test(name, { timeout: 12_000 }, (t) => {
    const roots: Board[] = [];
    try {
      use(() => {
        const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-github-board-'));
        t.diagnostic('Retained owned Board fixture: ' + root);
        const board = openBoard(root);
        roots.push(board);
        return board;
      });
    } finally {
      for (const board of roots.reverse()) assert.deepEqual(board.close(), { closed: true });
    }
  });
}

fixture('G01/G04 schema promotion, private backup, restore, copy and continue preserve review semantics', (open) => {
  const original = open();
  const initial = ok(original.initialize({ kind: 'sample' }));
  assert.equal(initial.snapshot.schemaVersion, 2);
  const before = ok(original.exportSnapshot(initial.version));
  assert.equal(initialized(original).version, initial.version);
  assert.deepEqual(JSON.parse(before.backupJson).snapshot, initial.snapshot);
  const prepared = ok(github(original, { type: 'prepare' }));
  assert.equal(prepared.snapshot.schemaVersion, 3);
  assert.deepEqual(prepared.snapshot.tasks, initial.snapshot.tasks);
  ok(github(original, { type: 'select', repository, connectionEpoch }));
  const imported = ok(github(original, { type: 'import', connectionEpoch, repositoryId: repository.id, issues: [issue] }));
  const reviewed = ok(original.review({ boardId: imported.snapshot.boardId, expectedVersion: imported.version,
    taskId: imported.createdIds.taskIds![0], decision: 'changes-requested', confirmed: true,
    reviewer: 'Fixture reviewer', scope: 'Fixture review', note: 'Add proof before acceptance.' }));
  const bundle = ok(original.exportSnapshot(reviewed.version));
  const backup = JSON.parse(bundle.backupJson);
  assert.deepEqual(backup.snapshot, reviewed.snapshot);
  for (const identity of ['restore', 'new', 'continue']) {
    const other = open();
    const result = ok(other.initialize({ kind: 'import', backup, identity,
      ...(identity === 'continue' ? { preserveHistoryConfirmed: true } : {}) }));
    const cached = state(other);
    assert.equal(cached.selection, 'disconnected');
    assert.notEqual(cached.connectionEpoch, connectionEpoch);
    assert.notEqual(result.snapshot.generation, imported.snapshot.generation);
    assert.equal(cached.issues[0].availability, 'historical');
    assert.equal(cached.issues[0].issueId, issue.issueId);
    assert(result.snapshot.tasks.some(({ id }) => id === cached.issues[0].localTaskId));
    assert(result.snapshot.schemaVersion === 3);
    if (identity === 'continue') assert.equal(result.snapshot.reviewArchive?.reviewCount, 1);
    else assert.equal(result.snapshot.reviews.length, 1);
  }
});

fixture('G02 ten imports, duplicate, wrong identity, overlong fields and atomic version refusal', (open) => {
  const board = open(), selectedScope = selected(board);
  const start = initialized(board);
  const issues = Array.from({ length: 10 }, (_, index) => ({ ...issue, issueId: String(301 + index), number: 31 + index }));
  const command = { type: 'import', ...selectedScope, issues };
  const saved = ok(github(board, command));
  assert.equal(saved.createdIds.taskIds?.length, 10);
  assert.equal(saved.report.acceptance.accepted, 0);
  const rejected = [
    github(board, command),
    github(board, { ...command, repositoryId: '1235' }),
    github(board, { ...command, issues: [{ ...issue, issueId: '999', values: { ...issue.values, body: 'x'.repeat(16001) } }] }),
    github(board, { ...command, issues: [{ ...issue, issueId: '999', extra: true }] }),
    github(board, command, start),
  ];
  for (const result of rejected) assert('error' in result);
  assert.equal(initialized(board).version, saved.version);
  assert.equal(state(board).issues.length, 10);
});

fixture('G03 local and remote merge, persistent conflicts, guarded resolution and independent issue state', (open) => {
  const board = open();
  const selectedScope = selected(board);
  const created = ok(github(board, { type: 'import', ...selectedScope, issues: [issue] }));
  const taskId = created.snapshot.tasks[0].id;
  const linked = (values: object) => ({ issueId: issue.issueId, number: issue.number, remoteUpdatedAt: observedAt, values });
  const edit = (title: string) => {
    const prior = initialized(board);
    return ok(board.change({ boardId: prior.snapshot.boardId, expectedVersion: prior.version,
      operation: { type: 'task.edit', id: taskId, fields: { title } } }));
  };
  ok(refresh(board, [linked({ ...issue.values, title: 'Remote only' })]));
  assert.equal(initialized(board).snapshot.tasks[0].title, 'Remote only');
  edit('Local only');
  ok(refresh(board, [linked({ ...issue.values, title: 'Remote only' })]));
  assert.deepEqual(state(board).issues[0].conflictFields, []);
  const latest = { ...issue.values, title: 'Both changed' };
  ok(refresh(board, [linked(latest)]));
  ok(refresh(board, [linked(latest)]));
  assert.deepEqual(state(board).issues[0].conflictFields, ['title']);
  edit(latest.title);
  assert.deepEqual(state(board).issues[0].conflictFields, []);
  assert.equal(state(board).issues[0].common.title, latest.title);
  edit('Another local edit');
  const newest = { ...latest, title: 'Another remote edit' };
  ok(refresh(board, [linked(newest)]));
  const current = initialized(board);
  assert('error' in github(board, { type: 'resolve', taskId, field: 'title', choice: 'remote',
    remoteUpdatedAt: observedAt, observedValue: 'stale' }));
  assert.equal(initialized(board).version, current.version);
  ok(github(board, { type: 'resolve', taskId, field: 'title', choice: 'remote', remoteUpdatedAt: observedAt, observedValue: newest.title }));
  assert.equal(initialized(board).snapshot.tasks[0].title, newest.title);
  ok(github(board, { type: 'issue-state', taskId, state: 'closed' }));
  assert.equal(state(board).issues[0].localIssueState, 'closed');
  assert.equal(initialized(board).snapshot.tasks[0].status, 'Planned');
  ok(refresh(board, [{ issueId: issue.issueId, number: issue.number, unavailable: true }]));
  assert.equal(state(board).issues[0].availability, 'unknown');
});

fixture('G09 explicit fact clear cascades reviews and preserves linked tasks', (open) => {
  const board = open(), selectedScope = selected(board);
  ok(github(board, { type: 'import', ...selectedScope, issues: [issue] }));
  const collect = (kind: string, pullRequestId: string | null, fact: object) =>
    ok(github(board, { type: 'refresh', ...selectedScope, issues: [],
      facts: [{ ...fact, repositoryId: repository.id, observedAt }],
      collection: { kind, pullRequestId, page: 1, pagesFetched: 1, count: 1, observedAt, completeness: 'complete-for-scope' },
      attempt: { at: observedAt, outcome: 'success', code: null } }));
  collect('pull-requests', null, { kind: 'pull-request', id: '401', number: 41, state: 'open', merged: null, headSha: null,
    baseRef: 'main', updatedAt: observedAt });
  collect('pull-request-reviews', '401', { kind: 'pull-request-review', id: '701', pullRequestId: '401', number: 41,
    commitId: null, state: 'APPROVED', authorLogin: null, submittedAt: null });
  const before = initialized(board);
  const backup = ok(board.exportCurrentBackup(before.version));
  const clear = { type: 'clear-facts', kinds: ['pull-request'], confirmed: true };
  assert('error' in github(board, { ...clear, confirmed: false }));
  ok(github(board, clear));
  assert('error' in github(board, clear, before));
  assert.equal(state(board).facts.length, 0);
  assert.equal(state(board).issues.length, 1);
  assert.equal(JSON.parse(backup.backupJson).snapshot.github.facts.length, 2);
  collect('pull-requests', null, { kind: 'pull-request', id: '401', number: 41, state: 'open', merged: null, headSha: null,
    baseRef: 'main', updatedAt: observedAt });
  assert.equal(state(board).facts.length, 1);
});
test('G01 legacy snapshot bytes survive ordinary reads and become the raw predecessor of prepare', { timeout: 12000 }, (t) => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-github-legacy-'));
  t.diagnostic('Retained owned legacy Board fixture: ' + root);
  const seed = openBoard(root);
  const first = ok(seed.initialize({ kind: 'blank', name: 'Legacy fixture' }));
  assert.deepEqual(seed.close(), { closed: true });
  assert(first.snapshot.schemaVersion === 2);
  const { reviews, reviewArchive, ...legacy } = first.snapshot;
  assert.deepEqual(reviews, []);
  assert.equal(reviewArchive, null);
  const document = JSON.stringify({ ...legacy, schemaVersion: 1 });
  const path = join(root, 'glance.sqlite');
  const writer = new DatabaseSync(path);
  try { writer.prepare('UPDATE state SET document = ?, sha256 = ? WHERE slot = 1')
    .run(document, createHash('sha256').update(document).digest('hex')); }
  finally { writer.close(); }
  function saved(slot: number) {
    const reader = new DatabaseSync(path, { readOnly: true });
    try { return reader.prepare('SELECT document FROM state WHERE slot = ?').get(slot)?.document; }
    finally { reader.close(); }
  }
  const board = openBoard(root);
  try {
    assert.equal(initialized(board).snapshot.schemaVersion, 1);
    assert.equal(ok(board.exportCurrentBackup(first.version)).version, first.version);
    assert.equal(saved(1), document);
    assert.equal(ok(github(board, { type: 'prepare' })).snapshot.schemaVersion, 3);
    assert.equal(saved(2), document);
  } finally { assert.deepEqual(board.close(), { closed: true }); }
});
fixture('G09 fact capacity refusal is atomic and explicit retirement makes room', (open) => {
  const board = open(), identity = selected(board);
  const descriptors = [
    ['workflow-runs', 'workflow-run', { workflowId: '90', status: null, conclusion: null, headSha: null, headBranch: null,
      attempt: 1, createdAt: observedAt, updatedAt: observedAt }],
    ['releases', 'release', { tagName: 'v1', targetCommitish: 'main', draft: false, prerelease: false, publishedAt: null }],
  ] as const;
  const batch = (descriptor: typeof descriptors[number], start: number, count: number) => {
    const [kind, factKind, fields] = descriptor;
    return github(board, { type: 'refresh', ...identity, issues: [],
      facts: Array.from({ length: count }, (_, index) => ({ ...fields, kind: factKind, id: String(start + index),
        repositoryId: repository.id, observedAt })),
      collection: { kind, pullRequestId: null, page: 1, pagesFetched: Math.ceil(count / 10), count, observedAt, completeness: 'partial' },
      attempt: { at: observedAt, outcome: 'partial', code: null } });
  };
  for (const start of [1000, 1030, 1060]) ok(batch(descriptors[0], start, 30));
  ok(batch(descriptors[1], 1090, 10));
  const full = initialized(board);
  assert.equal(state(board).facts.length, 100);
  const excess = batch(descriptors[1], 1100, 1);
  assert('error' in excess);
  assert.equal(excess.error.code, 'LIMIT_REACHED');
  assert.equal(initialized(board).version, full.version);
  ok(github(board, { type: 'clear-facts', kinds: ['release'], confirmed: true }));
  ok(batch(descriptors[1], 1100, 1));
  assert.equal(state(board).facts.length, 91);
});
fixture('G03 remote adoption invalidates accepted mapped work and its accepted dependent', (open) => {
  const board = open(), identity = selected(board);
  const imported = ok(github(board, { type: 'import', ...identity, issues: [issue] }));
  const taskId = imported.createdIds.taskIds![0];
  const edit = (operation: object) => {
    const before = initialized(board);
    return ok(board.change({ boardId: before.snapshot.boardId, expectedVersion: before.version, operation }));
  };
  const proof = edit({ type: 'evidence.add', fields: { title: 'Fixture proof', scope: 'unit', outcome: 'passed' } });
  const criterion = { requirement: 'Proof reviewed', evidenceIds: [proof.createdIds.evidenceId!] };
  edit({ type: 'criterion.add', taskId, ...criterion });
  const downstream = edit({ type: 'task.add', fields: { title: 'Dependent task', prerequisites: [taskId], criteria: [criterion] } });
  const dependentId = downstream.createdIds.taskId!;
  for (const id of [taskId, dependentId]) {
    const current = initialized(board);
    ok(board.review({ boardId: current.snapshot.boardId, expectedVersion: current.version, taskId: id,
      confirmed: true, decision: 'accepted', reviewer: 'Fixture reviewer', scope: 'Synthetic proof', note: 'Reviewed the saved proof.' }));
  }
  assert.equal(initialized(board).report.acceptance.accepted, 2);
  ok(refresh(board, [{ issueId: issue.issueId, number: issue.number, remoteUpdatedAt: observedAt,
    values: { ...issue.values, title: 'Accepted basis changed remotely' } }]));
  const result = initialized(board);
  assert.equal(result.report.acceptance.accepted, 0);
  assert.equal(result.report.acceptance.stale, 2);
  assert(result.snapshot.schemaVersion === 3);
  assert.deepEqual(result.snapshot.reviews.map(({ decision }) => decision), ['accepted', 'accepted', 'stale', 'stale']);
});
