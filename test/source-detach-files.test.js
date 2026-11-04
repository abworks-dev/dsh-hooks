import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHookManager } from '../core.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('detach preserves real JSON/TOML bytes and local edits, revoking only matching owned snapshots', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hooks-detach-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = {
    'hooks.json': Buffer.from(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'json-fixture-never-run' }] }] } }) + '\r\n'),
    'config.toml': Buffer.from('# Keep this comment and original line endings.\r\n[[hooks.Stop]]\r\n[[hooks.Stop.hooks]]\r\ntype = "command"\r\ncommand = "toml-fixture-never-run"\r\n'),
  };
  for (const [name, bytes] of Object.entries(documents)) await writeFile(path.join(root, name), bytes);
  const accepted = Object.fromEntries(Object.entries(documents).map(([name, bytes]) => [name, hash(bytes)]));
  let stored, executions = 0;
  const manager = createHookManager({
    fingerprint: async () => ({ digest: 'a'.repeat(64), files: [] }),
    execute: async () => { executions++; throw Error('must_not_execute'); },
    persist: async state => { stored = structuredClone(state); },
  });
  t.after(() => manager.dispose());
  await manager.registerSource({ id: 'selected-pair', request: { kind: 'user', directory: root }, accepted, options: { interpreter: { executable: process.execPath, argvPrefix: [] } } });
  const [pristine, edited] = manager.snapshot().rules;
  assert.equal(manager.snapshot().rules.length, 2);
  await manager.importRules([{ id: 'unrelated', name: 'independent fixture', event: 'Stop', action: { type: 'command', executable: process.execPath } }]);
  for (const id of [pristine.id, edited.id, 'unrelated']) {
    await manager.trust(id, (await manager.previewTrust(id)).digest);
    await manager.toggle(id, true);
  }
  await manager.configure({ enabled: true });
  await manager.upsert({ ...edited, name: 'local edit retained' });
  const before = manager.snapshot();
  const registration = before.sourceRegistrations[0];
  assert.equal(registration.status, 'conflict');
  const detached = await manager.detachSource({ id: registration.id, revision: registration.revision });
  assert.equal(Object.hasOwn(detached, 'sourceRegistrations'), false);
  assert.equal(Object.hasOwn(stored, 'sourceRegistrations'), false);
  assert.equal(detached.enabled, true);
  assert.equal(detached.rules.find(rule => rule.id === pristine.id).enabled, false);
  assert.equal(detached.rules.find(rule => rule.id === pristine.id).trust, undefined);
  for (const id of [edited.id, 'unrelated']) assert.deepEqual(detached.rules.find(rule => rule.id === id), before.rules.find(rule => rule.id === id));
  assert.equal(detached.rules.length, before.rules.length);
  for (const [name, bytes] of Object.entries(documents)) {
    const actual = await readFile(path.join(root, name));
    assert.deepEqual(actual, bytes);
    assert.equal(hash(actual), accepted[name]);
  }
  assert.equal(executions, 0);
});
