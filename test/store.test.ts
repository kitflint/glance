
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openBoard } from '../src/board.ts';
import type { Failure, Initialized, Changed } from '../src/board.ts';
import { SqliteStore } from '../src/store.ts';

type OwnedFixtures = { roots: string[]; boards: ReturnType<typeof openBoard>[] };

function storeTest(name: string, exercise: (t: TestContext, owned: OwnedFixtures) => void | Promise<void>) {
  test(name, { timeout: 60_000 }, async (t) => {
    const owned: OwnedFixtures = { roots: [], boards: [] };
    let passed = false;
    try {
      await exercise(t, owned);
      passed = true;
    } finally {
      let allClosed = true;
      for (const board of owned.boards.reverse()) {
        const close = board.close();
        allClosed = allClosed && ('closed' in close || close.error.code === 'CLOSED');
      }
      for (const root of owned.roots) {
        if (passed && allClosed) rmSync(root, { recursive: true });
        else t.diagnostic('Retained store fixture: ' + root);
      }
      if (passed) assert(allClosed, 'A board fixture did not close.');
    }
  });
}

function fixture(owned: OwnedFixtures) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-store-'));
  owned.roots.push(root);
  return { root, file: join(root, 'glance.sqlite') };
}

function ok<T>(result: T | Failure): T {
  assert(!('error' in (result as object)), JSON.stringify(result));
  return result as T;
}

function errorCode(result: object): string | undefined {
  return 'error' in result ? (result as Failure).error.code : undefined;
}

function edit(from: Initialized, goal: string) {
  return { boardId: from.snapshot.boardId, expectedVersion: from.version, operation: { type: 'project.edit', fields: { goal } } };
}

function openTracked(owned: OwnedFixtures, root: string) {
  const board = openBoard(root);
  owned.boards.push(board);
  return board;
}

function rawUpdate(file: string, apply: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file);
  try { apply(db); } finally { db.close(); }
}

function childExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('Owned fixture worker did not exit'));
    }, 3000);
    const onExit = () => { clearTimeout(timer); resolve(); };
    child.once('exit', onExit);
  });
}

function worker(root: string) {
  const file = fileURLToPath(new URL('./fixtures/store-worker.ts', import.meta.url));
  const child = fork(file, [root], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let counter = 0;
  function send(operation: 'read' | 'change' | 'close', command?: unknown): Promise<unknown> {
    const requestId = ++counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Store worker response timed out')), 4000);
      const onMessage = (message: { requestId: number; result: unknown }) => {
        if (message.requestId === requestId) finish(undefined, message.result);
      };
      const onExit = () => finish(new Error('Store worker exited before replying'));
      const finish = (error?: Error, result?: unknown) => {
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        child.removeListener('exit', onExit);
        child.removeListener('error', finish);
        if (error) reject(error); else resolve(result);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', finish);
      child.send({ requestId, operation, command }, (error) => { if (error) finish(error); });
    });
  }
  return {
    send,
    async close() {
      try {
        if (child.connected) {
          const result = await send('close');
          assert.deepEqual(result, { closed: true });
        }
        await childExit(child);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await childExit(child);
        throw error;
      }
      assert.equal(child.exitCode, 0);
    },
  };
}

storeTest('one current and one predecessor survive close and reopen', (t, owned) => {
  const { root } = fixture(owned);
  const board = openTracked(owned, root);
  const start = ok(board.initialize({ kind: 'blank', name: 'Durable' }));
  const saved = ok(board.change(edit(start, 'Second version')));
  board.close();
  const reopened = openTracked(owned, root);
  const read = ok(reopened.read());
  assert(read.initialized);
  assert.equal(read.version, saved.version);
  assert.deepEqual(read.snapshot, saved.snapshot);
  const recovery = ok(reopened.recoverySnapshot());
  assert(recovery.available);
  assert.equal(recovery.sourceVersion, start.version);
});

storeTest('two independent writers share the same optimistic version', async (t, owned) => {
  const { root } = fixture(owned);
  const board = openTracked(owned, root);
  const start = ok(board.initialize({ kind: 'blank', name: 'Concurrent' }));
  board.close();
  const left = worker(root);
  const right = worker(root);
  try {
    const results = await Promise.all([
      left.send('change', edit(start, 'Left')),
      right.send('change', edit(start, 'Right')),
    ]) as (Changed | Failure)[];
    const success = results.filter((result) => 'committed' in result && result.committed);
    const refused = results.filter((result) => errorCode(result));
    assert.equal(success.length, 1);
    assert.equal(refused.length, 1);
    assert(['REVISION_CONFLICT', 'BOARD_BUSY'].includes(errorCode(refused[0]) ?? ''));
    const saved = ok(openTracked(owned, root).read());
    assert(saved.initialized);
    assert.equal(saved.snapshot.revision, 2);
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

storeTest('a successful writer returns its own revision after an intervening commit', (t, owned) => {
  const { root } = fixture(owned);
  const board = openTracked(owned, root);
  const other = openTracked(owned, root);
  const first = ok(board.initialize({ kind: 'blank', name: 'Two writers' }));
  const commit = SqliteStore.prototype.commit;
  let intervened = false;
  t.mock.method(SqliteStore.prototype, 'commit', function (this: SqliteStore) {
    commit.call(this);
    if (intervened) return;
    intervened = true;
    const head = ok(other.read());
    assert(head.initialized);
    assert.equal(ok(other.change(edit(head, 'Later writer'))).snapshot.revision, 3);
  });
  const own = ok(board.change(edit(first, 'Original writer')));
  assert.equal(own.snapshot.revision, 2);
  assert.equal(own.snapshot.project.goal, 'Original writer');
  const head = ok(board.read());
  assert(head.initialized);
  assert.equal(head.snapshot.project.goal, 'Later writer');
});

storeTest('rollback, lost commit response and uncertain original closure have distinct outcomes', (t, owned) => {
  const { root } = fixture(owned);
  const board = openTracked(owned, root);
  const start = ok(board.initialize({ kind: 'blank', name: 'Outcomes' }));
  const stage = SqliteStore.prototype.stage;
  const stagedFault = t.mock.method(SqliteStore.prototype, 'stage', function (this: SqliteStore, ...args: Parameters<typeof stage>) {
    stage.call(this, ...args);
    throw new Error('Synthetic write-path failure');
  });
  assert.equal(errorCode(board.change(edit(start, 'Rollback'))), 'IO_NOT_COMMITTED');
  stagedFault.mock.restore();
  assert.deepEqual(board.read(), start);

  const commit = SqliteStore.prototype.commit;
  const lost = t.mock.method(SqliteStore.prototype, 'commit', function (this: SqliteStore) {
    commit.call(this);
    throw new Error('Synthetic lost commit result');
  });
  const committed = ok(board.change(edit(start, 'Reconciled')));
  assert.equal(committed.snapshot.revision, 2);
  lost.mock.restore();

  const commitFault = t.mock.method(SqliteStore.prototype, 'commit', () => { throw new Error('Synthetic uncertain commit'); });
  const closeFault = t.mock.method(SqliteStore.prototype, 'close', () => { throw new Error('Synthetic uncertain close'); });
  assert.equal(errorCode(board.change(edit(committed, 'Held'))), 'IO_OUTCOME_UNKNOWN');
  closeFault.mock.restore();
  commitFault.mock.restore();
  assert.equal(errorCode(board.read()), 'IO_OUTCOME_UNKNOWN');
  assert.equal(errorCode(board.change(edit(committed, 'Still held'))), 'IO_OUTCOME_UNKNOWN');
});

storeTest('cold recovery freezes a validated predecessor and restores into a fresh generation', (t, owned) => {
  const { root, file } = fixture(owned);
  const original = openTracked(owned, root);
  const first = ok(original.initialize({ kind: 'sample' }));
  const latest = ok(original.change(edit(first, 'Latest')));
  original.close();
  rawUpdate(file, (db) => db.exec("UPDATE state SET sha256='wrong' WHERE slot=1"));
  const cold = openTracked(owned, root);
  const failed = cold.read();
  assert.equal(errorCode(failed), 'RECOVERY_REQUIRED');
  assert('recoveryAvailable' in failed && failed.recoveryAvailable);
  const cached = ok(cold.recoverySnapshot());
  assert(cached.available);
  assert.equal(cached.sourceVersion, first.version);
  // Renaming after positive closure also makes any attempted reopen fail.
  const held = join(root, 'original-evidence.sqlite');
  renameSync(file, held);
  assert.deepEqual(cold.recoverySnapshot(), cached);
  assert.equal(errorCode(cold.change(edit(latest, 'Refused'))), 'RECOVERY_REQUIRED');
  const newRoot = fixture(owned).root;
  const restored = ok(openTracked(owned, newRoot).initialize({
    kind: 'import', backup: JSON.parse(cached.backupJson), identity: 'restore',
  }));
  assert.equal(restored.snapshot.boardId, first.snapshot.boardId);
  assert.notEqual(restored.version, first.version);
  assert.equal(restored.snapshot.revision, 1);
  assert.deepEqual(restored.snapshot.evidence, first.snapshot.evidence);
});

storeTest('an unrelated predecessor is unavailable and a persisted WAL mode is refused without conversion', (t, owned) => {
  const { root, file } = fixture(owned);
  const board = openTracked(owned, root);
  const start = ok(board.initialize({ kind: 'blank', name: 'Identity' }));
  ok(board.change(edit(start, 'Second')));
  board.close();
  const unrelated = { ...start.snapshot, boardId: 'b_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const bytes = JSON.stringify(unrelated);
  rawUpdate(file, (db) => {
    db.prepare("UPDATE state SET document=?, sha256=? WHERE slot=2").run(bytes, createHash('sha256').update(bytes).digest('hex'));
    db.exec("UPDATE state SET sha256='wrong' WHERE slot=1");
  });
  const cold = openTracked(owned, root);
  assert.equal(errorCode(cold.read()), 'RECOVERY_REQUIRED');
  assert.deepEqual(cold.recoverySnapshot(), { available: false });
  cold.close();

  const wal = fixture(owned);
  const valid = openTracked(owned, wal.root);
  ok(valid.initialize({ kind: 'blank', name: 'Wrong mode' }));
  valid.close();
  rawUpdate(wal.file, (db) => { db.exec('PRAGMA journal_mode=WAL'); });
  const before = readFileSync(wal.file);
  assert.equal(errorCode(openTracked(owned, wal.root).read()), 'RECOVERY_REQUIRED');
  assert.deepEqual(readFileSync(wal.file), before);
});

storeTest('a corrupt SQLite file requires recovery and preserves its original bytes', (t, owned) => {
  const { root, file } = fixture(owned);
  const original = Buffer.alloc(4096, 0xa5);
  writeFileSync(file, original, { flag: 'wx' });
  const board = openTracked(owned, root);

  const result = board.read();
  assert.equal(errorCode(result), 'RECOVERY_REQUIRED');
  assert('recoveryAvailable' in result && result.recoveryAvailable === false);
  assert.deepEqual(board.recoverySnapshot(), { available: false });
  assert.equal(errorCode(board.initialize({ kind: 'blank', name: 'Do not overwrite' })), 'RECOVERY_REQUIRED');
  assert.deepEqual(board.close(), { closed: true });
  assert.deepEqual(readFileSync(file), original);
});

storeTest('a concurrent writer cannot split a reader capture across two committed versions', (t, owned) => {
  const { root } = fixture(owned);
  const reader = openTracked(owned, root);
  const writer = openTracked(owned, root);
  const start = ok(reader.initialize({ kind: 'blank', name: 'Coherent reader' }));
  const second = ok(writer.change(edit(start, 'Current')));
  const capture = SqliteStore.prototype.capture;
  let interleaved = false;
  const hook = t.mock.method(SqliteStore.prototype, 'capture', function (this: SqliteStore) {
    const rows = capture.call(this);
    if (!interleaved) {
      interleaved = true;
      assert(this.inTransaction());
      assert.equal(errorCode(writer.change(edit(second, 'After reader'))), 'BOARD_BUSY');
    }
    return rows;
  });
  const captured = ok(reader.read());
  assert(captured.initialized && interleaved);
  assert.equal(captured.version, second.version);
  hook.mock.restore();
  const third = ok(writer.change(edit(second, 'After reader')));
  assert.deepEqual(reader.read(), {
    initialized: true, snapshot: third.snapshot, version: third.version, report: third.report,
  });
  const predecessor = ok(reader.recoverySnapshot());
  assert(predecessor.available);
  assert.equal(predecessor.sourceVersion, second.version);
});
