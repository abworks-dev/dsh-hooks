import test from 'node:test';
import assert from 'node:assert/strict';
import { bindEvents } from '../index.js';
test('obsolete host Agent cannot borrow a replacement Session with reused ID; disposal retains exact captured Session', async () => {
  const old = { id: 'same' }, replacement = { id: 'same' };
  const originalSession = { id: 'same' }, newSession = { id: 'same' };
  let liveAgent = old, liveSession = originalSession;
  const listeners = new Map(), selected = [];
  const ctx = { agents: { list: () => [old], get: () => liveAgent }, sessions: { get: () => liveSession }, workingDirectory: { get: session => session === originalSession ? '/original-effective' : '/replacement' }, on(name, fn) { listeners.set(name, fn); return () => {}; } };
  const m = { async dispatch(_event, metadata) { selected.push(metadata.getEffectiveDirectory?.()); }, async dispatchDecision(_event, metadata) { selected.push(metadata.getEffectiveDirectory?.()); return { blocked: false }; } };
  const off = bindEvents(ctx, m);
  try {
    liveAgent = undefined;
    listeners.get('agent/disposed')({ agent: old });
    liveAgent = replacement; liveSession = newSession;
    await listeners.get('tools/pre-execute')({ agent: old }, async () => ({}));
    listeners.get('agent/created')({ agent: old });
    listeners.get('agent/created')({ agent: replacement });
    assert.deepEqual(selected, ['/original-effective', undefined, undefined, '/replacement']);
  } finally { off(); }
});
