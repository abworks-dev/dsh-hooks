import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createHookManager, parseRule } from '../core.js';
import { parseSourceRegistry, parseSourceRegistrationRequest, sourceDefinitionDigest } from '../source-registry.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const document = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'fixed-fixture-only' }] }] } });
const options = { interpreter: { executable: process.execPath, argvPrefix: [] } };
const fingerprint = async () => ({ digest: 'f'.repeat(64), files: [] });
async function fixture(t, overrides = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'source-registry-'));
  const root = await realpath(temp);
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = { kind: 'user', directory: root };
  const value = { id: 'fixture', request, accepted: { 'hooks.json': hash(document) }, options };
  let status = 'available', sha256 = hash(document), content = document, calls = 0, writes = 0, fail = false, gate;
  const sourceReader = async (request, readOptions) => {
    calls++;
    assert.deepEqual(readOptions, { selectedNames: ['hooks.json'], requireCanonicalRoot: true });
    if (gate) await gate;
    return { ...request, sources: [{ format: 'json', status, sha256, document: content }] };
  };
  const manager = createHookManager({ sourceReader, fingerprint, execute: async () => { throw new Error('must_not_execute'); }, ...overrides, persist: async () => { writes++; if (fail) throw new Error('persist_failed'); } });
  return { manager, value, root, set: v => { if ('status' in v) status = v.status; if ('sha256' in v) sha256 = v.sha256; if ('content' in v) content = v.content; if ('fail' in v) fail = v.fail; if ('gate' in v) gate = v.gate; }, get calls() { return calls; }, get writes() { return writes; } };
}
async function enable(f) {
  const id = f.manager.snapshot().rules[0].id;
  await f.manager.configure({ enabled: true });
  await f.manager.trust(id, (await f.manager.previewTrust(id)).digest);
  await f.manager.toggle(id, true);
  return id;
}
test('legacy state remains absent, trust definition unchanged on ordinary writes', async () => {
  const rule = parseRule({ id: 'legacy', name: 'legacy', event: 'Stop', scope: { kind: 'user' }, action: { type: 'command', executable: process.execPath } });
  let stored;
  const m = createHookManager({ initial: { enabled: false, rules: [rule] }, persist: async s => { stored = s; }, fingerprint });
  const first = await m.previewTrust('legacy');
  await m.configure({ enabled: true });
  assert.equal(Object.hasOwn(stored, 'sourceRegistrations'), false);
  assert.equal(Object.hasOwn(m.snapshot(), 'sourceRegistrations'), false);
  assert.equal((await m.previewTrust('legacy')).digest, first.digest);
});
test('registration rereads fixed files, atomically imports disabled definitions and owns normalized digests', async t => {
  const f = await fixture(t);
  const s = await f.manager.registerSource(f.value);
  assert.equal(f.calls, 1); assert.equal(f.writes, 1);
  assert.equal(s.rules[0].enabled, false); assert.equal(s.rules[0].trust, undefined);
  assert.equal(s.sourceRegistrations[0].revision, 1);
  assert.equal(s.sourceRegistrations[0].status, 'current');
  assert.equal(s.sourceRegistrations[0].owners[0].digest, sourceDefinitionDigest(s.rules[0]));
  assert.equal(JSON.stringify(s.sourceRegistrations).includes('fixed-fixture-only'), false);
  await assert.rejects(f.manager.registerSource(f.value), /duplicate_source_registration_id/);
});
test('ownership digests and stored options use canonicalized target scope', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, 'scope-child'));
  const value = { ...f.value, options: { ...options, scope: { kind: 'project', root: f.root + path.sep } } };
  const s = await f.manager.registerSource(value);
  assert.deepEqual(s.rules[0].scope, { kind: 'project', root: f.root });
  assert.deepEqual(s.sourceRegistrations[0].options.scope, s.rules[0].scope);
  assert.equal(s.sourceRegistrations[0].owners[0].digest, sourceDefinitionDigest(s.rules[0]));
});
test('changed, missing and rejected registration reads are atomic failures', async t => {
  for (const bad of [{ sha256: '1'.repeat(64) }, { status: 'missing' }, { status: 'rejected' }, { content: JSON.stringify({ hooks: { Unknown: [{ hooks: [{ type: 'command', command: 'x' }] }] } }) }]) {
    const f = await fixture(t); f.set(bad);
    await assert.rejects(f.manager.registerSource(f.value));
    assert.equal(f.writes, 0); assert.deepEqual(f.manager.snapshot().rules, []);
    assert.equal(Object.hasOwn(f.manager.snapshot(), 'sourceRegistrations'), false);
  }
});
test('no-change zero writes; changes revoke trust and never accept or re-enable reappearing sources', async t => {
  const f = await fixture(t); await f.manager.registerSource(f.value); const id = await enable(f);
  const before = f.writes; await f.manager.checkSources(); assert.equal(f.writes, before);
  f.set({ status: 'missing' }); const s = await f.manager.checkSources();
  assert.equal(s.rules[0].enabled, false); assert.equal(s.rules[0].trust, undefined);
  assert.equal(s.sourceRegistrations[0].status, 'review'); assert.equal(s.sourceRegistrations[0].revision, 2);
  assert.deepEqual(s.sourceRegistrations[0].accepted, f.value.accepted);
  await f.manager.checkSources(); assert.equal(f.writes, before + 1);
  f.set({ status: 'available' }); await f.manager.checkSources(); assert.equal(f.writes, before + 1);
  await assert.rejects(f.manager.trust(id, (await f.manager.previewTrust(id)).digest), /source_review_required/);
  await assert.rejects(f.manager.toggle(id, true), /source_review_required/);
});
test('manual edits and deletion become sticky conflict without overwriting edited rule', async t => {
  for (const deleted of [false, true]) {
    const f = await fixture(t); await f.manager.registerSource(f.value);
    const rule = f.manager.snapshot().rules[0];
    if (deleted) await f.manager.remove(rule.id); else await f.manager.upsert({ ...rule, name: 'locally edited' });
    const before = f.manager.snapshot().rules;
    const s = await f.manager.checkSources();
    assert.equal(s.sourceRegistrations[0].status, 'conflict'); assert.deepEqual(s.rules, before);
    const writes = f.writes; await f.manager.checkSources(); assert.equal(f.writes, writes);
  }
});
test('local ownership breaks are sticky across deletion, reimport and identical restoration', async t => {
  const f = await fixture(t); await f.manager.registerSource(f.value);
  const rule = f.manager.snapshot().rules[0];
  await f.manager.remove(rule.id);
  assert.equal(f.manager.snapshot().sourceRegistrations[0].status, 'conflict');
  await assert.rejects(f.manager.importRules([rule]), /duplicate_hook_id/);
  await f.manager.upsert(rule);
  assert.equal(f.manager.snapshot().sourceRegistrations[0].status, 'conflict');
  const revision = f.manager.snapshot().sourceRegistrations[0].revision;
  await f.manager.upsert({ ...rule, name: 'local' }); await f.manager.upsert(rule);
  await f.manager.checkSources();
  assert.equal(f.manager.snapshot().sourceRegistrations[0].status, 'conflict');
  assert.equal(f.manager.snapshot().sourceRegistrations[0].revision, revision);
  await assert.rejects(f.manager.trust(rule.id, (await f.manager.previewTrust(rule.id)).digest), /source_review_required/);
});
test('persist rollback for registration and revocation; failed revocation is runtime fail-closed', async t => {
  const f = await fixture(t); f.set({ fail: true });
  await assert.rejects(f.manager.registerSource(f.value), /persist_failed/); assert.deepEqual(f.manager.snapshot().rules, []);
  f.set({ fail: false }); await f.manager.registerSource(f.value); const id = await enable(f);
  const before = f.manager.snapshot(); f.set({ fail: true, sha256: 'a'.repeat(64) });
  await assert.rejects(f.manager.checkSources(), /persist_failed/); assert.deepEqual(f.manager.snapshot(), before);
  await assert.rejects(f.manager.toggle(id, true), /source_review_required/);
  await f.manager.dispatch('Stop'); assert.equal(f.manager.snapshot().records[0].status, 'trust_error');
  f.set({ fail: false, sha256: hash(document) }); const s = await f.manager.checkSources(); assert.equal(s.rules[0].enabled, false); assert.equal(s.sourceRegistrations[0].status, 'review');
});
test('singleflight reads apply against fresh local definitions without overwriting edits', async t => {
  const f = await fixture(t); await f.manager.registerSource(f.value);
  let release; f.set({ sha256: 'b'.repeat(64), gate: new Promise(resolve => { release = resolve; }) });
  const a = f.manager.checkSources(), b = f.manager.checkSources(); assert.equal(a, b);
  await Promise.resolve(); await Promise.resolve();
  await f.manager.upsert({ ...f.manager.snapshot().rules[0], name: 'new local definition' });
  release(); const s = await a;
  assert.equal(f.calls, 2); assert.equal(s.rules[0].name, 'new local definition'); assert.equal(s.sourceRegistrations[0].status, 'conflict');
});
test('closed registry validation rejects accessors, duplicate owners and registration IDs, bounds', async t => {
  const f = await fixture(t); await f.manager.registerSource(f.value);
  const entry = f.manager.snapshot().sourceRegistrations[0];
  assert.deepEqual(parseSourceRegistry([entry]), [entry]);
  for (const value of [[{ ...entry, extra: true }], [{ ...entry, revision: 0 }], [{ ...entry, status: 'missing' }], [entry, { ...entry }], [entry, { ...entry, id: 'another' }], Array(9).fill(entry), [{ ...entry, owners: Array(101).fill(entry.owners[0]) }]]) assert.throws(() => parseSourceRegistry(value));
  let reads = 0; const getter = { ...f.value }; Object.defineProperty(getter, 'options', { enumerable: true, get() { reads++; throw new Error('getter'); } });
  assert.throws(() => parseSourceRegistrationRequest(getter)); assert.equal(reads, 0);
  assert.throws(() => parseSourceRegistrationRequest({ ...f.value, options: {} }));
  assert.throws(() => createHookManager({ initial: { enabled: false, rules: [], sourceRegistrations: [{ ...entry, revision: -1 }] }, persist: async () => {} }));
});
test('cross-source rule collisions and max-eight registrations reject atomically', async t => {
  const f = await fixture(t); await f.manager.registerSource(f.value);
  await assert.rejects(f.manager.registerSource({ ...f.value, id: 'other' }), /duplicate_hook_id/);
  assert.equal(f.writes, 1);
  const entry = f.manager.snapshot().sourceRegistrations[0];
  const m = createHookManager({ initial: { enabled: false, rules: [], sourceRegistrations: Array.from({ length: 8 }, (_, i) => ({ ...entry, id: `source${i}`, owners: [] })) }, persist: async () => { throw new Error('unexpected_write'); } });
  await assert.rejects(m.registerSource(f.value), /source_registration_limit/);
});
test('pending fingerprint cannot execute across failed source revocation persistence', async t => {
  let hold, entered, release, executions = 0;
  const f = await fixture(t, { fingerprint: async () => { if (hold) { entered(); await hold; } return fingerprint(); }, execute: async () => { executions++; return { status: 'completed', exitCode: 0 }; } });
  await f.manager.registerSource(f.value); await enable(f);
  const waiting = new Promise(resolve => { entered = resolve; });
  hold = new Promise(resolve => { release = resolve; });
  const dispatch = f.manager.dispatch('Stop'); await waiting;
  f.set({ fail: true, status: 'missing' });
  await assert.rejects(f.manager.checkSources(), /persist_failed/);
  release(); await dispatch;
  assert.equal(executions, 0); assert.equal(f.manager.snapshot().records[0].status, 'trust_error');
});
test('unchanged check preserves the live rule identity across pending verification', async t => {
  let hold, entered, release, executions = 0;
  const f = await fixture(t, { fingerprint: async () => { if (hold) { entered(); await hold; } return fingerprint(); }, execute: async () => { executions++; return { status: 'completed', exitCode: 0 }; } });
  await f.manager.registerSource(f.value); await enable(f);
  const waiting = new Promise(resolve => { entered = resolve; }); hold = new Promise(resolve => { release = resolve; });
  const dispatch = f.manager.dispatch('Stop'); await waiting;
  const writes = f.writes; await f.manager.checkSources(); assert.equal(f.writes, writes);
  release(); await dispatch; assert.equal(executions, 1);
});
test('100-rule bound and duplicate raw content sources reject atomically', async t => {
  const f = await fixture(t);
  const rules = Array.from({ length: 100 }, (_, i) => ({ id: `fixed${i}`, name: 'fixture', event: 'Stop', action: { type: 'command', executable: process.execPath } }));
  const full = await fixture(t, { initial: { enabled: false, rules } });
  await assert.rejects(full.manager.registerSource(full.value), /hook_rule_limit/); assert.equal(full.writes, 0);
  const both = { ...f.value, accepted: { 'hooks.json': hash(document), 'config.toml': hash(document) } };
  const m = createHookManager({ persist: async () => { throw new Error('unexpected_write'); }, sourceReader: async request => ({ ...request, sources: ['json', 'toml'].map(format => ({ format, status: 'available', sha256: hash(document), document })) }) });
  await assert.rejects(m.registerSource(both), /codex_sources_invalid_request/); assert.equal(m.snapshot().rules.length, 0);
});
test('rejected, changed and unavailable source checks disable matching owners', async t => {
  for (const update of [{ status: 'rejected' }, { sha256: '9'.repeat(64) }, { status: 'unavailable' }]) {
    const f = await fixture(t); await f.manager.registerSource(f.value); await enable(f); f.set(update);
    const s = await f.manager.checkSources(); assert.equal(s.rules[0].enabled, false); assert.equal(s.rules[0].trust, undefined); assert.equal(s.sourceRegistrations[0].status, 'review');
  }
});
test('default reader registers actual canonical selected files', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'hooks.json'), document);
  const m = createHookManager({ persist: async () => {} });
  assert.equal((await m.registerSource(f.value)).rules.length, 1);
  await mkdir(path.join(f.root, 'nested'));
  await assert.rejects(m.registerSource({ ...f.value, id: 'bad', request: { ...f.value.request, directory: path.join(f.root, 'missing') } }));
});
