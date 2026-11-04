import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createHookManager } from '../core.js';

// Deliberately checks the pre-registration envelope, not a claim that every old
// release understands every modern rule field.
const legacyEnvelope = z.object({ enabled: z.boolean(), rules: z.array(z.unknown()) }).strict();

test('paused JSON backup roundtrip preserves two selected registrations; detaching all restores legacy envelope without touching source bytes', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hooks-downgrade-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  let stored, executions = 0;
  const manager = createHookManager({ persist: async value => { stored = structuredClone(value); }, execute: async () => { executions++; throw new Error('must_not_execute'); } });
  t.after(() => manager.dispose());
  const originals = [];
  for (const id of ['first', 'second']) {
    const directory = path.join(temporary, id); await mkdir(directory);
    const document = `\r\n${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `fixture-${id}` }] }] } })}\r\n`;
    const filename = path.join(directory, 'hooks.json'); await writeFile(filename, document);
    originals.push([filename, document]);
    await manager.registerSource({ id, request: { kind: 'user', directory: await realpath(directory) }, accepted: { 'hooks.json': createHash('sha256').update(document).digest('hex') }, options: { interpreter: { executable: process.execPath, argvPrefix: [] } } });
  }
  const backupJson = JSON.stringify(manager.snapshot());
  const restored = createHookManager({ initial: JSON.parse(backupJson), persist: async value => { stored = structuredClone(value); }, execute: async () => { executions++; throw new Error('must_not_execute'); } });
  t.after(() => restored.dispose());
  assert.deepEqual(restored.snapshot(), manager.snapshot());
  assert.equal(restored.snapshot().enabled, false);
  assert.equal(restored.snapshot().sourceRegistrations.length, 2);
  assert.throws(() => legacyEnvelope.parse(restored.snapshot()));
  const originalRules = structuredClone(restored.snapshot().rules);
  for (const entry of [...restored.snapshot().sourceRegistrations]) {
    await restored.detachSource({ id: entry.id, revision: entry.revision });
    assert.equal(restored.snapshot().enabled, false);
  }
  const detached = restored.snapshot();
  assert.equal(Object.hasOwn(detached, 'sourceRegistrations'), false);
  legacyEnvelope.parse(stored);
  assert.deepEqual(detached.rules, originalRules);
  for (const rule of detached.rules) { assert.equal(rule.enabled, false); assert.equal(rule.trust, undefined); }
  for (const [filename, document] of originals) assert.equal(await readFile(filename, 'utf8'), document);
  assert.equal(executions, 0);
  // A separately retained backup is not rewritten by detachment.
  assert.equal(JSON.parse(backupJson).sourceRegistrations.length, 2);
});
