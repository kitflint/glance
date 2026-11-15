import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openBoard } from '../src/board.ts';
import { startHost } from '../src/host.ts';
import { config, githubFixture, jsonReply, responses } from './fixtures/github/host-worker.ts';

async function exchange(origin: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; payload: any }>((resolve, reject) => {
    const outgoing = request(origin + path, {
      method: raw ? 'POST' : 'GET', agent: false, signal: AbortSignal.timeout(4500),
      headers: raw ? { 'Content-Type': 'application/json', 'Content-Length': String(raw.length), ...headers } : headers,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.once('error', reject);
      incoming.once('end', () => {
        try { resolve({ status: incoming.statusCode!, payload: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.once('error', reject);
    outgoing.end(raw);
  });
}

test('G08 HTTP connection authority, initialization, prompt start, status projection and positive Quit', { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-github-host-'));
  t.diagnostic('Retained owned host fixture: ' + root);
  const fixture = githubFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixture.control.response = async ({ url, signal }) => {
    assert.equal(url.pathname, '/login/device/code');
    await gate;
    signal.throwIfAborted();
    return jsonReply(responses.device);
  };
  const host = await startHost(root, { githubConfig: config, githubDependencies: fixture.dependencies });
  try {
    const { origin } = host;
    const originHeader = { Origin: origin };
    const launchCode = new URLSearchParams(new URL(host.launchUrl).hash.slice(1)).get('launch');
    const session = await exchange(origin, '/api/session', { launchCode }, originHeader);
    assert.equal(session.status, 200);
    const headers = { ...originHeader, Authorization: 'Bearer ' + session.payload.token };
    const post = (route: string, body: unknown, extra = {}) => exchange(origin, route, body, { ...headers, ...extra });
    const overview = '/api/github/overview';
    assert.equal((await exchange(origin, overview)).status, 405);
    assert.equal((await post(overview + '?extra=1', {})).status, 404);
    assert.equal((await post(overview, {}, { Host: 'different.invalid' })).status, 403);
    assert.equal((await post(overview, {}, { Origin: 'https://different.invalid' })).status, 403);
    assert.equal((await exchange(origin, overview, {}, originHeader)).status, 401);
    assert.equal((await post(overview, { token: 'synthetic injection' })).status, 400);
    assert.equal((await post(overview, {})).payload.boardState, 'UNINITIALIZED');
    assert.equal((await post('/api/github/start', {})).payload.error.code, 'NOT_INITIALIZED');
    assert.equal(fixture.control.calls.length, 0);
    const initial = await post('/api/initialize', { kind: 'blank', name: 'Local synthetic board' });
    assert.equal(initial.status, 200);
    const input = { boardId: initial.payload.snapshot.boardId, expectedVersion: initial.payload.version };
    for (const extra of [{ url: 'https://different.invalid' }, { token: 'fixture' }, { rawFact: {} }]) {
      assert.equal((await post('/api/github/start', { ...input, ...extra })).status, 400);
    }
    const start = await post('/api/github/start', input);
    assert.equal(start.status, 202);
    const { operationId } = start.payload;
    assert.equal(start.payload.state, 'starting');
    assert.equal((await post('/api/github/status', { operationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })).status, 409);
    const status = await post('/api/github/status', { operationId });
    assert.equal(status.status, 200);
    assert.equal(status.payload.device, null);
    assert.equal((await post('/api/github/cancel', { operationId })).status, 200);
    release();
    let settled = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await post('/api/github/status', { operationId })).payload.state === 'cancelled') { settled = true; break; }
      await delay(10);
    }
    assert(settled);
    assert.equal((await post('/api/quit', {})).status, 202);
    await host.closedPromise;
    assert.equal(fixture.control.opens, fixture.control.closes);
  } finally {
    release();
    await host.stop();
  }
});
test('G08 a later recovery-only Board refuses new GitHub work and still closes the host', { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-github-recovery-'));
  t.diagnostic('Retained owned host fixture: ' + root);
  const seed = openBoard(root);
  const initial = seed.initialize({ kind: 'blank', name: 'Recovery fixture' });
  assert(!('error' in initial));
  assert(!('error' in seed.change({ boardId: initial.snapshot.boardId, expectedVersion: initial.version,
    operation: { type: 'project.edit', fields: { goal: 'Keep the predecessor' } } })));
  assert.deepEqual(seed.close(), { closed: true });
  const fixture = githubFixture();
  const host = await startHost(root, { githubConfig: config, githubDependencies: fixture.dependencies });
  try {
    const launchCode = new URLSearchParams(new URL(host.launchUrl).hash.slice(1)).get('launch');
    const session = await exchange(host.origin, '/api/session', { launchCode }, { Origin: host.origin });
    assert.equal(session.status, 200);
    const headers = { Origin: host.origin, Authorization: 'Bearer ' + session.payload.token };
    const post = (route: string, body: unknown) => exchange(host.origin, route, body, headers);
    const before = await post('/api/github/overview', {});
    assert.equal(before.payload.boardState, 'READY');
    const database = new DatabaseSync(join(root, 'glance.sqlite'));
    try { database.prepare('UPDATE state SET document = ? WHERE slot = 1').run('{}'); }
    finally { database.close(); }
    const overview = await post('/api/github/overview', {});
    assert.equal(overview.status, 200);
    assert.equal(overview.payload.boardState, 'RECOVERY_ONLY');
    const refused = await post('/api/github/start', { boardId: before.payload.boardId, expectedVersion: before.payload.version });
    assert.equal(refused.status, 503);
    assert.equal(refused.payload.error.code, 'RECOVERY_REQUIRED');
    const recovery = await exchange(host.origin, '/api/recovery', undefined, headers);
    assert.equal(recovery.status, 200);
    assert.equal(recovery.payload.available, true);
    assert.equal(fixture.control.opens, 0);
  } finally { await host.stop(); }
});
