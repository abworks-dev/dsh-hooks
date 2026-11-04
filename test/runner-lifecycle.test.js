import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runCommand, createHookManager } from '../core.js';

const action = { executable: process.execPath, argv: [], timeoutMs: 100, maxOutputBytes: 256 };
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdin.end = () => {};
  child.kills = 0; child.kill = () => { child.kills++; return false; };
  return child;
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('runner did not settle promptly')), 2000); })]); }
  finally { clearTimeout(timer); }
}

test('timeout settles before close, retains child, and ignores late output', async () => {
  const child = fakeChild(), children = new Set();
  const result = await bounded(runCommand(action, {}, { children, spawnProcess: () => child }));
  assert.equal(result.status, 'timeout'); assert.equal(child.kills, 1); assert.equal(children.size, 1);
  child.stdout.emit('data', Buffer.alloc(1000));
  assert.equal(child.kills, 1); assert.equal(result.stdout, '');
  child.emit('close', null, 'SIGKILL'); assert.equal(children.size, 0);
});

test('abort and runtime error settle without treating kill/error as close', async () => {
  for (const kind of ['abort', 'error']) {
    const child = fakeChild(), children = new Set(), controller = new AbortController();
    const pending = runCommand(action, {}, { children, signal: controller.signal, spawnProcess: () => child });
    if (kind === 'abort') controller.abort(); else child.emit('error', new Error('runtime kill failure'));
    const result = await bounded(pending);
    assert.equal(result.status, kind === 'abort' ? 'cancelled' : 'spawn_error');
    assert.equal(children.size, 1);
    child.emit('close', null, 'SIGKILL'); assert.equal(children.size, 0);
  }
});

test('normal close, termination, spawn throw, and pre-abort semantics', async () => {
  for (const [code, signal, status] of [[0, null, 'completed'], [2, null, 'completed'], [null, 'SIGTERM', 'terminated']]) {
    const child = fakeChild(), children = new Set();
    const pending = runCommand(action, {}, { children, spawnProcess: () => child });
    child.stdout.emit('data', Buffer.from('ok')); child.emit('close', code, signal);
    assert.deepEqual(await pending, { status, exitCode: code, stdout: 'ok', stderr: '' });
    assert.equal(children.size, 0);
  }
  const children = new Set();
  assert.equal((await runCommand(action, {}, { children, spawnProcess: () => { throw new Error('spawn'); } })).status, 'spawn_error');
  assert.equal(children.size, 0);
  assert.equal((await runCommand(action, {}, { signal: AbortSignal.abort(), spawnProcess: () => assert.fail('must not spawn') })).status, 'cancelled');
});

test('spawn error and setup failure retain close cleanup; failed kill cannot release capacity', async () => {
  for (const setupFailure of [false, true]) {
    const child = fakeChild(), children = new Set();
    if (setupFailure) { child.stdout = null; child.kill = () => { child.kills++; throw new Error('kill failed'); }; }
    const pending = runCommand(action, {}, { children, spawnProcess: () => child });
    if (!setupFailure) child.emit('error', new Error('spawn failed'));
    assert.equal((await bounded(pending)).status, 'spawn_error');
    assert.equal(children.size, 1);
    if (setupFailure) assert.equal(child.kills, 1);
    child.emit('close', -1, null); assert.equal(children.size, 0);
  }
});

test('shared runner capacity rejects a fifth live child until close', async () => {
  const children = new Set(), spawned = [];
  const launch = () => runCommand(action, {}, { children, spawnProcess: () => { const child = fakeChild(); spawned.push(child); return child; } });
  const pending = Array.from({ length: 4 }, launch);
  assert.equal((await launch()).status, 'busy');
  await bounded(Promise.all(pending));
  assert.equal((await launch()).status, 'busy'); assert.equal(spawned.length, 4);
  spawned[0].emit('close', null, 'SIGKILL');
  const next = launch(); assert.equal(spawned.length, 5); assert.equal(children.size, 4);
  spawned[4].emit('close', 0, null); await next;
  for (const child of spawned.slice(1, 4)) child.emit('close', null, 'SIGKILL');
});

async function managerFixture(execute) {
  const manager = createHookManager({ persist: async () => {}, execute, fingerprint: async () => ({ digest: 'fake', files: [] }) });
  await manager.upsert({ id: 'life', name: 'Lifecycle', event: 'PreToolUse', scope: { kind: 'user' }, action: { type: 'command', ...action } });
  await manager.trust('life', (await manager.previewTrust('life')).digest);
  await manager.toggle('life', true); await manager.configure({ enabled: true });
  return manager;
}

test('repeated dispatch stays at four live direct children; close restores capacity; dispose kills retained children', async () => {
  const spawned = []; let tracked;
  const manager = await managerFixture((a, payload, options) => {
    tracked = options.children;
    return runCommand(a, payload, { ...options, spawnProcess: () => { const child = fakeChild(); spawned.push(child); return child; } });
  });
  for (let i = 0; i < 4; i++) assert.equal(await bounded(manager.dispatch('PreToolUse')), true);
  for (let i = 0; i < 8; i++) assert.equal(await manager.dispatch('PreToolUse'), true);
  assert.equal(spawned.length, 4); assert.equal(manager.snapshot().records[0].status, 'busy');
  spawned[0].emit('close', null, 'SIGKILL');
  assert.equal(await bounded(manager.dispatch('PreToolUse')), true); assert.equal(spawned.length, 5);
  manager.dispose(); assert.equal(tracked.size, 4);
  assert.equal(spawned[0].kills, 1);
  for (const child of spawned.slice(1)) { assert.equal(child.kills, 2); child.emit('close', null, 'SIGKILL'); }
  assert.equal(tracked.size, 0);
});

test('dispose aborts active result promptly but retains child for repeated kill attempts until close', async () => {
  const child = fakeChild(); let tracked;
  const manager = await managerFixture((a, payload, options) => {
    tracked = options.children;
    return runCommand(a, payload, { ...options, spawnProcess: () => child });
  });
  const pending = manager.dispatch('PreToolUse');
  await new Promise(resolve => setImmediate(resolve));
  manager.dispose(); assert.equal(await bounded(pending), true);
  assert.equal(manager.snapshot().records[0].status, 'cancelled');
  assert.equal(tracked.size, 1); assert.equal(child.kills, 2);
  manager.dispose(); assert.equal(child.kills, 3);
  child.emit('close', null, 'SIGKILL'); assert.equal(tracked.size, 0);
});

test('manager reserves at most four in-flight jobs even before children exist', async () => {
  const releases = []; let entered = 0;
  const manager = await managerFixture(() => { entered++; return new Promise(resolve => releases.push(() => resolve({ status: 'completed', exitCode: 0, stdout: '', stderr: '' }))); });
  const pending = Array.from({ length: 4 }, () => manager.dispatch('PreToolUse'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 4); assert.equal(await manager.dispatch('PreToolUse'), true); assert.equal(entered, 4);
  releases.forEach(release => release()); await Promise.all(pending); manager.dispose();
});
