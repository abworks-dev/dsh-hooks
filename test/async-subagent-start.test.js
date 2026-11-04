import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager } from '../core.js';
import { bindEvents } from '../index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const completed = (stdout = '', exitCode = 0) => ({ status: 'completed', exitCode, stdout, stderr: '' });
const definition = { id: 'child', name: 'Child start', event: 'SubagentStart', async: true, action: { type: 'command', executable: process.execPath } };
async function fixture(extra = {}, fingerprint = async () => ({ digest: 'fixture', files: [] })) {
  const listeners = new Map(), executions = [], dispatches = [], warnings = [];
  let reads = 0, directory = process.cwd();
  const forbidden = () => { reads++; throw Error('private_child_read'); };
  const privateFields = Object.fromEntries(['prompt', 'replies', 'assistant', 'messages', 'arguments', 'parent', 'agentType'].map(key => [key, { get: forbidden }]));
  const agent = Object.defineProperties({ id: 'child-session' }, privateFields);
  const session = Object.defineProperties({ id: agent.id }, privateFields);
  const agents = new Map([[agent.id, agent]]), sessions = new Map([[session.id, session]]);
  const info = Object.defineProperties({ id: agent.id, runId: 'run-1', provider: 'in-process', local: true }, privateFields);
  const manager = createHookManager({ persist: async () => {}, fingerprint,
    execute(_action, payload, { signal }) { return new Promise(resolve => executions.push({ payload, signal, resolve })); },
  });
  async function add(rule) {
    await manager.upsert(rule);
    await manager.trust(rule.id, (await manager.previewTrust(rule.id)).digest);
    await manager.toggle(rule.id, true);
  }
  await add({ ...definition, ...extra });
  await manager.configure({ enabled: true });
  const dispatch = manager.dispatch.bind(manager);
  manager.dispatch = (...args) => { const result = dispatch(...args); dispatches.push(result); return result; };
  const off = bindEvents({ on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    agents: { list: () => [], get: id => agents.get(id) }, sessions: { get: id => sessions.get(id) },
    workingDirectory: { get(value) { assert.equal(value, session); return directory; } }, logger: { warn: (...args) => warnings.push(args) },
  }, manager);
  return { manager, listeners, executions, agent, session, agents, sessions, info, add,
    emit: (value = info) => listeners.get('subagent/start')(value),
    settle: async () => { await Promise.all(dispatches); await tick(); await tick(); },
    cd: value => { directory = value; },
    async dispose() { off(); manager.dispose(); for (const execution of executions) execution.resolve(completed()); await tick(); assert.equal(reads, 0); assert.deepEqual(warnings, []); assert.equal(listeners.size, 0); },
  };
}

for (const identity of ['Agent', 'Session']) test(`child ${identity} replacement during fingerprint verification cancels before execution`, { timeout: 3000 }, async () => {
  let armed = false, release = () => {}, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture({}, async () => {
    if (armed) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { digest: 'fixture', files: [] };
  });
  try {
    armed = true;
    assert.equal(f.emit(), undefined);
    await started;
    (identity === 'Agent' ? f.agents : f.sessions).set(f.agent.id, { id: f.agent.id });
    release();
    await f.settle();
    assert.equal(f.executions.length, 0);
    assert.equal(f.manager.snapshot().records[0].status, 'cancelled');
  } finally { release(); await f.dispose(); }
});

test('child start never evaluates terminal-only stopReason metadata', async () => {
  const f = await fixture();
  let reads = 0;
  Object.defineProperty(f.info, 'stopReason', { get() { reads++; throw Error('terminal_only_read'); } });
  try {
    assert.doesNotThrow(() => f.emit());
    await f.settle();
    assert.equal(reads, 0);
    assert.equal(f.executions.length, 1);
    assert.equal(Object.hasOwn(f.executions[0].payload, 'stop_reason'), false);
  } finally { await f.dispose(); }
});

test('published child notification returns undefined immediately; only public metadata is serialized and output cannot control', async () => {
  const f = await fixture();
  try {
    for (const output of [completed('{"continue":false,"stopReason":"ignore"}'), completed('deny', 2), completed('{invalid'), completed('{"hookSpecificOutput":{"additionalContext":"ignore"}}')]) {
      const count = f.executions.length;
      assert.equal(f.emit(), undefined);
      assert.equal(f.executions.length, count);
      await f.settle();
      const execution = f.executions[count];
      assert.deepEqual(execution.payload, { hook_event_name: 'SubagentStart', session_id: f.agent.id, tool_name: '', timestamp: execution.payload.timestamp, source: 'dsh', payload_version: 1, provider: 'in-process', runId: 'run-1', child_id: f.agent.id, run_id: 'run-1', local: true });
      execution.resolve(output); await tick(); await tick();
      assert.equal(f.manager.snapshot().records[0].status, 'completed');
      assert.equal(Object.hasOwn(f.manager.snapshot().records[0], 'policyOutcome'), false);
    }
  } finally { await f.dispose(); }
});

for (const missing of ['external', 'Agent', 'Session']) test(`${missing} at notification cancels, even if identity later appears`, async () => {
  const f = await fixture();
  try {
    if (missing === 'Agent') f.agents.clear();
    if (missing === 'Session') f.sessions.clear();
    assert.equal(f.emit(missing === 'external' ? { ...f.info, local: false } : f.info), undefined);
    f.agents.set(f.agent.id, f.agent); f.sessions.set(f.session.id, f.session);
    await f.settle();
    assert.equal(f.executions.length, 0);
    assert.equal(f.manager.snapshot().records[0].status, 'cancelled');
  } finally { await f.dispose(); }
});

for (const identity of ['Agent', 'Session']) for (const operation of ['replace', 'remove']) test(`queued child rejects ${operation} ${identity} without ID retargeting`, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++) f.emit();
    await f.settle(); assert.equal(f.executions.length, 4);
    const map = identity === 'Agent' ? f.agents : f.sessions;
    if (operation === 'replace') map.set(f.agent.id, { id: f.agent.id }); else map.delete(f.agent.id);
    for (const execution of f.executions) execution.resolve(completed());
    await f.settle(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 2);
  } finally { await f.dispose(); }
});

test('SubagentStart and Stop share four active and 32 pending FIFO slots; captured identity survives directory change', async () => {
  const f = await fixture();
  try {
    await f.add({ ...definition, id: 'stop', event: 'Stop' });
    f.listeners.get('agent/created')({ agent: f.agent, source: 'startup' });
    for (let i = 0; i < 37; i++) {
      if (i % 2) assert.equal(f.listeners.get('agent/status')({ agent: f.agent, status: 'idle' }), undefined);
      else assert.equal(f.emit(), undefined);
    }
    await f.settle();
    assert.equal(f.executions.length, 4);
    assert.deepEqual(f.executions.map(e => e.payload.hook_event_name), ['SubagentStart', 'Stop', 'SubagentStart', 'Stop']);
    f.cd('unrelated-after-event');
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'busy').length, 1);
    for (let i = 0; i < 32; i++) { f.executions[i].resolve(completed()); await f.settle(); assert.equal(f.executions.length, i + 5); }
    assert.equal(f.executions.length, 36);
  } finally { await f.dispose(); }
});

for (const cancellation of ['cancelSession', 'agent/disposed', 'dispose']) test(`${cancellation} aborts active signals and cancels queued children`, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++) f.emit();
    await f.settle(); assert.equal(f.executions.length, 4);
    if (cancellation === 'cancelSession') f.manager.cancelSession(f.agent.id);
    else if (cancellation === 'dispose') f.manager.dispose();
    else f.listeners.get('agent/disposed')({ agent: f.agent });
    assert.ok(f.executions.every(e => e.signal.aborted));
    for (const execution of f.executions) execution.resolve({ ...completed(), status: 'cancelled' });
    await f.settle(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 6);
  } finally { await f.dispose(); }
});

test('project selection uses captured child Session directory, not later cd', async () => {
  const f = await fixture({ scope: { kind: 'project', root: process.cwd() } });
  try {
    f.emit(); f.cd('unrelated-after-event');
    await f.settle();
    const deadline = Date.now() + 2000;
    while (!f.executions.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.executions.length, 1);
  } finally { await f.dispose(); }
});

test('unbound parent cannot stand in for missing child identities', async () => {
  const f = await fixture();
  try {
    f.agents.set('parent', { id: 'parent' }); f.sessions.set('parent', { id: 'parent' });
    f.agents.delete(f.agent.id); f.sessions.delete(f.session.id);
    f.emit(); await f.settle(); assert.equal(f.executions.length, 0);
    assert.equal(f.manager.snapshot().records[0].status, 'cancelled');
  } finally { await f.dispose(); }
});

for (const matcherMode of ['glob', 'regex']) test(`${matcherMode} matcher remains agentType, not provider, run ID or child ID`, async () => {
  const f = await fixture({ matcher: 'in-process', matcherMode });
  try { f.emit(); await f.settle(); assert.equal(f.executions.length, 0); assert.deepEqual(f.manager.snapshot().records, []); }
  finally { await f.dispose(); }
});
