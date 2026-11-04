import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHookManager } from '../core.js';

test('unchanged source checks preserve already queued asynchronous definition identities', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-source-queue-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = await realpath(temporary);
  const document = JSON.stringify({ hooks: { Stop: [{ hooks: Array.from({ length: 5 }, (_, i) => ({ type: 'command', command: `fixture-only-${i}`, async: true })) }] } });
  const sha256 = createHash('sha256').update(document).digest('hex');
  let writes = 0, four, fifth;
  const firstFour = new Promise(resolve => { four = resolve; });
  const lastStarted = new Promise(resolve => { fifth = resolve; });
  const releases = [];
  const manager = createHookManager({
    persist: async () => { writes++; },
    fingerprint: async () => ({ digest: 'fixture', files: [] }),
    sourceReader: async () => ({ directory, kind: 'user', sources: [{ format: 'json', status: 'available', sha256, document }] }),
    execute: () => new Promise(resolve => {
      releases.push(() => resolve({ status: 'completed', exitCode: 0, stdout: '', stderr: '' }));
      if (releases.length === 4) four();
      if (releases.length === 5) fifth();
    }),
  });
  t.after(() => { for (const release of releases) release(); manager.dispose(); });
  await manager.registerSource({ id: 'watch', request: { kind: 'user', directory }, accepted: { 'hooks.json': sha256 }, options: { interpreter: { executable: process.execPath, argvPrefix: [] } } });
  for (const rule of manager.snapshot().rules) {
    const review = await manager.previewTrust(rule.id);
    await manager.trust(rule.id, review.digest); await manager.toggle(rule.id, true);
  }
  await manager.configure({ enabled: true });
  await manager.dispatch('Stop', { sessionId: 'fixture-session', isSessionActive: () => true });
  await firstFour;
  const before = writes;
  await manager.checkSources();
  assert.equal(writes, before);
  releases[0](); await lastStarted;
  assert.equal(releases.length, 5);
});
