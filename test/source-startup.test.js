import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createHookManager } from '../core.js';
import { apply } from '../index.js';
import { startSourceChecks } from '../source-poller.js';
const document = command => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-startup-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = document('fixture-before');
  await writeFile(path.join(directory, 'hooks.json'), source);
  let stored;
  const manager = createHookManager({ persist: async value => { stored = structuredClone(value); } });
  await manager.registerSource({ id: 'watched', request: { kind: 'user', directory }, accepted: { 'hooks.json': createHash('sha256').update(source).digest('hex') }, options: { interpreter: { executable: process.execPath, argvPrefix: [] } } });
  manager.dispose();
  return { directory, initial: stored };
}

test('actual Host apply binds no event or RPC before startup source revocation commits; failure closes domain', async t => {
  const { directory, initial } = await fixture(t);
  await writeFile(path.join(directory, 'hooks.json'), document('fixture-after'));
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  let closed = 0, listeners = 0, rpc = 0, effects = 0;
  const ctx = {
    storageDomain: { async open() { return { global: { get: () => initial, set: async value => { entered.resolve(value); await gate.promise; } }, close: async () => { closed++; } }; } },
    on() { listeners++; return () => {}; }, typert: { register() { rpc++; } }, effect() { effects++; },
  };
  const mounting = apply(ctx);
  const pendingState = await entered.promise;
  assert.equal(pendingState.sourceRegistrations[0].status, 'review');
  assert.equal(listeners, 0); assert.equal(rpc, 0); assert.equal(effects, 0);
  const rejected = assert.rejects(mounting, /fixture_write_failure/);
  gate.reject(new Error('fixture_write_failure'));
  await rejected;
  assert.equal(closed, 1); assert.equal(listeners, 0); assert.equal(rpc, 0);
});

test('real selected files are rechecked at startup and subsequent completion-spaced polls without execution', async t => {
  const { directory, initial } = await fixture(t);
  let writes = 0, executed = 0, nextTimer;
  const manager = createHookManager({ initial, persist: async () => { writes++; }, execute: async () => { executed++; throw new Error('must_not_run'); } });
  t.after(() => manager.dispose());
  const stop = await startSourceChecks(manager, { setTimeout: callback => { nextTimer = callback; return { unref() {} }; }, clearTimeout: () => { nextTimer = undefined; } });
  assert.equal(writes, 0);
  await writeFile(path.join(directory, 'hooks.json'), document('fixture-after'));
  const check = nextTimer; nextTimer = undefined;
  await check();
  assert.equal(manager.snapshot().sourceRegistrations[0].status, 'review');
  assert.equal(manager.snapshot().rules[0].enabled, false);
  assert.equal(manager.snapshot().rules[0].trust, undefined);
  assert.equal(writes, 1); assert.equal(executed, 0);
  assert.equal(typeof nextTimer, 'function');
  stop(); assert.equal(nextTimer, undefined);
});

test('actual Host bind failure clears the scheduled poll, partial listeners and storage domain', async t => {
  const { initial } = await fixture(t);
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let handle, cleared = 0, removed = 0, closed = 0, listeners = 0;
  globalThis.setTimeout = callback => { handle = { callback, unref() {} }; return handle; };
  globalThis.clearTimeout = value => { assert.equal(value, handle); cleared++; };
  t.after(() => { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; });
  const ctx = {
    storageDomain: { async open() { return { global: { get: () => initial, set: async () => { throw new Error('unexpected_write'); } }, close: async () => { closed++; } }; } },
    on() { if (++listeners === 2) throw new Error('fixture_bind_failure'); return () => { removed++; }; },
  };
  await assert.rejects(apply(ctx), /fixture_bind_failure/);
  assert.equal(cleared, 1); assert.equal(removed, 1); assert.equal(closed, 1);
  await handle.callback();
  assert.equal(cleared, 1);
});

test('Host wiring disposes polling before manager and mounts listeners only after awaited source checks', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('stopChecks?.();') < source.indexOf('manager?.dispose();'));
  assert.ok(source.indexOf('stopChecks = await startSourceChecks(') < source.indexOf('off = bindEvents(ctx, manager)'));
  assert.ok(source.indexOf('off = bindEvents(ctx, manager)') < source.indexOf('release = mountRpc(ctx, manager'));
});
