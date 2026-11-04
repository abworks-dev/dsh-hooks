import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, realpath, writeFile, rename, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHookManager } from '../core.js';
import { discoverCodexSources } from '../config-sources.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const document = command => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });

for (const redirected of ['target', 'source']) {
  for (const empty of [true, false]) {
    test(`refresh rejects ${redirected} replacement after reading ${empty ? 'empty' : 'command'} source without changing accepted state`, async t => {
      const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hooks-refresh-paths-')));
      t.after(() => rm(parent, { recursive: true, force: true }));
      const source = path.join(parent, 'selected');
      const target = path.join(parent, 'target');
      const other = path.join(parent, 'other');
      const moved = path.join(parent, 'moved');
      for (const directory of [source, target, other]) await mkdir(directory);
      let attack = false, writes = 0, executions = 0, stored;
      const manager = createHookManager({
        initial: { enabled: true, rules: [] },
        fingerprint: async () => ({ digest: 'f'.repeat(64), files: [] }),
        execute: async () => { executions++; throw new Error('must_not_execute'); },
        persist: async value => { writes++; stored = structuredClone(value); },
        sourceReader: async (request, options) => {
          const result = await discoverCodexSources(request, options);
          if (attack) {
            attack = false;
            const original = redirected === 'target' ? target : source;
            await rename(original, moved);
            await symlink(other, original, process.platform === 'win32' ? 'junction' : 'dir');
          }
          return result;
        },
      });
      t.after(() => manager.dispose());
      const original = document('fixture-never-run');
      await writeFile(path.join(source, 'hooks.json'), original);
      await manager.registerSource({ id: 'selected', request: { kind: 'user', directory: await realpath(source) }, accepted: { 'hooks.json': hash(original) }, options: { interpreter: { executable: process.execPath, argvPrefix: [] }, scope: { kind: 'project', root: await realpath(target) } } });
      const id = manager.snapshot().rules[0].id;
      await manager.trust(id, (await manager.previewTrust(id)).digest);
      await manager.toggle(id, true);
      const before = manager.snapshot(), storedBefore = structuredClone(stored), writesBefore = writes;
      const replacement = empty ? '{"hooks":{}}' : document('changed-never-run');
      await writeFile(path.join(source, 'hooks.json'), replacement);
      attack = true;
      await assert.rejects(manager.refreshSource({ id: 'selected', revision: 1, accepted: { 'hooks.json': hash(replacement) } }), redirected === 'target' ? /^Error: source_target_scope_changed$/ : /^Error: source_root_not_canonical$/);
      assert.deepEqual(manager.snapshot(), before);
      assert.deepEqual(stored, storedBefore);
      assert.equal(writes, writesBefore);
      assert.equal(executions, 0);
      assert.equal(manager.snapshot().enabled, true);
      assert.ok(manager.snapshot().rules[0].trust);
    });
  }
}
