import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir, rename, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHookManager } from '../core.js';
import { mountRpc } from '../rpc.js';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hooks-register-owner-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const document = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'fixture-never-run' }] }] } });
  await writeFile(path.join(directory, 'hooks.json'), document);
  let writes = 0, executions = 0, stored;
  const manager = createHookManager({ persist: async value => { writes++; stored = structuredClone(value); }, execute: async () => { executions++; throw new Error('must_not_execute'); } });
  t.after(() => manager.dispose());
  const peer = { principal: { kind: 'owner' } };
  const ctx = { connection: { browserPeer: peer }, invocation: { peer }, typert: { register: () => () => {} } };
  let service;
  class Remote { constructor(context) { this.ctx = context; service = this; } }
  mountRpc(ctx, manager, Remote);
  const request = { id: 'explicit-selection', request: { kind: 'user', directory }, accepted: { 'hooks.json': createHash('sha256').update(document).digest('hex') }, options: { interpreter: { executable: process.execPath, argvPrefix: [] } } };
  return { directory, document, request, manager, service, writes: () => writes, executions: () => executions, stored: () => stored };
}

test('registration rejects project target redirection during source reads even for zero rules', async t => {
  for (const empty of [false, true]) await t.test(empty ? 'empty source' : 'command source', async t => {
    const f = await fixture(t);
    const target = path.join(f.directory, 'target'), moved = path.join(f.directory, 'moved'), other = path.join(f.directory, 'other');
    await mkdir(target); await mkdir(other);
    const document = empty ? '{"hooks":{}}' : f.document;
    let saves = 0;
    const manager = createHookManager({ persist: async () => { saves++; }, sourceReader: async request => {
      await rename(target, moved);
      await symlink(other, target, process.platform === 'win32' ? 'junction' : 'dir');
      return { ...request, sources: [{ format: 'json', status: 'available', sha256: createHash('sha256').update(document).digest('hex'), document }] };
    } });
    t.after(() => manager.dispose());
    const request = structuredClone(f.request);
    request.accepted['hooks.json'] = createHash('sha256').update(document).digest('hex');
    request.options.scope = { kind: 'project', root: await realpath(target) };
    const before = manager.snapshot();
    await assert.rejects(manager.registerSource(request), /source_target_scope_changed/);
    assert.deepEqual(manager.snapshot(), before); assert.equal(saves, 0);
  });
});

test('registration rejects a source root replaced by a junction before read returns', async t => {
  const f = await fixture(t);
  const root = path.join(f.directory, 'selected'), moved = path.join(f.directory, 'moved'), other = path.join(f.directory, 'other');
  await mkdir(root); await mkdir(other);
  let saves = 0;
  const manager = createHookManager({ persist: async () => { saves++; }, sourceReader: async request => {
    await rename(root, moved); await symlink(other, root, process.platform === 'win32' ? 'junction' : 'dir');
    return { ...request, sources: [{ format: 'json', status: 'available', sha256: f.request.accepted['hooks.json'], document: f.document }] };
  } });
  t.after(() => manager.dispose());
  const request = structuredClone(f.request); request.request.directory = await realpath(root);
  const before = manager.snapshot();
  await assert.rejects(manager.registerSource(request), /source_root_not_canonical/);
  assert.deepEqual(manager.snapshot(), before); assert.equal(saves, 0);
});

test('concurrent owner registrations cannot duplicate, rename or partially adopt the same selection', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.service.registerSource(f.request), f.service.registerSource(f.request)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const state = f.manager.snapshot();
  assert.equal(state.rules.length, 1); assert.equal(state.sourceRegistrations.length, 1);
  assert.equal(state.sourceRegistrations[0].id, f.request.id);
  assert.equal(state.rules[0].enabled, false); assert.equal(state.rules[0].trust, undefined);
  assert.equal(f.writes(), 1); assert.deepEqual(f.stored(), { enabled: state.enabled, rules: state.rules, sourceRegistrations: state.sourceRegistrations });
  assert.equal(await readFile(path.join(f.directory, 'hooks.json'), 'utf8'), f.document);
  assert.equal(f.executions(), 0);
});

test('registering a selection cannot claim a previously detached ordinary snapshot even with another interpreter', async t => {
  const f = await fixture(t);
  const initial = await f.service.registerSource(f.request);
  await f.service.detachSource({ id: f.request.id, revision: initial.sourceRegistrations[0].revision });
  const before = f.manager.snapshot(), stored = structuredClone(f.stored()), writes = f.writes();
  const changedInterpreter = structuredClone(f.request);
  changedInterpreter.id = 'another-selection';
  changedInterpreter.options.interpreter.argvPrefix = ['--no-warnings'];
  await assert.rejects(f.service.registerSource(changedInterpreter));
  assert.deepEqual(f.manager.snapshot(), before); assert.deepEqual(f.stored(), stored); assert.equal(f.writes(), writes);
  assert.equal(Object.hasOwn(f.manager.snapshot(), 'sourceRegistrations'), false);
  assert.equal(f.executions(), 0);
});
