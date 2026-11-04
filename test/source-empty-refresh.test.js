import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHookManager } from '../core.js';
import { mountRpc } from '../rpc.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('owner empty-source review removes only owned snapshots after explicit guarded refresh', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hooks-empty-source-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'hooks.json');
  const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'fixture-never-run' }] }] } });
  await writeFile(filename, original);
  let persisted, writes = 0, executions = 0;
  const manager = createHookManager({
    persist: async state => { writes++; persisted = structuredClone(state); },
    fingerprint: async () => ({ digest: 'fixture', files: [] }),
    execute: async () => { executions++; throw new Error('must_not_execute'); },
  });
  t.after(() => manager.dispose());
  const peer = { principal: { kind: 'owner' } };
  const ctx = { connection: { browserPeer: peer }, invocation: { peer }, typert: { register: () => () => {} } };
  let service;
  class Remote { constructor(context) { this.ctx = context; service = this; } }
  mountRpc(ctx, manager, Remote);
  await service.registerSource({ id: 'selected', request: { kind: 'user', directory: root }, accepted: { 'hooks.json': hash(original) }, options: { interpreter: { executable: process.execPath, argvPrefix: [] } } });
  const ownedId = manager.snapshot().rules[0].id;
  await manager.importRules([{ id: 'independent', name: 'Unrelated fixture', event: 'Stop', action: { type: 'command', executable: process.execPath } }]);
  for (const id of [ownedId, 'independent']) {
    await manager.trust(id, (await manager.previewTrust(id)).digest);
    await manager.toggle(id, true);
  }
  await manager.configure({ enabled: true });
  const empty = Buffer.from('{"hooks":{}}\r\n');
  await writeFile(filename, empty);
  const before = manager.snapshot(), beforePersisted = structuredClone(persisted), beforeWrites = writes;
  const preview = await service.previewSourceRefresh({ id: 'selected', revision: 1 });
  assert.deepEqual(preview.rules, []); assert.deepEqual(preview.unsupported, []);
  assert.equal(preview.request.accepted['hooks.json'], hash(empty));
  assert.equal(typeof preview.request.previewToken, 'string');
  assert.deepEqual(manager.snapshot(), before); assert.deepEqual(persisted, beforePersisted); assert.equal(writes, beforeWrites);
  const after = await service.refreshSource(preview.request);
  assert.equal(after.enabled, true);
  assert.deepEqual(after.rules, before.rules.filter(rule => rule.id === 'independent'));
  assert.deepEqual(after.sourceRegistrations[0].owners, []);
  assert.equal(after.sourceRegistrations[0].revision, 2);
  assert.equal(after.sourceRegistrations[0].accepted['hooks.json'], hash(empty));
  assert.equal(writes, beforeWrites + 1);
  assert.deepEqual(await readFile(filename), empty);
  await assert.rejects(service.refreshSource(preview.request), /source_revision_changed/);
  assert.equal(executions, 0);
});
