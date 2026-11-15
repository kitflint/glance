
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../src/board.ts';
import type { Failure, Initialized } from '../src/board.ts';

type OpenBoard = ReturnType<typeof openBoard>;

function boardTest(name: string, exercise: (boardFor: () => OpenBoard) => void) {
  test(name, { timeout: 60_000 }, (t) => {
    const owned: { root: string; board: OpenBoard }[] = [];
    const boardFor = () => {
      const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-board-'));
      const board = openBoard(root);
      owned.push({ root, board });
      return board;
    };
    let passed = false;
    try {
      exercise(boardFor);
      passed = true;
    } finally {
      let closureUncertain = false;
      for (const { root, board } of owned.reverse()) {
        const close = board.close();
        const closed = 'closed' in close || close.error.code === 'CLOSED';
        closureUncertain ||= !closed;
        if (passed && closed) rmSync(root, { recursive: true });
        else t.diagnostic('Retained board fixture: ' + root);
      }
      if (passed) assert(!closureUncertain, 'A board fixture did not close.');
    }
  });
}

function ok<T>(result: T | Failure): T {
  assert(!('error' in (result as object)), JSON.stringify(result));
  return result as T;
}

function code(result: object, expected: Failure['error']['code']) {
  assert('error' in result);
  assert.equal((result as Failure).error.code, expected);
}

function change(board: ReturnType<typeof openBoard>, from: Initialized, operation: unknown) {
  return board.change({ boardId: from.snapshot.boardId, expectedVersion: from.version, operation });
}

boardTest('blank and sample initialize distinct boards and expose the common projection', (boardFor) => {
  const blank = boardFor();
  assert.deepEqual(blank.read(), { initialized: false });
  const empty = ok(blank.initialize({ kind: 'blank', name: 'Local board' }));
  assert.deepEqual(empty.report.counts, { tasks: 0, open: 0, inProgress: 0, blocked: 0, needsReview: 0 });
  assert.deepEqual(empty.report.acceptance, { available: true, accepted: 0, stale: 0, changesRequested: 0 });
  assert.equal(empty.snapshot.revision, 1);
  assert.equal(empty.snapshot.schemaVersion, 2);
  assert.deepEqual(empty.report.taskReviews, []);
  code(blank.initialize({ kind: 'blank', name: 'Overwrite' }), 'ALREADY_EXISTS');
  const sample = ok(boardFor().initialize({ kind: 'sample' }));
  assert.notEqual(sample.snapshot.boardId, empty.snapshot.boardId);
  assert(sample.snapshot.tasks.length > 0);
  assert.equal(sample.snapshot.schemaVersion, 2);
  assert.equal(sample.report.counts.open, sample.snapshot.tasks.length);
  assert(sample.snapshot.tasks.some((task) => task.id === sample.report.focusTaskId));
});

boardTest('versioned edits preserve drafts by returning the confirmed conflict snapshot', (boardFor) => {
  const board = boardFor();
  const initial = ok(board.initialize({ kind: 'blank', name: 'Local board' }));
  const added = ok(change(board, initial, {
    type: 'task.add', fields: { title: 'Reopen', criteria: [{ requirement: 'Saved goal is visible' }] },
  }));
  assert.equal(added.initialized, true);
  assert.equal(added.committed, true);
  assert.equal(added.createdIds.taskId, added.snapshot.tasks[0].id);
  assert.deepEqual(added.createdIds.criterionIds, [added.snapshot.tasks[0].criteria[0].id]);
  const stale = change(board, initial, { type: 'project.edit', fields: { goal: 'Stale' } });
  code(stale, 'REVISION_CONFLICT');
  assert.equal((stale as Failure).current?.version, added.version);
  const same = ok(change(board, added, { type: 'task.edit', id: added.createdIds.taskId, fields: { title: 'Reopen' } }));
  assert.equal(same.committed, false);
  assert.equal(same.version, added.version);
  assert.deepEqual(same.createdIds, {});
});

boardTest('closed schemas, reference checks, cycles and limits leave the confirmed version intact', (boardFor) => {
  const board = boardFor();
  const initial = ok(board.initialize({ kind: 'sample' }));
  const [first, second] = initial.snapshot.tasks;
  assert(second.prerequisites.includes(first.id));
  const badOperations: unknown[] = [
    { type: 'project.edit', fields: { publicReady: true } },
    { type: 'project.edit', fields: { name: null } },
    { type: 'task.edit', id: first.id, fields: { status: 'Accepted' } },
    { type: 'task.edit', id: first.id, fields: { prerequisites: [second.id] } },
    { type: 'task.edit', id: first.id, fields: { prerequisites: [first.id] } },
    { type: 'task.edit', id: second.id, fields: { prerequisites: [first.id, first.id] } },
    { type: 'criterion.edit', taskId: first.id, id: second.criteria[0].id, fields: { requirement: 'Wrong parent' } },
    { type: 'evidence.add', fields: { title: 'Forged', scope: 'local', outcome: 'passed', recordedAt: '2026-11-12T00:00:00Z' } },
  ];
  for (const operation of badOperations) code(change(board, initial, operation), 'INVALID_INPUT');
  code(change(board, initial, { type: 'project.edit', fields: { goal: 'x'.repeat(16001) } }), 'LIMIT_REACHED');
  assert.deepEqual(board.read(), initial);
  board.close();
  code(board.read(), 'CLOSED');
  code(board.recoverySnapshot(), 'CLOSED');
});

boardTest('portable backup preserves failed evidence and correction order in restore and remaps IDs for a copy', (boardFor) => {
  const board = boardFor();
  const start = ok(board.initialize({ kind: 'sample' }));
  const failed = ok(change(board, start, {
    type: 'evidence.add', fields: { title: 'First reopen', scope: 'local', outcome: 'failed', location: 'notes/reopen.txt' },
  }));
  const corrected = ok(change(board, failed, {
    type: 'evidence.add', fields: { title: 'Second reopen', scope: 'local', outcome: 'passed', supersedesId: failed.createdIds.evidenceId },
  }));
  const bundle = ok(board.exportSnapshot(corrected.version));
  const backup: unknown = JSON.parse(bundle.backupJson);
  const restored = ok(boardFor().initialize({ kind: 'import', backup, identity: 'restore' }));
  assert.equal(restored.snapshot.boardId, corrected.snapshot.boardId);
  assert.equal(restored.snapshot.revision, 1);
  assert.notEqual(restored.snapshot.generation, corrected.snapshot.generation);
  assert.deepEqual(restored.snapshot.evidence, corrected.snapshot.evidence);
  const copied = ok(boardFor().initialize({ kind: 'import', backup, identity: 'new' }));
  assert.notEqual(copied.snapshot.boardId, corrected.snapshot.boardId);
  const [copyFailed, copyCorrected] = copied.snapshot.evidence.slice(-2);
  assert.notEqual(copyFailed.id, failed.createdIds.evidenceId);
  assert.equal(copyCorrected.supersedesId, copyFailed.id);
  assert.equal(copyFailed.outcome, 'failed');
  assert.equal(copyFailed.recordedAt, corrected.snapshot.evidence.at(-2)?.recordedAt);
  assert.equal(copied.snapshot.tasks[1].prerequisites[0], copied.snapshot.tasks[0].id);
  assert.notEqual(copied.snapshot.tasks[0].id, corrected.snapshot.tasks[0].id);
});

boardTest('one export packages and hashes one revision and escapes user text and links', (boardFor) => {
  const board = boardFor();
  const start = ok(board.initialize({ kind: 'blank', name: '<script>unsafe</script>' }));
  const inert = ok(change(board, start, {
    type: 'evidence.add', fields: { title: 'Inert [link](bad)', scope: 'local', outcome: 'failed', location: 'javascript:alert(1)' },
  }));
  const linked = ok(change(board, inert, {
    type: 'evidence.add', fields: { title: 'Reference', scope: 'source', outcome: 'unknown', location: 'https://example.test/a(b)' },
  }));
  code(board.exportSnapshot(inert.version), 'REVISION_CONFLICT');
  const bundle = ok(board.exportSnapshot(linked.version));
  assert.equal(bundle.version, linked.version);
  assert(bundle.html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert(!bundle.html.includes('<script>') && !bundle.html.includes('href="javascript:'));
  assert(bundle.html.includes('href="https://example.test/a(b)"'));
  assert(!bundle.markdown.includes('<script>') && !bundle.markdown.includes('](javascript:'));
  assert.deepEqual(JSON.parse(bundle.backupJson), {
    format: 'kitflint.glance.backup', version: 1, exportedAt: bundle.exportedAt, snapshot: linked.snapshot,
  });
  for (const format of ['html', 'markdown', 'backupJson'] as const) {
    assert.equal(bundle.sha256[format], createHash('sha256').update(bundle[format], 'utf8').digest('hex'));
  }
});

boardTest('a valid snapshot can exceed the complete export response cap', (boardFor) => {
  const base = ok(boardFor().initialize({ kind: 'blank', name: 'Large export' }));
  const tasks = Array.from({ length: 110 }, (_, index) => ({
    id: 't_' + randomUUID(), title: 'Task ' + index, description: '&'.repeat(16000), owner: '',
    priority: 'P1', status: 'Planned', milestoneId: null, workstreamId: null,
    prerequisites: [], criteria: [], blockers: [], evidenceIds: [],
  }));
  const backup = {
    format: 'kitflint.glance.backup', version: 1, exportedAt: base.snapshot.updatedAt,
    snapshot: { ...base.snapshot, tasks },
  };
  const board = boardFor();
  const imported = ok(board.initialize({ kind: 'import', backup, identity: 'new' }));
  assert.equal(imported.snapshot.tasks.length, 110);
  code(board.exportSnapshot(imported.version), 'LIMIT_REACHED');
  assert.deepEqual(board.read(), imported);
});

boardTest('evidence added for a task links to that task in the same commit and refuses unknown tasks', (boardFor) => {
  const board = boardFor();
  const start = ok(board.initialize({ kind: 'sample' }));
  const [first, second] = start.snapshot.tasks;
  const fields = { title: 'Task check failed', scope: 'local', outcome: 'failed', location: 'notes/task-check.txt' };
  code(change(board, start, { type: 'evidence.add', fields, taskId: 't_' + randomUUID() }), 'INVALID_INPUT');
  code(change(board, start, { type: 'evidence.add', fields, taskId: 'not-a-task' }), 'INVALID_INPUT');
  assert.deepEqual(board.read(), start);
  const linked = ok(change(board, start, { type: 'evidence.add', fields, taskId: second.id }));
  const evidenceId = linked.createdIds.evidenceId!;
  assert.equal(linked.snapshot.revision, start.snapshot.revision + 1);
  const task = linked.snapshot.tasks.find((item) => item.id === second.id)!;
  assert.deepEqual(task.evidenceIds, [...second.evidenceIds, evidenceId].sort());
  assert.deepEqual(linked.snapshot.tasks.find((item) => item.id === first.id)!.evidenceIds, first.evidenceIds);
  assert.equal(linked.snapshot.evidence.at(-1)!.outcome, 'failed');
  const unlinked = ok(change(board, linked, { type: 'evidence.add', fields: { ...fields, title: 'Unlinked' } }));
  assert.deepEqual(unlinked.snapshot.tasks.map((item) => item.evidenceIds), linked.snapshot.tasks.map((item) => item.evidenceIds));
});
