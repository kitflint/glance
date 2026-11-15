import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startHost } from '../../../src/host.ts';
import type { GithubDependencies } from '../../../src/github.ts';

type Exchange = NonNullable<GithubDependencies['request']>;
type Reply = Awaited<ReturnType<Exchange>>;
export const config = { clientId: 'fixture_public_client', slug: 'fixture-glance' };
export const responses = JSON.parse(readFileSync(new URL('./api-responses.json', import.meta.url), 'utf8'));
export const jsonReply = (data: unknown, status = 200, headers: Reply['headers'] = {}): Reply =>
  ({ status, headers, body: Buffer.from(JSON.stringify(data)) });

export function githubFixture() {
  let held = false;
  const storage = new Map<string, Buffer>();
  const pending = [{ error: 'authorization_pending' }, { error: 'slow_down' }];
  const control = {
    calls: [] as { method: string; path: string; body?: string; authorization?: string }[],
    sleeps: [] as number[],
    opens: 0,
    closes: 0,
    writes: 0,
    deletes: 0,
    installations: [structuredClone(responses.installation)],
    repositories: [structuredClone(responses.repository)],
    repository: structuredClone(responses.repository),
    issue: structuredClone(responses.issue),
    createdIssues: new Map<number, typeof responses.issue>(),
    publication: false,
    publicationReply: undefined as Exchange | undefined,
    loseCreateTitle: undefined as string | undefined,
    response: undefined as Exchange | undefined,
    beforeWrite: undefined as ((value: Buffer) => Promise<void>) | undefined,
    beforeRead: undefined as (() => Promise<void>) | undefined,
    beforeRemove: undefined as (() => Promise<void>) | undefined,
    clock: Date.parse('2026-11-13T02:00:00Z'),
    storage,
  };
  const dependencies: GithubDependencies = {
    now: () => control.clock,
    async wait(ms, signal) { signal.throwIfAborted(); control.sleeps.push(ms); control.clock += ms; },
    async acquire() {
      if (held) throw new Error('fixture owner already held');
      held = true;
      control.opens++;
      return { async close() { assert(held); held = false; control.closes++; } };
    },
    async vault({ boardId, generation }) {
      assert(held);
      const key = boardId + ':' + generation;
      return {
        async read() { await control.beforeRead?.(); return storage.get(key) ?? null; },
        async write(value) { await control.beforeWrite?.(value); storage.set(key, Buffer.from(value)); control.writes++; },
        async remove() { await control.beforeRemove?.(); storage.delete(key); control.deletes++; },
      };
    },
    async request(input) {
      const { url, method, body, headers, signal } = input;
      signal.throwIfAborted();
      control.calls.push({ method, path: url.pathname, body, authorization: headers.Authorization });
      if (control.response) return control.response(input);
      if (url.origin === 'https://github.com') {
        assert.equal(method, 'POST');
        assert.equal(headers.Authorization, undefined);
        if (url.pathname === '/login/device/code') return jsonReply(responses.device);
        assert.equal(url.pathname, '/login/oauth/access_token');
        return jsonReply(pending.shift() ?? responses.pair);
      }
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(headers.Authorization, 'Bearer ' + responses.pair.access_token);
      if (control.publication && (method === 'POST' || method === 'PATCH')) {
        assert.equal(headers['Content-Type'], 'application/json');
        assert.equal(url.search, '');
        if (control.publicationReply) return control.publicationReply(input);
        const fields = JSON.parse(body!);
        if (method === 'POST') {
          assert(url.pathname.endsWith('/issues'));
          const number = 51 + control.createdIssues.size;
          const issue = { id: 1000 + number, number, title: fields.title, body: fields.body ?? '', state: 'open',
            updated_at: new Date(control.clock).toISOString() };
          control.createdIssues.set(number, issue);
          if (fields.title === control.loseCreateTitle) throw new Error('Synthetic lost create response');
          return jsonReply(issue, 201);
        }
        const number = Number(url.pathname.split('/').at(-1));
        const existing = number === 31 ? control.issue : control.createdIssues.get(number);
        assert(existing);
        Object.assign(existing, fields, { updated_at: new Date(control.clock).toISOString() });
        return jsonReply(existing);
      }
      assert.equal(method, 'GET');
      switch (url.pathname) {
        case '/user': return jsonReply(responses.user);
        case '/user/installations': return jsonReply({ installations: control.installations });
        case '/user/installations/55/repositories': return jsonReply({ repositories: control.repositories });
        case '/repositories/1234': return jsonReply(control.repository);
      }
      assert(url.pathname.startsWith('/repos/fixture-org/' + control.repository.name + '/'));
      if (url.pathname.endsWith('/issues')) return jsonReply([control.issue,
        { ...responses.pull, pull_request: {} }, { ...control.issue, id: 302, number: 32, body: 'x'.repeat(16001) }]);
      if (url.pathname.endsWith('/issues/31')) return jsonReply(control.issue);
      if (control.publication && /\/issues\/\d+$/.test(url.pathname)) {
        const issue = control.createdIssues.get(Number(url.pathname.split('/').at(-1)));
        return issue ? jsonReply(issue) : jsonReply({}, 404);
      }
      if (url.pathname.endsWith('/pulls')) return jsonReply([responses.pull]);
      if (url.pathname.endsWith('/actions/runs')) return jsonReply({ workflow_runs: [responses.run] });
      if (url.pathname.endsWith('/releases')) return jsonReply([responses.release]);
      if (url.pathname.endsWith('/pulls/41/reviews')) return jsonReply([responses.review]);
      throw new Error('Unrecognized synthetic GitHub route');
    },
  };
  return { control, dependencies };
}

if (import.meta.main) {
  const [, , root, mode] = process.argv;
  if (process.argv.length !== 4 || !root || !process.send || !['configured', 'offline', 'publication'].includes(mode)) {
    throw new Error('Pass an owned Board root, fixture mode and IPC channel');
  }
  const fixture = githubFixture();
  fixture.control.publication = mode === 'publication';
  if (fixture.control.publication) {
    fixture.control.repositories[0].permissions.push = true;
    fixture.control.loseCreateTitle = 'Unknown create fixture';
  }
  fixture.control.clock = Date.now();
  let firstInstallationCheck = true;
  let firstRepositoryCheck = true;
  try {
    const host = await startHost(root, {
      githubConfig: mode === 'offline' ? null : config,
      githubDependencies: { ...fixture.dependencies, wait: async (ms, signal) => {
        await delay(850, undefined, { signal });
        await fixture.dependencies.wait!(ms, signal);
      }, request: async (input) => {
        const reply = await fixture.dependencies.request!(input);
        if (input.url.pathname === '/user/installations' && firstInstallationCheck) {
          firstInstallationCheck = false;
          return jsonReply({ installations: [] });
        }
        if (input.url.pathname === '/user/installations/55/repositories' && firstRepositoryCheck) {
          firstRepositoryCheck = false;
          return jsonReply({ repositories: [] });
        }
        if (mode !== 'publication' && input.url.pathname.endsWith('/issues/31')) {
          return jsonReply({ ...responses.issue, title: 'Remote edit', updated_at: '2026-11-13T03:00:00Z' });
        }
        return reply;
      } },
    });
    const stop = () => { void host.stop().catch(() => { process.exitCode = 1; }); };
    process.once('disconnect', stop);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    process.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'stop') stop();
    });
    process.send({ type: 'ready', origin: host.origin, launchUrl: host.launchUrl });
    await host.closedPromise;
  } catch {
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
