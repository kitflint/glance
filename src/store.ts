
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { win32 as path } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSyncOptions } from 'node:sqlite';

const applicationId = 1262896972;
const pageSize = 4096;
const maxPages = 4096;
const mainFile = 'glance.sqlite';
const sqliteHeaderSize = 100;
const sqliteMagic = Buffer.from('SQLite format 3\0', 'ascii');
const fileNames = [mainFile, 'glance.sqlite-journal', 'glance.sqlite-wal', 'glance.sqlite-shm'] as const;
const createState = 'CREATE TABLE state(slot INTEGER PRIMARY KEY CHECK(slot IN(1,2)), document TEXT NOT NULL, sha256 TEXT NOT NULL) STRICT';
const createIdentity = 'CREATE TABLE identity(slot INTEGER PRIMARY KEY CHECK(slot=1), board_id TEXT NOT NULL, generation TEXT NOT NULL) STRICT';

type StoreCode = 'INVALID_INPUT' | 'ALREADY_EXISTS' | 'RECOVERY_REQUIRED' | 'UNSUPPORTED_VERSION' |
  'BOARD_BUSY' | 'IO_OUTCOME_UNKNOWN';
export type StoreAccess = 'read-write' | 'read-only';

export class StoreError extends Error {
  readonly code: StoreCode;
  constructor(code: StoreCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type StoredDocument = { document: string; sha256: string };
export type CapturedRows = {
  identity: { slot: unknown; board_id: unknown; generation: unknown }[];
  state: { slot: unknown; document: unknown; sha256: unknown }[];
};

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function systemCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function extendedSqliteCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('errcode' in error) || typeof error.errcode !== 'number') {
    return undefined;
  }
  return error.errcode;
}

export function sqliteCode(error: unknown): number | undefined {
  const code = extendedSqliteCode(error);
  return code === undefined ? undefined : code & 0xff;
}

function lstatIfPresent(name: string): BigIntStats | undefined {
  try {
    return lstatSync(name, { bigint: true });
  } catch (error) {
    if (systemCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function canonicalEquals(name: string): boolean {
  return path.normalize(realpathSync.native(name)).toLowerCase() === name.toLowerCase();
}

function normalizedSql(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[ \t\r\n\f]+/g, '').toLowerCase() : '';
}

export class SqliteStore {
  readonly #selected: string;
  readonly #readOnly: boolean;
  #root: string | undefined;
  #rootIdentity: BigIntStats | undefined;
  #mainIdentity: BigIntStats | undefined;
  #db: DatabaseSync | undefined;
  #configured = false;

  constructor(selected: string, access: StoreAccess = 'read-write') {
    this.#selected = selected;
    this.#readOnly = access === 'read-only';
  }

  #requireWriter(): void {
    if (this.#readOnly) throw new StoreError('INVALID_INPUT', 'The board store is read-only.');
  }

  #verifyRoot(): string {
    const selected = this.#selected;
    if (process.platform !== 'win32' || !/^[a-z]:[\\/]/i.test(selected) ||
        selected.slice(2).includes(':') || selected.includes('\0') ||
        selected.slice(3).split(/[\\/]/).some((part) => /[. ]$/.test(part))) {
      throw new StoreError('INVALID_INPUT', 'Select an absolute local Windows directory.');
    }
    const normalized = path.normalize(selected);
    const drive = path.parse(normalized).root;
    const root = normalized === drive ? drive : normalized.replace(/\\+$/, '');
    const unavailable = this.#readOnly && this.#rootIdentity ? 'RECOVERY_REQUIRED' : 'INVALID_INPUT';
    let name = drive;
    for (const segment of root.slice(drive.length).split('\\').filter(Boolean)) {
      name = path.join(name, segment);
      const stat = lstatIfPresent(name);
      if (!stat?.isDirectory() || stat.isSymbolicLink() || !canonicalEquals(name)) {
        throw new StoreError(unavailable, 'The selected directory or a parent is unavailable or redirected.');
      }
    }
    const stat = lstatIfPresent(root);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || !canonicalEquals(root)) {
      throw new StoreError(unavailable, 'The selected directory is unavailable or redirected.');
    }
    if (this.#rootIdentity && (!sameFile(this.#rootIdentity, stat) || this.#root !== root)) {
      throw new StoreError('RECOVERY_REQUIRED', 'The selected directory identity changed.');
    }
    this.#root = root;
    this.#rootIdentity ??= stat;
    return root;
  }

  #files(): Map<(typeof fileNames)[number], BigIntStats> {
    const root = this.#verifyRoot();
    const found = new Map<(typeof fileNames)[number], BigIntStats>();
    for (const name of fileNames) {
      const file = path.join(root, name);
      const stat = lstatIfPresent(file);
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
        throw new StoreError('RECOVERY_REQUIRED', 'A board file is redirected or has an unsupported identity.');
      }
      try {
        if (!canonicalEquals(file)) {
          throw new StoreError('RECOVERY_REQUIRED', 'A board file resolves outside its expected path.');
        }
      } catch (error) {
        // A cooperating writer may finish and remove its transient rollback journal.
        if (name === 'glance.sqlite-journal' && systemCode(error) === 'ENOENT' && !lstatIfPresent(file)) continue;
        throw error;
      }
      found.set(name, stat);
    }
    const main = found.get(mainFile);
    if (this.#mainIdentity && (!main || !sameFile(this.#mainIdentity, main))) {
      throw new StoreError('RECOVERY_REQUIRED', 'The board file identity changed.');
    }
    return found;
  }

  #existingFiles(rejectJournal = this.#readOnly): BigIntStats | undefined {
    const found = this.#files();
    const main = found.get(mainFile);
    const journal = found.has('glance.sqlite-journal');
    if (found.has('glance.sqlite-wal') || found.has('glance.sqlite-shm') ||
        (!this.#readOnly && !main && journal)) {
      throw new StoreError('RECOVERY_REQUIRED', 'The board has unsupported or incomplete journal files.');
    }
    if (rejectJournal && journal) throw new StoreError('BOARD_BUSY', 'A rollback journal is present.');
    return main;
  }

  #verifyReadHeader(main: BigIntStats, rejectJournal: boolean): void {
    const header = Buffer.alloc(sqliteHeaderSize);
    const fd = openSync(path.join(this.#root!, mainFile), 'r');
    let offset = 0;
    try {
      if (!sameFile(main, fstatSync(fd, { bigint: true }))) {
        throw new StoreError('RECOVERY_REQUIRED', 'The board file identity changed.');
      }
      while (offset < header.length) {
        const count = readSync(fd, header, offset, header.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      if (!sameFile(main, fstatSync(fd, { bigint: true }))) {
        throw new StoreError('RECOVERY_REQUIRED', 'The board file identity changed.');
      }
    } finally {
      try {
        closeSync(fd);
      } catch {
        throw new StoreError('IO_OUTCOME_UNKNOWN', 'The board header handle could not be confirmed closed.');
      }
    }
    const current = this.#existingFiles(rejectJournal);
    if (!current || !sameFile(main, current) || offset !== header.length ||
        !header.subarray(0, sqliteMagic.length).equals(sqliteMagic) || header[18] !== 1 || header[19] !== 1) {
      throw new StoreError('RECOVERY_REQUIRED', 'The board header is not a supported rollback-mode SQLite header.');
    }
  }

  confirmReadContention(error: unknown): boolean {
    const code = extendedSqliteCode(error);
    // Do not retry WAL BUSY variants or general READONLY errors.
    if (!this.#readOnly || (code !== 5 && code !== 6 && code !== 776)) return false;
    const main = this.#existingFiles(false);
    if (!main || !this.#mainIdentity || !sameFile(this.#mainIdentity, main)) return false;
    this.#verifyReadHeader(main, false);
    return true;
  }

  #connection(): DatabaseSync {
    if (!this.#db) throw new Error('Store connection is closed.');
    return this.#db;
  }

  #openConnection(): DatabaseSync {
    // Node 24.22.1 supports defensive mode. The admitted Node 24.10.1 declarations predate this option.
    const options: DatabaseSyncOptions & { defensive: true } = {
      timeout: 500,
      allowExtension: false,
      enableForeignKeyConstraints: false,
      defensive: true,
      ...(this.#readOnly ? { readOnly: true } : {}),
    };
    const db = new DatabaseSync(path.join(this.#root!, mainFile), options);
    this.#db = db;
    return db;
  }

  #pragma(query: string, field: string): unknown {
    return this.#connection().prepare(query).get()?.[field];
  }

  #inspect(): void {
    const db = this.#connection();
    if (this.#pragma('PRAGMA journal_mode', 'journal_mode') !== 'delete' ||
        this.#pragma('PRAGMA page_size', 'page_size') !== pageSize) {
      throw new StoreError('RECOVERY_REQUIRED', 'The board uses an unsupported journal mode or page size.');
    }
    const count = this.#pragma('PRAGMA page_count', 'page_count');
    if (typeof count !== 'number' || count > maxPages) {
      throw new StoreError('RECOVERY_REQUIRED', 'The board exceeds its supported page count.');
    }
    if (this.#pragma('PRAGMA application_id', 'application_id') !== applicationId) {
      throw new StoreError('RECOVERY_REQUIRED', 'The file does not identify a Glance board.');
    }
    if (this.#pragma('PRAGMA user_version', 'user_version') !== 1) {
      throw new StoreError('UNSUPPORTED_VERSION', 'This Glance database schema version is unsupported.');
    }
    const schema = db.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY name').all();
    const [identity, state] = schema;
    if (schema.length !== 2 || identity.type !== 'table' || identity.name !== 'identity' ||
        identity.tbl_name !== 'identity' || normalizedSql(identity.sql) !== normalizedSql(createIdentity) ||
        state.type !== 'table' || state.name !== 'state' || state.tbl_name !== 'state' ||
        normalizedSql(state.sql) !== normalizedSql(createState)) {
      throw new StoreError('RECOVERY_REQUIRED', 'The board database structure does not match the expected schema.');
    }
    const tables = db.prepare('PRAGMA main.table_list').all();
    const columns = [
      { name: 'identity', query: 'PRAGMA main.table_xinfo(identity)', names: ['slot', 'board_id', 'generation'] },
      { name: 'state', query: 'PRAGMA main.table_xinfo(state)', names: ['slot', 'document', 'sha256'] },
    ];
    for (const table of columns) {
      const metadata = tables.find((row) => row.schema === 'main' && row.name === table.name);
      const actual = db.prepare(table.query).all();
      if (metadata?.strict !== 1 || metadata.wr !== 0 || metadata.ncol !== 3 || actual.length !== 3 ||
          actual.some((column, index) => column.cid !== index || column.name !== table.names[index] ||
            column.type !== (index === 0 ? 'INTEGER' : 'TEXT') || column.pk !== (index === 0 ? 1 : 0) ||
            column.hidden !== 0 || (index !== 0 && column.notnull !== 1))) {
        throw new StoreError('RECOVERY_REQUIRED', 'The board table metadata does not match the expected schema.');
      }
    }
  }

  #configure(): void {
    this.#connection().exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=4096');
    if (this.#pragma('PRAGMA synchronous', 'synchronous') !== 2 ||
        this.#pragma('PRAGMA foreign_keys', 'foreign_keys') !== 1 ||
        this.#pragma('PRAGMA trusted_schema', 'trusted_schema') !== 0 ||
        this.#pragma('PRAGMA max_page_count', 'max_page_count') !== maxPages) {
      throw new StoreError('RECOVERY_REQUIRED', 'The SQLite connection could not enforce the required settings.');
    }
    this.#configured = true;
  }

  #configureReader(): void {
    const db = this.#connection();
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY');
    if (this.#pragma('PRAGMA query_only', 'query_only') !== 1 ||
        this.#pragma('PRAGMA trusted_schema', 'trusted_schema') !== 0 ||
        this.#pragma('PRAGMA temp_store', 'temp_store') !== 2 ||
        db.prepare("SELECT sqlite_compileoption_used('TEMP_STORE=0') AS file_only").get()?.file_only !== 0) {
      throw new StoreError('RECOVERY_REQUIRED', 'The read-only SQLite settings could not be confirmed.');
    }
  }

  openExisting(): boolean {
    const main = this.#existingFiles();
    if (!main) return false;
    this.#mainIdentity ??= main;
    if (!this.#db) {
      if (this.#readOnly) this.#verifyReadHeader(main, true);
      this.#openConnection();
      if (this.#readOnly) this.#configureReader();
    }
    this.#existingFiles();
    if (!this.#configured) {
      this.#inspect();
      if (this.#readOnly) this.#configured = true;
      else this.#configure();
    }
    return true;
  }

  initialize(boardId: string, generation: string, first: StoredDocument): void {
    this.#requireWriter();
    if (this.#files().size > 0) {
      throw new StoreError('ALREADY_EXISTS', 'A board or board sidecar already exists in this directory.');
    }
    const file = path.join(this.#root!, mainFile);
    let created = false;
    try {
      const fd = openSync(file, 'wx');
      created = true;
      closeSync(fd);
      const main = this.#existingFiles();
      if (!main) throw new Error('The new board file disappeared.');
      this.#mainIdentity = main;
      const db = this.#openConnection();
      this.#existingFiles();
      db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE');
      this.#configure();
      this.begin(true);
      db.exec(createState);
      db.exec(createIdentity);
      db.exec('PRAGMA user_version=1; PRAGMA application_id=1262896972');
      db.prepare('INSERT INTO identity(slot, board_id, generation) VALUES (1, ?, ?)').run(boardId, generation);
      db.prepare('INSERT INTO state(slot, document, sha256) VALUES (1, ?, ?)').run(first.document, first.sha256);
      this.#inspect();
      const rows = this.capture();
      if (rows.identity.length !== 1 || rows.identity[0].board_id !== boardId ||
          rows.identity[0].generation !== generation || rows.state.length !== 1 ||
          rows.state[0].slot !== 1 || rows.state[0].document !== first.document || rows.state[0].sha256 !== first.sha256) {
        throw new Error('The initialized rows did not match the proposed snapshot.');
      }
      this.commit();
    } catch (error) {
      if (!created && systemCode(error) === 'EEXIST') {
        throw new StoreError('ALREADY_EXISTS', 'A board was created by another process.');
      }
      if (created) {
        throw new StoreError('RECOVERY_REQUIRED', 'Board initialization did not complete with a confirmed result.');
      }
      throw error;
    }
  }

  begin(write: boolean): void {
    if (write) this.#requireWriter();
    if (write || this.#readOnly) this.#existingFiles();
    this.#connection().exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  }

  capture(): CapturedRows {
    const db = this.#connection();
    if (!db.isTransaction) throw new Error('A row capture requires a transaction.');
    return {
      identity: db.prepare('SELECT slot, board_id, generation FROM identity ORDER BY slot').all()
        .map((row) => ({ slot: row.slot, board_id: row.board_id, generation: row.generation })),
      state: db.prepare('SELECT slot, document, sha256 FROM state ORDER BY slot').all()
        .map((row) => ({ slot: row.slot, document: row.document, sha256: row.sha256 })),
    };
  }

  stage(previous: StoredDocument, next: StoredDocument): void {
    this.#requireWriter();
    this.#existingFiles();
    const db = this.#connection();
    if (!db.isTransaction) throw new Error('A board write requires a transaction.');
    db.prepare('INSERT INTO state(slot, document, sha256) VALUES (2, ?, ?) ON CONFLICT(slot) DO UPDATE SET document=excluded.document, sha256=excluded.sha256')
      .run(previous.document, previous.sha256);
    const result = db.prepare('UPDATE state SET document=?, sha256=? WHERE slot=1').run(next.document, next.sha256);
    if (result.changes !== 1) throw new Error('The current board row was not updated.');
  }

  commit(): void {
    this.#requireWriter();
    this.#connection().exec('COMMIT');
  }

  inTransaction(): boolean {
    return this.#db?.isTransaction ?? false;
  }

  rollback(): void {
    if (this.#db?.isTransaction) this.#db.exec('ROLLBACK');
  }

  close(): void {
    if (this.#db) this.#db.close();
    this.#db = undefined;
    this.#configured = false;
  }
}
