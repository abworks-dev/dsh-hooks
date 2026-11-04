import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHookManager } from '../core.js';
import { descriptors, mountRpc } from '../rpc.js';

// The package root mounts apply() and contributes its Client resource together.
// A second Host row would open the same storage domain twice.
test('bundle mounts a single root row for both Host and Client', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.equal(manifest.exports['./host'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.match(patch, /id: abworks-generic-hooks\s+name:\s*['"]@abworks\/dsh-hooks['"]/);
  assert.doesNotMatch(patch, /name:\s*['"]@abworks\/dsh-hooks\/host['"]/);
  assert.equal((patch.match(/name:\s*['"]@abworks\/dsh-hooks['"]/g) ?? []).length, 1);
  assert.ok(manifest.files.includes('index.js'));
  assert.ok(manifest.files.includes('rpc.js'));
  assert.ok(manifest.files.includes('scope.js'));
  const host = await import('../' + manifest.exports['./host']);
  assert.equal(typeof host.apply, 'function');
});

test('backend contributes every strict RPC endpoint and retains local-owner authorization', async () => {
  const peer = { principal: { kind: 'owner' } };
  const services = new Map();
  let contribution, released = false;
  const ctx = {
    invocation: { peer }, connection: { browserPeer: peer },
    typert: { register(value) { contribution = value; return async () => { released = true; }; } },
  };
  class Remote {
    constructor(context, key) { this.ctx = context; services.set(key, this); }
  }
  const manager = createHookManager({ persist: async () => {} });
  const release = mountRpc(ctx, manager, Remote);
  try {
    assert.equal(contribution.package, '@abworks/dsh-hooks');
    assert.equal(contribution.face, 'host');
    assert.deepEqual(contribution.invocations, descriptors);
    assert.deepEqual(descriptors.map(d => d.method), ['snapshot', 'configure', 'upsert', 'remove', 'toggle', 'clearRecords', 'previewTrust', 'trust', 'previewImport', 'importCodex', 'discoverSources', 'previewSourceImports', 'importSources', 'registerSource', 'checkSources', 'previewSourceRefresh', 'refreshSource', 'detachSource']);
    const service = services.get('genericHooks');
    for (const d of descriptors) {
      assert.equal(typeof service[d.method], 'function');
      assert.equal(d.namespace, 'genericHooks');
      assert.equal(d.service, 'genericHooks');
      assert.equal(d.result.mode, 'strict');
      for (const parameter of d.parameters) assert.equal(parameter.codec.mode, 'strict');
    }
    assert.equal(service.snapshot().enabled, false);
    assert.deepEqual(service.snapshot().rules, []);
    for (const deniedPeer of [undefined, { principal: { kind: 'owner' } }, { principal: { kind: 'remote' } }]) {
      ctx.invocation.peer = deniedPeer;
      for (const d of descriptors) assert.throws(() => service[d.method](), /local_owner_client_required/);
    }
  } finally { await release(); manager.dispose(); }
  assert.equal(released, true);
});
