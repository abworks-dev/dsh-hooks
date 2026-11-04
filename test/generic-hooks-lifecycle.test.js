import test from 'node:test';
import assert from 'node:assert/strict';
import { bindEvents } from '../index.js';
import { createHookManager, EVENTS, parseHookOutput } from '../core.js';

const forbidden = () => { throw Error('private_read'); };
function fixture(manager) {
  const listeners = new Map();
  const off = bindEvents({ on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); } }, manager);
  return { listeners, off };
}
const event = (seq, reason) => ({ type: 'turn/end', seq, data: { turn: 3, reason, get message() { return forbidden(); }, get arguments() { return forbidden(); } } });
const session = () => ({ id: 'session', get snapshotEvents() { return forbidden(); }, get ownEvents() { return forbidden(); }, get deriveMessages() { return forbidden(); }, get header() { return forbidden(); } });

test('Interrupt observes only live user-aborted turn ends, deduplicates per Session, and unregisters', () => {
  const calls = [];
  const { listeners, off } = fixture({ dispatch: async (...args) => { calls.push(args); return true; } });
  const observe = listeners.get('session/event'), s = session();
  for (const kind of ['parent', 'hook', 'disposed', 'legacy']) observe(s, event(1, { kind: 'aborted', reason: { kind, get reason() { return forbidden(); } } }));
  for (const kind of ['interrupted', 'completed', 'blocked', 'error', 'max-tokens', 'forked']) observe(s, event(2, { kind }));
  observe(s, { type: 'assistant/message', get data() { return forbidden(); } });
  assert.equal(calls.length, 0);
  const user = event(3, { kind: 'aborted', reason: { kind: 'user', get reason() { return forbidden(); } } });
  assert.equal(observe(s, user), undefined);
  observe(s, user);
  observe(s, event(2, { kind: 'aborted', reason: { kind: 'user' } }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['Interrupt', { sessionId: 'session', reason: 'user' }, undefined]);
  observe(session(), user); // A different live Session object may reuse a sequence.
  assert.equal(calls.length, 2);
  off(); off(); assert.equal(listeners.size, 0);
});

test('SessionStart forwards exact source/signal without reading private payload; SessionEnd invents no reason', () => {
  const calls = [], signal = new AbortController().signal;
  const { listeners, off } = fixture({ dispatch: async (...args) => { calls.push(args); } });
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    assert.equal(listeners.get('agent/created')({ agent: { id: 's' }, source, signal, get arguments() { return forbidden(); }, get name() { return forbidden(); }, get message() { return forbidden(); } }), undefined);
    assert.deepEqual(calls.at(-1), ['SessionStart', { sessionId: 's', source }, signal]);
  }
  listeners.get('agent/disposed')({ agent: { id: 's' }, get reason() { return forbidden(); }, get arguments() { return forbidden(); } });
  assert.deepEqual(calls.at(-1), ['SessionEnd', { sessionId: 's' }, undefined]);
  off();
});

test('source regex sees lifecycle source and full mode remains metadata-only; Interrupt output cannot veto', async () => {
  const payloads = [], pending = [];
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }), execute: async (_action, payload) => { payloads.push(payload); return { status: 'completed', exitCode: 2, stdout: '' }; } });
  for (const [id, eventName, matcher] of [['start', 'SessionStart', '^resume$'], ['interrupt', 'Interrupt', '*']]) {
    await manager.upsert({ id, name: id, event: eventName, matcherMode: 'regex', matcher, payloadMode: 'full', action: { type: 'command', executable: process.execPath } });
    await manager.trust(id, (await manager.previewTrust(id)).digest); await manager.toggle(id, true);
  }
  await manager.configure({ enabled: true });
  const { listeners, off } = fixture({ dispatch(...args) { const promise = manager.dispatch(...args); pending.push(promise); return promise; } });
  listeners.get('agent/created')({ agent: { id: 's' }, source: 'startup', get arguments() { return forbidden(); } });
  listeners.get('agent/created')({ agent: { id: 's' }, source: 'resume', get arguments() { return forbidden(); } });
  listeners.get('session/event')(session(), event(4, { kind: 'aborted', reason: { kind: 'user' } }));
  assert.deepEqual(await Promise.all(pending), [false, false, false]);
  assert.equal(payloads.length, 2);
  assert.equal(payloads.find(p => p.hook_event_name === 'SessionStart').session_source, 'resume');
  const interrupt = payloads.find(p => p.hook_event_name === 'Interrupt');
  assert.equal(interrupt.reason, 'user');
  assert.equal(Object.hasOwn(interrupt, 'tool_input'), false);
  assert.equal(Object.hasOwn(interrupt, 'tool_response'), false);
  assert.equal(manager.snapshot().events.length, 12);
  assert.equal(EVENTS.find(e => e.name === 'Interrupt').blocking, false);
  assert.throws(() => parseHookOutput('Interrupt', { status: 'completed', exitCode: 0, stdout: '{"continue":false}' }), /unsupported_hook_output/);
  off(); manager.dispose();
});
