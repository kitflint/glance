import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { openBoard, openBoardReader } from '../src/board.ts';
import type { Failure } from '../src/board.ts';
import { createGlanceMcpServer } from '../src/mcp.ts';

function ok<T extends object>(value: T | Failure): T {
  assert(!('error' in value), JSON.stringify(value));
  return value as T;
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/github/board-v3.json', import.meta.url), 'utf8'));

test('G05 public export and cached-only MCP views with strict versioning in both launch modes', { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'glance-github-mcp-'));
  t.diagnostic('Retained owned MCP fixture: ' + root);
  const writer = openBoard(root);
  const reader = openBoardReader(root);
  try {
    let current = ok(writer.initialize({ kind: 'blank', name: 'Public-safe project' }));
    const change = (operation: object) => ok(writer.github({ boardId: current.snapshot.boardId, expectedVersion: current.version, operation }));
    current = change({ type: 'prepare' });
    current = change({ type: 'select', connectionEpoch: fixture.connectionEpoch, repository: fixture.repository });
    const identity = { connectionEpoch: fixture.connectionEpoch, repositoryId: fixture.repository.id };
    current = change({ type: 'import', ...identity, issues: [fixture.issue] });
    const taskId = current.snapshot.tasks[0].id;
    const publicFiles = ok(writer.preparePublicReport({ expectedVersion: current.version,
      labels: { project: null, tasks: [], milestones: [], workstreams: [] } }));
    for (const value of [fixture.repository.name, fixture.repository.owner, fixture.issue.values.body, fixture.issue.values.title]) {
      assert(!JSON.stringify(publicFiles).includes(value));
    }

    for (const writes of [false, true]) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createGlanceMcpServer(reader, writes ? (value) => writer.change(value) : undefined);
      const client = new Client({ name: 'github-cache-test', version: '1.0.0' });
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport, { timeout: 5000 });
        const roster = await client.listTools();
        const github = roster.tools.filter(({ name }) => name.startsWith('glance_github_'));
        assert.deepEqual(github.map(({ name }) => name).sort(), ['glance_github_list', 'glance_github_overview', 'glance_github_task']);
        for (const tool of github) {
          assert.equal(tool.annotations?.readOnlyHint, true);
          assert.equal(tool.annotations?.openWorldHint, false);
        }
        assert.equal(roster.tools.some(({ name }) => name === 'glance_update_board'), writes);
        assert.equal(roster.tools.length, writes ? 8 : 7);
        const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
        const listed = await call('glance_github_list', { kind: 'mappings', offset: 0, limit: 1 });
        assert.equal(listed.isError, undefined);
        const content = listed.structuredContent;
        assert(typeof content === 'object' && content !== null && !Array.isArray(content));
        assert('version' in content);
        assert.equal(content.version, current.version);
        assert(!JSON.stringify(listed).includes(fixture.issue.values.body));
        const detail = await call('glance_github_task', { taskId, expectedVersion: current.version });
        assert(JSON.stringify(detail).includes(fixture.issue.values.body));
        assert(Buffer.byteLength(JSON.stringify(detail)) <= 262144);
        const version = current.version;
        const at = '2026-11-13T05:00:00Z';
        current = change({ type: 'refresh', ...identity, issues: [], facts: [
          { kind: 'release', id: '601', repositoryId: fixture.repository.id, observedAt: at, tagName: 'v1',
            targetCommitish: 'main', draft: false, prerelease: false, publishedAt: at },
        ], collection: { kind: 'releases', pullRequestId: null, page: 1, pagesFetched: 1, count: 1,
          observedAt: at, completeness: 'complete-for-scope' }, attempt: { at, outcome: 'success', code: null } });
        if (current.version === version) current = change({ type: 'clear-facts', kinds: ['release'], confirmed: true });
        const stale = await call('glance_github_task', { taskId, expectedVersion: version });
        assert.equal(stale.isError, true);
        assert.match(JSON.stringify(stale), /REVISION_CONFLICT/);
        const stalePage = await call('glance_github_list', { kind: 'mappings', offset: 1, limit: 1, expectedVersion: version });
        assert.equal(stalePage.isError, true);
        assert.match(JSON.stringify(stalePage), /REVISION_CONFLICT/);
        const missing = await call('glance_github_list', { kind: 'mappings', offset: 1, limit: 1 });
        assert.equal(missing.isError, true);
        if (!writes) {
          const overview = await call('glance_github_overview', {});
          const empty = overview.structuredContent;
          assert(empty && typeof empty === 'object' && 'publication' in empty);
          assert.deepEqual(empty.publication, { counts: { prepared: 0, notSent: 0, rejected: 0, unknown: 0, conflict: 0, confirmed: 0 }, records: [] });
          const local = ok(writer.change({ boardId: current.snapshot.boardId, expectedVersion: current.version,
            operation: { type: 'task.add', fields: { title: 'Private proposal', description: 'Do not expose in summary' } } }));
          const unlinked = local.createdIds.taskId!;
          const intentId = randomUUID();
          const prepared = ok(writer.publication({ boardId: local.snapshot.boardId, expectedVersion: local.version,
            operation: { type: 'prepare-intents', intents: [{ id: intentId, batchId: randomUUID(),
              origin: { boardId: local.snapshot.boardId, generation: local.snapshot.generation, revision: local.snapshot.revision,
                connectionEpoch: fixture.connectionEpoch, taskId: unlinked },
              repository: { id: fixture.repository.id, owner: fixture.repository.owner, name: fixture.repository.name,
                visibility: fixture.repository.visibility }, action: 'create', issue: null, fields: ['title'],
              before: null, proposed: { title: 'Private proposal' }, preparedAt: at }] } }));
          current = prepared;
          const unmapped = await call('glance_github_task', { taskId: unlinked, expectedVersion: current.version });
          const dto = unmapped.structuredContent;
          assert(dto && typeof dto === 'object' && 'publication' in dto && 'mapping' in dto);
          assert.equal(dto.mapping, null);
          assert.deepEqual(dto.publication, { counts: { prepared: 1, notSent: 0, rejected: 0, unknown: 0, conflict: 0, confirmed: 0 },
            records: [{ intentId, taskId: unlinked, repositoryId: fixture.repository.id, action: 'create', state: 'prepared',
              issue: null, at, reconciled: null }] });
          assert.equal((await call('glance_github_task', { taskId: 't_' + randomUUID(), expectedVersion: current.version })).isError, true);
          const all = await call('glance_github_overview', {});
          assert(!JSON.stringify(all).includes('Private proposal'));
          assert(!JSON.stringify(all).includes('Do not expose in summary'));
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    assert.deepEqual(reader.close(), { closed: true });
    assert.deepEqual(writer.close(), { closed: true });
  }
});
