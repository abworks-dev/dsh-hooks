import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHookManager } from '../core.js';
test('cwd alias cannot retarget a historical event during a user hook', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dsh-alias-'));
  const a = path.join(base, 'a'), b = path.join(base, 'b'), alias = path.join(base, 'alias');
  await mkdir(a); await mkdir(b); await symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const calls = []; let hashes = 0;
  const m = createHookManager({ persist: async () => {}, fingerprint: async () => { hashes++; return { digest: 'fixture', files: [] }; }, execute: async action => { calls.push(action.argv[0]); if (action.argv[0] === 'user') { await rm(alias); await symlink(b, alias, process.platform === 'win32' ? 'junction' : 'dir'); } return { status: 'completed', exitCode: 0, stdout: '', stderr: '' }; } });
  try {
    for (const [id, scope] of [['project', { kind: 'project', root: b }], ['user', { kind: 'user' }]]) {
      await m.upsert({ id, name: id, event: 'PreToolUse', scope, action: { type: 'command', executable: process.execPath, argv: [id] } });
      const p = await m.previewTrust(id); await m.trust(id, p.digest); await m.toggle(id, true);
    }
    await m.configure({ enabled: true }); hashes = 0;
    await m.dispatch('PreToolUse', { getEffectiveDirectory: () => alias });
    assert.deepEqual(calls, ['user']); assert.equal(hashes, 1);
  } finally { m.dispose(); await rm(base, { recursive: true, force: true }); }
});
