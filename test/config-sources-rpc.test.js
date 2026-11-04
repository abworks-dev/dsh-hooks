import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mountRpc, descriptors } from '../rpc.js';

test('configuration file discovery is exact-browser-owner only and never mutates manager state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-source-rpc-'));
  try {
    await writeFile(path.join(directory, 'hooks.json'), '{"hooks":{}}');
    const peer = { principal: { kind: 'owner' } };
    let service;
    const ctx = { connection: { browserPeer: peer }, invocation: { peer }, typert: { register: () => () => {} } };
    class Remote { constructor(context) { this.ctx = context; service = this; } }
    const manager = new Proxy({}, { get() { throw new Error('discovery must not access manager'); } });
    mountRpc(ctx, manager, Remote);
    const request = { kind: 'user', directory };
    for (const denied of [undefined, { principal: { kind: 'owner' } }, { principal: { kind: 'remote' } }]) {
      ctx.invocation.peer = denied;
      assert.throws(() => service.discoverSources(request), /local_owner_client_required/);
    }
    ctx.invocation.peer = peer;
    const result = await service.discoverSources(request);
    assert.equal(result.sources[0].status, 'available');
    assert.equal(result.sources[0].document, '{"hooks":{}}');
    assert.equal(result.sources.length, 2);
    const descriptor = descriptors.find(d => d.method === 'discoverSources');
    const parse = descriptor.parameters[0].codec.create().parse;
    assert.deepEqual(parse(request), request);
    assert.throws(() => parse({ ...request, path: 'other.json' }));
    assert.throws(() => service.discoverSources({ kind: 'user', directory: '.' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
