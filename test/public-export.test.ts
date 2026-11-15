import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../src/board.ts';
import type { Failure, Initialized, Snapshot } from '../src/board.ts';
import { createPublicExport } from '../src/public-export.ts';
import type { PublicExportFiles, PublicReport } from '../src/public-export.ts';
import { startHost } from '../src/host.ts';

type Board = ReturnType<typeof openBoard>;
type V2 = Extract<Snapshot, { schemaVersion: 2 }>;
type PublicRequest = { expectedVersion: string; labels: {
  project: string | null;
  tasks: { id: string; label: string }[];
  milestones: { id: string; label: string }[];
  workstreams: { id: string; label: string }[];
} };

const timestamp = '2026-11-13T00:00:00.000Z';
const privateMarker = 'KFG_PRIVATE_FIXTURE_';
const deadline = AbortSignal.timeout(60_000);

function check(name: string, run: (fixture: () => { root: string; board: Board }, diagnostic: Diagnostic) => void | Promise<void>) {
  test(name, { timeout: 60_000, signal: deadline }, async (context) => {
    const boards: Board[] = [];
    try {
      await run(() => {
        const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-public-fixture-'));
        context.diagnostic('Retained Glance public fixture: ' + root);
        const board = openBoard(root);
        boards.push(board);
        return { root, board };
      }, (message) => context.diagnostic(message));
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

function refuse(result: object, code: Failure['error']['code']) {
  assert('error' in result);
  assert.equal((result as Failure).error.code, code);
  for (const key of ['html', 'markdown', 'publicJson', 'sha256']) assert(!Object.hasOwn(result, key));
}

function sha(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function request(board: Initialized): PublicRequest {
  return { expectedVersion: board.version, labels: { project: null, tasks: [], milestones: [], workstreams: [] } };
}

function change(board: Board, saved: Initialized, operation: object) {
  return ok(board.change({ boardId: saved.snapshot.boardId, expectedVersion: saved.version, operation }));
}

function review(board: Board, saved: Initialized, taskId: string, decision: 'accepted' | 'changes-requested') {
  return ok(board.review({ boardId: saved.snapshot.boardId, expectedVersion: saved.version, taskId, decision,
    reviewer: privateMarker + 'REVIEWER', scope: privateMarker + 'SCOPE', note: privateMarker + 'NOTE', confirmed: true }));
}

function snapshot(count: number): V2 {
  const milestoneId = 'm_' + randomUUID();
  const workstreamId = 'w_' + randomUUID();
  const evidenceId = 'e_' + randomUUID();
  const taskIds = Array.from({ length: count }, () => 't_' + randomUUID());
  return {
    schemaVersion: 2, boardId: 'b_' + randomUUID(), generation: randomUUID(), revision: 1, updatedAt: timestamp,
    project: { name: privateMarker + 'PROJECT', goal: privateMarker + 'GOAL', stage: 'Release',
      focusTaskId: taskIds[0] ?? null, nextActions: [privateMarker + 'NEXT'] },
    milestones: [{ id: milestoneId, title: privateMarker + 'MILESTONE' }, { id: 'm_' + randomUUID(), title: privateMarker + 'EMPTY' }],
    workstreams: [{ id: workstreamId, title: privateMarker + 'WORKSTREAM' }],
    tasks: taskIds.map((id, index) => ({
      id, title: privateMarker + 'TASK_' + index, description: privateMarker + 'DESCRIPTION', owner: privateMarker + 'OWNER',
      priority: 'P1', status: index === 0 ? 'In progress' : 'Planned',
      milestoneId: index < 2 ? milestoneId : null, workstreamId: index < 2 ? workstreamId : null,
      prerequisites: index === 1 ? [taskIds[0]] : [],
      criteria: index < 3 ? [{ id: 'c_' + randomUUID(), requirement: privateMarker + 'CRITERION', evidenceIds: [evidenceId] }] : [],
      blockers: [], evidenceIds: index < 3 ? [evidenceId] : [],
    })),
    evidence: [{ id: evidenceId, title: privateMarker + 'EVIDENCE', scope: 'unit', outcome: 'passed',
      location: 'D:\\' + privateMarker + 'LOCATION.txt', recordedAt: timestamp, supersedesId: null }],
    reviews: [], reviewArchive: null,
  };
}

function load(board: Board, value: Snapshot) {
  return ok(board.initialize({ kind: 'import', identity: 'restore',
    backup: { format: 'kitflint.glance.backup', version: 1, exportedAt: timestamp, snapshot: value } }));
}

function artifacts(pack: PublicExportFiles) {
  return [JSON.stringify(pack.report), pack.html, pack.markdown, pack.publicJson];
}

check('P01 default report excludes private data, keeps ordinals and matches hashes without writing', (fixture) => {
  const { root, board } = fixture();
  let saved: Initialized = load(board, snapshot(3));
  saved = review(board, saved, saved.snapshot.tasks[0].id, 'accepted');
  const beforeRead = ok(board.read());
  const disk = () => readdirSync(root).sort().map((name) => [name, sha(readFileSync(join(root, name)))]);
  const before = disk();
  const pack = ok(board.preparePublicReport(request(saved)));
  const privateValues = [privateMarker, saved.version, saved.snapshot.boardId, saved.snapshot.generation,
    ...saved.snapshot.tasks.map(({ id }) => id), ...saved.snapshot.milestones.map(({ id }) => id),
    ...saved.snapshot.evidence.map(({ id }) => id)];
  for (const value of privateValues) for (const artifact of artifacts(pack)) assert(!artifact.includes(value));
  assert.equal(pack.version, saved.version);
  assert.deepEqual(Object.keys(pack).sort(), ['html', 'markdown', 'publicJson', 'report', 'sha256', 'version']);
  assert.equal(pack.report.project.label, 'Project readiness');
  assert.equal(pack.report.project.stage, 'Release');
  assert.equal(pack.report.captured.revision, saved.snapshot.revision);
  assert.equal(pack.report.captured.updatedAt, new Date(saved.snapshot.updatedAt).toISOString());
  assert.equal(new Date(pack.report.captured.preparedAt).toISOString(), pack.report.captured.preparedAt);
  assert.equal(pack.report.focusTaskId, 't1');
  assert.deepEqual(pack.report.tasks.map(({ id, label }) => [id, label]), [['t1', 'Task 1'], ['t2', 'Task 2'], ['t3', 'Task 3']]);
  assert.deepEqual(pack.report.tasks[1].prerequisites, ['t1']);
  assert.equal(pack.report.tasks[0].evidenceCount, 1);
  assert.deepEqual(pack.report.milestones, [
    { id: 'm1', label: 'Milestone 1', total: 2, accepted: 1 },
    { id: 'm2', label: 'Milestone 2', total: 0, accepted: 0 },
  ]);
  assert.equal(pack.report.tasks[2].milestoneId, null);
  assert.deepEqual(JSON.parse(pack.publicJson), pack.report);
  assert(pack.publicJson.endsWith('\n'));
  for (const key of ['html', 'markdown', 'publicJson'] as const) assert.equal(pack.sha256[key], sha(pack[key]));
  assert.deepEqual(disk(), before);
  assert.deepEqual(ok(board.read()), beforeRead);
  const other = fixture().board;
  refuse(other.initialize({ kind: 'import', identity: 'restore', backup: JSON.parse(pack.publicJson) }), 'INVALID_INPUT');
});

check('P02 label opt-in is per record and markup, Markdown punctuation and Unicode stay literal', (fixture) => {
  const { board } = fixture();
  const saved = load(board, snapshot(3));
  const hostile = '</script><img alt="glance-fixture" onerror=""> [link](https://fixture.invalid) & Ω\u2028\u2029';
  const input = request(saved);
  input.labels.project = 'Public status';
  input.labels.tasks.push({ id: saved.snapshot.tasks[1].id, label: hostile });
  input.labels.workstreams.push({ id: saved.snapshot.workstreams[0].id, label: 'Public operations' });
  const pack = ok(board.preparePublicReport(input));
  assert.equal(pack.report.project.label, 'Public status');
  assert.equal(pack.report.tasks[0].label, 'Task 1');
  assert.equal(pack.report.tasks[1].label, hostile);
  assert.equal(pack.report.milestones[0].label, 'Milestone 1');
  assert.equal(pack.report.workstreams[0].label, 'Public operations');
  for (const artifact of artifacts(pack)) assert(!artifact.includes(privateMarker));
  const data = pack.html.match(/<script type="application\/json" id="public-data">([\s\S]+?)<\/script>/)?.[1];
  assert(data);
  assert(!/[<>&\u2028\u2029]/.test(data));
  assert.deepEqual(JSON.parse(data), pack.report);
  assert(!pack.markdown.includes('https://fixture.invalid'));
  assert(!pack.markdown.includes('<img'));
  assert(pack.markdown.includes('&#60;&#47;script&#62;'));
  const script = pack.html.match(/<script>([\s\S]+?)<\/script>/)?.[1];
  const style = pack.html.match(/<style>([\s\S]+?)<\/style>/)?.[1];
  assert(script && style);
  const hash = (text: string) => createHash('sha256').update(text).digest('base64');
  assert(pack.html.includes("script-src 'sha256-" + hash(script) + "'"));
  assert(pack.html.includes("style-src 'sha256-" + hash(style) + "'"));
  assert(pack.html.includes("connect-src 'none'"));
});

check('P03 request shape rejects duplicate, unknown, wrong-kind and malformed overrides', (fixture) => {
  const { board } = fixture();
  const saved = load(board, snapshot(2));
  const base = request(saved);
  const known = saved.snapshot.tasks[0].id;
  const bad = [
    { ...base, unexpected: true },
    { ...base, labels: { ...base.labels, unknown: [] } },
    { ...base, labels: { ...base.labels, tasks: [{ label: 'Missing ID' }] } },
    { ...base, labels: { ...base.labels, tasks: [{ id: known, label: 'One', extra: '' }] } },
    { ...base, labels: { ...base.labels, tasks: [{ id: known, label: 'One' }, { id: known, label: 'Two' }] } },
    { ...base, labels: { ...base.labels, tasks: [{ id: 't_' + randomUUID(), label: 'Unknown' }] } },
    { ...base, labels: { ...base.labels, tasks: [{ id: saved.snapshot.milestones[0].id, label: 'Wrong kind' }] } },
    { ...base, labels: { ...base.labels, project: 'bad\tlabel' } },
    { ...base, labels: { ...base.labels, project: 'bad\nlabel' } },
    { ...base, labels: { ...base.labels, project: 'bad\rlabel' } },
    { ...base, labels: { ...base.labels, project: 'bad\u009flabel' } },
    { ...base, labels: { ...base.labels, project: '' } },
    Object.assign(Object.create({ unexpected: true }), base),
    { ...base, labels: { ...base.labels, tasks: [{ id: known, get label() { throw new Error('Getter called'); } }] } },
  ];
  for (const value of bad) refuse(board.preparePublicReport(value), 'INVALID_INPUT');
  refuse(board.preparePublicReport({ ...base, labels: { ...base.labels, project: 'x'.repeat(201) } }), 'LIMIT_REACHED');
});

check('P04 full UTF-8 request limit is inclusive and oversize refusal is atomic', (fixture) => {
  const { board } = fixture();
  const saved = load(board, snapshot(240));
  const input = request(saved);
  const bytes = () => Buffer.byteLength(JSON.stringify(input), 'utf8');
  const cap = 128 * 1024;
  input.labels.tasks = saved.snapshot.tasks.map(({ id }) => ({ id, label: 'x' }));
  for (const entry of input.labels.tasks) {
    const targetBytes = Math.min(600, cap - bytes() + 1);
    const remainder = ['', 'x', 'é'][targetBytes % 3];
    entry.label = '界'.repeat(Math.floor(targetBytes / 3)) + remainder;
    if (bytes() === cap) break;
  }
  assert.equal(bytes(), cap);
  assert.equal(ok(board.preparePublicReport(input)).report.counts.tasks, 240);
  input.labels.project = 'xxx';
  assert(bytes() > cap);
  refuse(board.preparePublicReport(input), 'LIMIT_REACHED');
  assert.deepEqual(ok(board.read()), saved);
});

check('P05 maximum generic board, empty groups and null focus render without label overrides', (fixture) => {
  const { board } = fixture();
  const value = snapshot(1000);
  value.project.focusTaskId = null;
  while (value.milestones.length < 100) value.milestones.push({ id: 'm_' + randomUUID(), title: privateMarker + 'M' });
  while (value.workstreams.length < 100) value.workstreams.push({ id: 'w_' + randomUUID(), title: privateMarker + 'W' });
  const saved = load(board, value);
  const pack = ok(board.preparePublicReport(request(saved)));
  assert.equal(pack.report.tasks.length, 1000);
  assert.equal(pack.report.tasks[999].label, 'Task 1000');
  assert.equal(pack.report.milestones.length, 100);
  assert.equal(pack.report.workstreams.length, 100);
  assert.equal(pack.report.focusTaskId, null);
  assert(pack.markdown.includes('0 of 0 tasks accepted'));
  assert(pack.markdown.includes('Unassigned'));
  assert(Buffer.byteLength(JSON.stringify({ ok: true, ...pack })) < 16 * 1024 * 1024);
  const empty = fixture().board;
  const blank = ok(empty.initialize({ kind: 'blank', name: 'Private empty project' }));
  const report = ok(empty.preparePublicReport(request(blank))).report;
  assert.equal(report.focusTaskId, null);
  assert.deepEqual(report.tasks, []);
  assert.deepEqual(report.milestones, []);
});

check('P06 current review acceptance and workflow statuses stay independent', (fixture) => {
  const { board } = fixture();
  let saved: Initialized = load(board, snapshot(4));
  const [first, , third, fourth] = saved.snapshot.tasks;
  saved = review(board, saved, first.id, 'accepted');
  saved = review(board, saved, third.id, 'accepted');
  saved = change(board, saved, { type: 'task.edit', id: third.id, fields: { title: privateMarker + 'EDIT' } });
  saved = review(board, saved, fourth.id, 'changes-requested');
  const { report } = ok(board.preparePublicReport(request(saved)));
  assert.deepEqual(report.tasks.map(({ status, review }) => [status, review]),
    [['In progress', 'accepted'], ['Planned', 'unreviewed'], ['Planned', 'stale'], ['Planned', 'changes-requested']]);
  assert.deepEqual(report.counts, { tasks: 4, open: 3, accepted: 1, inProgress: 1,
    blocked: 0, needsReview: 0, stale: 1, changesRequested: 1 });
});

check('P07 serializer rejects unknown nested keys, invalid ordinals, cycles and inconsistent counts', (fixture) => {
  const { board } = fixture();
  const saved = load(board, snapshot(3));
  const source = ok(board.preparePublicReport(request(saved))).report;
  const valid = createPublicExport(source);
  assert(valid);
  assert.deepEqual(valid.report, source);
  assert.notEqual(valid.report, source);
  assert.notEqual(valid.report.tasks[0], source.tasks[0]);
  const alterations: ((report: PublicReport) => void)[] = [
    (r) => { Object.assign(r.project, { owner: privateMarker }); },
    (r) => { Object.assign(r.captured, { version: saved.version }); },
    (r) => { Object.assign(r.counts, { privateCount: 1 }); },
    (r) => { Object.assign(r.milestones[0], { privateId: saved.snapshot.milestones[0].id }); },
    (r) => { Object.assign(r.tasks[0], { description: privateMarker }); },
    (r) => { r.focusTaskId = 't90'; },
    (r) => { r.tasks[0].id = 't2'; },
    (r) => { r.tasks[0].milestoneId = 'w1'; },
    (r) => { r.tasks[0].prerequisites = ['t1']; },
    (r) => { r.tasks[0].prerequisites = ['t2']; },
    (r) => { r.tasks[2].prerequisites = ['t1', 't1']; },
    (r) => { r.tasks[0].criterionCount = 21; },
    (r) => { r.counts.accepted = 1; },
    (r) => { r.milestones[0].total = 1; },
    (r) => { r.captured.updatedAt = '2026-11-13T00:00:00Z'; },
  ];
  for (const modify of alterations) {
    const invalid = structuredClone(source);
    modify(invalid);
    assert.equal(createPublicExport(invalid), undefined);
  }
  assert.equal(createPublicExport({ ...source, token: saved.version }), undefined);
});


type Diagnostic = (message: string) => void;

const p08ErrorNames = new Set([
  'AbortError', 'AggregateError', 'AssertionError', 'DOMException', 'Error', 'RangeError',
  'SyntaxError', 'SystemError', 'TimeoutError', 'TypeError',
]);
const p08ErrorCodes = new Set([
  'ABORT_ERR', 'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAGAIN', 'EAI_AGAIN', 'ECONNABORTED',
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EIO', 'ENETDOWN', 'ENETUNREACH', 'ENOTFOUND',
  'EPIPE', 'ETIMEDOUT', 'ERR_ASSERTION', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_HTTP_TOKEN',
  'ERR_SOCKET_CLOSED', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_ABORTED', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_DESTROYED', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_INVALID_ARG',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_SOCKET',
]);

function p08ErrorDetails(error: unknown) {
  const property = (value: unknown, key: string): unknown => {
    if (value === null || typeof value !== 'object') return undefined;
    try { return Reflect.get(value, key); } catch { return undefined; }
  };
  const safe = (value: unknown, known: Set<string>) =>
    typeof value === 'string' && value.length <= 80 && known.has(value) ? value : 'unknown';
  const cause = property(error, 'cause');
  const children = property(cause, 'errors');
  const causeChildCodes: string[] = [];
  if (Array.isArray(children)) {
    for (let index = 0; index < Math.min(children.length, 4); index++) {
      causeChildCodes.push(safe(property(property(children, String(index)), 'code'), p08ErrorCodes));
    }
  }
  return {
    errorName: safe(property(error, 'name'), p08ErrorNames),
    errorCode: safe(property(error, 'code'), p08ErrorCodes),
    causeName: safe(property(cause, 'name'), p08ErrorNames),
    causeCode: safe(property(cause, 'code'), p08ErrorCodes),
    causeChildCodes,
  };
}

type PublicExchange = 'session-bootstrap' | 'missing-bearer' | 'wrong-origin' | 'malformed-host' |
  'wrong-method' | 'wrong-media' | 'oversize-body' | 'query-route' | 'valid-report' | 'stale-version';

async function observeP08<T>(diagnostic: Diagnostic, exchange: PublicExchange, expectedStatus: number,
  completion: 'json-complete' | 'response-end',
  request: (response: (status: number | undefined) => void) => Promise<T>): Promise<T> {
  const started = performance.now();
  let actualStatus: number | undefined;
  const emit = (phase: 'start' | 'response' | 'failure' | typeof completion, error?: unknown) => {
    diagnostic(JSON.stringify({
      case: 'P08', exchange, phase, expectedStatus, actualStatus,
      elapsedMs: Math.round(performance.now() - started),
      ...(phase === 'failure' ? p08ErrorDetails(error) : {}),
    }));
  };
  emit('start');
  try {
    const value = await request((status) => {
      actualStatus = status;
      emit('response');
    });
    emit(completion);
    return value;
  } catch (error) {
    emit('failure', error);
    throw error;
  }
}

check('P08 authenticated public route retains exact method, origin, host, media, cap and conflict checks', async (fixture, diagnostic) => {
  const { root, board } = fixture();
  const saved = load(board, snapshot(2));
  const host = await startHost(root);
  const launchCode = new URLSearchParams(new URL(host.launchUrl).hash.slice(1)).get('launch');
  assert(launchCode);
  const body = JSON.stringify(request(saved));
  const base = { origin: host.origin, 'content-type': 'application/json' };
  try {
    const { token } = await observeP08(diagnostic, 'session-bootstrap', 200, 'json-complete', async (response) => {
      const session = await fetch(host.origin + '/api/session', { method: 'POST', headers: base,
        body: JSON.stringify({ launchCode }), signal: AbortSignal.timeout(5000) });
      response(session.status);
      assert.equal(session.status, 200);
      return await session.json() as { token: string };
    });
    const headers = { ...base, authorization: 'Bearer ' + token };
    const attempt = (exchange: PublicExchange, expected: number, init: RequestInit, path = '/api/public-report') =>
      observeP08(diagnostic, exchange, expected, 'json-complete', async (response) => {
        const result = await fetch(host.origin + path, { ...init, signal: AbortSignal.timeout(5000) });
        response(result.status);
        assert.equal(result.status, expected);
        return await result.json() as Record<string, unknown>;
      });
    await attempt('missing-bearer', 401, { method: 'POST', headers: base, body });
    await attempt('wrong-origin', 403, { method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1:1' }, body });
    await observeP08(diagnostic, 'malformed-host', 403, 'response-end', async (response) => {
      const hostRefusal = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(host.origin + '/api/public-report', { method: 'POST', headers: {
          ...headers, host: 'localhost:1', 'content-length': Buffer.byteLength(body),
        }, signal: AbortSignal.timeout(5000) }, (res) => {
          response(res.statusCode);
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end(body);
      });
      assert.equal(hostRefusal, 403);
    });
    await attempt('wrong-method', 405, { method: 'GET', headers });
    await attempt('wrong-media', 415, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body });
    await observeP08(diagnostic, 'oversize-body', 413, 'json-complete', async (response) => {
      const declaredBytes = Buffer.byteLength(body + ' '.repeat(128 * 1024), 'utf8');
      const reply = await new Promise<{ status: number | undefined; connection: string | undefined; chunks: Buffer[] }>((resolve, reject) => {
        const fail = (error: unknown) => {
          reject(error);
          req.destroy();
        };
        const req = httpRequest(host.origin + '/api/public-report', {
          method: 'POST', headers: { ...headers, 'content-length': declaredBytes },
          agent: false, signal: AbortSignal.timeout(5000),
        }, (res) => {
          res.once('error', fail);
          res.once('aborted', () => fail(new Error('Oversize refusal response aborted.')));
          res.once('close', () => {
            if (!res.complete) fail(new Error('Oversize refusal response incomplete.'));
          });
          try {
            response(res.statusCode);
          } catch (error) {
            fail(error);
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > 8192) {
              fail(new Error('Oversize refusal response exceeded 8192 bytes.'));
              return;
            }
            chunks.push(chunk);
          });
          res.once('end', () => {
            if (!res.complete) {
              fail(new Error('Oversize refusal response incomplete.'));
              return;
            }
            resolve({ status: res.statusCode, connection: res.headers.connection, chunks });
          });
        });
        req.once('error', fail);
        req.end();
      });
      assert.equal(reply.status, 413);
      assert.equal(reply.connection, 'close');
      const refusal: unknown = JSON.parse(Buffer.concat(reply.chunks).toString('utf8'));
      assert(refusal !== null && typeof refusal === 'object' && !Array.isArray(refusal));
      refuse(refusal, 'LIMIT_REACHED');
    });
    await attempt('query-route', 404, { method: 'POST', headers, body }, '/api/public-report?format=html');
    const good = await attempt('valid-report', 200, { method: 'POST', headers, body });
    assert.equal(good.version, saved.version);
    assert.equal((good.report as PublicReport).format, 'kitflint.glance.public.v1');
    const newer = change(board, saved, { type: 'project.edit', fields: { stage: 'Verify' } });
    const stale = await attempt('stale-version', 409, { method: 'POST', headers, body });
    refuse(stale, 'REVISION_CONFLICT');
    assert.equal((stale.current as Initialized).version, newer.version);
  } finally {
    await host.stop();
    await host.closedPromise;
  }
});
