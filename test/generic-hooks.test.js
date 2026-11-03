import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHookManager, parseRule, matches, runCommand, EVENTS } from '../core.js';
import { bindEvents } from '../index.js';
import { mountRpc, descriptors } from '../rpc.js';
const rule = (extra = {}) => ({ id: 'test', name: 'Test', event: 'PreToolUse', action: { type: 'command', executable: process.execPath, argv: [] }, ...extra });
const manager = (options = {}) => createHookManager({ persist: async () => {}, ...options });

test('rules validate absolute native executables, bounded argv, safe globs and disabled default', () => {
  assert.equal(parseRule(rule()).enabled, false);
  for (const executable of ['node', 'relative.exe', process.platform === 'win32' ? 'C:\\test.cmd' : '/test.cmd']) assert.throws(() => parseRule(rule({ action: { type: 'command', executable } })));
  assert.throws(() => parseRule(rule({ matcher: '(a+)+$' })));
  assert.throws(() => parseRule(rule({ action: { type: 'command', executable: process.execPath, timeoutMs: 99999 } })));
  assert.throws(() => parseRule(rule({ enabled: 'yes' })));
  assert.equal(matches('ops_*', 'ops_bash'), true);
  assert.equal(matches('ops_?', 'ops_bash'), false);
  assert.equal(matches('*', ''), true);
  assert.equal(matches('*a'.repeat(60), 'a'.repeat(256)), true);
});

test('CRUD persists atomically, defaults off, serializes updates and rolls back write failures', async () => {
  const writes = [];
  const m = manager({ persist: async s => { writes.push(structuredClone(s)); if (s.enabled) throw Error('disk'); } });
  await m.upsert(rule());
  assert.equal(m.snapshot().enabled, false);
  await Promise.all([m.toggle('test', true), m.upsert(rule({ id: 'two' }))]);
  assert.equal(m.snapshot().rules.length, 2);
  await m.upsert(rule({ enabled: true, name: 'Edited' }));
  assert.equal(m.snapshot().rules.find(r => r.id === 'test').enabled, false);
  await assert.rejects(m.configure({ enabled: true }), /disk/);
  assert.equal(m.snapshot().enabled, false);
  await m.remove('test');
  assert.equal(m.snapshot().rules.length, 1);
  assert.equal(writes.length, 6);
  m.dispose(); await assert.rejects(m.upsert(rule()), /disposed/);
});

test('dispatch uses metadata only; only PreToolUse exit 2 blocks; records bounded', async () => {
  const payloads = [];
  const m = manager({ maxRecords: 2, execute: async (_a, payload) => { payloads.push(payload); return { status: 'completed', exitCode: 2, stdout: '', stderr: '' }; } });
  await m.upsert(rule({ enabled: true }));
  assert.equal(m.snapshot().rules[0].enabled, false);
  await m.toggle('test', true);
  assert.equal(await m.dispatch('PreToolUse', { toolName: 'x' }), false);
  await m.configure({ enabled: true });
  assert.equal(await m.dispatch('PreToolUse', { sessionId: 's', toolName: 'x', arguments: { password: 'secret' }, body: 'private' }), true);
  assert.equal(JSON.stringify(payloads).includes('secret'), false);
  assert.deepEqual(Object.keys(payloads[0]).sort(), ['hook_event_name', 'payload_version', 'session_id', 'source', 'timestamp', 'tool_name']);
  await m.upsert(rule({ id: 'post', event: 'PostToolUse', enabled: true }));
  await m.toggle('post', true);
  assert.equal(await m.dispatch('PostToolUse'), false);
  await m.dispatch('PreToolUse');
  assert.equal(m.snapshot().records.length, 2);
  m.clearRecords(); assert.equal(m.snapshot().records.length, 0);
  m.dispose();
});

function fakeSpawn({ code = 0, output, hang = false } = {}) {
  const calls = [];
  const spawnProcess = (...args) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
    c.stdin.end = input => { calls.push({ args, input, child: c }); queueMicrotask(() => { if (output) c.stdout.emit('data', Buffer.from(output)); if (!hang) c.emit('close', code); }); };
    c.kill = () => { c.killed = true; return true; };
    return c;
  };
  return { spawnProcess, calls };
}

test('command runner never shells, sanitizes env, sends JSON stdin and captures exit 2', async () => {
  const f = fakeSpawn({ code: 2, output: 'ok' }), action = parseRule(rule()).action;
  const result = await runCommand(action, { event: 'x' }, f);
  assert.equal(result.exitCode, 2); assert.equal(result.stdout, 'ok');
  assert.equal(f.calls[0].args[2].shell, false);
  assert.deepEqual(f.calls[0].args[2].env, {});
  assert.deepEqual(JSON.parse(f.calls[0].input), { event: 'x' });
});

test('fixed internal Node fixture receives valid JSON stdin without shell', async () => {
  const action = parseRule(rule({ action: { type: 'command', executable: process.execPath,
    argv: ['-e', 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify(JSON.parse(s)));process.exitCode=2})'] } })).action;
  const result = await runCommand(action, { fixture: 'safe', number: 42 });
  assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.stdout), { fixture: 'safe', number: 42 });
  assert.throws(() => parseRule(rule({ action: { type: 'command', executable: process.execPath + '\0' } })));
});

test('command limits output, observes cancellation, and cleans children without executing real commands', async () => {
  const action = parseRule(rule()).action, children = new Set();
  const f = fakeSpawn({ output: 'x'.repeat(5000), hang: true });
  const limited = await runCommand(action, {}, { ...f, children });
  assert.equal(limited.status, 'output_limit'); assert.equal(Buffer.byteLength(limited.stdout), 4096);
  assert.equal(f.calls[0].child.killed, true); assert.equal(children.size, 0);
  const abort = new AbortController(), hanging = fakeSpawn({ hang: true });
  const pending = runCommand(action, {}, { ...hanging, signal: abort.signal, children }); abort.abort();
  assert.equal((await pending).status, 'cancelled'); assert.equal(children.size, 0);
  const pre = fakeSpawn(); await runCommand(action, {}, { ...pre, signal: abort.signal }); assert.equal(pre.calls.length, 0);
});

test('timeouts and unload abort active work; pre-tool execution failures fail closed', async () => {
  const f = fakeSpawn({ hang: true });
  const keeper = setTimeout(() => {}, 1000);
  try {
    const timed = await runCommand({ ...parseRule(rule()).action, timeoutMs: 10 }, {}, f);
    assert.equal(timed.status, 'timeout'); assert.equal(f.calls[0].child.killed, true);
  } finally { clearTimeout(keeper); }
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const m = manager({ initial: { enabled: true, rules: [rule({ enabled: true })] }, execute: async (_a, _p, { signal }) => {
    started(); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'cancelled', exitCode: null }), { once: true }));
  } });
  const pending = m.dispatch('PreToolUse'); await startedPromise; m.dispose();
  assert.equal(await pending, true);
  const failing = manager({ initial: { enabled: true, rules: [rule({ enabled: true })] }, execute: async () => { throw Error('fixture'); } });
  assert.equal(await failing.dispatch('PreToolUse'), true); failing.dispose();
});

test('event binding preserves approval chain and actually gates before tool next', async () => {
  const listeners = new Map(), calls = [];
  const ctx = { on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); } };
  let deny = true;
  const off = bindEvents(ctx, { dispatch: async (event, metadata) => { calls.push({ event, metadata }); return deny; } });
  const signal = new AbortController().signal;
  assert.equal((await listeners.get('tools/pre-execute')({ name: 'tool', agent: { id: 's' }, arguments: { private: 1 }, signal }, () => { throw Error('must_not_dispatch'); })).kind, 'deny');
  deny = false;
  assert.deepEqual(await listeners.get('tools/pre-execute')({ name: 'tool', signal }, async () => ({ kind: 'ask' })), { kind: 'ask' });
  assert.equal(await listeners.get('approval/request')({ toolName: 'tool', agent: { id: 's' } }, async () => 'rejected'), 'rejected');
  assert.deepEqual(calls[0].metadata, { sessionId: 's', toolName: 'tool' });
  assert.equal(EVENTS.filter(e => e.blocking).length, 1);
  off(); assert.equal(listeners.size, 0);
});

test('every RPC requires the exact browser owner peer, including read/output access', async () => {
  const peer = { principal: { kind: 'owner' } }, services = {};
  const ctx = { connection: { browserPeer: peer }, invocation: { peer }, typert: { register: c => { assert.equal(c.invocations.length, 6); return async () => {}; } } };
  class Remote { constructor(ctx, key) { this.ctx = ctx; services[key] = this; } }
  const m = manager(); const release = mountRpc(ctx, m, Remote), rpc = services.genericHooks;
  assert.equal(rpc.snapshot().enabled, false);
  for (const deniedPeer of [undefined, { principal: { kind: 'owner' } }, { principal: { kind: 'remote' } }]) {
    ctx.invocation.peer = deniedPeer;
    for (const d of descriptors) assert.throws(() => rpc[d.method](), /local_owner_client_required/);
  }
  ctx.invocation.peer = peer; await rpc.upsert(rule()); assert.equal(rpc.snapshot().rules.length, 1);
  await release(); m.dispose();
});
