import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { previewCodexImport, previewCodexSources, parseCodexSourcesRequest } from '../codex-import.js';
import { extractTomlHooks } from '../toml-config.js';
import { mountRpc, descriptors } from '../rpc.js';
import { createHookManager } from '../core.js';

const source = digit => `codex-file:${digit.repeat(64)}`;
const options = { interpreter: { executable: process.execPath, argvPrefix: ['-e'] } };
const document = (count = 1, type = 'command') => JSON.stringify({ hooks: { PreToolUse: [{ hooks: Array.from({ length: count }, () => ({ type, command: 'never executed' })) }] } });
const request = () => ({ documents: [{ document: document(), source: source('a') }, { document: document(), source: source('b') }], options });
function rpc(manager) {
  const peer = { principal: { kind: 'owner' } };
  const ctx = { invocation: { peer }, connection: { browserPeer: peer }, typert: { register: () => () => {} } };
  let service;
  class Remote { constructor(context) { this.ctx = context; service = this; } }
  mountRpc(ctx, manager, Remote);
  return { ctx, peer, service };
}

test('batch interpreter rejects cmd and bat suffixes like the original importer', () => {
  for (const suffix of ['cmd', 'bat', 'CMD', 'BAT']) {
    const input = request();
    input.options = { interpreter: { executable: path.resolve(`unsafe.${suffix}`), argvPrefix: [] } };
    assert.throws(() => parseCodexSourcesRequest(input), /codex_import_invalid_interpreter/);
    assert.throws(() => previewCodexSources(input), /codex_import_invalid_interpreter/);
    assert.throws(() => previewCodexImport(input.documents[0].document, input.options), /codex_import_invalid_interpreter/);
  }
});

test('JSON then extracted TOML import is cumulative, source-specific, atomic and disabled', async () => {
  const input = request();
  input.documents[1].document = await extractTomlHooks('[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype="command"\ncommand="never executed"');
  const preview = previewCodexSources(input);
  const expected = input.documents.map(entry => previewCodexImport(entry.document, { ...options, source: entry.source }));
  assert.deepEqual(preview, { rules: expected.flatMap(p => p.rules), warnings: expected.flatMap(p => p.warnings), unsupported: [] });
  assert.notEqual(preview.rules[0].id, preview.rules[1].id);
  assert.deepEqual(preview.rules.map(r => r.review.source), [source('a'), source('b')]);
  const writes = [];
  const manager = createHookManager({ persist: async snapshot => writes.push(structuredClone(snapshot)), execute: () => { throw Error('must not execute'); } });
  try {
    const { service } = rpc(manager);
    assert.deepEqual(service.previewSourceImports(input), preview);
    await service.importSources(input);
    assert.equal(writes.length, 1);
    const snapshot = manager.snapshot();
    assert.equal(snapshot.enabled, false);
    assert.deepEqual(snapshot.rules.map(r => r.id), preview.rules.map(r => r.id));
    assert.ok(snapshot.rules.every(r => !r.enabled));
    assert.deepEqual(snapshot.rules.map(r => r.review), preview.rules.map(r => r.review));
  } finally { manager.dispose(); }
});

test('unsupported mixed batch never invokes manager, and all owner boundaries precede parsing', () => {
  let calls = 0;
  const { service, ctx, peer } = rpc({ importRules() { calls++; } });
  const input = request();
  input.documents[1].document = document(1, 'prompt');
  assert.equal(service.previewSourceImports(input).unsupported.length, 1);
  assert.throws(() => service.importSources(input), /hook_import_contains_unsupported/);
  assert.equal(calls, 0);
  for (const denied of [undefined, { principal: { kind: 'owner' } }, { principal: { kind: 'remote' } }]) {
    ctx.invocation.peer = denied;
    for (const method of ['previewSourceImports', 'importSources']) assert.throws(() => service[method](null), /local_owner_client_required/);
  }
  ctx.invocation.peer = peer;
  for (const method of ['previewSourceImports', 'importSources']) {
    const descriptor = descriptors.find(d => d.method === method);
    assert.equal(descriptor.parameters[0].codec.mode, 'strict');
    assert.deepEqual(descriptor.parameters[0].codec.create().parse(request()), parseCodexSourcesRequest(request()));
  }
});

test('closed bounded transport rejects malformed sources, shapes and accessors without invoking getters', () => {
  const bad = [null, {}, { documents: [] }, { ...request(), extra: true }, { ...request(), documents: [...request().documents, request().documents[0]] }];
  for (const value of ['', 'codex-file:a', `codex-file:${'A'.repeat(64)}`, source('b')]) {
    const input = request(); input.documents[0].source = value; bad.push(input);
  }
  bad.push({ ...request(), options: { ...options, source: source('a') } });
  bad.push({ ...request(), documents: [{ document: {}, source: source('a') }] });
  bad.push({ ...request(), documents: [{ document: 'é'.repeat(131073), source: source('a') }] });
  bad.push({ ...request(), documents: Array(1) });
  bad.push(Object.assign(Object.create({ inherited: true }), request()));
  bad.push({ ...request(), options: Object.create({ interpreter: options.interpreter }) });
  bad.push({ ...request(), options: { interpreter: { ...options.interpreter, argvPrefix: Array(1) } } });
  let getters = 0;
  const accessor = () => { getters++; throw Error('getter executed'); };
  bad.push(Object.defineProperty({}, 'documents', { enumerable: true, get: accessor }));
  bad.push({ ...request(), documents: [Object.defineProperty({ source: source('a') }, 'document', { enumerable: true, get: accessor })] });
  bad.push({ ...request(), documents: Object.defineProperty([], '0', { enumerable: true, get: accessor }) });
  bad.push({ ...request(), options: Object.defineProperty({}, 'scope', { enumerable: true, get: accessor }) });
  bad.push({ ...request(), options: { scope: Object.defineProperty({}, 'kind', { enumerable: true, get: accessor }) } });
  bad.push({ ...request(), options: { interpreter: Object.defineProperty({}, 'executable', { enumerable: true, get: accessor }) } });
  const decorated = request(); decorated.documents.extra = true; bad.push(decorated);
  const symbol = request(); symbol.documents[0][Symbol('extra')] = true; bad.push(symbol);
  const protoKey = request(); Object.defineProperty(protoKey.documents[0], '__proto__', { enumerable: true, value: {} }); bad.push(protoKey);
  for (const input of bad) {
    assert.throws(() => parseCodexSourcesRequest(input));
    assert.throws(() => previewCodexSources(input));
    for (const method of ['previewSourceImports', 'importSources']) assert.throws(() => descriptors.find(d => d.method === method).parameters[0].codec.create().parse(input));
  }
  assert.equal(getters, 0);
});

test('real manager rejects existing IDs atomically and rolls back failed batch persistence', async () => {
  let fail = false, writes = 0;
  const manager = createHookManager({ persist: async () => { writes++; if (fail) throw Error('disk fixture'); } });
  try {
    const { service } = rpc(manager);
    const input = request();
    await service.importSources({ documents: [input.documents[0]], options });
    const before = manager.snapshot();
    await assert.rejects(service.importSources(input), /duplicate_hook_id/);
    assert.equal(writes, 1);
    assert.deepEqual(manager.snapshot(), before);
    // Use two fresh provenance labels; a disk failure must keep the earlier source.
    const fresh = request(); fresh.documents[0].source = source('c'); fresh.documents[1].source = source('d');
    fail = true;
    await assert.rejects(service.importSources(fresh), /disk fixture/);
    assert.equal(writes, 2);
    assert.deepEqual(manager.snapshot(), before);
    fail = false;
    await service.importSources(fresh);
    assert.equal(writes, 3);
    assert.deepEqual(manager.snapshot().rules.map(r => r.source), [source('a'), source('c'), source('d')]);
    assert.ok(manager.snapshot().rules.every(r => !r.enabled && !r.trust));
  } finally { manager.dispose(); }
});

test('aggregate handler bounds count unsupported too and retain per-document bounds', () => {
  for (const [first, second, type] of [[51, 50, 'command'], [50, 51, 'prompt'], [101, 1, 'command']]) {
    const input = request(); input.documents[0].document = document(first); input.documents[1].document = document(second, type);
    assert.throws(() => previewCodexSources(input), /codex_import_handler_limit/);
    let calls = 0; const { service } = rpc({ importRules() { calls++; } });
    assert.throws(() => service.importSources(input), /codex_import_handler_limit/); assert.equal(calls, 0);
  }
  const input = request(); input.documents[0].document = document(50); input.documents[1].document = document(50);
  assert.equal(previewCodexSources(input).rules.length, 100);
});
