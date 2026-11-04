import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager, parseRule, cloneToolInput, EVENTS } from '../core.js';
import { bindEvents } from '../index.js';

const rule = (extra = {}) => ({ id: 'r', name: 'Rule', event: 'PreToolUse', enabled: true, action: { type: 'command', executable: process.execPath }, ...extra });
const result = (stdout = '', exitCode = 0) => ({ status: 'completed', exitCode, stdout, stderr: 'private diagnostic' });
const json = (permissionDecision, permissionDecisionReason) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...(permissionDecisionReason === undefined ? {} : { permissionDecisionReason }) } });
const manager = async (execute, rules = [rule()]) => { const m = createHookManager({ initial: { enabled: true, rules }, persist: async () => {}, execute, fingerprint: async () => ({ digest: 'fixture', files: [] }) }); for (const r of rules) { const p = await m.previewTrust(r.id); await m.trust(r.id, p.digest); if (r.enabled) await m.toggle(r.id, true); } return m; };
const bindings = m => { const listeners = new Map(); const off = bindEvents({ on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); } }, m); return { listeners, off }; };

test('input option defaults false, is boolean/tool-only, and edits always disable', async () => {
  assert.equal(parseRule(rule()).includeToolInput, false);
  for (const includeToolInput of [null, 1, 'true']) assert.throws(() => parseRule(rule({ includeToolInput })));
  for (const event of EVENTS.filter(e => !['PreToolUse', 'PostToolUse'].includes(e.name)).map(e => e.name)) {
    assert.throws(() => parseRule(rule({ event, includeToolInput: true })));
    assert.equal(parseRule(rule({ event })).includeToolInput, false);
  }
  const m = await manager(async () => result());
  await m.upsert(rule({ includeToolInput: true }));
  assert.equal(m.snapshot().rules[0].enabled, false);
  assert.equal(m.snapshot().rules[0].includeToolInput, true);
  m.dispose();
});

test('default, disabled, unmatched and unrelated rules never read tool arguments', async () => {
  for (const options of [{}, { enabled: false, includeToolInput: true }, { matcher: 'other', includeToolInput: true }]) {
    const payloads = [], m = await manager(async (_a, p) => { payloads.push(p); return result(); }, [rule(options)]);
    const { listeners, off } = bindings(m);
    const exec = { name: 'tool', get arguments() { throw Error('must_not_read'); } };
    assert.deepEqual(await listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'ask' })), { kind: 'ask' });
    assert.equal(JSON.stringify(payloads).includes('tool_input'), false);
    off(); m.dispose();
  }
});

test('pre/post input is cloned per rule and never retained even if command echoes it', async () => {
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const input = { password: 'input-secret', nested: [1, null, true] }, payloads = [];
    const m = await manager(async (_a, p) => { payloads.push(p); p.tool_input.nested.push(2); return result(JSON.stringify(p)); }, [rule({ event, includeToolInput: true })]);
    await m.dispatchDecision(event, { getToolInput: () => input });
    assert.notEqual(payloads[0].tool_input, input);
    assert.deepEqual(input.nested, [1, null, true]);
    assert.equal(JSON.stringify(m.snapshot().records).includes('input-secret'), false);
    assert.equal(m.snapshot().records[0].stderr, '');
    m.dispose();
  }
});

test('input serialization enforces exact UTF-8 64KiB boundary and rejects invalid JSON safely', async () => {
  const exact = { x: 'a'.repeat(65528) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 65536);
  assert.deepEqual(cloneToolInput(exact), exact);
  const cycle = {}; cycle.self = cycle;
  const getter = { get secret() { throw Error('getter'); } };
  const invalid = [undefined, null, 'bad', [], { x: 'a'.repeat(65529) }, { x: '中'.repeat(22000) }, cycle, { x: 1n }, { x: undefined }, { x: NaN }, { x: () => 1 }, { x: new Date() }, getter, { x: new Array(65537) }];
  let deep = {}; for (let i = 0; i < 70; i++) deep = { x: deep }; invalid.push(deep);
  for (const input of invalid) {
    let calls = 0;
    const m = await manager(async () => { calls++; return result(); }, [rule({ includeToolInput: true })]);
    const decision = await m.dispatchDecision('PreToolUse', { getToolInput: () => input });
    assert.equal(decision.blocked, true);
    assert.equal(calls, 0);
    assert.equal(m.snapshot().records[0].status, 'internal_error');
    m.dispose();
  }
  const post = await manager(async () => { throw Error('must_not_spawn'); }, [rule({ event: 'PostToolUse', includeToolInput: true })]);
  assert.equal(await post.dispatch('PostToolUse', { getToolInput: () => cycle }), false);
  post.dispose();
});

test('deny at exit zero carries validated reason, allow abstains and plain text is advisory', async () => {
  for (const stdout of ['', 'advisory text', json('allow')]) {
    const m = await manager(async () => result(stdout));
    assert.deepEqual(await m.dispatchDecision('PreToolUse'), { blocked: false, reason: '' });
    const { listeners, off } = bindings(m);
    assert.deepEqual(await listeners.get('tools/pre-execute')({ name: 'x' }, async () => ({ kind: 'ask' })), { kind: 'ask' });
    off(); m.dispose();
  }
  const m = await manager(async () => result(json('deny', 'Owner policy denied this call.')));
  assert.deepEqual(await m.dispatchDecision('PreToolUse'), { blocked: true, reason: 'Owner policy denied this call.' });
  assert.equal(await m.dispatch('PreToolUse'), true);
  const { listeners, off } = bindings(m);
  assert.deepEqual(await listeners.get('tools/pre-execute')({}, () => assert.fail('next called')), { kind: 'deny', reason: 'Owner policy denied this call.' });
  off(); m.dispose();
});

test('malformed/unsupported control or rewrite JSON fails closed only on pretool', async () => {
  const invalid = ['{', '[1]', '{}', JSON.stringify({ decision: 'allow' }), json('ask'), json('deny', ''), json('deny', 'x'.repeat(1025)), json('deny', 'bad\nreason'), json('deny', 3), JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'allow' } }), JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: {} } }), JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })];
  for (const stdout of invalid) {
    const m = await manager(async () => result(stdout), [rule(), rule({ id: 'post', event: 'PostToolUse' })]);
    assert.equal((await m.dispatchDecision('PreToolUse')).blocked, true, stdout);
    assert.equal(await m.dispatch('PostToolUse'), false);
    m.dispose();
  }
});

test('unsupported updatedInput cannot mutate frozen original execution or delegate rewritten arguments', async () => {
  for (const includeToolInput of [false, true]) {
    const input = Object.freeze({ marker: 'private-original-input', nested: Object.freeze({ mode: 'original' }) });
    const token = Symbol('original-execution');
    const exec = Object.freeze({ name: 'fixture', callId: 'fixture-call', arguments: input, token, signal: new AbortController().signal });
    const m = await manager(async (_action, payload) => {
      if (includeToolInput) { assert.notEqual(payload.tool_input, input); payload.tool_input.nested.mode = 'attempted-copy-mutation'; }
      return result(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { marker: 'private-replacement-input' } } }));
    }, [rule({ includeToolInput })]);
    const { listeners, off } = bindings(m);
    try {
      const decision = await listeners.get('tools/pre-execute')(exec, async () => assert.fail('unsupported rewrite must not delegate'));
      assert.equal(decision.kind, 'deny');
      assert.equal(exec.arguments, input); assert.equal(exec.token, token);
      assert.equal(input.nested.mode, 'original');
      const diagnostics = JSON.stringify(m.snapshot().records);
      assert.equal(diagnostics.includes('private-original-input'), false);
      // Metadata-only hooks retain their bounded command diagnostics; opt-in tool-input hooks redact output.
      assert.equal(diagnostics.includes('private-replacement-input'), !includeToolInput);
    } finally { off(); m.dispose(); }
  }
});
test('exit 2/failure use static safe reason, and allow does not bypass later deny rules', async () => {
  for (const response of [result('secret', 2), { status: 'timeout', stdout: 'secret', stderr: 'secret' }]) {
    const m = await manager(async () => response);
    const decision = await m.dispatchDecision('PreToolUse');
    assert.equal(decision.blocked, true); assert.equal(decision.reason.includes('secret'), false); m.dispose();
  }
  let calls = 0;
  const m = await manager(async () => result(json(++calls === 1 ? 'allow' : 'deny', 'Later rule')), [rule(), rule({ id: 'later' })]);
  assert.deepEqual(await m.dispatchDecision('PreToolUse'), { blocked: true, reason: 'Later rule' });
  assert.equal(calls, 2); m.dispose();
});

test('concurrent invocation reasons are local, not shared mutable state', async () => {
  const releases = new Map();
  const m = await manager(async (_a, p) => new Promise(resolve => releases.set(p.tool_name, () => resolve(result(json('deny', p.tool_name))))));
  const a = m.dispatchDecision('PreToolUse', { toolName: 'first' });
  const b = m.dispatchDecision('PreToolUse', { toolName: 'second' });
  while (releases.size < 2) await new Promise(resolve => setImmediate(resolve));
  releases.get('second')(); assert.deepEqual(await b, { blocked: true, reason: 'second' });
  releases.get('first')(); assert.deepEqual(await a, { blocked: true, reason: 'first' });
  m.dispose();
});

test('subagent lifecycle is metadata-only observation with no veto or assistant read', async () => {
  const payloads = [];
  const m = await manager(async (_a, p) => { payloads.push(p); return result(json('deny', 'ignored'), 2); }, [rule({ event: 'SubagentStart' }), rule({ id: 'end', event: 'SubagentStop' })]);
  const { listeners, off } = bindings(m);
  const info = { id: 'child', provider: 'harness', runId: 'run', local: true, stopReason: 'completed', get lastAssistantMessage() { throw Error('private'); } };
  assert.equal(listeners.get('subagent/start')(info), undefined);
  assert.equal(listeners.get('subagent/end')(info), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads.map(p => [p.hook_event_name, p.child_id, p.provider, p.run_id, p.local, p.stop_reason]), [['SubagentStart', 'child', 'harness', 'run', true, undefined], ['SubagentStop', 'child', 'harness', 'run', true, 'completed']]);
  assert.equal(JSON.stringify(payloads).includes('lastAssistantMessage'), false);
  assert.equal(EVENTS.filter(e => e.blocking).length, 2);
  off(); assert.equal(listeners.size, 0); m.dispose();
});
