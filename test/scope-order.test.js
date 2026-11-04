import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHookManager } from '../core.js';
const definition = (id, scope) => ({ id, name: id, event: 'PreToolUse', scope, action: { type: 'command', executable: process.execPath, argv: [id] } });
test('user rules precede projects and event directory is read once before asynchronous execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-order-'));
  let cwd = root, reads = 0; const order = [];
  const m = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }), execute: async action => { order.push(action.argv[0]); cwd = path.dirname(root); return { status: 'completed', exitCode: 0, stdout: '', stderr: '' }; } });
  try {
    for (const rule of [definition('project', { kind: 'project', root }), definition('user')]) { await m.upsert(rule); const p = await m.previewTrust(rule.id); await m.trust(rule.id, p.digest); await m.toggle(rule.id, true); }
    await m.configure({ enabled: true });
    await m.dispatch('PreToolUse', { getEffectiveDirectory() { reads++; return cwd; } });
    assert.deepEqual(order, ['user', 'project']); assert.equal(reads, 1);
    await m.upsert(definition('project', { kind: 'user' }));
    const changed = m.snapshot().rules.find(rule => rule.id === 'project');
    assert.equal(changed.enabled, false); assert.equal(changed.trust, undefined);
  } finally { m.dispose(); await rm(root, { recursive: true, force: true }); }
});
