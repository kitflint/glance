import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseJSONRPCMessage } from '@modelcontextprotocol/server';
import { openBoard, openBoardReader } from '../src/board.ts';
import type { BoardReader, Changed, Failure, Initialized } from '../src/board.ts';
import { createGlanceMcpServer } from '../src/mcp.ts';
import type { BoardChange } from '../src/mcp.ts';

const entry = fileURLToPath(new URL('../src/mcp-main.ts', import.meta.url));
const protocol = '2026-07-28';
const waitMs = 5_000;
const fileDeadline = AbortSignal.timeout(60_000);
const update = 'glance_update_board';
const readTools = ['glance_read_overview', 'glance_list_tasks', 'glance_read_task', 'glance_list_evidence', 'glance_github_overview', 'glance_github_list', 'glance_github_task'];
const identity = { name: 'glance-write-test', version: '0.1.0' };
const boardId = 'b_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const version = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1';
let childClosureKnown = true;

class InPlaceStdio extends StdioClientTransport {}

type Log = Record<string, unknown>;
type Fixture = { root: string; artifacts: string };
type Call = (name: string, args?: Log) => Promise<CallToolResult>;
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type UpdatePayload = {
  ok: true; boardId: string; version: string; updatedAt: string;
  committed: boolean; createdIds: Changed['createdIds'];
};

function within<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(description + ' exceeded five seconds.')), waitMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function errorRecord(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}

function writeCase(name: string, exercise: (fixture: Fixture) => Promise<void>) {
  test(name, { timeout: 60_000, signal: fileDeadline }, async (t) => {
    if (!childClosureKnown) {
      t.skip('NOT_RUN: preceding child closure is UNKNOWN.');
      return;
    }
    const artifacts = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-mcp-write-'));
    const root = join(artifacts, 'board');
    mkdirSync(root);
    t.diagnostic('Retained MCP write fixture and evidence: ' + artifacts);
    await exercise({ root, artifacts });
  });
}

function ok<T extends object>(result: T | Failure): T {
  assert(!('error' in result), JSON.stringify(result));
  return result as T;
}

function withWriter<T>(root: string, use: (writer: ReturnType<typeof openBoard>) => T): T {
  const writer = openBoard(root);
  try { return use(writer); }
  finally { assert.deepEqual(writer.close(), { closed: true }); }
}

function seed(root: string): Initialized {
  return withWriter(root, (writer) => ok(writer.initialize({ kind: 'blank', name: 'Glance write fixture' })));
}

function readSaved(root: string): Initialized {
  const reader = openBoardReader(root);
  try {
    const board = ok(reader.read());
    assert(board.initialized);
    return board;
  } finally {
    assert.deepEqual(reader.close(), { closed: true });
  }
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inventory(root: string) {
  return readdirSync(root).sort().map((name) => {
    const bytes = readFileSync(join(root, name));
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

function receipt(fixture: Fixture, name: string, data: Log) {
  writeFileSync(join(fixture.artifacts, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}

function capture(path: string) {
  writeFileSync(path, '', { flag: 'wx' });
  let error: ReturnType<typeof errorRecord> | undefined;
  let bytes = 0;
  return {
    append(chunk: Buffer) {
      if (error) return;
      try {
        appendFileSync(path, chunk);
        bytes += chunk.length;
      } catch (failure) {
        error = errorRecord(failure);
      }
    },
    report(eof: boolean) {
      const raw = readFileSync(path);
      return { path, bytes, sha256: sha256(raw), eof, complete: eof && !error && raw.length === bytes, error };
    },
  };
}

const emptyReader: BoardReader = {
  read: () => ({ initialized: false }),
  close: () => ({ closed: true }),
};

async function withMemory(reader: BoardReader, change: BoardChange | undefined,
  exercise: (client: Client, call: Call) => Promise<void>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGlanceMcpServer(reader, change);
  const client = new Client(identity, { versionNegotiation: { mode: 'legacy' } });
  try {
    await within(server.connect(serverTransport), 'In-memory server connection');
    await within(client.connect(clientTransport, { timeout: waitMs }), 'In-memory client connection');
    await exercise(client, (name, args = {}) =>
      within(client.callTool({ name, arguments: args }, { timeout: waitMs }), name));
  } finally {
    try { await within(client.close(), 'In-memory client close'); }
    finally { await within(server.close(), 'In-memory server close'); }
  }
}

function launchArgs(root: string, allowWrites: boolean) {
  return ['--root', root, ...(allowWrites ? ['--allow-writes'] : [])];
}

async function withClient(fixture: Fixture, allowWrites: boolean, exercise: (call: Call) => Promise<void>) {
  const operations: Log[] = [];
  const stderr = capture(join(fixture.artifacts, 'sdk-stderr.raw'));
  const transport = new InPlaceStdio({
    command: process.execPath, args: [entry, ...launchArgs(fixture.root, allowWrites)],
    cwd: fixture.artifacts, stderr: 'pipe', maxBufferSize: 524_288,
  });
  const closed = deferred<void>();
  let childClose = false;
  let stderrEof = false;
  let established = false;
  let metadata: Log = {};
  transport.onclose = () => { childClose = true; closed.resolve(); };
  transport.onerror = (error) => { operations.push({ transportError: errorRecord(error) }); };
  const stream = transport.stderr;
  assert(stream);
  stream.on('data', (chunk: Buffer) => stderr.append(chunk));
  stream.on('end', () => { stderrEof = true; });
  const client = new Client(identity, {
    versionNegotiation: { mode: { pin: protocol }, probe: { timeoutMs: waitMs, maxRetries: 0 } },
  });
  const notExposed = 'NOT_EXPOSED_BY_PUBLIC_API';

  childClosureKnown = false;
  try {
    await within(client.connect(transport, { timeout: waitMs }), 'SDK connect');
    established = true;
    metadata = {
      era: client.getProtocolEra(), version: client.getNegotiatedProtocolVersion(),
      server: client.getServerVersion(), node: process.version, platform: process.platform, sdk: '2.4.0',
    };
    assert.equal(metadata.era, 'modern');
    assert.equal(metadata.version, protocol);
    await exercise(async (name, args = {}) => {
      const record: Log = { name, arguments: args };
      operations.push(record);
      try {
        const result = await within(client.callTool({ name, arguments: args }, { timeout: waitMs }), name);
        record.result = result;
        return result;
      } catch (error) {
        record.error = errorRecord(error);
        throw error;
      }
    });
  } finally {
    let closeError: ReturnType<typeof errorRecord> | undefined;
    try {
      await within(client.close(), 'SDK close');
      if (established) await within(closed.promise, 'SDK child-close notification');
    } catch (error) {
      closeError = errorRecord(error);
    } finally {
      childClosureKnown = established && childClose;
      receipt(fixture, 'sdk-receipt.json', {
        metadata, operations, established, closeError, sdkTransportChildCloseObserved: childClose,
        closure: childClosureKnown ? 'CHILD_CLOSE_OBSERVED' : 'UNKNOWN',
        sdkClientRawStdout: notExposed, sdkChildExitCode: notExposed, sdkChildSignal: notExposed,
        sdkEscalation: notExposed, applicationCleanup: 'UNCONFIRMED', stderr: stderr.report(stderrEof),
      });
    }
    assert(!closeError, JSON.stringify(closeError));
    assert(childClosureKnown, 'SDK child closure is unknown.');
    assert(stderr.report(stderrEof).complete, 'SDK stderr capture is incomplete.');
  }
}

function textObject(result: CallToolResult): Log {
  assert.equal(result.content?.length, 1);
  const block = result.content?.[0];
  assert(block?.type === 'text');
  return JSON.parse(block.text) as Log;
}

function success(result: CallToolResult): Log {
  assert.notEqual(result.isError, true);
  const data = textObject(result);
  assert.deepEqual(data, result.structuredContent);
  assert.equal(data.ok, true);
  return data;
}

function updated(result: CallToolResult): UpdatePayload {
  const data = success(result);
  assert.deepEqual(Object.keys(data).sort(), ['boardId', 'committed', 'createdIds', 'ok', 'updatedAt', 'version']);
  assert.equal(typeof data.boardId, 'string');
  assert.equal(typeof data.version, 'string');
  assert.equal(typeof data.updatedAt, 'string');
  assert.equal(typeof data.committed, 'boolean');
  assert(data.createdIds && typeof data.createdIds === 'object' && !Array.isArray(data.createdIds));
  return data as UpdatePayload;
}

function expectError(result: CallToolResult, code: string, currentVersion?: string) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  const data = textObject(result);
  assert.deepEqual(Object.keys(data).sort(), ['ok', 'code', 'message', ...(currentVersion ? ['currentVersion'] : [])].sort());
  assert.equal(data.ok, false);
  assert.equal(data.code, code);
  assert.equal(typeof data.message, 'string');
  if (currentVersion) assert.equal(data.currentVersion, currentVersion);
  return data.message;
}

async function sdkRefusal(use: () => Promise<CallToolResult>, expectedMessage: RegExp) {
  let result: CallToolResult;
  try { result = await use(); }
  catch (error) {
    assert(error instanceof Error);
    assert.match(error.message, expectedMessage);
    return;
  }
  assert.equal(result.isError, true);
  const block = result.content?.[0];
  assert(block?.type === 'text');
  assert.match(block.text, expectedMessage);
}

function command(board: Initialized, operation: Log) {
  return { boardId: board.snapshot.boardId, expectedVersion: board.version, operation };
}

function projectEdit(goal: string) {
  return { type: 'project.edit', fields: { goal } };
}

writeCase('W01 default and opted-in discovery and annotations', async () => {
  const change = () => { throw new Error('Discovery cannot invoke a change.'); };
  for (const capability of [undefined, change]) {
    await withMemory(emptyReader, capability, async (client) => {
      const { tools } = await within(client.listTools(undefined, { timeout: waitMs }), 'Tool discovery');
      assert.deepEqual(tools.map(({ name }) => name).sort(), [...readTools, ...(capability ? [update] : [])].sort());
      for (const { name, annotations } of tools) {
        const writes = name === update;
        assert.deepEqual(annotations, {
          readOnlyHint: !writes, destructiveHint: writes, idempotentHint: !writes, openWorldHint: false,
        });
      }
    });
  }
});

writeCase('W02 one callback and exact compact success metadata', async ({ root }) => {
  const board = seed(root);
  const input = command(board, { type: 'task.add', fields: { title: 'New task' } });
  const createdIds = { taskId: 't_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', criterionIds: [] };
  const changed = { ...board, committed: true, createdIds };
  const seen: unknown[] = [];
  await withMemory(emptyReader, (value) => { seen.push(value); return changed; }, async (_client, call) => {
    assert.deepEqual(updated(await call(update, input)), {
      ok: true, boardId: board.snapshot.boardId, version: board.version, updatedAt: board.snapshot.updatedAt,
      committed: true, createdIds,
    });
  });
  assert.deepEqual(seen, [input]);
});

writeCase('W03 invalid shapes and unknown operations refuse before callback', async () => {
  const input = { boardId, expectedVersion: version, operation: projectEdit('Fixture') };
  let calls = 0;
  await withMemory(emptyReader, () => { calls++; throw new Error('Unexpected change'); }, async (_client, call) => {
    for (const args of [
      { ...input, extra: true },
      { boardId, operation: input.operation },
      { ...input, operation: { type: 'unknown.action' } },
      { ...input, operation: { ...input.operation, extra: true } },
      { ...input, operation: { type: 'task.add', fields: [] } },
    ]) {
      await sdkRefusal(() => call(update, args), /Invalid board update arguments\./);
    }
  });
  assert.equal(calls, 0);
});

writeCase('W04 adapter UTF-8 cap rejects before callback', async () => {
  const args = { boardId, expectedVersion: version, operation: projectEdit('한'.repeat(11_000)) };
  const serialized = JSON.stringify(args);
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: update, arguments: args } }) + '\n';
  assert(serialized.length < 32_768 && Buffer.byteLength(serialized) > 32_768 && Buffer.byteLength(frame) < 65_536);
  let calls = 0;
  await withMemory(emptyReader, () => { calls++; throw new Error('Unexpected change'); }, async (_client, call) => {
    assert.equal(expectError(await call(update, args), 'LIMIT_REACHED'), 'The update arguments exceed 32768 UTF-8 bytes.');
  });
  assert.equal(calls, 0);
});

writeCase('W05 simulated unknown change outcome returns fixed message without retry', async () => {
  let calls = 0;
  await withMemory(emptyReader, () => {
    calls++;
    throw new Error('Private fault at D:/private/board');
  }, async (_client, call) => {
    assert.equal(expectError(await call(update, {
      boardId, expectedVersion: version, operation: projectEdit('Fixture'),
    }), 'IO_OUTCOME_UNKNOWN'), 'The update outcome is unknown. Read the saved board and compare before another update.');
  });
  assert.equal(calls, 1);
});

writeCase('W06 unsupported acceptance and unknown fields preserve the saved board', async (fixture) => {
  const saved = seed(fixture.root);
  const before = inventory(fixture.root);
  await withClient(fixture, true, async (call) => {
    for (const fields of [
      { title: 'Refused', status: 'Accepted' },
      { title: 'Refused', accepted: true },
      JSON.parse('{"title":"Refused","__proto__":{"accepted":true}}') as Log,
    ]) {
      expectError(await call(update, command(saved, { type: 'task.add', fields })), 'INVALID_INPUT');
    }
  });
  assert.deepEqual(inventory(fixture.root), before);
  assert.deepEqual(readSaved(fixture.root), saved);
});

writeCase('W07 missing board refuses without creating files', async (fixture) => {
  await withClient(fixture, true, async (call) => {
    expectError(await call(update, { boardId, expectedVersion: version, operation: projectEdit('Fixture') }), 'NOT_INITIALIZED');
  });
  assert.deepEqual(inventory(fixture.root), []);
});

writeCase('W08 modern SDK applies all ten operations and reads saved state', async (fixture) => {
  const initial = seed(fixture.root);
  await withClient(fixture, true, async (call) => {
    let previous = initial.version;
    async function apply(operation: Log) {
      const result = updated(await call(update, {
        boardId: initial.snapshot.boardId, expectedVersion: previous, operation,
      }));
      assert.equal(result.boardId, initial.snapshot.boardId);
      assert.equal(result.committed, true);
      const [generation, revision] = previous.split(':');
      assert.equal(result.version, generation + ':' + (Number(revision) + 1));
      previous = result.version;
      return result.createdIds;
    }
    await apply(projectEdit('Current goal'));
    const { milestoneId } = await apply({ type: 'milestone.add', title: 'Milestone' });
    assert(milestoneId);
    await apply({ type: 'milestone.edit', id: milestoneId, title: 'Updated milestone' });
    const { workstreamId } = await apply({ type: 'workstream.add', title: 'Workstream' });
    assert(workstreamId);
    await apply({ type: 'workstream.edit', id: workstreamId, title: 'Updated workstream' });
    const { evidenceId } = await apply({ type: 'evidence.add', fields: { title: 'Evidence', scope: 'unit', outcome: 'passed' } });
    assert(evidenceId);
    const { taskId } = await apply({ type: 'task.add', fields: {
      title: 'Task', milestoneId, workstreamId, evidenceIds: [evidenceId],
    } });
    assert(taskId);
    await apply({ type: 'task.edit', id: taskId, fields: { title: 'Updated task', status: 'In progress' } });
    const { criterionIds } = await apply({ type: 'criterion.add', taskId, requirement: 'Criterion' });
    assert.equal(criterionIds?.length, 1);
    const criterionId = criterionIds![0];
    await apply({ type: 'criterion.edit', taskId, id: criterionId, fields: {
      requirement: 'Updated criterion', evidenceIds: [evidenceId],
    } });

    const saved = readSaved(fixture.root);
    assert.equal(saved.version, previous);
    assert.equal(saved.snapshot.revision, initial.snapshot.revision + 10);
    assert.equal(saved.snapshot.project.goal, 'Current goal');
    assert.deepEqual(saved.snapshot.milestones, [{ id: milestoneId, title: 'Updated milestone' }]);
    assert.deepEqual(saved.snapshot.workstreams, [{ id: workstreamId, title: 'Updated workstream' }]);
    const task = saved.snapshot.tasks[0];
    assert.deepEqual([task.id, task.title, task.status, task.milestoneId, task.workstreamId, task.evidenceIds],
      [taskId, 'Updated task', 'In progress', milestoneId, workstreamId, [evidenceId]]);
    assert.deepEqual(task.criteria, [{ id: criterionId, requirement: 'Updated criterion', evidenceIds: [evidenceId] }]);
    assert.equal(saved.snapshot.evidence[0].id, evidenceId);
    assert.equal(saved.snapshot.evidence[0].title, 'Evidence');
    const overview = success(await call('glance_read_overview'));
    assert.deepEqual([overview.version, overview.project, overview.milestones, overview.workstreams],
      [previous, saved.snapshot.project, saved.snapshot.milestones, saved.snapshot.workstreams]);
    const detail = success(await call('glance_read_task', { id: taskId, expectedVersion: previous }));
    assert.deepEqual([detail.version, detail.task], [previous, task]);
    assert.deepEqual(detail.review, { state: 'unreviewed', latest: null, historicalCount: 0 });
    const tasks = success(await call('glance_list_tasks', { expectedVersion: previous }));
    assert.equal(tasks.version, previous);
    assert.deepEqual(tasks.items, [{
      id: taskId, title: task.title, owner: task.owner, priority: task.priority, status: task.status,
      milestoneId, workstreamId, prerequisiteCount: 0, blockerCount: 0, criterionCount: 1, evidenceCount: 1, reviewState: 'unreviewed',
    }]);
    const evidence = success(await call('glance_list_evidence', { expectedVersion: previous }));
    assert.deepEqual([evidence.version, evidence.items], [previous, saved.snapshot.evidence]);
  });
});

writeCase('W09 default SDK refuses update and preserves exact board files', async (fixture) => {
  const saved = seed(fixture.root);
  const before = inventory(fixture.root);
  await withClient(fixture, false, async (call) => {
    await sdkRefusal(() => call(update, command(saved, projectEdit('Refused'))), /Tool glance_update_board not found/);
  });
  assert.deepEqual(inventory(fixture.root), before);
  assert.deepEqual(readSaved(fixture.root), saved);
});

writeCase('W10 stale version and wrong board ID preserve saved content and revision', async (fixture) => {
  const initial = seed(fixture.root);
  const current = withWriter(fixture.root, (writer) => ok(writer.change(command(initial, projectEdit('Saved goal')))));
  const before = inventory(fixture.root);
  await withClient(fixture, true, async (call) => {
    expectError(await call(update, command(initial, projectEdit('Refused'))), 'REVISION_CONFLICT', current.version);
    assert.notEqual(current.snapshot.boardId, boardId);
    expectError(await call(update, { ...command(current, projectEdit('Refused')), boardId }), 'REVISION_CONFLICT', current.version);
  });
  assert.deepEqual(inventory(fixture.root), before);
  const saved = readSaved(fixture.root);
  assert.equal(saved.version, current.version);
  assert.deepEqual(saved.snapshot, current.snapshot);
});

writeCase('W11 valid no-op preserves saved content, bytes and version', async (fixture) => {
  const saved = seed(fixture.root);
  const before = inventory(fixture.root);
  await withClient(fixture, true, async (call) => {
    assert.deepEqual(updated(await call(update, command(saved, projectEdit(saved.snapshot.project.goal)))), {
      ok: true, boardId: saved.snapshot.boardId, version: saved.version, updatedAt: saved.snapshot.updatedAt,
      committed: false, createdIds: {},
    });
  });
  assert.deepEqual(inventory(fixture.root), before);
  assert.deepEqual(readSaved(fixture.root), saved);
});

writeCase('W12 concurrent SDK calls using one version yield one commit and one conflict', async (fixture) => {
  const initial = seed(fixture.root);
  const goals = ['Concurrent left', 'Concurrent right'];
  await withClient(fixture, true, async (call) => {
    const results = await Promise.all(goals.map((goal) => call(update, command(initial, projectEdit(goal)))));
    assert.equal(results.filter((result) => result.isError !== true).length, 1);
    const winner = results.findIndex((result) => result.isError !== true);
    const committed = updated(results[winner]);
    assert.equal(committed.committed, true);
    expectError(results[1 - winner], 'REVISION_CONFLICT', committed.version);
    const saved = readSaved(fixture.root);
    assert.equal(saved.version, committed.version);
    assert.equal(saved.snapshot.revision, initial.snapshot.revision + 1);
    assert.equal(saved.snapshot.project.goal, goals[winner]);
  });
});

function pipeRequest(id: number, method: string, params: Log) {
  return { jsonrpc: '2.0', id, method, params };
}

async function withPipe(fixture: Fixture, args: string[], label: string, expectedExit: number,
  exchange?: (send: (message: Log) => void, response: (id: number) => Promise<Log>) => Promise<void>) {
  assert(childClosureKnown, 'Previous child closure is unknown.');
  const stdoutPath = join(fixture.artifacts, label + '-stdout.raw');
  const stderrPath = join(fixture.artifacts, label + '-stderr.raw');
  const stdout = capture(stdoutPath);
  const stderr = capture(stderrPath);
  const messages: Log[] = [];
  const events: Log[] = [];
  const launched = deferred<void>();
  const exited = deferred<Exit>();
  const closed = deferred<Exit>();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let exitStatus: Exit | undefined;
  let closeStatus: Exit | undefined;
  let spawnError: ReturnType<typeof errorRecord> | undefined;
  let forced: boolean | undefined;
  let stdoutEof = false;
  let stderrEof = false;
  let carry = Buffer.alloc(0);
  let malformedFrames = 0;
  let responseConfirmed = false;

  childClosureKnown = false;
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: fixture.artifacts, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('spawn', () => launched.resolve());
  child.on('error', (error) => { spawnError = errorRecord(error); });
  child.on('exit', (code, signal) => { exitStatus = { code, signal }; exited.resolve(exitStatus); });
  child.on('close', (code, signal) => { closeStatus = { code, signal }; closed.resolve(closeStatus); });
  child.stdin.on('error', (error) => events.push({ stdinError: errorRecord(error) }));
  child.stdout.on('end', () => { stdoutEof = true; });
  child.stderr.on('end', () => { stderrEof = true; });
  child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.append(chunk);
    carry = Buffer.concat([carry, chunk]);
    for (let newline = carry.indexOf(10); newline !== -1; newline = carry.indexOf(10)) {
      const line = carry.subarray(0, newline);
      carry = carry.subarray(newline + 1);
      try {
        const parsed: unknown = JSON.parse(decoder.decode(line));
        parseJSONRPCMessage(parsed);
        messages.push(parsed as Log);
      } catch {
        malformedFrames++;
      }
    }
  });

  function send(message: Log) {
    const data = Buffer.from(JSON.stringify(message) + '\n');
    events.push({ inputBytes: data.length, sha256: sha256(data) });
    child.stdin.write(data);
  }

  async function response(id: number): Promise<Log> {
    const deadline = performance.now() + waitMs;
    for (;;) {
      const result = messages.find((message) => message.id === id);
      if (result) {
        events.push({ responseObserved: id });
        return result;
      }
      if (closeStatus || performance.now() >= deadline) throw new Error('No complete response for request ' + id);
      await delay(10);
    }
  }

  let passed = false;
  try {
    await within(launched.promise, 'Ordinary child startup');
    if (exchange) {
      await exchange(send, response);
      responseConfirmed = true;
      events.push({ stdinEnded: true });
      child.stdin.end();
    }
    const expected = { code: expectedExit, signal: null };
    assert.deepEqual(await within(exited.promise, 'Ordinary child exit'), expected);
    assert.deepEqual(await within(closed.promise, 'Ordinary child close'), expected);
    passed = true;
  } finally {
    if (!passed && !exitStatus && !spawnError) forced = child.kill();
    child.stdin.end();
    child.stdout.resume();
    await Promise.allSettled([
      within(exited.promise, 'Ordinary child cleanup exit'),
      within(closed.promise, 'Ordinary child cleanup close'),
    ]);
    childClosureKnown = !!exitStatus && !!closeStatus;
    const stdoutReport = stdout.report(stdoutEof);
    const stderrReport = stderr.report(stderrEof);
    const protocolClean = stdoutReport.complete && malformedFrames === 0 && carry.length === 0;
    receipt(fixture, label + '-receipt.json', {
      node: process.version, platform: process.platform, pid: child.pid, args, events, responseConfirmed,
      exit: exitStatus ?? 'UNKNOWN', childClose: closeStatus ?? 'UNKNOWN', spawnError,
      forcedTerminationRequested: forced !== undefined, forcedTerminationReturn: forced,
      applicationCleanup: exchange && passed && protocolClean && forced === undefined
        ? 'HEALTHY_EOF_EXIT_OBSERVED' : 'UNCONFIRMED',
      stdout: stdoutReport, stderr: stderrReport, validStdoutFrames: messages.length,
      malformedStdoutFrames: malformedFrames, partialStdoutBytes: carry.length, protocolClean,
    });
    assert(childClosureKnown, 'Ordinary child closure is unknown.');
    assert(stdoutReport.complete && stderrReport.complete, 'Raw pipe capture is incomplete.');
    assert(protocolClean, 'Ordinary stdout contains an invalid or partial protocol frame.');
    if (expectedExit !== 0) assert.equal(stdoutReport.bytes, 0);
  }
  return readFileSync(stderrPath, 'utf8');
}

writeCase('W13 opted-in ordinary pipes confirm the write response before healthy EOF', async (fixture) => {
  const initial = seed(fixture.root);
  let confirmed: UpdatePayload | undefined;
  await withPipe(fixture, launchArgs(fixture.root, true), 'write-eof', 0, async (send, response) => {
    send(pipeRequest(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: identity }));
    const initialized = await response(1);
    assert.equal((initialized.result as Log).protocolVersion, '2025-11-25');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send(pipeRequest(2, 'tools/call', { name: update, arguments: command(initial, projectEdit('Before EOF')) }));
    const result = await response(2);
    confirmed = updated(result.result as CallToolResult);
    assert.equal(confirmed.committed, true);
    assert.equal(confirmed.boardId, initial.snapshot.boardId);
  });
  assert(confirmed);
  const saved = readSaved(fixture.root);
  assert.equal(saved.version, confirmed.version);
  assert.equal(saved.snapshot.revision, initial.snapshot.revision + 1);
  assert.equal(saved.snapshot.project.goal, 'Before EOF');
});

writeCase('W14 invalid launch flag forms are refused before opening the board', async (fixture) => {
  const saved = seed(fixture.root);
  const before = inventory(fixture.root);
  for (const [label, args] of [
    ['misplaced', ['--allow-writes', '--root', fixture.root]],
    ['repeated', [...launchArgs(fixture.root, true), '--allow-writes']],
    ['valued', [...launchArgs(fixture.root, true), 'true']],
    ['equals', ['--root', fixture.root, '--allow-writes=true']],
    ['unknown', ['--root', fixture.root, '--enable-writes']],
  ] as const) {
    assert.equal(await withPipe(fixture, [...args], label, 1), 'KFG_MCP INVALID_ARGUMENTS\n');
    assert.deepEqual(inventory(fixture.root), before);
  }
  assert.deepEqual(readSaved(fixture.root), saved);
});
