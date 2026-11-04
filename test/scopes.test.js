import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseScope, canonicalizeScope, matchesScope, directoryIdentity } from '../scope.js';
import { createHookManager, parseRule } from '../core.js';
import { bindEvents } from '../index.js';
import { previewCodexImport } from '../codex-import.js';
const rule = scope => ({ id: 'scope', name: 'Scope', event: 'PreToolUse', scope, includeToolInput: true, action: { type: 'command', executable: process.execPath } });
test('scope is closed and defaults user; Windows identity and POSIX case remain distinct', () => {
  assert.deepEqual(parseScope(), { kind: 'user' });
  for (const scope of [{ kind: 'all' }, { kind: 'user', root: '/' }, { kind: 'project', root: 'relative' }, { kind: 'project', root: '/', extra: true }]) assert.throws(() => parseScope(scope));
  assert.deepEqual(parseRule(rule()).scope, { kind: 'user' });
  assert.equal(directoryIdentity('C:\\A\\', 'win32'), directoryIdentity('c:/a', 'win32'));
  assert.notEqual(directoryIdentity('/A', 'linux'), directoryIdentity('/a', 'linux'));
});
test('explicit import scopes distinguish IDs without changing provenance', () => {
  const document = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'fixture', timeout: 1 }] }] } };
  const options = { interpreter: { executable: process.execPath, argvPrefix: [] } };
  const first = previewCodexImport(document, { ...options, scope: { kind: 'project', root: path.resolve('a') } });
  const second = previewCodexImport(document, { ...options, scope: { kind: 'project', root: path.resolve('b') } });
  assert.notEqual(first.rules[0].id, second.rules[0].id);
  assert.deepEqual(first.rules[0].review, second.rules[0].review);
  assert.equal(first.rules[0].id, previewCodexImport(document, { ...options, scope: { kind: 'project', root: path.resolve('a') } }).rules[0].id);
});
test('legacy trusted rules load disabled and untrusted without filesystem hashing', () => {
  const legacy = rule(); delete legacy.scope; legacy.enabled = true; legacy.trust = { digest: 'a'.repeat(64) };
  const m = createHookManager({ initial: { enabled: true, rules: [legacy] }, persist: async () => {}, fingerprint() { throw new Error('must not hash'); } });
  try { const saved = m.snapshot().rules[0]; assert.equal(saved.enabled, false); assert.equal(saved.trust, undefined); assert.deepEqual(saved.scope, { kind: 'user' }); } finally { m.dispose(); }
});
test('project scope canonicalizes atomically, matches exact cwd before private reads/hash and loses eligibility when deleted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-scope-'));
  const child = path.join(root, 'child'); await mkdir(child);
  let hashes = 0, reads = 0, executions = 0, writes = 0;
  const m = createHookManager({ persist: async () => { writes++; }, fingerprint: async () => { hashes++; return { digest: 'fixture', files: [] }; }, execute: async () => { executions++; return { status: 'completed', exitCode: 0, stdout: '', stderr: '' }; } });
  try {
    await m.upsert(rule({ kind: 'project', root: path.join(root, '.') }));
    assert.deepEqual(m.snapshot().rules[0].scope, await canonicalizeScope({ kind: 'project', root }));
    const preview = await m.previewTrust('scope'); await m.trust('scope', preview.digest); await m.toggle('scope', true); await m.configure({ enabled: true });
    hashes = 0;
    const metadata = { sessionId: 'spoof', getToolInput() { reads++; return {}; } };
    await m.dispatch('PreToolUse', metadata);
    await m.dispatch('PreToolUse', { ...metadata, getEffectiveDirectory: () => child });
    assert.deepEqual([hashes, reads, executions], [0, 0, 0]);
    await m.dispatch('PreToolUse', { ...metadata, getEffectiveDirectory: () => root });
    assert.deepEqual([hashes, reads, executions], [1, 1, 1]);
    const before = writes;
    await assert.rejects(m.importRules([rule({ kind: 'project', root: path.join(root, 'missing') })]));
    assert.equal(writes, before);
    await rm(root, { recursive: true });
    assert.equal(await matchesScope(m.snapshot().rules[0].scope, root), false);
    await m.dispatch('PreToolUse', { ...metadata, getEffectiveDirectory: () => root });
    assert.equal(executions, 1);
  } finally { m.dispose(); await rm(root, { recursive: true, force: true }); }
});
test('adapters use exact host Agent/Session and effective directory, never submitted session IDs', async () => {
  const listeners = new Map(), session = { id: 'host', header: { cwd: '/original' } };
  const seen = [], agent = { id: 'host' };
  const ctx = { agents: { get: () => agent, list: () => [agent] }, on(name, fn) { listeners.set(name, fn); return () => {}; }, sessions: { get(id) { return id === 'host' ? session : undefined; } }, workingDirectory: { get(value) { assert.equal(value, session); return '/effective'; } } };
  const manager = { async dispatch(_event, metadata) { seen.push(metadata.getEffectiveDirectory?.()); }, async dispatchDecision(_event, metadata) { seen.push(metadata.getEffectiveDirectory?.()); return { blocked: false }; } };
  const off = bindEvents(ctx, manager);
  try {
    await listeners.get('tools/pre-execute')({ agent, arguments: { submittedsessionId: 'other' }, signal: new AbortController().signal }, async () => ({}));
    listeners.get('agent/created')({ agent, source: 'startup' });
    listeners.get('agent/disposed')({ agent });
    await listeners.get('tools/pre-execute')({ arguments: { sessionId: 'host' }, signal: new AbortController().signal }, async () => ({}));
    assert.deepEqual(seen, ['/effective', '/effective', '/effective', undefined]);
  } finally { off(); }
});
