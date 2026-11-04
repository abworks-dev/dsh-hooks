import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager } from '../core.js';
import { bindEvents } from '../index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const completed = (stdout = '', exitCode = 0) => ({ status: 'completed', stdout, stderr: '', exitCode });
async function fixture(fingerprint = async () => ({ digest: 'fixture', files: [] })) {
  const listeners = new Map(), executions = [];
  let reads = 0;
  const protect = object => Object.defineProperties(object, Object.fromEntries(['arguments', 'content', 'text', 'tool_response', 'result', 'messages'].map(key => [key, { get() { reads++; throw Error('private_tool_read'); } }])));
  const agent = protect({ id: 'tool-session' }), session = protect({ id: agent.id });
  const agents = new Map([[agent.id, agent]]), sessions = new Map([[agent.id, session]]);
  const manager = createHookManager({ persist: async () => {}, fingerprint,
    execute(_action, payload, { signal }) { return new Promise(resolve => executions.push({ action: _action, payload, signal, resolve })); },
  });
  const add = async (event = 'PostToolUse') => {
    await manager.upsert({ id: event, name: event, event, async: true, action: { type: 'command', executable: process.execPath } });
    await manager.trust(event, (await manager.previewTrust(event)).digest);
    await manager.toggle(event, true);
  };
  await add(); await manager.configure({ enabled: true });
  const off = bindEvents({ on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    agents: { list: () => [agent], get: id => agents.get(id) }, sessions: { get: id => sessions.get(id) },
    workingDirectory: { get: value => { assert.equal(value, session); return process.cwd(); } },
  }, manager);
  const value = Object.freeze(protect({ privateValue: 'original-tool-value' }));
  const originalResult = Object.freeze(protect({ isError: false, value }));
  const result = Object.freeze({ kind: 'accept', value });
  const emit = (next = () => result, signal) => listeners.get('tools/post-execute')(protect({ agent, name: 'fixture-tool', signal }), originalResult, next);
  return { manager, agent, agents, sessions, executions, listeners, emit, result, originalResult, value, add,
    async flush() { await tick(); await tick(); },
    async dispose() { off(); manager.dispose(); for (const execution of executions) execution.resolve(completed()); await tick(); assert.equal(reads, 0); assert.equal(listeners.size, 0); },
  };
}

test('actual post-execute binding immediately preserves result identity and downstream decision while notifications remain pending', { timeout: 3000 }, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    assert.equal(await f.emit(() => { calls++; return f.result; }), f.result);
    const decision = Object.freeze({ kind: 'block', feedback: [{ type: 'text', text: 'downstream decision' }] });
    assert.equal(await f.emit(() => { calls++; return decision; }), decision);
    assert.equal(calls, 2);
    assert.equal(f.result.kind, 'accept');
    assert.equal(f.result.value, f.value);
    assert.equal(f.originalResult.isError, false);
    assert.equal(f.originalResult.value, f.value);
    const originalDescriptors = Object.getOwnPropertyDescriptors(f.originalResult);
    await f.flush(); assert.equal(f.executions.length, 2);
    assert.deepEqual(Object.getOwnPropertyDescriptors(f.originalResult), originalDescriptors);
    assert.ok(Object.isFrozen(f.originalResult));
    for (const execution of f.executions) assert.deepEqual(execution.payload, {
      hook_event_name: 'PostToolUse', session_id: f.agent.id, tool_name: 'fixture-tool', timestamp: execution.payload.timestamp, source: 'dsh', payload_version: 1,
    });
  } finally { await f.dispose(); }
});

test('post-execute preserves exact downstream rejection while background notification remains pending', async () => {
  const f = await fixture();
  try {
    const sentinel = Error('downstream_post_execute_failure');
    let calls = 0;
    await assert.rejects(f.emit(() => { calls++; throw sentinel; }), error => error === sentinel);
    assert.equal(calls, 1);
    await f.flush(); assert.equal(f.executions.length, 1);
    assert.equal(f.manager.snapshot().records.length, 0);
    f.executions[0].resolve(completed('{"decision":"block","continue":false,"hookSpecificOutput":{"additionalContext":"ignore"}}', 2));
    await f.flush();
    assert.equal(f.manager.snapshot().records[0].status, 'completed');
    assert.equal(await f.emit(), f.result);
  } finally { await f.dispose(); }
});

for (const output of [completed('deny', 2), completed('{"decision":"block","continue":false}'), completed('{"hookSpecificOutput":{"additionalContext":"private injection"}}'), completed('{invalid')]) {
  test(`background post-tool ignores control/context output ${output.stdout}`, async () => {
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

for (const identity of ['Agent', 'Session']) for (const operation of ['remove', 'replace']) {
  test(`queued post-tool cancels captured ${identity} ${operation} without ID retargeting`, async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 6; i++) assert.equal(await f.emit(), f.result);
      await f.flush(); assert.equal(f.executions.length, 4);
      const map = identity === 'Agent' ? f.agents : f.sessions;
      if (operation === 'remove') map.delete(f.agent.id); else map.set(f.agent.id, { id: f.agent.id });
      for (const execution of f.executions) execution.resolve(completed());
      await f.flush(); assert.equal(f.executions.length, 4);
      assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 2);
    } finally { await f.dispose(); }
  });
}

for (const identity of ['Agent', 'Session']) test(`post-tool ${identity} replacement during verification cancels execution`, async () => {
  let armed = false, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(async () => { if (armed) { entered(); await pending; } return { digest: 'fixture', files: [] }; });
  try {
    armed = true;
    assert.equal(await f.emit(), f.result); await started;
    (identity === 'Agent' ? f.agents : f.sessions).set(f.agent.id, { id: f.agent.id });
    release(); await f.flush(); assert.equal(f.executions.length, 0);
    assert.equal(f.manager.snapshot().records[0].status, 'cancelled');
  } finally { release(); await f.dispose(); }
});

test('notification saturation cannot bypass a synchronous pre-tool safety gate', async () => {
  const f = await fixture();
  try {
    await f.manager.upsert({ id: 'gate', name: 'gate', event: 'PreToolUse', action: { type: 'command', executable: process.execPath } });
    await f.manager.trust('gate', (await f.manager.previewTrust('gate')).digest);
    await f.manager.toggle('gate', true);
    for (let i = 0; i < 4; i++) await f.emit();
    await f.flush();
    assert.equal(f.executions.length, 4);
    let nextCalls = 0;
    const decision = await f.listeners.get('tools/pre-execute')({ agent: f.agent, name: 'guarded-tool' }, () => { nextCalls++; return { kind: 'allow' }; });
    assert.equal(decision.kind, 'deny');
    assert.equal(nextCalls, 0);
    assert.equal(f.executions.length, 4);
    assert.ok(f.manager.snapshot().records.some(record => record.status === 'busy' && record.event === 'PreToolUse'));
  } finally { await f.dispose(); }
});

test('async notification does not suppress a synchronous PostToolUse feedback rule', { timeout: 3000 }, async () => {
  const f = await fixture();
  try {
    await f.manager.upsert({ id: 'feedback', name: 'feedback', event: 'PostToolUse', action: { type: 'command', executable: process.execPath, argv: ['sync-feedback'] } });
    await f.manager.trust('feedback', (await f.manager.previewTrust('feedback')).digest);
    await f.manager.toggle('feedback', true);
    let nextCalls = 0;
    const pending = f.emit(() => { nextCalls++; return f.result; });
    await f.flush();
    assert.equal(f.executions.length, 2);
    const synchronous = f.executions.find(e => e.action.argv[0] === 'sync-feedback');
    assert.ok(synchronous);
    synchronous.resolve(completed(JSON.stringify({ decision: 'block', reason: 'Review required' })));
    const decision = await pending;
    assert.equal(decision.kind, 'block');
    assert.equal(nextCalls, 0);
    assert.ok(JSON.stringify(decision.feedback).includes('Review required'));
    const background = f.executions.find(e => e !== synchronous);
    background.resolve(completed(JSON.stringify({ decision: 'allow' })));
    await f.flush();
    assert.equal(decision.kind, 'block');
    assert.equal(nextCalls, 0);
  } finally { await f.dispose(); }
});

test('post-tool and Stop share the same four active plus 32 pending FIFO queue', async () => {
  const f = await fixture();
  try {
    await f.add('Stop');
    for (let i = 0; i < 37; i++) {
      if (i % 2) f.listeners.get('agent/status')({ agent: f.agent, status: 'idle' });
      else assert.equal(await f.emit(), f.result);
    }
    await f.flush(); assert.equal(f.executions.length, 4);
    assert.deepEqual(f.executions.map(e => e.payload.hook_event_name), ['PostToolUse', 'Stop', 'PostToolUse', 'Stop']);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'busy').length, 1);
    for (let i = 0; i < 32; i++) { f.executions[i].resolve(completed()); await f.flush(); assert.equal(f.executions.length, i + 5); }
    assert.equal(f.executions.length, 36);
  } finally { await f.dispose(); }
});

for (const cancellation of ['signal', 'cancelSession', 'agent/disposed', 'dispose']) test(`${cancellation} aborts active post-tool signals and cancels pending jobs`, async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    for (let i = 0; i < 6; i++) await f.emit(undefined, controller.signal);
    await f.flush(); assert.equal(f.executions.length, 4);
    if (cancellation === 'signal') controller.abort();
    else if (cancellation === 'cancelSession') f.manager.cancelSession(f.agent.id);
    else if (cancellation === 'agent/disposed') f.listeners.get('agent/disposed')({ agent: f.agent });
    else f.manager.dispose();
    assert.ok(f.executions.every(e => e.signal.aborted));
    for (const execution of f.executions) execution.resolve({ ...completed(), status: 'cancelled' });
    await f.flush(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 6);
  } finally { await f.dispose(); }
});
