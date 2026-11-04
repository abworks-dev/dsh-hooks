import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager } from '../core.js';

test('Post usage payload does not extend rule trust, records or persisted state', async () => {
  const writes = [], payloads = [];
  const manager = createHookManager({
    persist: async state => writes.push(structuredClone(state)),
    fingerprint: async () => ({ digest: 'fixture', files: [] }),
    execute: async (_action, payload) => {
      payloads.push(payload);
      return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
    },
  });
  try {
    await manager.upsert({ id: 'usage', name: 'usage', event: 'PostModelRequest', action: { type: 'command', executable: process.execPath } });
    await manager.trust('usage', (await manager.previewTrust('usage')).digest);
    await manager.toggle('usage', true);
    await manager.configure({ enabled: true });
    const before = manager.snapshot().rules;
    const writeCount = writes.length;
    await manager.dispatch('PostModelRequest', {
      sessionId: 'usage-session', status: 'stop',
      tokenUsage: { inputTokens: 101, outputTokens: 202, totalTokens: 303 },
    });
    assert.equal(payloads.length, 1);
    assert.deepEqual(payloads[0].token_usage, { inputTokens: 101, outputTokens: 202, totalTokens: 303 });
    assert.equal(payloads[0].status, 'stop');
    assert.deepEqual(manager.snapshot().rules, before);
    assert.equal(writes.length, writeCount);
    const records = manager.snapshot().records;
    assert.equal(records.length, 1);
    for (const record of records) {
      assert.equal(Object.hasOwn(record, 'token_usage'), false);
      assert.equal(Object.hasOwn(record, 'tokenUsage'), false);
      assert.equal(Object.hasOwn(record, 'payload'), false);
    }
    for (const state of writes) {
      assert.equal(JSON.stringify(state).includes('inputTokens'), false);
      assert.equal(JSON.stringify(state).includes('token_usage'), false);
    }
  } finally { manager.dispose(); }
});
