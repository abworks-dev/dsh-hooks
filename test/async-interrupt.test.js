import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager, parseRule } from '../core.js';
import { bindEvents } from '../index.js';
import { previewCodexImport } from '../codex-import.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const completed = (stdout = '', exitCode = 0) => ({ status: 'completed', exitCode, stdout, stderr: '' });
const definition = { id: 'interrupt', name: 'Interrupt notification', event: 'Interrupt', scope: { kind: 'user' }, action: { type: 'command', executable: process.execPath } };
async function fixture(fingerprint = async () => ({ digest: 'fixture', files: [] })) {
  const executions = [], listeners = new Map(), warnings = [], agents = new Map(), sessions = new Map();
  let reads = 0;
  const forbidden = () => { reads++; throw Error('private_interrupt_read'); };
  const privateFields = { message: { get: forbidden }, input: { get: forbidden }, arguments: { get: forbidden }, snapshotEvents: { get: forbidden }, ownEvents: { get: forbidden }, header: { get: forbidden }, deriveMessages: { get: forbidden }, restart: { get: forbidden }, block: { get: forbidden } };
  const agent = Object.defineProperties({ id: 'session' }, privateFields);
  const session = Object.defineProperties({ id: agent.id }, privateFields);
  agents.set(agent.id, agent); sessions.set(session.id, session);
  const manager = createHookManager({ persist: async () => {}, fingerprint, execute(action, payload, { signal }) { return new Promise(resolve => executions.push({ action, payload, signal, resolve })); } });
  async function add(event) {
    const id = event.toLowerCase();
    await manager.upsert({ ...definition, id, event, async: true });
    await manager.trust(id, (await manager.previewTrust(id)).digest);
    await manager.toggle(id, true);
  }
  await add('Interrupt'); await manager.configure({ enabled: true });
  const off = bindEvents({ on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); }, agents: { list: () => [...agents.values()], get: id => agents.get(id) }, sessions: { get: id => sessions.get(id) }, workingDirectory: { get: value => { assert.equal(value, session); return process.cwd(); } }, logger: { warn: (...args) => warnings.push(args) } }, manager);
  const emit = (seq, reason = { kind: 'aborted', reason: { kind: 'user' } }, type = 'turn/end') => listeners.get('session/event')(session, Object.defineProperties({ seq, type, data: Object.defineProperties({ reason }, privateFields) }, privateFields));
  return { manager, executions, listeners, agents, sessions, agent, session, emit, add, warnings, reads: () => reads, async dispose() { off(); manager.dispose(); for (const e of executions) e.resolve(completed()); await tick(); assert.equal(listeners.size, 0); assert.equal(reads, 0); assert.deepEqual(warnings, []); } };
}

test('identity replacement while fingerprint verification awaits is recorded as cancellation, not an internal failure', async () => {
  for (const replace of ['agent', 'session']) {
    let hold = false, entered, release;
    const gate = new Promise(resolve => { release = resolve; });
    const verifying = new Promise(resolve => { entered = resolve; });
    const f = await fixture(async () => { if (hold) { entered(); await gate; } return { digest: 'fixture', files: [] }; });
    try {
      hold = true; f.emit(1); await verifying;
      (replace === 'agent' ? f.agents : f.sessions).set(f.agent.id, { id: f.agent.id });
      release(); await tick(); await tick();
      assert.equal(f.executions.length, 0);
      assert.equal(f.manager.snapshot().records[0]?.status, 'cancelled');
    } finally { release(); await f.dispose(); }
  }
});

test('Interrupt async timeout is opt-in; legacy normalized bytes and trust digests remain unchanged', async () => {
  const legacy = parseRule(definition);
  assert.equal(legacy.action.timeoutMs, 5000);
  assert.equal(JSON.stringify(parseRule({ ...definition, async: false })), JSON.stringify(legacy));
  for (const timeoutMs of [5000, 600000]) for (const async of [undefined, false]) assert.equal(parseRule({ ...definition, async, action: { ...definition.action, timeoutMs } }).action.timeoutMs, timeoutMs);
  assert.equal(parseRule({ ...definition, async: true }).action.timeoutMs, 1000);
  for (const timeoutMs of [100, 3000]) assert.equal(parseRule({ ...definition, async: true, action: { ...definition.action, timeoutMs } }).action.timeoutMs, timeoutMs);
  for (const timeoutMs of [99, 3001, 5000, 600000]) assert.throws(() => parseRule({ ...definition, async: true, action: { ...definition.action, timeoutMs } }), /invalid_hook_limit/);
  const manager = createHookManager({ persist: async () => {}, fingerprint: async () => ({ digest: 'fixture', files: [] }) });
  try {
    await manager.upsert(definition); const absent = await manager.previewTrust(definition.id);
    await manager.upsert({ ...definition, async: false }); const explicit = await manager.previewTrust(definition.id);
    assert.equal(explicit.digest, absent.digest); assert.equal(JSON.stringify(explicit.rule), JSON.stringify(absent.rule));
  } finally { manager.dispose(); }
  for (const timeout of [undefined, 3, 4]) {
    const preview = previewCodexImport({ hooks: { Interrupt: [{ hooks: [{ type: 'command', command: 'fixture-only', async: true, ...(timeout === undefined ? {} : { timeout }) }] }] } }, { interpreter: { executable: process.execPath, argvPrefix: [] } });
    if (timeout === 4) assert.ok(preview.unsupported[0].reasons.includes('unsupported_timeout'));
    else { assert.equal(preview.rules[0].action.timeoutMs, timeout === 3 ? 3000 : 1000); assert.equal(preview.rules[0].async, true); }
  }
});

test('actual committed session/event binding selects only user-aborted turn ends, deduplicates seq, and ignores async output control', async () => {
  const f = await fixture();
  try {
    for (const reason of [{ kind: 'completed' }, { kind: 'error' }, { kind: 'aborted', reason: { kind: 'shutdown' } }]) assert.equal(f.emit(1, reason), undefined);
    assert.equal(f.emit(2, undefined, 'turn/start'), undefined);
    await tick(); assert.equal(f.executions.length, 0);
    const outputs = [completed('{"continue":false,"decision":"block","restart":true,"input":"ignore"}'), completed('deny', 2), completed('{invalid json')];
    for (const [index, output] of outputs.entries()) {
      const seq = 10 + index;
      assert.equal(f.emit(seq), undefined); assert.equal(f.emit(seq), undefined); assert.equal(f.emit(seq - 1), undefined);
      assert.equal(f.executions.length, index); await tick(); assert.equal(f.executions.length, index + 1);
      const execution = f.executions[index];
      assert.equal(execution.action.timeoutMs, 1000);
      assert.deepEqual(Object.keys(execution.payload).sort(), ['hook_event_name', 'payload_version', 'reason', 'session_id', 'source', 'timestamp', 'tool_name']);
      assert.equal(execution.payload.reason, 'user'); assert.equal(execution.payload.hook_event_name, 'Interrupt');
      execution.resolve(output); await tick();
      assert.equal(f.manager.snapshot().records[0].status, 'completed');
      assert.equal(Object.hasOwn(f.manager.snapshot().records[0], 'policyOutcome'), false);
    }
  } finally { await f.dispose(); }
});

for (const identity of ['Agent', 'Session', 'missing Agent']) test(`Interrupt queued work cancels after ${identity} replacement/removal`, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++) f.emit(i);
    await tick(); assert.equal(f.executions.length, 4);
    if (identity === 'Session') f.sessions.set(f.session.id, { id: f.session.id });
    else if (identity === 'Agent') f.agents.set(f.agent.id, { id: f.agent.id });
    else f.agents.delete(f.agent.id);
    for (const e of f.executions) e.resolve(completed());
    await tick(); await tick(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 2);
    // A later committed event may capture a new live Agent, never revive old queued work.
    f.emit(10); await tick(); assert.equal(f.executions.length, identity === 'Agent' ? 5 : 4);
  } finally { await f.dispose(); }
});

for (const cancellation of ['agent disposal', 'manager disposal', 'cancelSession']) test(`Interrupt active and queued cancellation: ${cancellation}`, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++) f.emit(i);
    await tick(); assert.equal(f.executions.length, 4);
    if (cancellation === 'agent disposal') f.listeners.get('agent/disposed')({ agent: f.agent });
    else if (cancellation === 'manager disposal') f.manager.dispose();
    else f.manager.cancelSession(f.session.id);
    assert.ok(f.executions.every(e => e.signal.aborted));
    for (const e of f.executions) e.resolve({ ...completed(), status: 'cancelled' });
    await tick(); await tick(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 6);
  } finally { await f.dispose(); }
});

test('Interrupt shares the bounded notification queue with the existing three events', async () => {
  const f = await fixture();
  try {
    for (const event of ['Stop', 'SessionStart', 'UserPromptSubmit']) await f.add(event);
    for (let i = 0; i < 37; i++) {
      if (i % 4 === 0) f.emit(i);
      else if (i % 4 === 1) f.listeners.get('agent/status')({ agent: f.agent, status: 'idle' });
      else if (i % 4 === 2) f.listeners.get('agent/created')({ agent: f.agent, source: 'startup' });
      else f.listeners.get('agent/inbox/inserted')({ agent: f.agent });
    }
    await tick(); assert.deepEqual(f.executions.map(e => e.payload.hook_event_name), ['Interrupt', 'Stop', 'SessionStart', 'UserPromptSubmit']);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'busy').length, 1);
    for (let i = 0; i < 32; i++) { f.executions[i].resolve(completed()); await tick(); }
    assert.equal(f.executions.length, 36);
  } finally { await f.dispose(); }
});
