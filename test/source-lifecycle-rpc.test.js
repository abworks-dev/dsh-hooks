import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mountRpc, descriptors } from '../rpc.js';
import { createHookManager } from '../core.js';
const methods = ['registerSource', 'checkSources', 'previewSourceRefresh', 'refreshSource', 'detachSource'];
const hash = value => createHash('sha256').update(value).digest('hex');
function remote(manager) {
  const peer = { principal: { kind: 'owner' } };
  const ctx = { connection: { browserPeer: peer }, invocation: { peer }, typert: { register: () => () => {} } };
  let service;
  class Remote { constructor(context) { this.ctx = context; service = this; } }
  mountRpc(ctx, manager, Remote);
  return { peer, ctx, service };
}
const request = () => ({ id: 'watch', request: { kind: 'user', directory: path.resolve('selected') }, accepted: { 'hooks.json': 'a'.repeat(64) }, options: { interpreter: { executable: process.execPath, argvPrefix: [] } } });

test('all source lifecycle methods deny non-exact owners before manager lookup or input evaluation', () => {
  const r = remote(new Proxy({}, { get() { throw new Error('manager_access'); } }));
  const malicious = new Proxy({}, { ownKeys() { throw new Error('request_access'); } });
  for (const peer of [undefined, { principal: { kind: 'owner' } }, { principal: { kind: 'remote' } }]) {
    r.ctx.invocation.peer = peer;
    for (const method of methods) assert.throws(() => r.service[method](malicious), /local_owner_client_required/);
  }
});

test('source lifecycle codecs are closed, copied and bound to their exact RPC method', () => {
  const parse = method => descriptors.find(d => d.method === method).parameters[0].codec.create().parse;
  const original = request(), copied = parse('registerSource')(original);
  original.accepted['hooks.json'] = 'b'.repeat(64);
  original.options.interpreter.argvPrefix.push('changed');
  assert.equal(copied.accepted['hooks.json'], 'a'.repeat(64));
  assert.deepEqual(copied.options.interpreter.argvPrefix, []);
  assert.equal(descriptors.find(d => d.method === 'checkSources').parameters.length, 0);
  let calls = 0;
  const bad = { id: 'watch', revision: 1 };
  Object.defineProperty(bad, 'accepted', { enumerable: true, get() { calls++; return {}; } });
  assert.throws(() => parse('refreshSource')(bad)); assert.equal(calls, 0);
  for (const method of ['previewSourceRefresh', 'refreshSource', 'detachSource']) {
    const input = { id: 'watch', revision: 1, ...(method === 'refreshSource' ? { accepted: request().accepted } : {}) };
    assert.deepEqual(parse(method)(input), input);
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) assert.throws(() => parse(method)({ ...input, revision }));
    assert.throws(() => parse(method)({ ...input, scope: { kind: 'user' } }));
    assert.throws(() => parse(method)({ ...input, id: 'x'.repeat(65) }));
    const accessor = { ...input };
    Object.defineProperty(accessor, 'id', { enumerable: true, get() { calls++; throw new Error('must_not_read_getter'); } });
    assert.throws(() => parse(method)(accessor)); assert.equal(calls, 0);
  }
  assert.throws(() => parse('refreshSource')({ id: 'watch', revision: 1, accepted: {} }));
  assert.throws(() => parse('refreshSource')({ id: 'watch', revision: 1, accepted: { 'other.json': 'a'.repeat(64) } }));
  const guarded = { id: 'watch', revision: 1, accepted: request().accepted, previewToken: '12345678-1234-4abc-8123-123456789abc' };
  assert.deepEqual(parse('refreshSource')(guarded), guarded);
  for (const previewToken of [null, undefined, '', 'a'.repeat(36)]) assert.throws(() => parse('refreshSource')({ ...guarded, previewToken }));
  Object.defineProperty(guarded, 'previewToken', { enumerable: true, get() { calls++; return '12345678-1234-4abc-8123-123456789abc'; } });
  assert.throws(() => parse('refreshSource')(guarded)); assert.equal(calls, 0);
});

test('authorized methods validate direct calls before delegating and forward only normalized inputs', async () => {
  const calls = [];
  const r = remote(Object.fromEntries(methods.map(method => [method, value => { calls.push({ method, value }); return method; }])));
  assert.equal(r.service.registerSource(request()), 'registerSource');
  assert.equal(calls[0].value.options.platform, process.platform);
  assert.equal(r.service.checkSources(), 'checkSources');
  assert.equal(r.service.previewSourceRefresh({ id: 'watch', revision: 1 }), 'previewSourceRefresh');
  assert.equal(r.service.refreshSource({ id: 'watch', revision: 1, accepted: request().accepted }), 'refreshSource');
  assert.equal(r.service.detachSource({ id: 'watch', revision: 2 }), 'detachSource');
  const count = calls.length;
  for (const method of ['registerSource', 'previewSourceRefresh', 'refreshSource', 'detachSource']) assert.throws(() => r.service[method]({}));
  assert.equal(calls.length, count);
});

test('owner RPC real-file lifecycle never enables rules and final detach restores legacy persistent shape', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-source-owner-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = await realpath(temporary);
  let persisted;
  const manager = createHookManager({ persist: async value => { persisted = structuredClone(value); }, fingerprint: async () => ({ digest: 'fixture', files: [] }), execute: async () => { throw new Error('must_not_execute'); } });
  t.after(() => manager.dispose());
  const r = remote(manager);
  const document = command => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
  const before = document('fixture-original'), after = document('fixture-changed'), latest = document('fixture-later');
  await writeFile(path.join(directory, 'hooks.json'), before);
  let state = await r.service.registerSource({ ...request(), request: { kind: 'user', directory }, accepted: { 'hooks.json': hash(before) } });
  assert.equal(state.rules[0].enabled, false); assert.equal(state.rules[0].trust, undefined);
  const oldId = state.rules[0].id;
  await writeFile(path.join(directory, 'hooks.json'), after);
  state = await r.service.checkSources();
  assert.equal(state.sourceRegistrations[0].status, 'review');
  const revision = state.sourceRegistrations[0].revision;
  await assert.rejects(r.service.refreshSource({ id: 'watch', revision: 1, accepted: { 'hooks.json': hash(after) } }));
  const beforePreview = manager.snapshot(), beforePersisted = structuredClone(persisted);
  const preview = await r.service.previewSourceRefresh({ id: 'watch', revision });
  assert.deepEqual(preview.request, { id: 'watch', revision, accepted: { 'hooks.json': hash(after) }, previewToken: preview.request.previewToken });
  assert.match(preview.request.previewToken, /^[a-f0-9-]{36}$/);
  assert.equal(preview.rules[0].enabled, false); assert.equal(preview.rules[0].trust, undefined);
  assert.deepEqual(preview.unsupported, []);
  assert.deepEqual(manager.snapshot(), beforePreview); assert.deepEqual(persisted, beforePersisted);
  await writeFile(path.join(directory, 'hooks.json'), latest);
  await assert.rejects(r.service.refreshSource(preview.request), /source_registration_changed/);
  assert.deepEqual(manager.snapshot(), beforePreview); assert.deepEqual(persisted, beforePersisted);
  const newer = await r.service.previewSourceRefresh({ id: 'watch', revision });
  assert.equal(newer.request.accepted['hooks.json'], hash(latest));
  state = await r.service.refreshSource(newer.request);
  assert.equal(state.sourceRegistrations[0].status, 'current');
  assert.notEqual(state.rules[0].id, oldId);
  assert.equal(state.rules[0].enabled, false); assert.equal(state.rules[0].trust, undefined);
  state = await r.service.detachSource({ id: 'watch', revision: state.sourceRegistrations[0].revision });
  assert.equal(Object.hasOwn(state, 'sourceRegistrations'), false);
  assert.equal(state.rules.length, 1);
  assert.equal(Object.hasOwn(persisted, 'sourceRegistrations'), false);
  z.object({ enabled: z.boolean(), rules: z.array(z.unknown()) }).strict().parse(persisted);
});
