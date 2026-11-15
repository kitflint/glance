import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { acquireGithubOwner } from '../../../src/github.ts';

const [, , mode, ownedId] = process.argv;
assert.equal(process.argv.length, 4);
assert(process.platform === 'win32' && process.arch === 'x64');
assert.match(ownedId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
assert(['vault', 'pipe-hold', 'pipe-busy', 'pipe-release'].includes(mode));
const boardId = 'b_' + ownedId;
const generation = ownedId;
const target = { boardId, generation, rootBinding: 'a'.repeat(64) };

if (mode === 'pipe-busy') {
  await assert.rejects(async () => {
    const owner = await acquireGithubOwner(target);
    await owner.close();
  }, { message: 'Another operation owns this GitHub connection.' });
  console.log(JSON.stringify({ mode, excluded: true }));
} else {
  const owner = await acquireGithubOwner(target);
  try {
    if (mode === 'pipe-hold') {
      assert(process.send);
      process.send({ type: 'holding', pid: process.pid });
      const [message] = await once(process, 'message', { signal: AbortSignal.timeout(15_000) });
      assert.deepEqual(message, { type: 'release' });
    } else if (mode === 'vault') {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      const service = 'KitFlint.Glance.GitHub.v1';
      const user = boardId + ':' + generation;
      const make = () => new AsyncEntry(service, user);
      const expected = createHash('sha256').update('owned fixture ' + ownedId).digest();
      assert.equal(await make().getSecret(), null, 'An entry already exists for this fixture');
      let attempted = false;
      try {
        attempted = true;
        await make().setSecret(expected);
        const recovered = await make().getSecret();
        assert(recovered && Buffer.from(recovered).equals(expected));
      } finally {
        if (attempted) {
          const entry = make();
          const observed = await entry.getSecret();
          if (observed) {
            assert(Buffer.from(observed).equals(expected), 'Unexpected credential bytes');
            assert.equal(await entry.deleteCredential(), true);
          }
          assert.equal(await make().getSecret(), null);
        }
      }
    }
  } finally {
    await owner.close();
    if (process.connected) process.disconnect();
  }
  console.log(JSON.stringify({ mode, ownerClosed: true }));
}
