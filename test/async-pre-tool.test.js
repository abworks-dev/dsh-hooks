import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager } from '../core.js';
import { bindEvents } from '../index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const completed = (stdout = '', exitCode = 0) => ({ status: 'completed', stdout, stderr: '', exitCode });
async function fixture({ syncFirst = false, synchronous = false, fingerprint = async () => ({ digest: 'fixture', files: [] }) } = {}) {
  const listeners = new Map(), executions = [];
  let reads = 0;
  const protect = object => Object.defineProperties(object, Object.fromEntries(['arguments', 'content', 'text', 'messages', 'result', 'tool_input'].map(key => [key, { get() { reads++; throw Error('private_read'); } }])));
  const agent = protect({ id: 'pre-tool-session' }), session = protect({ id: agent.id });
  const agents = new Map([[agent.id, agent]]), sessions = new Map([[agent.id, session]]);
  const manager = createHookManager({ persist: async () => {}, fingerprint,
    execute(action, payload, { signal }) { return new Promise(resolve => executions.push({ action, payload, signal, resolve })); },
  });
  const add = async (id, event = 'PreToolUse', async = true) => {
    await manager.upsert({ id, name: id, event, ...(async ? { async: true } : {}), action: { type: 'command', executable: process.execPath, argv: [id] } });
    await manager.trust(id, (await manager.previewTrust(id)).digest);
    await manager.toggle(id, true);
  };
  if (syncFirst) await add('gate', 'PreToolUse', false);
  await add('notification', 'PreToolUse', !synchronous);
  await manager.configure({ enabled: true });
  const off = bindEvents({ on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    agents: { list: () => [agent], get: id => agents.get(id) }, sessions: { get: id => sessions.get(id) },
    workingDirectory: { get: value => { assert.equal(value, session); return process.cwd(); } },
  }, manager);
  const result = Object.freeze({ kind: 'allow' });
  const emit = (next = () => result, signal, subject = agent) => listeners.get('tools/pre-execute')(protect({ agent: subject, name: 'fixture-tool', signal }), next);
  return { manager, agent, agents, sessions, executions, listeners, result, emit, add,
    async flush() { await tick(); await tick(); },
    async dispose() { off(); manager.dispose(); for (const e of executions) e.resolve(completed()); await tick(); assert.equal(reads, 0); assert.equal(listeners.size, 0); },
  };
}

test('actual pre-execute binding preserves all legitimate downstream decisions and exact errors while notifications remain pending', { timeout: 3000 }, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    for (const decision of [{ kind: 'allow' }, { kind: 'deny', reason: 'downstream', info: { name: 'Policy', code: 'denied' } }, { kind: 'cancel' }, { kind: 'ask', reason: 'review', displayReason: { en: 'Review' } }]) {
      Object.freeze(decision);
      assert.equal(await f.emit(() => { calls++; return decision; }), decision);
    }
    const sentinel = Error('downstream_failure');
    await assert.rejects(f.emit(() => { calls++; throw sentinel; }), error => error === sentinel);
    assert.equal(calls, 5);
    await f.flush(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.length, 0);
    for (const e of f.executions) assert.deepEqual(e.payload, { hook_event_name: 'PreToolUse', session_id: f.agent.id, tool_name: 'fixture-tool', timestamp: e.payload.timestamp, source: 'dsh', payload_version: 1 });
  } finally { await f.dispose(); }
});

for (const output of [completed('deny', 2), completed('{"decision":"block"}'), completed('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'), completed('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'), completed('{invalid'), completed('{"hookSpecificOutput":{"additionalContext":"private injection"}}')]) {
  test(`pre-tool notification ignores output ${output.stdout}`, async () => {
    const f = await fixture();
    try {
      assert.equal(await f.emit(), f.result); await f.flush();
      f.executions[0].resolve(output); await f.flush();
      const record = f.manager.snapshot().records[0];
      assert.equal(record.status, 'completed'); assert.equal(Object.hasOwn(record, 'policyOutcome'), false);
      assert.equal(await f.emit(), f.result);
    } finally { await f.dispose(); }
  });
}

for (const syncFirst of [true, false]) test(`same-event synchronous denial stays authoritative, syncFirst=${syncFirst}`, async () => {
  const f = await fixture({ syncFirst });
  try {
    if (!syncFirst) await f.add('gate', 'PreToolUse', false);
    let calls = 0;
    const pending = f.emit(() => { calls++; return f.result; });
    await f.flush();
    assert.equal(f.executions.length, syncFirst ? 1 : 2);
    const gate = f.executions.find(e => e.action.argv[0] === 'gate');
    gate.resolve(completed('', 2));
    const decision = await pending;
    assert.equal(decision.kind, 'deny'); assert.equal(calls, 0);
    if (!syncFirst) {
      const notification = f.executions.find(e => e !== gate);
      notification.resolve(completed('{"hookSpecificOutput":{"permissionDecision":"allow"}}')); await f.flush();
      assert.equal(decision.kind, 'deny'); assert.equal(calls, 0);
    }
  } finally { await f.dispose(); }
});

test('default synchronous PreToolUse waits and fails closed on malformed output', async () => {
  const f = await fixture({ synchronous: true });
  try {
    let calls = 0, settled = false;
    const pending = f.emit(() => { calls++; return f.result; }).then(value => { settled = true; return value; });
    await f.flush(); assert.equal(settled, false); assert.equal(calls, 0);
    f.executions[0].resolve(completed('{invalid'));
    assert.equal((await pending).kind, 'deny'); assert.equal(calls, 0);
    assert.equal(f.manager.snapshot().records[0].status, 'protocol_error');
  } finally { await f.dispose(); }
});

for (const identity of ['Agent', 'Session']) for (const operation of ['remove', 'replace']) test(`queued pre-tool cancels exact ${identity} ${operation}`, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++) assert.equal(await f.emit(), f.result);
    await f.flush(); assert.equal(f.executions.length, 4);
    const map = identity === 'Agent' ? f.agents : f.sessions;
    if (operation === 'remove') map.delete(f.agent.id); else map.set(f.agent.id, { id: f.agent.id });
    for (const e of f.executions) e.resolve(completed());
    await f.flush(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 2);
  } finally { await f.dispose(); }
});

for (const identity of ['Agent', 'Session']) test(`${identity} replacement during pre-tool trust verification cancels`, async () => {
  let armed = false, release, entered;
  const started = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const f = await fixture({ fingerprint: async () => { if (armed) { entered(); await pending; } return { digest: 'fixture', files: [] }; } });
  try {
    armed = true; assert.equal(await f.emit(), f.result); await started;
    (identity === 'Agent' ? f.agents : f.sessions).set(f.agent.id, { id: f.agent.id });
    release(); await f.flush(); assert.equal(f.executions.length, 0);
    assert.equal(f.manager.snapshot().records[0].status, 'cancelled');
  } finally { release(); await f.dispose(); }
});

test('no-agent tool call delegates but cancels notification without reading arguments', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.emit(undefined, undefined, null), f.result); await f.flush();
    assert.equal(f.executions.length, 0); assert.equal(f.manager.snapshot().records[0].status, 'cancelled');
  } finally { await f.dispose(); }
});

for (const cancellation of ['signal', 'cancelSession', 'agent/disposed', 'dispose', 'configure']) test(`${cancellation} prevents queued pre-tool execution`, async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    for (let i = 0; i < 6; i++) await f.emit(undefined, controller.signal);
    await f.flush(); assert.equal(f.executions.length, 4);
    if (cancellation === 'signal') controller.abort();
    else if (cancellation === 'cancelSession') f.manager.cancelSession(f.agent.id);
    else if (cancellation === 'agent/disposed') f.listeners.get('agent/disposed')({ agent: f.agent });
    else if (cancellation === 'configure') await f.manager.configure({ enabled: false });
    else f.manager.dispose();
    if (cancellation !== 'configure') assert.ok(f.executions.every(e => e.signal.aborted));
    for (const e of f.executions) e.resolve(cancellation === 'configure' ? completed() : { ...completed(), status: 'cancelled' });
    await f.flush(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === (cancellation === 'configure' ? 'trust_error' : 'cancelled')).length, cancellation === 'configure' ? 2 : 6);
  } finally { await f.dispose(); }
});

test('shared notification capacity can fail closed a synchronous pre-tool gate', async () => {
  const f = await fixture();
  try {
    await f.add('gate', 'PreToolUse', false);
    await f.add('stop', 'Stop');
    for (let i = 0; i < 4; i++) f.listeners.get('agent/status')({ agent: f.agent, status: 'idle' });
    await f.flush(); assert.equal(f.executions.length, 4);
    let calls = 0;
    assert.equal((await f.emit(() => { calls++; return f.result; })).kind, 'deny');
    assert.equal(calls, 0); assert.equal(f.executions.length, 4);
    assert.ok(f.manager.snapshot().records.some(r => r.ruleId === 'gate' && r.status === 'busy'));
  } finally { await f.dispose(); }
});

test('pre-tool and Stop share four active and 32 pending FIFO capacity', async () => {
  const f = await fixture();
  try {
    await f.add('stop', 'Stop');
    for (let i = 0; i < 37; i++) {
      if (i % 2) f.listeners.get('agent/status')({ agent: f.agent, status: 'idle' });
      else assert.equal(await f.emit(), f.result);
    }
    await f.flush(); assert.equal(f.executions.length, 4);
    assert.deepEqual(f.executions.map(e => e.payload.hook_event_name), ['PreToolUse', 'Stop', 'PreToolUse', 'Stop']);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'busy').length, 1);
    for (let i = 0; i < 32; i++) { f.executions[i].resolve(completed()); await f.flush(); assert.equal(f.executions.length, i + 5); }
    assert.equal(f.executions.length, 36);
  } finally { await f.dispose(); }
});
