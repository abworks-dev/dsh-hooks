import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHookManager } from '../core.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-scope-private-'));
  let hashes = 0, executions = 0, writes = 0;
  const manager = createHookManager({ persist: async () => { writes++; }, fingerprint: async () => { hashes++; return { digest: 'fixture', files: [] }; }, execute: async () => { executions++; throw new Error('must not execute'); } });
  await manager.upsert({ id: 'project', name: 'Project', scope: { kind: 'project', root }, event: 'PreToolUse', includeToolInput: true, payloadMode: 'full', action: { type: 'command', executable: process.execPath } });
  const preview = await manager.previewTrust('project');
  await manager.trust('project', preview.digest);
  await manager.toggle('project', true);
  await manager.configure({ enabled: true });
  hashes = 0; writes = 0;
  t.after(async () => { manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, manager, counts: () => [hashes, executions, writes] };
}
function privateMetadata(getEffectiveDirectory) {
  const metadata = { getEffectiveDirectory };
  for (const key of ['toolName', 'sessionId', 'getToolInput', 'readPayload', 'arguments', 'prompt', 'matcher', 'source']) {
    Object.defineProperty(metadata, key, { enumerable: true, get() { throw new Error('private-payload-sentinel'); } });
  }
  return metadata;
}
function checkRecord(manager, status) {
  const records = manager.snapshot().records;
  assert.equal(records[0].status, status);
  assert.deepEqual(Object.keys(records[0]).sort(), ['durationMs', 'event', 'exitCode', 'id', 'ruleId', 'startedAt', 'status']);
  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes('dsh-scope-private'));
  assert.ok(!serialized.includes('private-payload-sentinel'));
}
test('missing subject or unavailable effective cwd is a private observation, never a Pre denial', async t => {
  const { root, manager, counts } = await fixture(t);
  for (const getDirectory of [undefined, () => undefined, () => 'relative', () => { throw new Error(root); }, () => path.join(root, 'missing')]) {
    assert.deepEqual(await manager.dispatchDecision('PreToolUse', privateMetadata(getDirectory)), { blocked: false, reason: '' });
    checkRecord(manager, 'scope_unavailable');
  }
  assert.equal(manager.snapshot().records.length, 5);
  assert.deepEqual(counts(), [0, 0, 0]);
});
test('ordinary unrelated exact-directory mismatches stay silent without matcher, args, payload or hash reads', async t => {
  const { root, manager, counts } = await fixture(t);
  const child = path.join(root, 'child'); await mkdir(child);
  assert.equal(await manager.dispatch('PreToolUse', privateMetadata(() => child)), false);
  assert.deepEqual(manager.snapshot().records, []);
  assert.deepEqual(counts(), [0, 0, 0]);
});
test('deleted or non-directory project root is invalid even when effective cwd cannot resolve', async t => {
  const { root, manager, counts } = await fixture(t);
  await rm(root, { recursive: true });
  assert.equal(await manager.dispatch('PreToolUse', privateMetadata(() => root)), false);
  checkRecord(manager, 'scope_invalid');
  await writeFile(root, 'private-payload-sentinel');
  assert.equal(await manager.dispatch('PreToolUse', privateMetadata()), false);
  checkRecord(manager, 'scope_invalid');
  assert.deepEqual(counts(), [0, 0, 0]);
});
test('redirected project root is invalid rather than an ordinary mismatch', async t => {
  const { root, manager, counts } = await fixture(t);
  const target = await mkdtemp(path.join(os.tmpdir(), 'dsh-scope-target-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await rm(root, { recursive: true });
  await symlink(target, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await manager.dispatch('PreToolUse', privateMetadata(() => target)), false);
  checkRecord(manager, 'scope_invalid');
  assert.deepEqual(counts(), [0, 0, 0]);
});
test('scope skip diagnostics use the existing 100-record bound without persistence', async t => {
  const { manager, counts } = await fixture(t);
  for (let i = 0; i < 115; i++) assert.equal(await manager.dispatch('PreToolUse', privateMetadata()), false);
  assert.equal(manager.snapshot().records.length, 100);
  assert.ok(manager.snapshot().records.every(record => record.status === 'scope_unavailable'));
  assert.deepEqual(counts(), [0, 0, 0]);
});
