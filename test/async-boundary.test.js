import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, createHookManager, parseHookOutput, parseRule } from '../core.js';
import { previewCodexImport } from '../codex-import.js';

const rule = event => ({ id: 'async-boundary', name: 'Async boundary', event, scope: { kind: 'user' }, action: { type: 'command', executable: process.execPath, argv: [] } });
const interpreter = { executable: process.execPath, argvPrefix: [] };
const completed = stdout => ({ status: 'completed', exitCode: 0, stdout: JSON.stringify(stdout), stderr: '' });
const allowed = new Set(['Stop', 'UserPromptSubmit', 'SessionStart', 'Interrupt', 'PreModelRequest', 'PostModelRequest', 'SubagentStart', 'PostToolUse', 'PreToolUse', 'PermissionRequest']);
const signals = [{ async: true }, { async: true, asyncTimeout: 1000 }, { async: false }, { asyncTimeout: 1000 }];

test('native async only accepts the explicit root notification subset and never silently downgrades', () => {
  for (const { name: event } of EVENTS) {
    const original = rule(event);
    for (const value of [true, 'true', 'false', 0, 1, null, {}, []]) {
      if (allowed.has(event) && value === true) assert.equal(parseRule({ ...original, async: value }).async, true);
      else assert.throws(() => parseRule({ ...original, async: value }), /unsupported_async_hook/);
      assert.throws(() => parseRule({ ...original, action: { ...original.action, async: value } }), /unsupported_async_hook/);
    }
    assert.deepEqual(parseRule({ ...original, async: false, action: { ...original.action, async: false } }), parseRule(original));
  }
});

test('async notifications reject full payloads, tool input and approval policy flags', () => {
  for (const event of allowed) {
    for (const extra of [{ payloadMode: 'full' }, { includeToolInput: true }, { denyPermissionRequest: true }]) {
      assert.throws(() => parseRule({ ...rule(event), async: true, ...extra }), /unsupported_async_hook/);
    }
  }
});

test('false and absent async retain the same legacy trust digest', async () => {
  for (const event of allowed) {
    const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }) });
    try {
      await manager.upsert(rule(event));
      const legacy = await manager.previewTrust('async-boundary');
      await manager.upsert({ ...rule(event), async: false });
      const explicit = await manager.previewTrust('async-boundary');
      assert.equal(explicit.digest, legacy.digest);
      assert.deepEqual(explicit.rule, legacy.rule);
    } finally { manager.dispose(); }
  }
});

test('Codex async import accepts exactly the explicit notification whitelist, with unsupported review retained', () => {
  for (const { name: event } of EVENTS) {
    const handler = { type: 'command', command: 'preview-only', async: true };
    const document = { hooks: { [event]: [{ hooks: [handler] }] } };
    const preview = previewCodexImport(document, { interpreter });
    if (allowed.has(event)) {
      assert.equal(preview.rules.length, 1);
      assert.equal(preview.rules[0].async, true);
      assert.equal(preview.rules[0].enabled, false);
      assert.equal(preview.rules[0].payloadMode, 'metadata');
      assert.equal(Object.hasOwn(preview.rules[0], 'trust'), false);
      assert.equal(preview.unsupported.length, 0);
      assert.deepEqual(preview.rules[0].review.definition.handler, handler);
      assert.ok(preview.warnings.some(warning => warning.code === 'review_required'));
      const withoutInterpreter = previewCodexImport(document);
      assert.equal(withoutInterpreter.rules.length, 0);
      assert.ok(withoutInterpreter.unsupported[0].reasons.includes('explicit_interpreter_required'));
    } else {
      assert.deepEqual(preview.rules, []);
      assert.equal(preview.unsupported.length, 1);
      assert.ok(preview.unsupported[0].reasons.includes('unsupported_async'));
      assert.deepEqual(preview.unsupported[0].definition.handler, handler);
      assert.equal(preview.unsupported[0].pointer, `/hooks/${event}/0/hooks/0`);
    }
    const synchronous = structuredClone(document);
    synchronous.hooks[event][0].hooks[0].async = false;
    const accepted = previewCodexImport(synchronous, { interpreter });
    assert.equal(accepted.unsupported.length, 0);
    assert.equal(accepted.rules[0].enabled, false);
    assert.equal(Object.hasOwn(accepted.rules[0], 'trust'), false);
  }
});

test('stdout cannot opt any mapped event into an unsupported asynchronous protocol', () => {
  for (const { name: event } of EVENTS) {
    for (const output of signals) assert.throws(() => parseHookOutput(event, completed(output)), /unsupported_hook_output/);
  }
});

async function managerFor(event, execute) {
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }), execute });
  const definition = rule(event);
  if (event === 'PermissionRequest') definition.denyPermissionRequest = true;
  await manager.upsert(definition);
  await manager.trust(definition.id, (await manager.previewTrust(definition.id)).digest);
  await manager.toggle(definition.id, true);
  await manager.configure({ enabled: true });
  return manager;
}

test('async stdout fails closed for PreToolUse and explicitly enforced approval policies', async () => {
  for (const event of ['PreToolUse', 'PermissionRequest']) {
    for (const output of signals) {
      let calls = 0;
      const manager = await managerFor(event, async () => { calls++; return completed(output); });
      try {
        const decision = event === 'PermissionRequest' ? await manager.dispatchPermissionRequest() : await manager.dispatchProtocol(event);
        assert.equal(decision.blocked, true);
        assert.equal(calls, 1);
        assert.equal(manager.snapshot().records[0].status, 'protocol_error');
        if (event === 'PermissionRequest') assert.equal(manager.snapshot().records[0].policyOutcome, 'deny');
      } finally { manager.dispose(); }
    }
  }
});

test('a pending synchronous tool gate never delegates before its hook settles', async () => {
  let release;
  let invoked;
  const started = new Promise(resolve => { invoked = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const manager = await managerFor('PreToolUse', () => { invoked(); return pending; });
  try {
    let settled = false;
    const dispatch = manager.dispatchProtocol('PreToolUse').then(decision => { settled = true; return decision; });
    await started;
    await Promise.resolve();
    assert.equal(settled, false);
    release(completed({ async: true }));
    assert.equal((await dispatch).blocked, true);
  } finally { manager.dispose(); }
});
