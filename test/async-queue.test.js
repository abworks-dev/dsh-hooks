import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncQueue } from '../async-queue.js';
import { createHookManager, parseRule } from '../core.js';
import { bindEvents } from '../index.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const tick = () => new Promise(resolve => setImmediate(resolve));
const completed = { status: 'completed', exitCode: 0, stdout: '{"continue":false,"async":true}', stderr: '' };
const definition = { id: 'stop', name: 'Stop', event: 'Stop', async: true, scope: { kind: 'user' }, action: { type: 'command', executable: process.execPath } };
async function managerFor(execute, fingerprint = async () => ({ digest: 'fixture', files: [] })) {
  const manager = createHookManager({ persist: async () => {}, execute, fingerprint });
  await manager.upsert(definition);
  await manager.trust('stop', (await manager.previewTrust('stop')).digest);
  await manager.toggle('stop', true);
  await manager.configure({ enabled: true });
  return manager;
}
const metadata = { sessionId: 's', isSessionActive: () => true };
test('project mismatch is silent even at full capacity and consumes no pending slot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hooks-async-scope-'));
  const selected = path.join(root, 'selected'), other = path.join(root, 'other');
  await mkdir(selected); await mkdir(other);
  const releases = []; let calls = 0;
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }), execute: () => { calls++; return new Promise(resolve => releases.push(resolve)); } });
  try {
    await manager.upsert({ ...definition, scope: { kind: 'project', root: selected } });
    await manager.trust('stop', (await manager.previewTrust('stop')).digest);
    await manager.toggle('stop', true); await manager.configure({ enabled: true });
    const matching = { ...metadata, getEffectiveDirectory: () => selected };
    for (let i = 0; i < 36; i++) await manager.dispatch('Stop', matching);
    await tick(); assert.equal(calls, 4);
    const before = manager.snapshot().records;
    await manager.dispatch('Stop', { ...metadata, getEffectiveDirectory: () => other });
    assert.deepEqual(manager.snapshot().records, before);
    await manager.dispatch('Stop', matching);
    assert.equal(manager.snapshot().records[0].status, 'busy');
  } finally {
    manager.dispose(); releases.forEach(resolve => resolve(completed)); await tick();
    await rm(root, { recursive: true, force: true });
  }
});
test('FIFO has four global active slots, 32 pending, bounded busy and no retry', async () => {
  const queue = createAsyncQueue(), starts = [], releases = [];
  for (let i = 0; i < 36; i++) assert.equal(queue.enqueue({ sessionId: 's', run: () => { starts.push(i); return new Promise(resolve => releases.push(resolve)); } }), 'queued');
  assert.equal(queue.enqueue({ run() { assert.fail('busy work ran'); } }), 'busy');
  assert.deepEqual(queue.snapshot(), { active: 4, pending: 32 });
  await tick(); assert.deepEqual(starts, [0, 1, 2, 3]);
  releases.shift()(); await tick(); assert.deepEqual(starts, [0, 1, 2, 3, 4]);
  queue.dispose(); for (const release of releases) release(); await tick();
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0 });
});
test('native subset rejects unsafe flags, false preserves exact legacy shape', () => {
  for (const extra of [{ payloadMode: 'full' }, { includeToolInput: true }, { denyPermissionRequest: true }, { event: 'SessionEnd' }]) assert.throws(() => parseRule({ ...definition, ...extra }), /unsupported_async_hook/);
  const { async: _, ...legacy } = definition;
  assert.deepEqual(parseRule({ ...legacy, async: false }), parseRule(legacy));
});
test('Stop dispatch returns before executor and ignores async stdout control', async () => {
  let release, calls = 0;
  const manager = await managerFor(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  assert.equal((await manager.dispatchProtocol('Stop', metadata)).blocked, false);
  await tick(); assert.equal(calls, 1);
  release(completed); await tick();
  assert.equal(manager.snapshot().records[0].status, 'completed');
  manager.dispose();
});
test('missing host activity proof and empty session never execute', async () => {
  let calls = 0; const manager = await managerFor(async () => { calls++; return completed; });
  for (const meta of [{ sessionId: 's' }, { isSessionActive: () => true }, { ...metadata, sessionId: '' }, { ...metadata, isSessionActive: () => false }]) await manager.dispatch('Stop', meta);
  await tick(); assert.equal(calls, 0); manager.dispose();
});
test('queued old definitions never run after mutations; disposal cancels active signals', async () => {
  for (const mutate of [m => m.configure({ enabled: false }), m => m.remove('stop'), m => m.toggle('stop', false), m => m.upsert(definition)]) {
    const signals = [], releases = [];
    const manager = await managerFor((_a, _p, { signal }) => { signals.push(signal); return new Promise(resolve => releases.push(resolve)); });
    for (let i = 0; i < 5; i++) await manager.dispatch('Stop', metadata);
    await tick(); assert.equal(signals.length, 4);
    await mutate(manager); releases[0](completed); await tick();
    assert.equal(signals.length, 4);
    manager.cancelSession('s'); assert.ok(signals.slice(1).every(s => s.aborted));
    manager.dispose(); releases.slice(1).forEach(r => r(completed)); await tick();
  }
});
test('activity and fingerprint are rechecked after scheduling', async () => {
  let active = true, calls = 0, digest = 'fixture';
  const manager = await managerFor(async () => { calls++; return completed; }, async () => ({ digest, files: [] }));
  const dispatch = manager.dispatch('Stop', { sessionId: 's', isSessionActive: () => active }); active = false;
  await dispatch; await tick(); assert.equal(calls, 0);
  active = true; digest = 'changed'; await manager.dispatch('Stop', metadata); await tick();
  assert.equal(calls, 0); assert.equal(manager.snapshot().records[0].status, 'trust_error'); manager.dispose();
});
test('index binds exact Session and Agent, cancels on disposal and rejects late old Stop', async () => {
  const handlers = new Map(), session = { id: 's' }, agent = { id: 's' }; let current = agent;
  const seen = [], cancelled = [];
  const ctx = { on: (name, handler) => { handlers.set(name, handler); return () => {}; }, agents: { list: () => [agent], get: () => current }, sessions: { get: () => session }, workingDirectory: { get: () => process.cwd() } };
  const off = bindEvents(ctx, { dispatch: async (_event, meta) => { seen.push(meta); }, cancelSession: id => cancelled.push(id) });
  handlers.get('agent/status')({ agent, status: 'idle' }); assert.equal(seen[0].isSessionActive(), true);
  current = { id: 's' }; assert.equal(seen[0].isSessionActive(), false);
  handlers.get('agent/disposed')({ agent }); assert.deepEqual(cancelled, ['s']);
  handlers.get('agent/status')({ agent, status: 'idle' }); assert.equal(seen.at(-1).isSessionActive(), false); off();
});
