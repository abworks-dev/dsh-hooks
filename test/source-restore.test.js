import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHookManager } from '../core.js';

// Tests manager snapshot recovery, not a backup of the Host storage backend.
for (const condition of ['changed', 'missing']) {
  test(`restored trusted snapshot rechecks ${condition} selected source and cannot silently regain trust`, async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hooks-restore-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'hooks.json');
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'never-execute-fixture' }] }] } });
    await writeFile(file, original);
    let executions = 0;
    const deps = {
      fingerprint: async () => ({ digest: 'f'.repeat(64), files: [] }),
      execute: async () => { executions++; throw Error('must_not_execute'); },
    };
    const source = createHookManager({ ...deps, persist: async () => {} });
    t.after(() => source.dispose());
    await source.registerSource({ id: 'recovery', request: { kind: 'user', directory: root }, accepted: { 'hooks.json': createHash('sha256').update(original).digest('hex') }, options: { interpreter: { executable: process.execPath, argvPrefix: [] } } });
    const id = source.snapshot().rules[0].id;
    await source.trust(id, (await source.previewTrust(id)).digest);
    await source.toggle(id, true);
    await source.configure({ enabled: true });
    const backup = JSON.stringify(source.snapshot());
    const initial = JSON.parse(backup);
    assert.equal(initial.rules[0].enabled, true);
    assert.ok(initial.rules[0].trust);
    if (condition === 'changed') await writeFile(file, '{"hooks":{}}');
    else await rm(file);
    let persisted;
    const restored = createHookManager({ ...deps, initial, persist: async value => { persisted = structuredClone(value); } });
    t.after(() => restored.dispose());
    await restored.checkSources();
    const checked = restored.snapshot();
    assert.equal(checked.enabled, true);
    assert.equal(checked.rules[0].enabled, false);
    assert.equal(checked.rules[0].trust, undefined);
    assert.equal(checked.sourceRegistrations[0].status, 'review');
    assert.deepEqual(checked.sourceRegistrations[0].accepted, initial.sourceRegistrations[0].accepted);
    assert.deepEqual(persisted, { enabled: checked.enabled, rules: checked.rules, sourceRegistrations: checked.sourceRegistrations });
    await writeFile(file, original);
    await restored.checkSources();
    assert.equal(restored.snapshot().sourceRegistrations[0].status, 'review');
    await assert.rejects(restored.toggle(id, true));
    await restored.dispatch('Stop');
    assert.equal(executions, 0);
    assert.equal(JSON.parse(backup).rules[0].enabled, true);
    assert.ok(JSON.parse(backup).rules[0].trust);
  });
}
