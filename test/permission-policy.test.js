import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHookManager, parseRule, parseHookOutput } from '../core.js';
import { bindEvents } from '../index.js';

const rule = (extra = {}) => ({ id: 'policy', name: 'Policy', event: 'PermissionRequest', scope: { kind: 'user' }, enabled: false, action: { type: 'command', executable: process.execPath, argv: [] }, ...extra });
const result = stdout => ({ status: 'completed', exitCode: 0, stdout, stderr: '' });
const output = (behavior, extra = {}) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, ...extra } } });
const fingerprint = async () => ({ digest: 'f'.repeat(64), files: [] });
async function setup(execute, extra = {}) {
  const manager = createHookManager({ persist: async () => {}, fingerprint, execute });
  await manager.upsert(rule({ denyPermissionRequest: true, ...extra }));
  const preview = await manager.previewTrust('policy');
  await manager.trust('policy', preview.digest);
  await manager.toggle('policy', true);
  await manager.configure({ enabled: true });
  return manager;
}
function listener(manager) {
  const handlers = new Map();
  const agent = { id: 'session' }, session = { id: 'session' };
  bindEvents({ agents: { list: () => [agent], get: () => agent }, sessions: { get: () => session }, workingDirectory: { get: () => process.cwd() }, on: (event, fn) => { handlers.set(event, fn); return () => {}; } }, manager);
  return { invoke: handlers.get('approval/request'), agent };
}

test('opt-in normalization preserves legacy definitions and trust fingerprints', async () => {
  const original = parseRule(rule());
  assert.deepEqual(parseRule(rule({ denyPermissionRequest: false })), original);
  assert.equal(Object.hasOwn(original, 'denyPermissionRequest'), false);
  assert.throws(() => parseRule(rule({ denyPermissionRequest: 'true' })));
  assert.throws(() => parseRule(rule({ event: 'PreToolUse', denyPermissionRequest: true })));
  const manager = await setup(async () => result(''), { denyPermissionRequest: false });
  const legacy = await manager.previewTrust('policy');
  assert.equal(legacy.digest, createHash('sha256').update(JSON.stringify({ version: 1, rule: legacy.rule, fingerprint: 'f'.repeat(64), files: [] })).digest('hex'));
  await manager.upsert({ ...rule(), denyPermissionRequest: true });
  const updated = await manager.previewTrust('policy');
  assert.notEqual(updated.digest, legacy.digest);
  const saved = manager.snapshot().rules[0];
  assert.equal(saved.enabled, false);
  assert.equal(saved.trust, undefined);
  assert.equal(saved.denyPermissionRequest, true);
});

test('dedicated strict output accepts only nested deny/allow or abstention', () => {
  assert.equal(parseHookOutput('PermissionRequest', result(output('deny', { message: 'No' }))).blocked, true);
  for (const value of ['', 'plain stdout deny', '{}', '{"hookSpecificOutput":{"hookEventName":"PermissionRequest"}}', output('allow')]) assert.equal(parseHookOutput('PermissionRequest', result(value)).blocked, false);
  for (const value of ['{', '[]', '{"decision":"block"}', '{"continue":false}', '{"stopReason":"no"}', output('deny', { updatedInput: {} }), output('deny', { updatedPermissions: [] }), output('deny', { interrupt: true }), output('deny', { message: '\n' }), output('deny', { message: 'x'.repeat(1025) }), output('ask')]) assert.throws(() => parseHookOutput('PermissionRequest', result(value)));
});

test('valid deny rejects, records message, never executes twice or accesses private request data', async () => {
  let calls = 0;
  const manager = await setup(async (_action, payload) => { calls++; assert.equal(Object.hasOwn(payload, 'tool_input'), false); return result(output('deny', { message: 'Policy denial' })); }, { payloadMode: 'full' });
  const { invoke, agent } = listener(manager);
  const request = { agent, toolName: 'shell' };
  for (const key of ['name', 'arguments', 'reason', 'displayReason', 'callId']) Object.defineProperty(request, key, { get() { throw Error('private field'); } });
  assert.equal(await invoke(request, () => assert.fail('must not delegate')), 'rejected');
  assert.equal(calls, 1);
  assert.equal(manager.snapshot().records[0].diagnostic, 'Policy denial');
  assert.equal(manager.snapshot().records[0].policyOutcome, 'deny');
  assert.equal(manager.snapshot().rules[0].policyOutcome, undefined);
});

test('allow and empty delegate exact next outcomes; no manufactured approval', async () => {
  for (const stdout of [output('allow'), '{}', '', 'plain deny']) {
    const manager = await setup(async () => result(stdout));
    const { invoke, agent } = listener(manager);
    for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
      assert.equal(await invoke({ agent, toolName: 'shell' }, async () => outcome), outcome);
      assert.equal(manager.snapshot().records[0].policyOutcome, 'abstain');
    }
  }
});

test('local enforced failures fail closed, including exit 2 (not an official denial protocol)', async () => {
  const failures = [result('{'), result(output('deny', { interrupt: true })), { ...result(''), exitCode: 2 }, { ...result(''), exitCode: 1 }, ...['spawn_error', 'timeout', 'busy', 'output_limit'].map(status => ({ ...result(''), status }))];
  for (const failure of failures) {
    const manager = await setup(async () => failure);
    const { invoke, agent } = listener(manager);
    assert.equal(await invoke({ agent, toolName: 'shell' }, () => assert.fail('must not delegate')), 'rejected');
    assert.equal(manager.snapshot().records[0].policyOutcome, 'deny');
  }
  let broken = false;
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => { if (broken) throw Error('hook_trust_changed'); return fingerprint(); }, execute: () => assert.fail('untrusted execution') });
  await manager.upsert(rule({ denyPermissionRequest: true }));
  await manager.trust('policy', (await manager.previewTrust('policy')).digest);
  await manager.toggle('policy', true); await manager.configure({ enabled: true }); broken = true;
  assert.equal((await manager.dispatchPermissionRequest({ toolName: 'shell' })).blocked, true);
});

test('abort dominates before and during enforcement and delegation', async () => {
  let finish;
  const controller = new AbortController();
  const { invoke, agent } = listener({ dispatchPermissionRequest: () => new Promise(resolve => { finish = resolve; }), dispatch: async () => false });
  const pending = invoke({ agent, toolName: 'shell', signal: controller.signal }, () => assert.fail('aborted delegation'));
  await Promise.resolve(); controller.abort();
  assert.equal(await pending, 'cancelled'); finish({ blocked: true });
  assert.equal(await invoke({ agent, signal: controller.signal }, () => assert.fail()), 'cancelled');
  const later = new AbortController();
  const bound = listener({ dispatchPermissionRequest: async () => ({ blocked: false }), dispatch: async () => false });
  assert.equal(await bound.invoke({ agent: bound.agent, toolName: 'shell', signal: later.signal }, async () => { later.abort(); return 'allowed-once'; }), 'cancelled');
});

test('legacy observation is fire-and-forget and separate from enforced selection', async () => {
  let observationStarted = false;
  const manager = await setup(async () => { observationStarted = true; return new Promise(() => {}); }, { denyPermissionRequest: false });
  const { invoke, agent } = listener(manager);
  assert.equal(await invoke({ agent, toolName: 'shell' }, async () => 'unavailable'), 'unavailable');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observationStarted, true);
  manager.dispose();
});

test('manager capacity and matcher failures fail closed without extra execution', async () => {
  const finish = [];
  const manager = await setup(() => new Promise(resolve => finish.push(resolve)));
  const active = Array.from({ length: 4 }, () => manager.dispatchPermissionRequest({ toolName: 'shell' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finish.length, 4);
  assert.equal((await manager.dispatchPermissionRequest({ toolName: 'shell' })).blocked, true);
  assert.equal(manager.snapshot().records[0].status, 'busy');
  for (const resolve of finish) resolve(result('{}'));
  await Promise.all(active);
  const matcher = await setup(() => assert.fail('matcher must fail first'), { matcherMode: 'regex', matcher: '(a+)+$' });
  const failed = await matcher.dispatchPermissionRequest({ toolName: 'a'.repeat(250) + '!' });
  assert.equal(failed.blocked, true);
  assert.equal(matcher.snapshot().records[0].status, 'matcher_timeout');
});

test('ordinary PermissionRequest observations never return control even for valid deny JSON', async () => {
  const manager = await setup(async () => result(output('deny', { message: 'Observation only' })), { denyPermissionRequest: false });
  assert.equal(await manager.dispatch('PermissionRequest', { toolName: 'shell' }), false);
  assert.deepEqual(await manager.dispatchProtocol('PermissionRequest', { toolName: 'shell' }), { blocked: false, reason: '', feedback: [] });
  assert.equal(manager.snapshot().records.length, 2);
  assert.ok(manager.snapshot().records.every(record => !Object.hasOwn(record, 'policyOutcome')));
});

test('manager disposal cancels pending enforcement without request signal or delegation', async () => {
  let started, active = 0;
  const running = new Promise(resolve => { started = resolve; });
  const manager = await setup((_action, _payload, { signal }) => new Promise(resolve => {
    active++; started();
    signal.addEventListener('abort', () => { active--; resolve({ ...result(''), status: 'cancelled', exitCode: null }); }, { once: true });
  }));
  const { invoke, agent } = listener(manager);
  const pending = invoke({ agent, toolName: 'shell' }, () => assert.fail('disposed enforcement must not delegate'));
  await running; manager.dispose();
  assert.equal(await pending, 'cancelled');
  assert.equal(active, 0);
  assert.equal(manager.snapshot().records[0].status, 'cancelled');
  assert.equal(manager.snapshot().records[0].policyOutcome, 'cancelled');
  assert.deepEqual(await manager.dispatchPermissionRequest({ toolName: 'shell' }), { blocked: false, reason: '', feedback: [], cancelled: true });
  assert.deepEqual(await manager.dispatchProtocol('PermissionRequest'), { blocked: false, reason: '', feedback: [] });
});

test('allow does not short-circuit later deny; all abstaining policies delegate exactly once', async () => {
  for (const laterDeny of [true, false]) {
    let calls = 0, delegated = 0;
    const manager = await setup(async () => { calls++; return result(output('allow')); });
    await manager.upsert(rule({ id: 'second', denyPermissionRequest: true, action: { ...rule().action, argv: ['second'] } }));
    await manager.trust('second', (await manager.previewTrust('second')).digest);
    await manager.toggle('second', true);
    // Distinguish executors by a fixed reviewed command argument, not private input.
    const persisted = manager.snapshot();
    const arbitration = createHookManager({ initial: persisted, persist: async () => {}, fingerprint, execute: async action => { calls++; return result(action.argv[0] === 'second' ? laterDeny ? output('deny', { message: 'Diagnostic only' }) : '{}' : output('allow')); } });
    const { invoke, agent } = listener(arbitration);
    for (const outcome of ['rejected', 'unavailable']) {
      const before = calls;
      assert.equal(await invoke({ agent, toolName: 'shell' }, async () => { delegated++; return outcome; }), laterDeny ? 'rejected' : outcome);
      assert.equal(calls - before, 2);
      assert.deepEqual(arbitration.snapshot().records.slice(0, 2).map(record => [record.ruleId, record.policyOutcome]), [['second', laterDeny ? 'deny' : 'abstain'], ['policy', 'abstain']]);
    }
    assert.equal(delegated, laterDeny ? 0 : 2);
  }
});

test('only matching enabled scoped trusted policies execute', async () => {
  let calls = 0;
  const manager = await setup(async () => { calls++; return result(output('deny')); }, { matcher: 'other' });
  assert.equal((await manager.dispatchPermissionRequest({ toolName: 'shell' })).blocked, false);
  assert.equal(calls, 0);
  await manager.upsert(rule({ denyPermissionRequest: true }));
  assert.equal((await manager.dispatchPermissionRequest({ toolName: 'shell' })).blocked, false);
  const project = await setup(async () => { calls++; return result(output('deny')); }, { scope: { kind: 'project', root: process.cwd() } });
  assert.equal((await project.dispatchPermissionRequest({ toolName: 'shell' })).blocked, false);
  assert.equal(calls, 0);
  assert.equal(manager.snapshot().records.length, 0);
  assert.equal(project.snapshot().records.length, 1);
  assert.equal(Object.hasOwn(project.snapshot().records[0], 'policyOutcome'), false);
  assert.equal((await project.dispatchPermissionRequest({ toolName: 'shell', getEffectiveDirectory: () => process.cwd() })).blocked, true);
  assert.equal(calls, 1);
});

test('request cancellation overrides a completed deny record and preserves record bounds and redaction', async () => {
  const controller = new AbortController();
  const manager = await setup(async () => { controller.abort(); return result(output('deny', { message: 'Private diagnostic' })); }, { payloadMode: 'full' });
  assert.equal((await manager.dispatchPermissionRequest({ toolName: 'shell' }, controller.signal)).cancelled, true);
  const record = manager.snapshot().records[0];
  assert.equal(record.status, 'completed');
  assert.equal(record.policyOutcome, 'cancelled');
  assert.equal(record.diagnostic, undefined);
  assert.equal(record.stdout, '');
  assert.equal(record.stderr, '');
});

test('policy outcomes remain bounded record-only enums and other events are unaffected', async () => {
  const configured = await setup(async () => result('{}'));
  const manager = createHookManager({ initial: configured.snapshot(), persist: async () => {}, fingerprint, execute: async () => result('{}'), maxRecords: 2 });
  for (let i = 0; i < 3; i++) await manager.dispatchPermissionRequest({ toolName: 'shell' });
  assert.equal(manager.snapshot().records.length, 2);
  assert.ok(manager.snapshot().records.every(record => record.policyOutcome === 'abstain'));
  const other = await setup(async () => result(''), { event: 'PostToolUse', denyPermissionRequest: false });
  await other.dispatch('PostToolUse', { toolName: 'shell' });
  assert.equal(Object.hasOwn(other.snapshot().records[0], 'policyOutcome'), false);
});
