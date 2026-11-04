import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm, writeFile, mkdir, rename, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHookManager } from '../core.js';
import { discoverCodexSources } from '../config-sources.js';
import { previewCodexSources } from '../codex-import.js';
import { sourceDefinitionDigest } from '../source-registry.js';
const hash = text => createHash('sha256').update(text).digest('hex');
const doc = (command = 'old') => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
const options = { interpreter: { executable: process.execPath, argvPrefix: [] } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, extraOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'source-preview-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let document = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'old' }] }] } }), reader;
  let writes = 0, executions = 0;
  const request = { kind: 'user', directory: root };
  const m = createHookManager({ persist: async () => { writes++; }, fingerprint: async () => ({ digest: 'f'.repeat(64), files: [{ path: 'original-trusted-file', sha256: 'f'.repeat(64) }] }), execute: async () => { executions++; throw Error('must_not_execute'); }, sourceReader: async (r, o) => {
    assert.deepEqual(r, request); assert.deepEqual(o, { selectedNames: ['hooks.json'], requireCanonicalRoot: true });
    return reader ? reader(r, o) : { ...r, sources: [{ format: 'json', status: 'available', sha256: hash(document), document }] };
  } });
  const registration = () => ({ id: 'fixture', request, accepted: { 'hooks.json': hash(document) }, options: { ...options, ...extraOptions } });
  await m.registerSource(registration());
  return { m, root, registration, preview: () => m.previewSourceRefresh({ id: 'fixture', revision: m.snapshot().sourceRegistrations[0].revision }), get writes() { return writes; }, get executions() { return executions; }, get document() { return document; }, setDocument(v) { document = v; }, setReader(v) { reader = v; } };
}
test('real JSON and TOML previews bind raw bytes, redact non-hooks, return disabled server-read rules', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'preview-real-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const json = doc('json');
  const toml = 'model = "PRIVATE_MODEL"\r\n[[hooks.Stop]]\r\n[[hooks.Stop.hooks]]\r\ntype = "command"\r\ncommand = "toml"\r\n';
  await writeFile(path.join(root, 'hooks.json'), json); await writeFile(path.join(root, 'config.toml'), toml);
  let writes = 0; const m = createHookManager({ persist: async () => { writes++; }, execute: async () => assert.fail('execute'), sourceReader: discoverCodexSources });
  await m.registerSource({ id: 'both', request: { kind: 'user', directory: root }, accepted: { 'hooks.json': hash(json), 'config.toml': hash(toml) }, options });
  const changed = doc('changed-from-disk'); await writeFile(path.join(root, 'hooks.json'), changed);
  const before = m.snapshot(); const p = await m.previewSourceRefresh({ id: 'both', revision: 1 });
  assert.deepEqual(p.request, { id: 'both', revision: 1, accepted: { 'hooks.json': hash(changed), 'config.toml': hash(toml) }, previewToken: p.request.previewToken }); assert.match(p.request.previewToken, /^[a-f0-9-]{36}$/);
  assert.equal(p.rules.length, 2); assert.equal(p.rules[0].action.argv.at(-1), 'changed-from-disk');
  for (const r of p.rules) { assert.equal(r.enabled, false); assert.equal(r.trust, undefined); assert.deepEqual(r.action.trustFiles, []); }
  assert.ok(!JSON.stringify(p).includes('PRIVATE_')); assert.equal(p.document, undefined);
  assert.equal(writes, 1); assert.deepEqual(m.snapshot(), before);
});
test('pure preview leaves accepted hashes, trust, enabled rules and rule identity intact', async t => {
  const f = await fixture(t); const id = f.m.snapshot().rules[0].id;
  await f.m.trust(id, (await f.m.previewTrust(id)).digest); await f.m.toggle(id, true);
  const before = f.m.snapshot(), writes = f.writes;
  f.setDocument(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'new' }] }] } }));
  const p = await f.preview(); assert.equal(p.rules[0].enabled, false); assert.equal(p.rules[0].trust, undefined); assert.deepEqual(p.rules[0].action.trustFiles, []);
  assert.deepEqual(f.m.snapshot(), before); assert.equal(f.writes, writes); assert.equal(f.executions, 0);
  // If preview had implicitly checked sources, this enable would now fail review.
  await f.m.toggle(id, true);
});
test('reload ownership checks reject absent/edited rules and never carry original file trust', async t => {
  const f = await fixture(t); const base = f.m.snapshot(); delete base.records; delete base.events;
  const original = structuredClone(base); original.rules[0].action.trustFiles = [path.join(f.root, 'original-trusted-file')]; original.rules[0].trust = { digest: 'f'.repeat(64) }; original.rules[0].enabled = true;
  original.sourceRegistrations[0].owners[0].digest = sourceDefinitionDigest(original.rules[0]);
  let writes = 0;
  const make = initial => createHookManager({ initial, persist: async () => { writes++; }, sourceReader: async r => ({ ...r, sources: [{ format: 'json', status: 'available', sha256: hash(f.document), document: f.document }] }) });
  const m = make(original); const p = await m.previewSourceRefresh({ id: 'fixture', revision: 1 }); assert.deepEqual(p.rules[0].action.trustFiles, []); assert.equal(p.rules[0].trust, undefined); assert.equal(m.snapshot().rules[0].enabled, true);
  for (const missing of [false, true]) { const initial = structuredClone(base); if (missing) initial.rules = []; else initial.rules[0].name = 'externally edited'; await assert.rejects(make(initial).previewSourceRefresh({ id: 'fixture', revision: 1 }), /source_ownership_conflict/); }
  assert.equal(writes, 0);
});
test('preview token binds returned requests across ABA, changed interpreter/scope and reload', async t => {
  for (const change of ['interpreter', 'scope']) {
    const f = await fixture(t); const p = await f.preview(); const rule = f.m.snapshot().rules[0];
    await f.m.detachSource({ id: 'fixture', revision: 1 }); await f.m.remove(rule.id);
    const changed = change === 'interpreter' ? { ...options, interpreter: { executable: process.execPath, argvPrefix: ['--eval'] } } : { ...options, scope: { kind: 'project', root: f.root } };
    await f.m.registerSource({ ...f.registration(), options: changed });
    assert.equal(f.m.snapshot().sourceRegistrations[0].revision, 1);
    await assert.rejects(f.m.refreshSource(p.request), /source_revision_changed/);
    const current = await f.preview(); assert.notEqual(current.request.previewToken, p.request.previewToken); await f.m.refreshSource(current.request);
    const latest = await f.preview(); const initial = f.m.snapshot(); delete initial.records; delete initial.events;
    let reads = 0; const reloaded = createHookManager({ initial, persist: async () => assert.fail('stale token must not persist'), sourceReader: async () => { reads++; assert.fail('stale token must not read'); } });
    await assert.rejects(reloaded.refreshSource(latest.request), /source_revision_changed/); assert.equal(reads, 0);
  }
});
test('closed envelopes and accessors never execute getters', async t => {
  const f = await fixture(t); let calls = 0;
  for (const key of ['id', 'revision']) { const bad = { id: 'fixture', revision: 1 }; Object.defineProperty(bad, key, { enumerable: true, get() { calls++; } }); await assert.rejects(f.m.previewSourceRefresh(bad), /invalid_source_registry/); }
  for (const bad of [{ id: 'fixture', revision: 1, accepted: {} }, { id: 'fixture', revision: 0 }, { id: 'fixture', revision: 1, scope: {} }]) await assert.rejects(f.m.previewSourceRefresh(bad), /invalid_source_registry/);
  assert.equal(calls, 0); f.m.dispose(); await assert.rejects(f.preview(), /hooks_disposed/);
});
test('gated reads reject edit/remove/refresh/detach and identical revision ABA without locking mutations', async t => {
  for (const action of ['edit', 'remove', 'refresh', 'detach', 'aba']) {
    const f = await fixture(t); const entered = deferred(), gate = deferred(); let reads = 0;
    f.setReader(async r => { if (++reads === 1) { entered.resolve(); await gate.promise; } return { ...r, sources: [{ format: 'json', status: 'available', sha256: hash(f.document), document: f.document }] }; });
    const preview = f.preview(); const rejected = assert.rejects(preview, /source_revision_changed|source_registration_not_found|source_ownership_conflict/); await entered.promise;
    const rule = f.m.snapshot().rules[0];
    if (action === 'edit') await f.m.upsert({ ...rule, name: 'edited' });
    if (action === 'remove') await f.m.remove(rule.id);
    if (action === 'refresh') await f.m.refreshSource({ id: 'fixture', revision: 1, accepted: f.registration().accepted });
    if (action === 'detach' || action === 'aba') await f.m.detachSource({ id: 'fixture', revision: 1 });
    if (action === 'aba') { await f.m.remove(rule.id); await f.m.registerSource(f.registration()); assert.equal(f.m.snapshot().sourceRegistrations[0].revision, 1); }
    gate.resolve(); await rejected;
  }
});
test('missing/rejected sources and reader errors are sanitized; unsupported is reviewable but refresh rejects', async t => {
  const f = await fixture(t);
  for (const status of ['missing', 'rejected', 'unavailable']) { f.setReader(async r => ({ ...r, sources: [{ format: 'json', status, error: 'OS_PRIVATE' }] })); await assert.rejects(f.preview(), /source_registration_changed/); }
  f.setReader(async () => { throw Error('OS_PRIVATE'); }); await assert.rejects(f.preview(), { message: 'source_registration_read_failed' });
  f.setReader(undefined); f.setDocument(JSON.stringify({ hooks: { Unknown: [{ hooks: [{ type: 'command', command: 'review me' }] }] } }));
  const p = await f.preview(); assert.equal(p.unsupported.length, 1); assert.equal(p.rules.length, 0); await assert.rejects(f.m.refreshSource(p.request), /source_import_unsupported/);
});
test('edited/missing ownership and new ID collisions cannot be previewed as silent replacement', async t => {
  for (const remove of [false, true]) { const f = await fixture(t); const rule = f.m.snapshot().rules[0]; if (remove) await f.m.remove(rule.id); else await f.m.upsert({ ...rule, name: 'edited' }); await assert.rejects(f.preview(), /source_ownership_conflict/); }
  const f = await fixture(t); f.setDocument(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'collision' }] }] } }));
  const rule = previewCodexSources({ documents: [{ document: f.document, source: `codex-file:${hash(f.document)}` }], options }).rules[0]; await f.m.importRules([rule]); await assert.rejects(f.preview(), /duplicate_hook_id/);
});
test('read-only preview preserves the fifth queued async Stop rule identity', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'preview-queue-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const document = JSON.stringify({ hooks: { Stop: [{ hooks: Array.from({ length: 5 }, (_, i) => ({ type: 'command', command: `fixture-${i}`, async: true })) }] } });
  const firstFour = deferred(), fifth = deferred(), releases = []; let writes = 0;
  const m = createHookManager({ persist: async () => { writes++; }, fingerprint: async () => ({ digest: 'fixture', files: [] }), sourceReader: async r => ({ ...r, sources: [{ format: 'json', status: 'available', sha256: hash(document), document }] }), execute: () => new Promise(resolve => {
    releases.push(() => resolve({ status: 'completed', exitCode: 0, stdout: '', stderr: '' })); if (releases.length === 4) firstFour.resolve(); if (releases.length === 5) fifth.resolve();
  }) });
  t.after(() => { releases.forEach(release => release()); m.dispose(); });
  await m.registerSource({ id: 'fixture', request: { kind: 'user', directory: root }, accepted: { 'hooks.json': hash(document) }, options });
  for (const r of m.snapshot().rules) { await m.trust(r.id, (await m.previewTrust(r.id)).digest); await m.toggle(r.id, true); }
  await m.configure({ enabled: true }); await m.dispatch('Stop', { sessionId: 'fixture', isSessionActive: () => true }); await firstFour.promise;
  const before = writes; await m.previewSourceRefresh({ id: 'fixture', revision: 1 }); assert.equal(writes, before);
  releases[0](); await fifth.promise; assert.equal(releases.length, 5);
});
test('project target redirection before or during read is rejected', async t => {
  for (const during of [false, true]) {
    const f = await fixture(t); const target = path.join(f.root, 'target'), moved = path.join(f.root, 'moved'), replacement = path.join(f.root, 'replacement'); await mkdir(target); await mkdir(replacement);
    await f.m.detachSource({ id: 'fixture', revision: 1 }); await f.m.remove(f.m.snapshot().rules[0].id);
    await f.m.registerSource({ ...f.registration(), options: { ...options, scope: { kind: 'project', root: await realpath(target) } } });
    const redirect = async () => { await rename(target, moved); await symlink(replacement, target, process.platform === 'win32' ? 'junction' : 'dir'); };
    if (during) f.setReader(async r => { await redirect(); return { ...r, sources: [{ format: 'json', status: 'available', sha256: hash(f.document), document: f.document }] }; }); else await redirect();
    await assert.rejects(f.preview(), /source_target_scope_changed/);
  }
});
