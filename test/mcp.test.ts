import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseJSONRPCMessage } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { openBoard } from '../src/board.ts';
import type { Changed, Failure, Initialized } from '../src/board.ts';
import { createBoundedStdioTransport } from '../src/mcp-main.ts';

const entry = fileURLToPath(new URL('../src/mcp-main.ts', import.meta.url));
const protocol = '2026-07-28';
const waitMs = 5_000;
const fileDeadline = AbortSignal.timeout(60_000);
const notExposed = 'NOT_EXPOSED_BY_PUBLIC_API';
const overview = 'glance_read_overview';
const tasks = 'glance_list_tasks';
const task = 'glance_read_task';
const evidence = 'glance_list_evidence';
const expectedTools = [overview, tasks, task, evidence, 'glance_github_overview', 'glance_github_list', 'glance_github_task'];
const fakeId = 't_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const fakeVersion = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1';
const commonKeys = ['ok', 'boardId', 'version', 'updatedAt'];
let childClosureKnown = true;

class InPlaceStdio extends StdioClientTransport {}

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

function ok<T>(result: T | Failure): T {
  assert(!('error' in (result as object)), JSON.stringify(result));
  return result as T;
}

function inventory(root: string) {
  return readdirSync(root).sort().map((name) => {
    const bytes = readFileSync(join(root, name));
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

type Fixture = { root: string; artifacts: string };
type Log = Record<string, unknown>;

function childCase(name: string, exercise: (fixture: Fixture) => Promise<void>) {
  test(name, { timeout: 18_000, signal: fileDeadline }, async (t) => {
    if (!childClosureKnown) {
      t.skip('NOT_RUN: preceding child closure is UNKNOWN.');
      return;
    }
    const artifacts = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-mcp-'));
    const root = join(artifacts, 'board');
    mkdirSync(root);
    t.diagnostic('Retained MCP fixture and evidence: ' + artifacts);
    await exercise({ root, artifacts });
  });
}

function withWriter<T>(root: string, use: (writer: ReturnType<typeof openBoard>) => T): T {
  const writer = openBoard(root);
  try { return use(writer); }
  finally { assert.deepEqual(writer.close(), { closed: true }); }
}

function change(writer: ReturnType<typeof openBoard>, from: Initialized, operation: unknown): Changed {
  return ok(writer.change({ boardId: from.snapshot.boardId, expectedVersion: from.version, operation }));
}

function seedBoard(root: string): Initialized {
  return withWriter(root, (writer) => {
    let board = ok(writer.initialize({ kind: 'blank', name: 'MCP fixtures' }));
    board = change(writer, board, { type: 'milestone.add', title: 'Review' });
    board = change(writer, board, { type: 'workstream.add', title: 'Quality' });
    const failed = change(writer, board, { type: 'evidence.add', fields: {
      title: 'Failed evidence', scope: 'unit', outcome: 'failed', location: 'D:\\private\\unread-evidence',
    } });
    const failedId = failed.createdIds.evidenceId!;
    const passed = change(writer, failed, { type: 'evidence.add', fields: {
      title: 'Superseding evidence', scope: 'unit', outcome: 'passed', supersedesId: failedId,
    } });
    const passedId = passed.createdIds.evidenceId!;
    board = change(writer, passed, { type: 'task.add', fields: {
      title: 'Review first',
      description: 'A saved task',
      owner: 'Fixture',
      milestoneId: passed.snapshot.milestones[0].id,
      workstreamId: passed.snapshot.workstreams[0].id,
      blockers: ['Needs a reviewer'],
      evidenceIds: [failedId],
      criteria: [
        { requirement: 'Preserve history', evidenceIds: [failedId, passedId] },
        { requirement: 'Count evidence once', evidenceIds: [failedId] },
      ],
    } });
    return change(writer, board, { type: 'task.add', fields: {
      title: 'Review second',
      prerequisites: [board.snapshot.tasks[0].id],
      criteria: [{ requirement: 'Criterion-only evidence', evidenceIds: [passedId] }],
    } });
  });
}

function seedLarge(root: string, overflow = false): Initialized {
  return withWriter(root, (writer) => {
    const board = ok(writer.initialize({ kind: 'blank', name: 'Large valid task' }));
    return change(writer, board, { type: 'task.add', fields: {
      title: 'Large valid task',
      description: '한'.repeat(16_000),
      criteria: Array.from({ length: overflow ? 20 : 12 }, () => ({ requirement: '한'.repeat(1_500) })),
      ...(overflow ? { blockers: Array.from({ length: 20 }, (_, i) => i + '한'.repeat(990)) } : {}),
    } });
  });
}

function taskArgs(board: Initialized) {
  return { id: board.snapshot.tasks[0].id, expectedVersion: board.version };
}

function errorRecord(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
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
    report(eof: boolean) { return { path, bytes, eof, complete: eof && !error, error }; },
  };
}

function receipt(fixture: Fixture, name: string, data: Log) {
  writeFileSync(join(fixture.artifacts, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;

async function withClient(fixture: Fixture, exercise: (client: Client, call: Call, list: () => ReturnType<Client['listTools']>) => Promise<void>) {
  const operations: Log[] = [];
  const stderr = capture(join(fixture.artifacts, 'sdk-stderr.raw'));
  const transport = new InPlaceStdio({
    command: process.execPath, args: [entry, '--root', fixture.root],
    cwd: fixture.artifacts, stderr: 'pipe', maxBufferSize: 524_288,
  });
  const closeObserved = deferred<void>();
  let childClose = false;
  let stderrEof = false;
  let established = false;
  let metadata: Log = {};
  transport.onclose = () => {
    childClose = true;
    closeObserved.resolve();
  };
  transport.onerror = (error) => { operations.push({ transportError: errorRecord(error) }); };
  const stderrStream = transport.stderr;
  assert(stderrStream);
  stderrStream.on('data', (chunk: Buffer) => stderr.append(chunk));
  stderrStream.on('end', () => { stderrEof = true; });

  const client = new Client({ name: 'glance-library-test', version: '0.1.0' }, {
    versionNegotiation: { mode: { pin: protocol }, probe: { timeoutMs: waitMs, maxRetries: 0 } },
  });
  async function observed<T>(operation: string, args: Log, use: () => Promise<T>): Promise<T> {
    const record: Log = { operation, args };
    operations.push(record);
    try {
      const result = await within(use(), operation);
      record.result = result;
      return result;
    } catch (error) {
      record.error = errorRecord(error);
      throw error;
    }
  }

  childClosureKnown = false;
  try {
    await observed('connect', { version: protocol }, () => client.connect(transport, { timeout: waitMs }));
    established = true;
    metadata = {
      era: client.getProtocolEra(), version: client.getNegotiatedProtocolVersion(),
      server: client.getServerVersion(), capabilities: client.getServerCapabilities(),
      node: process.version, platform: process.platform, sdk: '2.4.0',
    };
    assert.equal(metadata.era, 'modern');
    assert.equal(metadata.version, protocol);
    await exercise(client,
      (name, args = {}) => observed('tools/call', { name, arguments: args },
        () => client.callTool({ name, arguments: args }, { timeout: waitMs })),
      () => observed('tools/list', {}, () => client.listTools(undefined, { timeout: waitMs })));
  } finally {
    let closeError: ReturnType<typeof errorRecord> | undefined;
    try {
      await within(client.close(), 'SDK close');
      if (established) await within(closeObserved.promise, 'SDK child-close notification');
    } catch (error) {
      closeError = errorRecord(error);
    } finally {
      childClosureKnown = established && childClose;
      receipt(fixture, 'sdk-receipt.json', {
        operations, metadata, established,
        sdkTransportChildCloseObserved: childClose,
        closure: childClosureKnown ? 'CHILD_CLOSE_OBSERVED' : 'UNKNOWN',
        sdkClientRawStdout: notExposed, sdkChildExitCode: notExposed,
        sdkChildSignal: notExposed, sdkEscalation: notExposed,
        applicationCleanup: 'UNCONFIRMED', stderr: stderr.report(stderrEof), closeError,
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

function payload(result: CallToolResult, board: Initialized, keys: string[]) {
  assert.notEqual(result.isError, true);
  const data = textObject(result);
  assert.deepEqual(data, result.structuredContent);
  assert.deepEqual(Object.keys(data).sort(), [...commonKeys, ...keys].sort());
  assert.equal(data.ok, true);
  assert.equal(data.boardId, board.snapshot.boardId);
  assert.equal(data.version, board.version);
  assert.equal(data.updatedAt, board.snapshot.updatedAt);
  return data;
}

function expectError(result: CallToolResult, code: string, version?: string) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  const data = textObject(result);
  assert.equal(data.ok, false);
  assert.equal(data.code, code);
  assert.equal(typeof data.message, 'string');
  assert.deepEqual(Object.keys(data).sort(), ['ok', 'code', 'message', ...(version ? ['currentVersion'] : [])].sort());
  if (version) assert.equal(data.currentVersion, version);
}

async function sdkRefusal(use: () => Promise<CallToolResult>) {
  let result: CallToolResult;
  try { result = await use(); }
  catch (error) {
    assert(error instanceof Error);
    assert(!/exceeded five seconds|timed?\s*out|connection closed/i.test(error.message), error.message);
    return;
  }
  assert.equal(result.isError, true);
}

childCase('modern client reads exact envelopes, refuses stale requests and preserves board bytes', async (fixture) => {
  const saved = seedBoard(fixture.root);
  const before = inventory(fixture.root);
  await withClient(fixture, async (client, call, list) => {
    assert.equal(client.getServerVersion()?.name, 'kitflint-glance');
    const { tools } = await list();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...expectedTools].sort());
    for (const tool of tools) {
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      });
    }

    const top = payload(await call(overview), saved, ['project', 'report', 'milestones', 'workstreams']);
    assert.deepEqual(top.project, saved.snapshot.project);
    const { taskReviews, ...compactReport } = saved.report;
    assert.deepEqual(top.report, compactReport);
    assert.deepEqual((top.report as Initialized['report']).acceptance, { available: true, accepted: 0, stale: 0, changesRequested: 0 });
    assert.deepEqual(top.milestones, saved.snapshot.milestones);
    assert.deepEqual(top.workstreams, saved.snapshot.workstreams);

    const pageKeys = ['total', 'offset', 'nextOffset', 'items'];
    const first = payload(await call(tasks, { limit: 1 }), saved, pageKeys);
    assert.deepEqual([first.total, first.offset, first.nextOffset], [2, 0, 1]);
    const firstTask = saved.snapshot.tasks[0];
    assert.deepEqual(first.items, [{
      id: firstTask.id, title: firstTask.title, owner: firstTask.owner, priority: firstTask.priority,
      status: firstTask.status, milestoneId: firstTask.milestoneId, workstreamId: firstTask.workstreamId,
      prerequisiteCount: 0, blockerCount: 1, criterionCount: 2, evidenceCount: 2, reviewState: 'unreviewed',
    }]);
    const next = payload(await call(tasks, { offset: 1, limit: 1, expectedVersion: saved.version }), saved, pageKeys);
    const secondTask = saved.snapshot.tasks[1];
    assert.deepEqual(next.items, [{
      id: secondTask.id, title: secondTask.title, owner: secondTask.owner, priority: secondTask.priority,
      status: secondTask.status, milestoneId: null, workstreamId: null,
      prerequisiteCount: 1, blockerCount: 0, criterionCount: 1, evidenceCount: 1, reviewState: 'unreviewed',
    }]);
    assert.deepEqual([next.total, next.offset, next.nextOffset], [2, 1, null]);
    const end = payload(await call(tasks, { offset: 2, expectedVersion: saved.version }), saved, pageKeys);
    assert.deepEqual([end.items, end.nextOffset], [[], null]);
    expectError(await call(tasks, { offset: 3, expectedVersion: saved.version }), 'INVALID_INPUT');

    const detail = payload(await call(task, taskArgs(saved)), saved, ['task', 'review']);
    assert.deepEqual(detail.review, { state: taskReviews[0].state, latest: null, historicalCount: 0 });
    assert.deepEqual(detail.task, firstTask);
    const initialEvidence = payload(await call(evidence, { limit: 1 }), saved, pageKeys);
    const laterEvidence = payload(await call(evidence, { offset: 1, limit: 1, expectedVersion: saved.version }), saved, pageKeys);
    assert.deepEqual([initialEvidence.nextOffset, laterEvidence.nextOffset], [1, null]);
    assert.deepEqual(initialEvidence.items, [saved.snapshot.evidence[0]]);
    assert.deepEqual(laterEvidence.items, [saved.snapshot.evidence[1]]);
    assert.equal(saved.snapshot.evidence[1].supersedesId, saved.snapshot.evidence[0].id);

    expectError(await call(task, { id: fakeId, expectedVersion: saved.version }), 'NOT_FOUND');
    await sdkRefusal(() => call(overview, { root: fixture.root }));
    await sdkRefusal(() => call(tasks, { offset: 1 }));
    await sdkRefusal(() => call(task, { id: fakeId, expectedVersion: fakeVersion + '\n' }));
    await sdkRefusal(() => call('glance_change_board'));
    assert.deepEqual(inventory(fixture.root), before);

    const updated = withWriter(fixture.root, (writer) =>
      change(writer, saved, { type: 'project.edit', fields: { goal: 'A later committed revision' } }));
    const after = inventory(fixture.root);
    expectError(await call(tasks, { offset: 1, expectedVersion: saved.version }), 'REVISION_CONFLICT', updated.version);
    expectError(await call(evidence, { offset: 1, expectedVersion: saved.version }), 'REVISION_CONFLICT', updated.version);
    expectError(await call(task, taskArgs(saved)), 'REVISION_CONFLICT', updated.version);
    payload(await call(overview), updated, ['project', 'report', 'milestones', 'workstreams']);
    assert.deepEqual(inventory(fixture.root), after);
  });
});

childCase('every tool returns the same missing-board refusal and leaves the directory empty', async (fixture) => {
  await withClient(fixture, async (_client, call) => {
    const results = [
      await call(overview), await call(tasks), await call(task, { id: fakeId, expectedVersion: fakeVersion }),
      await call(evidence),
    ];
    for (const result of results) expectError(result, 'NOT_INITIALIZED');
    for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
  });
  assert.deepEqual(inventory(fixture.root), []);
});

childCase('a valid oversized full task returns a bounded explicit refusal', async (fixture) => {
  const saved = seedLarge(fixture.root, true);
  const before = inventory(fixture.root);
  await withClient(fixture, async (_client, call) => {
    expectError(await call(task, taskArgs(saved)), 'LIMIT_REACHED');
  });
  assert.deepEqual(inventory(fixture.root), before);
});

function request(id: number, method: string, params?: Log) {
  return { jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) };
}

function notification(method: string, params?: Log) {
  return { jsonrpc: '2.0' as const, method, ...(params ? { params } : {}) };
}

function frame(message: unknown): string {
  return JSON.stringify(message) + '\n';
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Raw = {
  send(data: string): void;
  end(): void;
  pauseOutput(): void;
  response(id: number, allowClose?: boolean): Promise<Log | undefined>;
  exit(): Promise<Exit>;
  stderrText(): string;
  events: Log[];
};

async function withRaw(fixture: Fixture, exercise: (raw: Raw) => Promise<void>) {
  const stdout = capture(join(fixture.artifacts, 'stdout.raw'));
  const stderrPath = join(fixture.artifacts, 'stderr.raw');
  const stderr = capture(stderrPath);
  const messages: Log[] = [];
  const events: Log[] = [];
  const launched = deferred<void>();
  const exited = deferred<Exit>();
  const closed = deferred<Exit>();
  let exitStatus: Exit | undefined;
  let closeStatus: Exit | undefined;
  let spawnError: ReturnType<typeof errorRecord> | undefined;
  let forced: boolean | undefined;
  let stdoutEof = false;
  let stderrEof = false;
  let carry = Buffer.alloc(0);
  let malformedFrames = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  childClosureKnown = false;
  const child = spawn(process.execPath, [entry, '--root', fixture.root], {
    cwd: fixture.artifacts, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('spawn', () => launched.resolve());
  child.on('error', (error) => { spawnError = errorRecord(error); });
  child.on('exit', (code, signal) => {
    exitStatus = { code, signal };
    exited.resolve(exitStatus);
  });
  child.on('close', (code, signal) => {
    closeStatus = { code, signal };
    closed.resolve(closeStatus);
  });
  child.stdin.on('error', (error) => events.push({ stdinError: errorRecord(error) }));
  child.stdout.on('end', () => { stdoutEof = true; });
  child.stderr.on('end', () => { stderrEof = true; });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.append(chunk);
    carry = Buffer.concat([carry, chunk]);
    for (let newline = carry.indexOf(10); newline !== -1; newline = carry.indexOf(10)) {
      const line = carry.subarray(0, newline);
      carry = carry.subarray(newline + 1);
      try {
        const decoded: unknown = JSON.parse(decoder.decode(line));
        parseJSONRPCMessage(decoded);
        messages.push(decoded as Log);
      } catch {
        malformedFrames++;
        events.push({ malformedStdoutFrameBytes: line.length });
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));

  const raw: Raw = {
    send(data) {
      events.push({ inputBytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') });
      child.stdin.write(data);
    },
    end: () => { child.stdin.end(); },
    pauseOutput: () => { child.stdout.pause(); },
    async response(id, allowClose = false) {
      const deadline = performance.now() + waitMs;
      for (;;) {
        const result = messages.find((item) => item?.id === id);
        if (result) return result;
        if (closeStatus && allowClose) return undefined;
        if (closeStatus || performance.now() >= deadline) throw new Error('No complete response for request ' + id);
        await delay(10);
      }
    },
    exit: () => within(exited.promise, 'Ordinary child exit'),
    stderrText: () => readFileSync(stderrPath, 'utf8'),
    events,
  };

  let passed = false;
  try {
    await within(launched.promise, 'Ordinary child startup');
    await exercise(raw);
    passed = true;
  } finally {
    if (!passed && !exitStatus && !spawnError) forced = child.kill();
    child.stdin.end();
    child.stdout.resume();
    await Promise.allSettled([
      within(exited.promise, 'Ordinary child exit during cleanup'),
      within(closed.promise, 'Ordinary child stream close'),
    ]);
    childClosureKnown = !!exitStatus && !!closeStatus;
    const completeStdout = stdout.report(stdoutEof);
    const protocolClean = completeStdout.complete && malformedFrames === 0 && carry.length === 0;
    const healthyEof = passed && childClosureKnown && forced === undefined &&
      exitStatus?.code === 0 && exitStatus.signal === null;
    receipt(fixture, 'pipe-receipt.json', {
      node: process.version, platform: process.platform, pid: child.pid, events,
      exit: exitStatus ?? 'UNKNOWN', childClose: closeStatus ?? 'UNKNOWN', spawnError,
      forcedTerminationRequested: forced !== undefined, forcedTerminationReturn: forced,
      applicationCleanup: healthyEof && protocolClean ? 'HEALTHY_EOF_EXIT_OBSERVED' : 'UNCONFIRMED',
      stdout: completeStdout, stderr: stderr.report(stderrEof),
      validStdoutFrames: messages.length, malformedStdoutFrames: malformedFrames,
      partialStdoutBytes: carry.length, protocolClean,
    });
    assert(childClosureKnown, 'Ordinary child closure is unknown.');
    assert(completeStdout.complete && stderr.report(stderrEof).complete, 'Raw pipe capture is incomplete.');
    if (healthyEof) {
      assert.equal(malformedFrames, 0, 'Healthy EOF had a non-protocol stdout frame.');
      assert.equal(carry.length, 0, 'Healthy EOF had trailing partial stdout bytes.');
    }
  }
}

async function legacy(raw: Raw) {
  raw.send(frame(request(1, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'glance-legacy-test', version: '0.1.0' },
  })));
  const response = await raw.response(1);
  assert.equal((response?.result as Log).protocolVersion, '2025-11-25');
  raw.send(frame(notification('notifications/initialized')));
}

childCase('legacy real pipes observe healthy EOF without signals', async (fixture) => {
  const saved = seedBoard(fixture.root);
  const before = inventory(fixture.root);
  await withRaw(fixture, async (raw) => {
    await legacy(raw);
    raw.send(frame(request(2, 'tools/call', { name: overview, arguments: {} })));
    const result = await raw.response(2);
    payload(result?.result as CallToolResult, saved, ['project', 'report', 'milestones', 'workstreams']);
    raw.end();
    assert.deepEqual(await raw.exit(), { code: 0, signal: null });
  });
  assert.deepEqual(inventory(fixture.root), before);
});

for (const [name, input] of [
  ['malformed', '{broken json}\n'],
  ['oversized', frame(notification('fixture', { padding: 'x'.repeat(65_536) }))],
] as const) {
  childCase(name + ' raw input closes the connection without board creation', async (fixture) => {
    await withRaw(fixture, async (raw) => {
      raw.send(input);
      assert.deepEqual(await raw.exit(), { code: 1, signal: null });
    });
    assert.deepEqual(inventory(fixture.root), []);
  });
}

childCase('a single large real-pipe response hits the write stall deadline', async (fixture) => {
  const saved = seedLarge(fixture.root);
  const before = inventory(fixture.root);
  const projected = {
    ok: true, boardId: saved.snapshot.boardId, version: saved.version, updatedAt: saved.snapshot.updatedAt,
    task: saved.snapshot.tasks[0],
  };
  const projectedBytes = Buffer.byteLength(JSON.stringify({
    structuredContent: projected, content: [{ type: 'text', text: JSON.stringify(projected) }],
  }));
  assert(projectedBytes > 131_072 && projectedBytes <= 262_144);
  await withRaw(fixture, async (raw) => {
    raw.events.push({ projectedResultBytes: projectedBytes });
    await legacy(raw);
    raw.pauseOutput();
    raw.send(frame(request(2, 'tools/call', { name: task, arguments: taskArgs(saved) })));
    assert.deepEqual(await raw.exit(), { code: 1, signal: null });
    assert.match(raw.stderrText(), /^KFG_MCP OUTPUT_STALL\n$/);
  });
  assert.deepEqual(inventory(fixture.root), before);
});

childCase('real pipe cancellation records the observed order without substituting for the controlled case', async (fixture) => {
  seedBoard(fixture.root);
  const before = inventory(fixture.root);
  await withRaw(fixture, async (raw) => {
    await legacy(raw);
    raw.send(frame(request(2, 'tools/call', { name: overview, arguments: {} })) +
      frame(notification('notifications/cancelled', { requestId: 2 })));
    const reply = await raw.response(2, true);
    let later: Log | undefined;
    if (reply) {
      raw.send(frame(request(3, 'tools/call', { name: overview, arguments: {} })));
      later = await raw.response(3, true);
    }
    if (later) {
      assert('result' in later);
      raw.events.push({ cancellationOrder: 'RESPONSE_COMPLETED_FIRST' });
      raw.end();
      assert.deepEqual(await raw.exit(), { code: 0, signal: null });
    } else {
      raw.events.push({ cancellationOrder: 'CANCELLATION_WON', responseBytesObserved: !!reply });
      assert.deepEqual(await raw.exit(), { code: 1, signal: null });
      assert.match(raw.stderrText(), /^KFG_MCP CANCELLED_REQUEST\n$/);
    }
  });
  assert.deepEqual(inventory(fixture.root), before);
});

function blockedTransport(t: TestContext) {
  const input = new PassThrough();
  const callbacks: (() => void)[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) { callbacks.push(callback); },
  });
  output.on('error', () => {});
  const failures: string[] = [];
  const forwarded: JSONRPCMessage[] = [];
  const closed = deferred<void>();
  const transport = createBoundedStdioTransport(input, output, (code) => failures.push(code));
  transport.onmessage = (message) => forwarded.push(message);
  transport.onclose = () => closed.resolve();
  t.after(async () => {
    await transport.close();
    input.destroy();
    output.destroy(new Error('Controlled sink released.'));
  });
  return { input, output, callbacks, failures, forwarded, closed: closed.promise, transport };
}

function resultFrame(id: number, padding = ''): JSONRPCMessage {
  return { jsonrpc: '2.0', id, result: { padding } };
}

function controlled(name: string, exercise: (t: TestContext) => void | Promise<void>) {
  test(name, { timeout: 7_000, signal: fileDeadline }, exercise);
}

controlled('transport refuses a sink with a buffering threshold above one', () => {
  const input = new PassThrough();
  const output = new Writable({ highWaterMark: 2, write(_chunk, _encoding, callback) { callback(); } });
  assert.throws(() => createBoundedStdioTransport(input, output, () => {}), /highWaterMark 1/);
  input.destroy();
  output.destroy();
});

controlled('one small nonempty frame remains pending and closes on its own deadline', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  const message = resultFrame(1);
  assert(Buffer.byteLength(frame(message)) < 16_384);
  let completed = false;
  const sent = fixture.transport.send(message).finally(() => { completed = true; });
  const refused = assert.rejects(sent, /OUTPUT_STALL/);
  await nextTurn();
  assert.equal(completed, false);
  assert.equal(fixture.callbacks.length, 1);
  await refused;
  await within(fixture.closed, 'Controlled stalled connection close');
  assert.deepEqual(fixture.failures, ['OUTPUT_STALL']);
});

controlled('completed small write cancels its deadline and releases its request ID', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  fixture.input.write(frame(request(1, 'fixture')));
  const sent = fixture.transport.send(resultFrame(1));
  await nextTurn();
  assert.equal(fixture.callbacks.length, 1);
  fixture.callbacks.shift()!();
  await sent;
  await delay(2_050);
  fixture.input.write(frame(request(1, 'fixture')));
  assert.deepEqual(fixture.failures, []);
  assert.equal(fixture.forwarded.length, 2);
});

controlled('matching cancellation shuts down, rejects the send and prevents slot reuse', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  fixture.input.write(frame(request(1, 'fixture')));
  const refused = assert.rejects(fixture.transport.send(resultFrame(1)), /CANCELLED_REQUEST/);
  fixture.input.write(frame(notification('notifications/cancelled', { requestId: 1 })) +
    frame(request(2, 'fixture')) + frame(request(1, 'fixture')));
  await refused;
  await within(fixture.closed, 'Controlled cancellation close');
  assert.deepEqual(fixture.failures, ['CANCELLED_REQUEST']);
  assert.deepEqual(fixture.forwarded, [request(1, 'fixture')]);
});

controlled('late and unknown cancellations preserve another pending request', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  fixture.input.write(frame(request(1, 'fixture')));
  const sent = fixture.transport.send(resultFrame(1));
  fixture.callbacks.shift()!();
  await sent;
  fixture.input.write(frame(request(2, 'fixture')));
  const late = notification('notifications/cancelled', { requestId: 1 });
  const unknown = notification('notifications/cancelled', { requestId: 999 });
  fixture.input.write(frame(late) + frame(unknown) + frame(request(3, 'fixture')));
  assert.deepEqual(fixture.failures, []);
  assert.deepEqual(fixture.forwarded, [request(1, 'fixture'), request(2, 'fixture'), late, unknown, request(3, 'fixture')]);
  fixture.input.write(frame(notification('notifications/cancelled', { requestId: 2 })));
  await within(fixture.closed, 'Remaining pending request cancellation');
  assert.deepEqual(fixture.failures, ['CANCELLED_REQUEST']);
});

for (const [code, messages, admitted] of [
  ['DUPLICATE_REQUEST', [request(1, 'fixture'), request(1, 'fixture')], 1],
  ['INPUT_REQUEST_LIMIT', Array.from({ length: 9 }, (_, i) => request(i, 'fixture')), 8],
  ['INPUT_BYTE_LIMIT', Array.from({ length: 3 }, (_, i) => request(i, 'fixture', { padding: 'x'.repeat(46_000) })), 2],
  ['INPUT_RATE_LIMIT', Array.from({ length: 33 }, () => notification('fixture')), 32],
] as const) {
  controlled(code + ' bounds decoded intake independently of the parser', async (t) => {
    t.mock.method(performance, 'now', () => 1234);
    const fixture = blockedTransport(t);
    await fixture.transport.start();
    for (const message of messages) fixture.input.write(frame(message));
    await within(fixture.closed, 'Input cap connection close');
    assert.deepEqual(fixture.failures, [code]);
    assert.equal(fixture.forwarded.length, admitted);
  });
}

controlled('bounded aggregate sends fail at the output cap rather than an intake or single-frame cap', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  const sends = Array.from({ length: 5 }, (_, i) => {
    fixture.input.write(frame(request(i, 'fixture')));
    return assert.rejects(fixture.transport.send(resultFrame(i, 'x'.repeat(220_000))), /OUTPUT_PENDING_LIMIT/);
  });
  await Promise.all(sends);
  await within(fixture.closed, 'Output cap connection close');
  assert.deepEqual(fixture.failures, ['OUTPUT_PENDING_LIMIT']);
  assert.equal(fixture.forwarded.length, 5);
  assert.equal(fixture.callbacks.length, 1);
});

controlled('a single frame beyond the wire cap is refused before delegation', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  await assert.rejects(fixture.transport.send(resultFrame(1, 'x'.repeat(524_288))), /OUTPUT_FRAME_LIMIT/);
  await within(fixture.closed, 'Frame cap connection close');
  assert.deepEqual(fixture.failures, ['OUTPUT_FRAME_LIMIT']);
  assert.equal(fixture.callbacks.length, 0);
});

controlled('split UTF-8 JSON and CRLF forward each complete message once', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  const first = request(101, 'fixture', { label: '한' });
  const second = request(102, 'fixture');
  const crlf = Buffer.from(JSON.stringify(first) + '\r\n', 'utf8');
  const character = crlf.indexOf(Buffer.from('한', 'utf8'));
  assert(character > 0);

  fixture.input.write(crlf.subarray(0, character + 1));
  assert.deepEqual(fixture.forwarded, []);
  fixture.input.write(crlf.subarray(character + 1, crlf.length - 1));
  assert.deepEqual(fixture.forwarded, []);
  assert.deepEqual(fixture.failures, []);

  fixture.input.write(Buffer.concat([crlf.subarray(crlf.length - 1), Buffer.from(frame(second))]));
  assert.deepEqual(fixture.forwarded, [first, second]);
  assert.deepEqual(fixture.failures, []);
});

controlled('split malformed JSON refuses the whole completing chunk once', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  fixture.input.write(Buffer.from('{"broken":'));
  assert.deepEqual(fixture.forwarded, []);
  assert.deepEqual(fixture.failures, []);

  fixture.input.write(Buffer.from('}\n' + frame(request(103, 'fixture'))));
  await within(fixture.closed, 'Split malformed input close');
  assert.deepEqual(fixture.failures, ['PROTOCOL_ERROR']);
  assert.deepEqual(fixture.forwarded, []);
});

controlled('one malformed line suppresses valid messages on both sides in its chunk', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  fixture.input.write(Buffer.from(
    frame(request(104, 'fixture')) + '{broken json}\n' + frame(request(105, 'fixture')),
  ));
  await within(fixture.closed, 'Malformed chunk close');
  assert.deepEqual(fixture.failures, ['PROTOCOL_ERROR']);
  assert.deepEqual(fixture.forwarded, []);
});

controlled('unfinished input at the exact byte cap refuses only on the next byte', async (t) => {
  const fixture = blockedTransport(t);
  await fixture.transport.start();
  fixture.input.write(Buffer.alloc(65_536, 0x20));
  assert.deepEqual(fixture.failures, []);
  assert.deepEqual(fixture.forwarded, []);

  fixture.input.write(Buffer.from([0x20]));
  await within(fixture.closed, 'Input over byte cap close');
  assert.deepEqual(fixture.failures, ['PROTOCOL_ERROR']);
  assert.deepEqual(fixture.forwarded, []);
});

controlled('duplicate start and close preserve the caller input listener and deliver no duplicates', async (t) => {
  const fixture = blockedTransport(t);
  const callerListener = () => {};
  fixture.input.on('data', callerListener);
  const baseline = fixture.input.listeners('data');
  await fixture.transport.start();
  const started = fixture.input.listeners('data');
  assert.equal(started.length, baseline.length + 2);

  await assert.rejects(fixture.transport.start(), /already started/);
  assert.deepEqual(fixture.input.listeners('data'), started);
  const message = request(106, 'fixture');
  fixture.input.write(Buffer.from(frame(message)));
  assert.deepEqual(fixture.forwarded, [message]);
  assert.deepEqual(fixture.failures, []);

  await fixture.transport.close();
  await within(fixture.closed, 'Normal transport close');
  assert.deepEqual(fixture.input.listeners('data'), baseline);
  assert.equal(fixture.input.destroyed, false);
  assert.equal(fixture.output.destroyed, false);
  await assert.rejects(fixture.transport.start(), /closed/);
  assert.deepEqual(fixture.input.listeners('data'), baseline);
});
