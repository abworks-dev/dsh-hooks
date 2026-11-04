import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager } from '../core.js';

test('trust preview returns the exact current definition bound to its digest, not a caller snapshot', async () => {
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }) });
  const old = { id: 'review', name: 'Review', event: 'PreToolUse', payloadMode: 'metadata', action: { type: 'command', executable: process.execPath } };
  try {
    await manager.upsert(old);
    const first = await manager.previewTrust(old.id);
    await manager.upsert({ ...old, payloadMode: 'full', includeToolInput: true });
    const current = await manager.previewTrust(old.id);
    assert.equal(first.rule.payloadMode, 'metadata');
    assert.equal(current.rule.payloadMode, 'full');
    assert.equal(current.rule.includeToolInput, true);
    assert.notEqual(first.digest, current.digest);
    assert.equal(current.rule.trust, undefined);
    assert.equal(current.rule.enabled, undefined);
    current.rule.payloadMode = 'metadata';
    assert.equal(manager.snapshot().rules[0].payloadMode, 'full');
    await assert.rejects(manager.trust(old.id, first.digest), /hook_trust_changed/);
    await manager.trust(old.id, current.digest);
    assert.equal(manager.snapshot().rules[0].enabled, false);
  } finally { manager.dispose(); }
});
