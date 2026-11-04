import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHookManager, runCommand } from '../core.js';
import { bindEvents } from '../index.js';
import { mountRpc, descriptors } from '../rpc.js';
import { previewCodexImport } from '../codex-import.js';
const rule = (extra = {}) => ({ id: 'fixture', name: 'Fixture', event: 'PreToolUse', action: { type: 'command', executable: process.execPath }, ...extra });
async function trusted(extra = {}, execute = async () => ({ status: 'completed', exitCode: 0, stdout: '', stderr: '' })) {
  const m = createHookManager({ initial: { enabled: true, rules: [] }, persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }), execute });
  await m.upsert(rule(extra)); const p = await m.previewTrust('fixture'); await m.trust('fixture', p.digest); await m.toggle('fixture', true); return m;
}
test('signal termination and missing exit code fail closed before tools', async () => {
  for (const signal of ['SIGTERM', 'SIGSEGV', undefined]) {
    const spawnProcess = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = () => queueMicrotask(() => child.emit('close', null, signal)); return child; };
    const m = await trusted({}, (action, payload, options) => runCommand(action, payload, { ...options, spawnProcess }));
    assert.equal(await m.dispatch('PreToolUse'), true); assert.equal(m.snapshot().records[0].status, 'terminated'); m.dispose();
  }
});
test('strict import request validates closed bounded data without getters', () => {
  const parse = descriptors.find(d => d.method === 'previewImport').parameters[0].codec.create().parse;
  for (const value of [null, [], {}, { document: { hooks: {} }, extra: true }, { document: 'x'.repeat(262145) }, { get document() { assert.fail('getter invoked'); } }]) assert.throws(() => parse(value));
  assert.deepEqual(parse({ document: { hooks: {} }, options: {} }), { document: { hooks: {} }, options: {} });
});
test('legacy enabled rules never run before explicit review and trust', async () => {
  let calls = 0; const m = createHookManager({ initial: { enabled: true, rules: [rule({ enabled: true })] }, persist: async () => {}, execute: async () => { calls++; } });
  assert.equal(m.snapshot().rules[0].enabled, false); await assert.rejects(m.toggle('fixture', true), /hook_trust_required/); await m.dispatch('PreToolUse'); assert.equal(calls, 0); m.dispose();
});
test('full pre input failures fail closed without spawning; full output is redacted', async () => {
  let calls = 0; const m = await trusted({ payloadMode: 'full' }, async (_action, payload) => { calls++; assert.equal(Object.hasOwn(payload, 'prompt'), false); return { status: 'completed', exitCode: 0, stdout: 'secret', stderr: 'secret' }; });
  const cycle = {}; cycle.self = cycle;
  assert.equal(await m.dispatch('PreToolUse', { readPayload: () => ({ tool_input: cycle }) }), true); assert.equal(calls, 0);
  assert.equal(await m.dispatch('PreToolUse', { readPayload: () => ({ tool_input: { x: 'a'.repeat(60000) }, tool_response: { x: 'b'.repeat(60000) } }) }), true); assert.equal(calls, 0);
  assert.equal(await m.dispatch('PreToolUse', { readPayload: () => ({ prompt: 'never-share', tool_input: { safe: true } }) }), false); assert.equal(calls, 1); assert.equal(JSON.stringify(m.snapshot().records).includes('secret'), false); m.dispose();
});
test('post hook is awaited and returns feedback without claiming effects undone', async () => {
  const m = await trusted({ event: 'PostToolUse' }, async () => ({ status: 'completed', exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: 'Review this result; effects remain.' }), stderr: '' }));
  const handlers = new Map(); const off = bindEvents({ on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); } }, m);
  const outcome = await handlers.get('tools/post-execute')({ name: 'fixture' }, { isError: false, value: 1 }, () => assert.fail('next called'));
  assert.equal(outcome.kind, 'block'); assert.match(outcome.feedback[0].text, /effects remain/); off(); m.dispose();
});
test('model wrapper observes finish and early close without changing chunks or request', async () => {
  const handlers = new Map(), calls = []; const off = bindEvents({ on: (name, fn) => { handlers.set(name, fn); return () => {}; } }, { dispatch: async (event, meta) => { calls.push([event, meta.status]); } });
  const options = Object.freeze({ sessionId: 's', provider: 'p', model: 'm' }); const chunk = { type: 'finish', reason: { kind: 'stop' } };
  const stream = handlers.get('llm/stream')(options, async function* () { yield chunk; }); assert.equal((await stream.next()).value, chunk); await stream.next(); assert.deepEqual(calls, [['PreModelRequest', undefined], ['PostModelRequest', 'stop']]);
  calls.length = 0; const early = handlers.get('llm/stream')(options, async function* () { yield { type: 'text-delta' }; }); await early.next(); await early.return(); assert.equal(calls[1][1], 'closed'); off();
});
test('model observers never delay streaming or replace original failures', async () => {
  let wrapper; const original = new Error('original'); const off = bindEvents({ on: (name, fn) => { if (name === 'llm/stream') wrapper = fn; return () => {}; } }, { dispatch: () => new Promise(() => {}) });
  const stream = wrapper({ sessionId: 's' }, async function* () { yield { type: 'text-delta' }; throw original; });
  assert.equal((await stream.next()).value.type, 'text-delta'); await assert.rejects(stream.next(), error => error === original); off();
});
test('trust preview must match commit and changed bytes block every dispatch', async () => {
  let bytes = 'first', calls = 0; const m = createHookManager({ initial: { enabled: true, rules: [] }, persist: async () => {}, fingerprint: async () => ({ digest: bytes, files: [] }), execute: async () => { calls++; return { status: 'completed', exitCode: 0 }; } });
  await m.upsert(rule()); const stale = await m.previewTrust('fixture'); bytes = 'second'; await assert.rejects(m.trust('fixture', stale.digest), /hook_trust_changed/);
  const p = await m.previewTrust('fixture'); await m.trust('fixture', p.digest); await m.toggle('fixture', true); await m.dispatch('PreToolUse'); assert.equal(calls, 1); bytes = 'third'; assert.equal(await m.dispatch('PreToolUse'), true); assert.equal(calls, 1); assert.equal(m.snapshot().records[0].status, 'trust_error'); m.dispose();
});
test('import preview is pure and mixed unsupported RPC import commits nothing', () => {
  const document = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo fixture', timeout: 1 }, { type: 'prompt', prompt: 'unsupported' }] }] } };
  const options = { interpreter: { executable: process.execPath, argvPrefix: ['-e'] } }; const preview = previewCodexImport(document, options); assert.equal(preview.rules.length, 1); assert.equal(preview.unsupported.length, 1); assert.equal(preview.rules[0].enabled, false);
  let imports = 0, rpc; const peer = { principal: { kind: 'owner' } }; const ctx = { invocation: { peer }, connection: { browserPeer: peer }, typert: { register: () => () => {} } }; class Remote { constructor(context) { this.ctx = context; rpc = this; } }
  mountRpc(ctx, { importRules: () => { imports++; } }, Remote); assert.throws(() => rpc.importCodex({ document, options }), /hook_import_contains_unsupported/); assert.equal(imports, 0);
});
