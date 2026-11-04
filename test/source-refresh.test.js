import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm, mkdir, rename, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHookManager } from '../core.js';
import { previewCodexSources } from '../codex-import.js';
const hash = text => createHash('sha256').update(text).digest('hex');
const doc = (command = 'fixture', count = 1) => JSON.stringify({ hooks: { Stop: [{ hooks: Array.from({ length: count }, () => ({ type: 'command', command })) }] } });
const options = { interpreter: { executable: process.execPath, argvPrefix: [] } };
const fingerprint = async () => ({ digest: 'f'.repeat(64), files: [] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'source-refresh-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let document = doc(), status = 'available', extra = [], fail = false, reader, persister, writes = 0, stored;
  const request = { kind: 'user', directory: root };
  const m = createHookManager({ fingerprint, execute: async () => { throw Error('must_not_execute'); }, sourceReader: async (r, o) => {
    assert.deepEqual(r, request); assert.deepEqual(o, { selectedNames: ['hooks.json'], requireCanonicalRoot: true });
    if (reader) return reader(r, o);
    return { ...r, sources: [{ format: 'json', status, sha256: hash(document), document }, ...extra] };
  }, persist: async s => { writes++; if (persister) await persister(s); if (fail) throw Error('persist_failed'); stored = structuredClone(s); } });
  await m.registerSource({ id: 'fixture', request, accepted: { 'hooks.json': hash(document) }, options });
  const refresh = (overrides = {}) => m.refreshSource({ id: 'fixture', revision: m.snapshot().sourceRegistrations[0].revision, accepted: { 'hooks.json': hash(document) }, ...overrides });
  return { m, request, refresh, get document() { return document; }, get stored() { return stored; }, get writes() { return writes; }, set(v) { if ('document' in v) document = v.document; if ('status' in v) status = v.status; if ('extra' in v) extra = v.extra; if ('fail' in v) fail = v.fail; if ('reader' in v) reader = v.reader; if ('persister' in v) persister = v.persister; } };
}
async function trust(f) { const id = f.m.snapshot().rules[0].id; await f.m.trust(id, (await f.m.previewTrust(id)).digest); await f.m.toggle(id, true); return id; }
test('refresh replaces accepted identities, never carries trust; same-content refresh also revokes trust', async t => {
  const f = await fixture(t); const old = await trust(f); f.set({ document: doc('changed') });
  await f.m.checkSources(); const s = await f.refresh();
  assert.notEqual(s.rules[0].id, old); assert.equal(s.sourceRegistrations[0].revision, 3); assert.equal(s.sourceRegistrations[0].status, 'current');
  assert.deepEqual(s.sourceRegistrations[0].accepted, { 'hooks.json': hash(f.document) });
  assert.equal(s.rules[0].enabled, false); assert.equal(s.rules[0].trust, undefined);
  await trust(f); const again = await f.refresh(); assert.equal(again.rules[0].trust, undefined); assert.equal(again.rules[0].enabled, false);
  await trust(f);
});
test('revision, accepted hashes, missing/rejected/partial/unsupported/file-set failures are atomic', async t => {
  const f = await fixture(t); const before = f.m.snapshot();
  await assert.rejects(f.refresh({ revision: 2 }), /source_revision_changed/);
  await assert.rejects(f.refresh({ accepted: { 'hooks.json': '0'.repeat(64) } }), /source_registration_changed/);
  await assert.rejects(f.refresh({ accepted: { 'config.toml': hash(f.document) } }), /source_file_set_changed/);
  for (const status of ['missing', 'rejected', 'unavailable']) { f.set({ status }); await assert.rejects(f.refresh(), /source_registration_changed/); }
  f.set({ status: 'available', extra: [{ format: 'toml', status: 'missing' }] }); await assert.rejects(f.refresh(), /source_file_set_changed/);
  f.set({ extra: [], reader: async r => ({ ...r, sources: [] }) }); await assert.rejects(f.refresh(), /source_file_set_changed/);
  f.set({ reader: undefined, document: JSON.stringify({ hooks: { Unknown: [{ hooks: [{ type: 'command', command: 'fixture' }] }] } }) });
  await assert.rejects(f.refresh(), /source_import_unsupported/);
  assert.deepEqual(f.m.snapshot(), before); assert.equal(f.writes, 1);
});
test('new collisions and aggregate 100 cap reject without adopting unrelated definitions', async t => {
  const f = await fixture(t); f.set({ document: doc('new') });
  const collision = previewCodexSources({ documents: [{ document: f.document, source: `codex-file:${hash(f.document)}` }], options }).rules[0];
  await f.m.importRules([collision]); const before = f.m.snapshot(); await assert.rejects(f.refresh(), /duplicate_hook_id/); assert.deepEqual(f.m.snapshot(), before);
  const g = await fixture(t); await g.m.importRules(Array.from({ length: 99 }, (_, i) => ({ id: `unrelated${i}`, name: 'fixture', scope: { kind: 'user' }, event: 'Stop', action: { type: 'command', executable: process.execPath } })));
  g.set({ document: doc('two', 2) }); await assert.rejects(g.refresh(), /hook_rule_limit/); assert.equal(g.m.snapshot().rules.length, 100);
  g.set({ document: doc('many', 101) }); await assert.rejects(g.refresh(), /codex_import_handler_limit/);
});
test('refresh and detach persistence failures retain both state and volatile review block', async t => {
  const f = await fixture(t); const id = await trust(f); f.set({ document: doc('changed'), fail: true });
  await assert.rejects(f.m.checkSources(), /persist_failed/); const before = f.m.snapshot();
  await assert.rejects(f.refresh(), /persist_failed/); assert.deepEqual(f.m.snapshot(), before);
  await assert.rejects(f.m.detachSource({ id: 'fixture', revision: 1 }), /persist_failed/); assert.deepEqual(f.m.snapshot(), before);
  await assert.rejects(f.m.toggle(id, true), /source_review_required/);
  f.set({ fail: false }); await f.refresh(); await trust(f);
});
test('stale check cannot revoke a same-content same-revision re-registration incarnation', async t => {
  const f = await fixture(t); t.after(() => f.m.dispose());
  const old = await trust(f), entered = deferred(), gate = deferred(); let reads = 0;
  f.set({ reader: async r => {
    if (++reads === 1) { entered.resolve(); await gate.promise; return { ...r, sources: [{ format: 'json', status: 'missing' }] }; }
    return { ...r, sources: [{ format: 'json', status: 'available', sha256: hash(f.document), document: f.document }] };
  } });
  const checking = f.m.checkSources(); await entered.promise;
  try {
    await f.m.detachSource({ id: 'fixture', revision: 1 });
    await f.m.remove(old);
    await f.m.registerSource({ id: 'fixture', request: f.request, accepted: { 'hooks.json': hash(f.document) }, options });
    const id = await trust(f), before = f.m.snapshot(), writes = f.writes;
    assert.equal(before.sourceRegistrations[0].revision, 1);
    gate.resolve(); await checking;
    assert.deepEqual(f.m.snapshot(), before);
    assert.equal(f.writes, writes);
    await f.m.toggle(id, false); await f.m.toggle(id, true);
    assert.equal(f.m.snapshot().rules[0].enabled, true);
  } finally { gate.resolve(); await checking; }
});
test('stale old check cannot revoke refreshed or detached identities', async t => {
  for (const detach of [false, true]) {
    const f = await fixture(t); const old = await trust(f); const entered = deferred(), gate = deferred(); let reads = 0;
    f.set({ reader: async r => { if (++reads === 1) { entered.resolve(); await gate.promise; return { ...r, sources: [{ format: 'json', status: 'missing' }] }; } return { ...r, sources: [{ format: 'json', status: 'available', sha256: hash(f.document), document: f.document }] }; } });
    const checking = f.m.checkSources(); await entered.promise;
    if (detach) await f.m.detachSource({ id: 'fixture', revision: 1 }); else await f.refresh();
    gate.resolve(); await checking;
    const id = detach ? old : f.m.snapshot().rules[0].id;
    await f.m.trust(id, (await f.m.previewTrust(id)).digest); await f.m.toggle(id, true);
  }
});
test('check observed during refresh persistence remains blocked, then explicit refresh recovers', async t => {
  const f = await fixture(t); await trust(f); const entered = deferred(), gate = deferred();
  // Start check first so its snapshot is revision 1; release it while refresh persists.
  const checkingEntered = deferred(), checkingGate = deferred(); let reads = 0;
  f.set({ reader: async r => { if (++reads === 1) { checkingEntered.resolve(); await checkingGate.promise; return { ...r, sources: [{ format: 'json', status: 'missing' }] }; } return { ...r, sources: [{ format: 'json', status: 'available', sha256: hash(f.document), document: f.document }] }; } });
  const checking = f.m.checkSources(); await checkingEntered.promise;
  f.set({ persister: async () => { entered.resolve(); await gate.promise; } }); const refreshing = f.refresh(); await entered.promise;
  checkingGate.resolve(); await new Promise(resolve => setImmediate(resolve)); gate.resolve(); await refreshing; await checking;
  const id = f.m.snapshot().rules[0].id;
  await assert.rejects(f.m.trust(id, (await f.m.previewTrust(id)).digest), /source_review_required/);
  f.set({ persister: undefined }); await f.refresh(); await trust(f);
});
test('detach current and conflict registries preserves edits/deletions; last entry omitted and legacy reload works', async t => {
  const f = await fixture(t); const id = await trust(f); const s = await f.m.detachSource({ id: 'fixture', revision: 1 });
  assert.equal(Object.hasOwn(s, 'sourceRegistrations'), false); assert.equal(Object.hasOwn(f.stored, 'sourceRegistrations'), false); assert.equal(s.rules[0].trust, undefined); assert.equal(s.rules[0].enabled, false);
  const reload = createHookManager({ initial: f.stored, fingerprint, persist: async () => {} }); assert.equal(Object.hasOwn(reload.snapshot(), 'sourceRegistrations'), false);
  await f.m.trust(id, (await f.m.previewTrust(id)).digest);
  for (const deleted of [false, true]) {
    const g = await fixture(t); const rule = g.m.snapshot().rules[0];
    if (deleted) await g.m.remove(rule.id); else await g.m.upsert({ ...rule, name: 'manual edit' });
    const before = g.m.snapshot(); await assert.rejects(g.refresh(), /source_ownership_conflict/);
    await assert.rejects(g.m.detachSource({ id: 'fixture', revision: 1 }), /source_revision_changed/);
    const detached = await g.m.detachSource({ id: 'fixture', revision: before.sourceRegistrations[0].revision }); assert.deepEqual(detached.rules, before.rules);
    if (!deleted) await g.m.trust(rule.id, (await g.m.previewTrust(rule.id)).digest);
  }
});
test('refresh refuses redirected canonical project target rather than silently retargeting', async t => {
  const f = await fixture(t);
  const target = path.join(f.request.directory, 'target'), moved = path.join(f.request.directory, 'moved'), replacement = path.join(f.request.directory, 'replacement');
  await mkdir(target); await mkdir(replacement);
  const m = createHookManager({ persist: async () => {}, sourceReader: async r => ({ ...r, sources: [{ format: 'json', status: 'available', sha256: hash(f.document), document: f.document }] }) });
  await m.registerSource({ id: 'targeted', request: f.request, accepted: { 'hooks.json': hash(f.document) }, options: { ...options, scope: { kind: 'project', root: await realpath(target) } } });
  const before = m.snapshot(); await rename(target, moved);
  await symlink(replacement, target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(m.refreshSource({ id: 'targeted', revision: 1, accepted: { 'hooks.json': hash(f.document) } }), /source_target_scope_changed/);
  assert.deepEqual(m.snapshot(), before);
});
test('refresh rejects other registrations reserved absent IDs and max-safe revision overflow', async t => {
  const f = await fixture(t); const entry = f.m.snapshot().sourceRegistrations[0];
  const changed = doc('reserved');
  const candidate = previewCodexSources({ documents: [{ document: changed, source: `codex-file:${hash(changed)}` }], options }).rules[0];
  let writes = 0;
  const initial = { enabled: false, rules: f.m.snapshot().rules, sourceRegistrations: [entry, { ...entry, id: 'other', status: 'conflict', owners: [{ id: candidate.id, digest: '0'.repeat(64) }] }] };
  const m = createHookManager({ initial, persist: async () => { writes++; }, sourceReader: async r => ({ ...r, sources: [{ format: 'json', status: 'available', sha256: hash(changed), document: changed }] }) });
  await assert.rejects(m.refreshSource({ id: 'fixture', revision: 1, accepted: { 'hooks.json': hash(changed) } }), /duplicate_hook_id/);
  assert.equal(writes, 0);
  const capped = createHookManager({ initial: { ...initial, sourceRegistrations: [{ ...entry, revision: Number.MAX_SAFE_INTEGER }] }, persist: async () => { writes++; } });
  await assert.rejects(capped.refreshSource({ id: 'fixture', revision: Number.MAX_SAFE_INTEGER, accepted: entry.accepted }), /source_revision_limit/);
  assert.equal(writes, 0);
});
test('two-file partial refresh rejects entire aggregate and preserves stored target scope/options', async t => {
  const f = await fixture(t); const first = doc('json'), second = doc('toml');
  const accepted = { 'hooks.json': hash(first), 'config.toml': hash(second) };
  let partial = false;
  const m = createHookManager({ persist: async () => {}, sourceReader: async (r, o) => {
    assert.deepEqual(o, { selectedNames: ['hooks.json', 'config.toml'], requireCanonicalRoot: true });
    return { ...r, sources: [{ format: 'json', status: 'available', document: first, sha256: hash(first) }, { format: 'toml', status: partial ? 'missing' : 'available', document: second, sha256: hash(second) }] };
  } });
  await m.registerSource({ id: 'both', request: f.request, accepted, options: { ...options, scope: { kind: 'project', root: f.request.directory } } });
  const before = m.snapshot(); partial = true;
  await assert.rejects(m.refreshSource({ id: 'both', revision: 1, accepted }), /source_registration_changed/); assert.deepEqual(m.snapshot(), before);
  partial = false; const s = await m.refreshSource({ id: 'both', revision: 1, accepted });
  assert.deepEqual(s.sourceRegistrations[0].options, before.sourceRegistrations[0].options);
  for (const rule of s.rules) assert.deepEqual(rule.scope, { kind: 'project', root: f.request.directory });
});
test('recovery envelopes reject getters, unknown fields, invalid revisions without invocation', async t => {
  const f = await fixture(t); let calls = 0;
  for (const method of ['refreshSource', 'detachSource']) {
    const value = { id: 'fixture', revision: 1, ...(method === 'refreshSource' ? { accepted: { 'hooks.json': hash(f.document) } } : {}) };
    for (const key of Object.keys(value)) { const bad = { ...value }; Object.defineProperty(bad, key, { enumerable: true, get() { calls++; throw Error('getter'); } }); assert.throws(() => f.m[method](bad)); }
    assert.throws(() => f.m[method]({ ...value, extra: true }));
    for (const revision of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.m[method]({ ...value, revision }));
  }
  const accepted = {}; Object.defineProperty(accepted, 'hooks.json', { enumerable: true, get() { calls++; } }); assert.throws(() => f.refresh({ accepted })); assert.equal(calls, 0);
});
