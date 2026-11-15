import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openBoard, openBoardReader } from '../src/board.ts';
import type { Failure, Initialized } from '../src/board.ts';
import { SqliteStore, StoreError } from '../src/store.ts';

function ok<T>(result: T | Failure): T {
  assert(!('error' in (result as object)), JSON.stringify(result));
  return result as T;
}

function code(result: object) {
  return 'error' in result ? (result as Failure).error.code : undefined;
}

function bytes(root: string) {
  return readdirSync(root).sort().map((name) => {
    const data = readFileSync(join(root, name));
    return { name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  });
}

type Reader = ReturnType<typeof openBoardReader>;
type Fixture = {
  root: string;
  file: string;
  reader(): Reader;
  seed(): Initialized;
};

function readerTest(name: string, exercise: (fixture: Fixture, t: TestContext) => void) {
  test(name, { timeout: 6_000 }, (t) => {
    const parent = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-reader-'));
    const root = join(parent, 'board');
    mkdirSync(root);
    const readers: Reader[] = [];
    let passed = false;
    try {
      exercise({
        root,
        file: join(root, 'glance.sqlite'),
        reader() {
          const reader = openBoardReader(root);
          readers.push(reader);
          return reader;
        },
        seed() {
          const writer = openBoard(root);
          try { return ok(writer.initialize({ kind: 'blank', name: 'Reader fixture' })); }
          finally { assert.deepEqual(writer.close(), { closed: true }); }
        },
      }, t);
      passed = true;
    } finally {
      const closures = readers.map((reader) => reader.close());
      const closed = closures.every((result) => 'closed' in result || code(result) === 'CLOSED');
      if (passed && closed) rmSync(parent, { recursive: true });
      else t.diagnostic('Retained reader fixture: ' + parent);
      if (passed) assert(closed, 'Reader fixture close was not confirmed.');
    }
  });
}

readerTest('reader is frozen, missing stays missing, and CLOSED persists', ({ root, reader }) => {
  const board = reader();
  assert(Object.isFrozen(board));
  assert.deepEqual(Reflect.ownKeys(board).sort(), ['close', 'read']);
  assert.deepEqual(board.read(), { initialized: false });
  assert.deepEqual(board.read(), { initialized: false });
  assert.deepEqual(bytes(root), []);
  assert.deepEqual(board.close(), { closed: true });
  assert.equal(code(board.read()), 'CLOSED');
  assert.equal(code(board.close()), 'CLOSED');
});

readerTest('reads match the writer and advance on the same reader without writes', ({ root, seed, reader }) => {
  const start = seed();
  const board = reader();
  const before = bytes(root);
  assert.deepEqual(board.read(), start);
  assert.deepEqual(bytes(root), before);
  const writer = openBoard(root);
  let saved: Initialized;
  try {
    const changed = ok(writer.change({
      boardId: start.snapshot.boardId, expectedVersion: start.version,
      operation: { type: 'project.edit', fields: { goal: 'Next committed version' } },
    }));
    saved = { initialized: true, snapshot: changed.snapshot, report: changed.report, version: changed.version };
  } finally { assert.deepEqual(writer.close(), { closed: true }); }
  const committed = bytes(root);
  assert.deepEqual(board.read(), saved);
  assert.deepEqual(board.close(), { closed: true });
  assert.deepEqual(bytes(root), committed);
});

readerTest('transient rollback journal refuses repeatedly, then the same reader sees the commit', ({ root, file, seed, reader }) => {
  const start = seed();
  const board = reader();
  assert.deepEqual(board.read(), start);
  const writer = new DatabaseSync(file);
  try {
    writer.exec('BEGIN IMMEDIATE; UPDATE state SET sha256=sha256 || char(32) WHERE slot=1');
    const before = bytes(root);
    assert(before.some((entry) => entry.name === 'glance.sqlite-journal'));
    assert.equal(code(board.read()), 'BOARD_BUSY');
    assert.equal(code(board.read()), 'BOARD_BUSY');
    assert.deepEqual(bytes(root), before);
    writer.exec('UPDATE state SET sha256=rtrim(sha256) WHERE slot=1; COMMIT');
  } finally { writer.close(); }
  const after = bytes(root);
  assert(!after.some((entry) => entry.name === 'glance.sqlite-journal'));
  assert.deepEqual(board.read(), start);
  assert.deepEqual(board.close(), { closed: true });
  assert.deepEqual(bytes(root), after);
});

for (const sidecar of ['-wal', '-shm']) {
  readerTest('unsupported ' + sidecar + ' establishes a persistent recovery hold', ({ root, file, seed, reader }, t) => {
    seed();
    writeFileSync(file + sidecar, Buffer.from([1, 2, 3]), { flag: 'wx' });
    const board = reader();
    const before = bytes(root);
    assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
    assert.deepEqual(bytes(root), before);
    unlinkSync(file + sidecar);
    const capture = t.mock.method(SqliteStore.prototype, 'openExisting', () => {
      assert.fail('Recovery-only reader attempted another open');
    });
    assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
    assert.equal(capture.mock.callCount(), 0);
    assert.deepEqual(board.close(), { closed: true });
    assert.equal(code(board.read()), 'CLOSED');
  });
}

readerTest('WAL header without sidecars is refused before SQLite inspection', ({ root, file, seed, reader }, t) => {
  seed();
  const header = readFileSync(file);
  header[18] = 2;
  header[19] = 2;
  writeFileSync(file, header);
  const before = bytes(root);
  assert.deepEqual(before.map((entry) => entry.name), ['glance.sqlite']);
  const inspect = t.mock.method(DatabaseSync.prototype, 'prepare', () => {
    assert.fail('An unsupported header reached SQLite inspection');
  });
  assert.equal(code(reader().read()), 'RECOVERY_REQUIRED');
  assert.equal(inspect.mock.callCount(), 0);
  assert.deepEqual(bytes(root), before);
});

readerTest('a replaced root stays in recovery on repeated read', ({ root, reader }) => {
  const board = reader();
  assert.deepEqual(board.read(), { initialized: false });
  renameSync(root, root + '-prior');
  mkdirSync(root);
  assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
  assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
  assert.deepEqual(bytes(root), []);
});

readerTest('a replaced main file is refused even after transient close', ({ root, file, seed, reader }) => {
  seed();
  const board = reader();
  assert('initialized' in board.read());
  writeFileSync(file + '-journal', Buffer.from([1]), { flag: 'wx' });
  assert.equal(code(board.read()), 'BOARD_BUSY');
  unlinkSync(file + '-journal');
  renameSync(file, file + '-prior');
  writeFileSync(file, readFileSync(file + '-prior'), { flag: 'wx' });
  const before = bytes(root);
  assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
  assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
  assert.deepEqual(bytes(root), before);
});

for (const fault of ['hash', 'schema']) {
  readerTest('a corrupt ' + fault + ' is held without file changes', ({ root, file, seed, reader }) => {
    seed();
    const db = new DatabaseSync(file);
    try {
      db.exec(fault === 'hash' ? "UPDATE state SET sha256='invalid' WHERE slot=1" : 'CREATE TABLE unexpected (x)');
    } finally { db.close(); }
    const before = bytes(root);
    const board = reader();
    assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
    assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
    assert.deepEqual(board.close(), { closed: true });
    assert.deepEqual(bytes(root), before);
  });
}

readerTest('an unsupported schema reports its code and holds the reader closed to further reads', ({ root, file, seed, reader }, t) => {
  seed();
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA user_version=2'); }
  finally { db.close(); }
  const before = bytes(root);
  const board = reader();
  assert.equal(code(board.read()), 'UNSUPPORTED_VERSION');
  const noReopen = t.mock.method(SqliteStore.prototype, 'openExisting', () => {
    assert.fail('Unsupported-schema reader attempted another open');
  });
  assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
  assert.equal(noReopen.mock.callCount(), 0);
  assert.deepEqual(board.close(), { closed: true });
  assert.deepEqual(bytes(root), before);
});

for (const [errcode, expected] of [
  [5, 'BOARD_BUSY'], [6, 'BOARD_BUSY'], [776, 'BOARD_BUSY'],
  [261, 'RECOVERY_REQUIRED'], [262, 'RECOVERY_REQUIRED'],
  [8, 'RECOVERY_REQUIRED'], [1032, 'RECOVERY_REQUIRED'], [266, 'RECOVERY_REQUIRED'],
] as const) {
  readerTest('SQLite error ' + errcode + ' preserves the reader state contract', ({ root, seed, reader }, t) => {
    const start = seed();
    const board = reader();
    const before = bytes(root);
    const fault = t.mock.method(SqliteStore.prototype, 'capture', () => {
      throw Object.assign(new Error('Synthetic SQLite fault'), { errcode });
    });
    try { assert.equal(code(board.read()), expected); }
    finally { fault.mock.restore(); }
    if (expected === 'BOARD_BUSY') assert.deepEqual(board.read(), start);
    else assert.equal(code(board.read()), 'RECOVERY_REQUIRED');
    assert.deepEqual(board.close(), { closed: true });
    assert.equal(code(board.read()), 'CLOSED');
    assert.deepEqual(bytes(root), before);
  });
}

for (const operation of ['rollback', 'close'] as const) {
  readerTest('uncertain ' + operation + ' makes subsequent reads terminal', ({ root, seed, reader }, t) => {
    seed();
    const board = reader();
    const before = bytes(root);
    const capture = t.mock.method(SqliteStore.prototype, 'capture', () => {
      throw Object.assign(new Error('Synthetic busy fault'), { errcode: 5 });
    });
    const fault = t.mock.method(SqliteStore.prototype, operation, () => {
      throw new Error('Synthetic uncertain cleanup');
    });
    try { assert.equal(code(board.read()), 'IO_OUTCOME_UNKNOWN'); }
    finally {
      capture.mock.restore();
      fault.mock.restore();
    }
    const noReopen = t.mock.method(SqliteStore.prototype, 'openExisting', () => {
      assert.fail('Terminal reader attempted another open');
    });
    assert.equal(code(board.read()), 'IO_OUTCOME_UNKNOWN');
    assert.equal(code(board.read()), 'IO_OUTCOME_UNKNOWN');
    assert.equal(noReopen.mock.callCount(), 0);
    assert.deepEqual(board.close(), { closed: true });
    assert.equal(code(board.read()), 'CLOSED');
    assert.deepEqual(bytes(root), before);
  });
}

readerTest('read-only store rejects every mutation before touching a missing board', ({ root }) => {
  const store = new SqliteStore(root, 'read-only');
  const sample = { document: '{}', sha256: '' };
  const invalid = (error: unknown) => error instanceof StoreError && error.code === 'INVALID_INPUT';
  try {
    assert.throws(() => store.initialize('b', 'g', sample), invalid);
    assert.throws(() => store.begin(true), invalid);
    assert.throws(() => store.stage(sample, sample), invalid);
    assert.throws(() => store.commit(), invalid);
    assert.deepEqual(bytes(root), []);
  } finally { store.close(); }
});
