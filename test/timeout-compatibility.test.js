import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseRule, createHookManager } from '../core.js';
import { fingerprintAction } from '../trust.js';
import { previewCodexImport } from '../codex-import.js';

const rule = timeoutMs => ({ id: 'timeout', name: 'Timeout', event: 'PreToolUse', action: { type: 'command', executable: process.execPath, timeoutMs } });

test('native bounds increase to 600 seconds without changing existing omitted defaults or output limits', () => {
  assert.equal(parseRule(rule()).action.timeoutMs, 5000);
  for (const timeoutMs of [100, 30000, 30001, 600000]) assert.equal(parseRule(rule(timeoutMs)).action.timeoutMs, timeoutMs);
  for (const timeoutMs of [99, 600001, Infinity, 30000.5, '600000']) assert.throws(() => parseRule(rule(timeoutMs)));
  assert.throws(() => parseRule({ ...rule(600000), action: { ...rule(600000).action, maxOutputBytes: 65537 } }));
  assert.throws(() => parseRule({ ...rule(600000), action: { ...rule(600000).action, async: true } }));
});

test('file trust accepts the new bound, binds the timeout, and retains the prior default digest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hooks-timeout-'));
  try {
    const executable = path.join(directory, 'fixture');
    await writeFile(executable, 'not executed');
    const action = { type: 'command', executable, argv: [] };
    const original = await fingerprintAction(action);
    assert.equal((await fingerprintAction({ ...action, timeoutMs: 5000 })).digest, original.digest);
    const longer = await fingerprintAction({ ...action, timeoutMs: 600000 });
    assert.notEqual(longer.digest, original.digest);
    await assert.rejects(fingerprintAction({ ...action, timeoutMs: 600001 }), /invalid_hook_trust_timeoutMs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('default Codex import travels through review and dispatch with its exact timeout; no automatic execution', async () => {
  const document = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'fixture only' }] }] } };
  const preview = previewCodexImport(document, { interpreter: { executable: process.execPath, argvPrefix: ['-e'] } });
  assert.equal(preview.unsupported.length, 0);
  const actions = [];
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }), execute: async action => { actions.push(action); return { status: 'completed', exitCode: 0, stdout: '', stderr: '' }; } });
  try {
    await manager.importRules(preview.rules);
    const id = preview.rules[0].id;
    assert.equal(manager.snapshot().rules[0].enabled, false);
    assert.equal(actions.length, 0);
    const review = await manager.previewTrust(id);
    assert.equal(review.rule.action.timeoutMs, 600000);
    await manager.trust(id, review.digest);
    assert.equal(manager.snapshot().rules[0].enabled, false);
    await manager.toggle(id, true);
    await manager.configure({ enabled: true });
    assert.equal(actions.length, 0);
    await manager.dispatch('PreToolUse', { sessionId: 'fixture', toolName: 'fixture' });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].timeoutMs, 600000);
    await manager.upsert({ ...manager.snapshot().rules[0], action: { ...actions[0], timeoutMs: 30000 } });
    assert.equal(manager.snapshot().rules[0].enabled, false);
    assert.equal(manager.snapshot().rules[0].trust, undefined);
  } finally { manager.dispose(); }
});
