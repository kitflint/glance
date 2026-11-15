import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openBoard } from '../src/board.ts';
import { startHost } from '../src/host.ts';
import { SqliteStore } from '../src/store.ts';

type Host = Awaited<ReturnType<typeof startHost>>;
type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer };
type Fixture = { root: string; open: () => Promise<Host> };
type Headers = Record<string, string>;
const fileDeadline = AbortSignal.timeout(60_000);

function exchange(origin: string, path: string, options: {
  method?: string; headers?: Headers; chunks?: string[]; body?: unknown;
} = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers = { ...options.headers };
    if (data !== undefined) {
      headers['Content-Type'] ??= 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(data));
    }
    const req = request(origin + path, {
      method: options.method ?? 'GET', headers, agent: false, signal: AbortSignal.timeout(6500),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end(data);
  });
}

function json(response: Reply) {
  return JSON.parse(response.body.toString('utf8'));
}

function launchCode(host: Host): string {
  return new URLSearchParams(new URL(host.launchUrl).hash.slice(1)).get('launch')!;
}

async function session(host: Host): Promise<Headers> {
  const response = await exchange(host.origin, '/api/session', {
    method: 'POST', headers: { Origin: host.origin }, body: { launchCode: launchCode(host) },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['set-cookie'], undefined);
  const { token } = json(response);
  assert(typeof token === 'string' && token.length >= 43, 'Session capability missing');
  return { Authorization: 'Bearer ' + token, Origin: host.origin };
}

function hostTest(name: string, exercise: (t: TestContext, fixture: Fixture) => Promise<void>) {
  test(name, { timeout: 12_000, signal: fileDeadline }, async (t) => {
    const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-host-'));
    let host: Host | undefined;
    let passed = false;
    let closed = false;
    try {
      await exercise(t, { root, open: async () => (host = await startHost(root)) });
      t.signal.throwIfAborted();
      passed = true;
    } finally {
      try {
        if (host) await host.stop();
        closed = true;
      } finally {
        if (passed && closed && !t.signal.aborted) rmSync(root, { recursive: true });
        else t.diagnostic('Retained host fixture: ' + root);
      }
    }
  });
}

function post(origin: string, route: string, headers: Headers, body: unknown) {
  return exchange(origin, route, { method: 'POST', headers, body });
}

hostTest('fixed public routes and exact Host, Origin, method and capability checks', async (t, fixture) => {
  const host = await fixture.open();
  const { origin } = host;
  const emptyRoot = readdirSync(fixture.root);
  const page = await exchange(origin, '/');
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.body.includes(launchCode(host)), false);
  assert.equal((await exchange(origin, '/app.js')).status, 200);
  assert.equal((await exchange(origin, '/style.css')).status, 200);
  assert.equal((await exchange(origin, '/', { headers: { 'X-Large': 'x'.repeat(16 * 1024) } })).status, 431);
  for (const route of ['/favicon.ico', '/%2e%2e/package.json', '/api/board?extra=1', '/api/board/']) {
    assert.equal((await exchange(origin, route)).status, 404, route);
  }
  assert.equal((await exchange(origin, '/', { headers: { Host: 'localhost:' + new URL(origin).port } })).status, 403);
  assert.equal((await exchange(origin, '/api/board')).status, 401);
  assert.equal((await exchange(origin, '/api/session')).status, 405);
  const code = launchCode(host);
  assert.equal((await post(origin, '/api/session', { Origin: 'http://example.invalid' }, { launchCode: code })).status, 403);
  assert.equal((await post(origin, '/api/session', { Origin: origin }, { launchCode: code, extra: true })).status, 400);
  assert.equal((await post(origin, '/api/session', { Origin: origin }, { launchCode: 'invalid' })).status, 401);
  const headers = await session(host);
  assert.equal((await post(origin, '/api/session', headers, { launchCode: code })).status, 401);
  assert.equal((await exchange(origin, '/api/board', { headers: { Authorization: headers.Authorization } })).status, 200);
  assert.equal((await exchange(origin, '/api/board', { headers: { ...headers, Origin: 'null' } })).status, 403);
  assert.equal((await exchange(origin, '/api/board', { headers: { ...headers, Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await exchange(origin, '/api/board', { method: 'HEAD', headers })).status, 405);
  assert.equal((await exchange(origin, '/api/change', { method: 'OPTIONS', headers })).status, 405);
  assert.equal((await post(origin, '/api/initialize', { Authorization: headers.Authorization }, { kind: 'sample' })).status, 403);
  assert.equal((await post(origin, '/api/initialize', { ...headers, 'Content-Type': 'text/plain' }, { kind: 'sample' })).status, 415);
  assert.equal((await post(origin, '/api/initialize', headers, { kind: 'blank', name: 'x', root: 'invalid' })).status, 400);
  assert.equal((await post(origin, '/api/quit', headers, { extra: true })).status, 400);
  assert.deepEqual(json(await exchange(origin, '/api/board', { headers })), { ok: true, initialized: false });
  assert.deepEqual(readdirSync(fixture.root), emptyRoot);
});

hostTest('expiry closes the listener and revokes unconsumed launch codes', async (t, fixture) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await fixture.open();
  const code = launchCode(host);
  t.mock.timers.tick(120_000);
  await host.closedPromise;
  await assert.rejects(post(host.origin, '/api/session', { Origin: host.origin }, { launchCode: code }), { code: 'ECONNREFUSED' });
});

hostTest('streaming byte caps and request saturation release counters without mutation', async (t, fixture) => {
  const host = await fixture.open();
  const headers = await session(host);
  const size = await exchange(host.origin, '/api/change', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    chunks: [' '.repeat(65536), ' '.repeat(65536), ' '],
  });
  assert.equal(size.status, 413);
  assert.equal(size.headers.connection, 'close');
  const oversized = await exchange(host.origin, '/api/initialize', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(3 * 1024 * 1024 + 1) },
  });
  assert.equal(oversized.status, 413);

  const partials = await openPartialBatch(host.origin, headers, 8, t.signal);
  try {
    await Promise.all(partials.map((active) => active.ready));
    assert.equal((await exchange(host.origin, '/api/board', { headers })).status, 429);
  } finally {
    for (const active of partials) active.socket.destroy();
    await Promise.all(partials.map((active) => active.closed));
  }
  assert.deepEqual(json(await exchange(host.origin, '/api/board', { headers })), { ok: true, initialized: false });
});

function ownedSocket(origin: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(origin).port) });
  socket.on('error', () => {});
  const cancel = () => { socket.destroy(new Error('Socket fixture was cancelled')); };
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    });
  });
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Socket did not connect')); }, 2500);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  signal.addEventListener('abort', cancel, { once: true });
  socket.resume();
  return { socket, closed, connected };
}

function waitForText(socket: Socket, text: string) {
  return new Promise<void>((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => finish(new Error('Expected HTTP status line was not observed')), 2500);
    function read(chunk: Buffer) {
      data += chunk.toString('ascii');
      if (data.includes(text)) finish();
    }
    function finish(error?: Error) {
      clearTimeout(timer);
      socket.removeListener('data', read);
      socket.removeListener('error', finish);
      if (error) reject(error); else resolve();
    }
    socket.on('data', read);
    socket.once('error', finish);
  });
}

async function openPartialBatch(origin: string, headers: Headers, count: number, signal: AbortSignal) {
  const owned = Array.from({ length: count }, () => ownedSocket(origin, signal));
  try {
    await Promise.all(owned.map((item) => item.connected));
    const host = new URL(origin).host;
    return owned.map((item) => {
      const ready = waitForText(item.socket, 'HTTP/1.1 100 Continue');
      item.socket.write(
        'POST /api/change HTTP/1.1\r\nHost: ' + host + '\r\nOrigin: ' + origin +
        '\r\nAuthorization: ' + headers.Authorization + '\r\nContent-Type: application/json' +
        '\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n{',
      );
      return { ...item, ready };
    });
  } catch (error) {
    for (const item of owned) item.socket.destroy();
    await Promise.all(owned.map((item) => item.closed));
    throw error;
  }
}

hostTest('partial headers count toward the socket cap and release on close', async (t, fixture) => {
  const host = await fixture.open();
  const sockets = Array.from({ length: 16 }, () => ownedSocket(host.origin, t.signal));
  try {
    await Promise.all(sockets.map((item) => item.connected));
    for (const item of sockets) item.socket.write('GET / HTTP/1.1\r\nHost: ');
    const overflow = ownedSocket(host.origin, t.signal);
    try {
      await overflow.connected;
      await overflow.closed;
      t.signal.throwIfAborted();
    } finally {
      overflow.socket.destroy();
    }
    for (const item of sockets.slice(0, 2)) item.socket.end();
    await Promise.all(sockets.slice(0, 2).map((item) => item.closed));
    t.signal.throwIfAborted();
    assert.equal((await exchange(host.origin, '/')).status, 200);
  } finally {
    for (const item of sockets) item.socket.destroy();
    await Promise.all(sockets.map((item) => item.closed));
  }
});

hostTest('Quit with a partial change drains or closes the exact sockets without a commit', async (t, fixture) => {
  const host = await fixture.open();
  const headers = await session(host);
  const created = await post(host.origin, '/api/initialize', headers, { kind: 'blank', name: 'Quit fixture' });
  assert.equal(created.status, 200);
  const before = json(created);
  const change = JSON.stringify({
    boardId: before.snapshot.boardId, expectedVersion: before.version,
    operation: { type: 'project.edit', fields: { goal: 'Late write' } },
  });
  const partial = ownedSocket(host.origin, t.signal);
  try {
    await partial.connected;
    const waiting = waitForText(partial.socket, 'HTTP/1.1 100 Continue');
    partial.socket.write(
      'POST /api/change HTTP/1.1\r\nHost: ' + new URL(host.origin).host + '\r\nOrigin: ' + host.origin +
      '\r\nAuthorization: ' + headers.Authorization + '\r\nContent-Type: application/json' +
      '\r\nContent-Length: ' + Buffer.byteLength(change) + '\r\nExpect: 100-continue\r\n\r\n' + change[0],
    );
    await waiting;
    const reply = await post(host.origin, '/api/quit', headers, {});
    assert.equal(reply.status, 202);
    assert.equal(json(reply).state, 'stopping');
    if (!partial.socket.destroyed) partial.socket.end(change.slice(1));
    await host.closedPromise;
    await partial.closed;
    t.signal.throwIfAborted();
    await assert.rejects(exchange(host.origin, '/'));
    const board = openBoard(fixture.root);
    try {
      const after = board.read();
      assert(!('error' in after) && after.initialized);
      assert.equal(after.version, before.version);
      assert.equal(after.snapshot.project.goal, '');
    } finally {
      assert.deepEqual(board.close(), { closed: true });
    }
  } finally {
    partial.socket.destroy();
    await partial.closed;
  }
});

hostTest('recovery-only HTTP retrieval reuses the cold cached predecessor after detecting close', async (t, fixture) => {
  const original = openBoard(fixture.root);
  let priorVersion = '';
  try {
    const initial = original.initialize({ kind: 'sample' });
    assert(!('error' in initial));
    priorVersion = initial.version;
    const next = original.change({
      boardId: initial.snapshot.boardId, expectedVersion: initial.version,
      operation: { type: 'project.edit', fields: { goal: 'Latest before corruption' } },
    });
    assert(!('error' in next));
  } finally {
    assert.deepEqual(original.close(), { closed: true });
  }
  const file = join(fixture.root, 'glance.sqlite');
  const db = new DatabaseSync(file);
  try { db.exec("UPDATE state SET sha256='wrong' WHERE slot=1"); } finally { db.close(); }
  const before = readFileSync(file);
  const close = t.mock.method(SqliteStore.prototype, 'close');
  const host = await fixture.open();
  assert.equal(close.mock.callCount(), 1);
  const opens = t.mock.method(SqliteStore.prototype, 'openExisting');
  const reads = t.mock.method(SqliteStore.prototype, 'capture');
  const held = join(fixture.root, 'preserved.sqlite');
  renameSync(file, held);
  assert.equal((await exchange(host.origin, '/api/recovery')).status, 401);
  const headers = await session(host);
  const board = await exchange(host.origin, '/api/board', { headers });
  assert.equal(board.status, 503);
  assert.equal(json(board).error.code, 'RECOVERY_REQUIRED');
  assert.equal(json(board).recoveryAvailable, true);
  const first = await exchange(host.origin, '/api/recovery', { headers });
  const second = await exchange(host.origin, '/api/recovery', { headers });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(json(first).sourceVersion, priorVersion);
  for (const [route, input] of [
    ['/api/initialize', { kind: 'sample' }], ['/api/change', {}], ['/api/export', { expectedVersion: priorVersion }],
  ] as const) {
    assert.equal((await post(host.origin, route, headers, input)).status, 503);
  }
  assert.equal(opens.mock.callCount(), 0);
  assert.equal(reads.mock.callCount(), 0);
  assert.deepEqual(readFileSync(held), before);
  assert.equal((await post(host.origin, '/api/quit', headers, {})).status, 202);
  await host.closedPromise;
});

hostTest('untrusted structure allows an authenticated unavailable-recovery session', async (t, fixture) => {
  const path = join(fixture.root, 'glance.sqlite');
  const original = Buffer.alloc(4096, 0x9e);
  writeFileSync(path, original, { flag: 'wx' });
  const host = await fixture.open();
  const headers = await session(host);
  const board = await exchange(host.origin, '/api/board', { headers });
  assert.equal(board.status, 503);
  assert.equal(json(board).recoveryAvailable, false);
  assert.deepEqual(json(await exchange(host.origin, '/api/recovery', { headers })), { ok: true, available: false });
  await host.stop();
  assert.deepEqual(readFileSync(path), original);
});
