import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookManager } from '../core.js';
import { bindEvents } from '../index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const completed = (stdout = '', exitCode = 0) => ({ status: 'completed', stdout, stderr: '', exitCode });
const decision = behavior => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } });
async function fixture({ enforcer = false, fingerprint = async () => ({ digest: 'fixture', files: [] }) } = {}) {
  const listeners = new Map(), executions = [];
  let reads = 0;
  const protect = value => Object.defineProperties(value, Object.fromEntries(['arguments', 'reason', 'displayReason', 'reasons', 'content'].map(key => [key, { get() { reads++; throw Error('private_read'); } }])));
  const agent = protect({ id: 'permission-session' }), session = protect({ id: agent.id });
  const agents = new Map([[agent.id, agent]]), sessions = new Map([[agent.id, session]]);
  const manager = createHookManager({ persist: async () => {}, fingerprint,
    execute(action, payload, { signal }) { return new Promise(resolve => executions.push({ action, payload, signal, resolve })); },
  });
  const add = async (id, enforce = false) => {
    await manager.upsert({ id, name: id, event: 'PermissionRequest', scope: { kind: 'user' }, ...(enforce ? { denyPermissionRequest: true } : { async: true }), action: { type: 'command', executable: process.execPath, argv: [id] } });
    await manager.trust(id, (await manager.previewTrust(id)).digest);
    await manager.toggle(id, true);
  };
  await add('observer');
  if (enforcer) await add('enforcer', true);
  await manager.configure({ enabled: true });
  const off = bindEvents({ on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); }, agents: { list: () => [agent], get: id => agents.get(id) }, sessions: { get: id => sessions.get(id) }, workingDirectory: { get: value => { assert.equal(value, session); return process.cwd(); } } }, manager);
  return { manager, executions, agent, agents, sessions, listeners,
    emit: (next = () => 'allowed-once', signal, subject = agent) => listeners.get('approval/request')(protect({ agent: subject, toolName: 'fixture-tool', signal }), next),
    async flush() { await tick(); await tick(); },
    async dispose() { off(); manager.dispose(); for (const e of executions) e.resolve(completed()); await tick(); assert.equal(reads, 0); assert.equal(listeners.size, 0); },
  };
}

for (const withSignal of [false, true]) test(`real approval binding preserves actual downstream outcomes and exact errors without waiting for observer, signal=${withSignal}`, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const signal = withSignal ? new AbortController().signal : undefined;
    for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) assert.equal(await f.emit(() => { calls++; return outcome; }, signal), outcome);
    const error = Error('approval_failure');
    await assert.rejects(f.emit(() => { calls++; throw error; }, signal), actual => actual === error);
    assert.equal(calls, 5);
    await f.flush(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.length, 0);
    for (const e of f.executions) assert.deepEqual(e.payload, { hook_event_name: 'PermissionRequest', session_id: f.agent.id, tool_name: 'fixture-tool', timestamp: e.payload.timestamp, source: 'dsh', payload_version: 1 });
  } finally { await f.dispose(); }
});

for (const output of [completed(decision('deny')), completed(decision('allow')), completed('{invalid'), completed('deny', 2)]) test(`observer ignores ${output.stdout}/${output.exitCode}`, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    assert.equal(await f.emit(() => { calls++; return 'unavailable'; }), 'unavailable');
    await f.flush(); f.executions[0].resolve(output); await f.flush();
    const record = f.manager.snapshot().records[0];
    assert.equal(record.status, 'completed'); assert.equal(Object.hasOwn(record, 'policyOutcome'), false); assert.equal(calls, 1);
  } finally { await f.dispose(); }
});

for (const output of [completed(decision('allow')), completed(decision('deny')), completed('{invalid'), { status: 'timeout', exitCode: null, stdout: '', stderr: '' }]) test(`enforcer settles before exactly one observer: ${output.stdout || output.status}`, async () => {
  const f = await fixture({ enforcer: true });
  try {
    let calls = 0, settled = false;
    const pending = f.emit(() => { calls++; return 'allowed-once'; }).then(value => { settled = true; return value; });
    await f.flush(); assert.equal(settled, false); assert.equal(calls, 0); assert.equal(f.executions.length, 1); assert.equal(f.executions[0].action.argv[0], 'enforcer');
    f.executions[0].resolve(output);
    const allowed = output.stdout === decision('allow');
    assert.equal(await pending, allowed ? 'allowed-once' : 'rejected'); assert.equal(calls, allowed ? 1 : 0);
    await f.flush(); assert.equal(f.executions.length, 2); assert.equal(f.executions[1].action.argv[0], 'observer');
    f.executions[1].resolve(completed(decision('allow'))); await f.flush();
    assert.equal(f.manager.snapshot().records.filter(r => r.ruleId === 'observer').length, 1);
  } finally { await f.dispose(); }
});

for (const before of [true, false]) test(`cancellation launches no observer, already aborted=${before}`, async () => {
  const f = await fixture({ enforcer: true });
  try {
    const controller = new AbortController(); let calls = 0;
    if (before) controller.abort();
    const pending = f.emit(() => { calls++; return 'allowed-once'; }, controller.signal);
    if (!before) { await f.flush(); assert.equal(f.executions.length, 1); controller.abort(); }
    assert.equal(await pending, 'cancelled'); assert.equal(calls, 0);
    for (const e of f.executions) e.resolve(completed(decision('allow')));
    await f.flush(); assert.equal(f.executions.some(e => e.action.argv[0] === 'observer'), false);
  } finally { await f.dispose(); }
});

for (const identity of ['Agent', 'Session']) for (const operation of ['replace', 'remove']) test(`queued observer requires exact ${identity} after ${operation}`, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) await f.emit();
    await f.flush(); assert.equal(f.executions.length, 4);
    const map = identity === 'Agent' ? f.agents : f.sessions;
    if (operation === 'remove') map.delete(f.agent.id); else map.set(f.agent.id, { id: f.agent.id });
    f.executions[0].resolve(completed()); await f.flush();
    assert.equal(f.executions.length, 4); assert.ok(f.manager.snapshot().records.some(r => r.status === 'cancelled'));
  } finally { await f.dispose(); }
});

test('shared observer queue has four active and 32 pending; session cancellation drains without fifth execute', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    for (let i = 0; i < 37; i++) assert.equal(await f.emit(() => { calls++; return 'rejected'; }), 'rejected');
    await f.flush(); assert.equal(calls, 37); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'busy').length, 1);
    f.manager.cancelSession(f.agent.id);
    assert.ok(f.executions.every(e => e.signal.aborted));
    for (const e of f.executions) e.resolve({ status: 'cancelled', exitCode: null });
    await f.flush(); assert.equal(f.executions.length, 4);
    assert.equal(f.manager.snapshot().records.filter(r => r.status === 'cancelled').length, 36);
  } finally { await f.dispose(); }
});

test('observer saturation never converts a later approval enforcement failure into approval', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 4; i++) assert.equal(await f.emit(), 'allowed-once');
    await f.flush(); assert.equal(f.executions.length, 4);
    await f.manager.upsert({ id: 'capacity-enforcer', name: 'capacity-enforcer', event: 'PermissionRequest', scope: { kind: 'user' }, denyPermissionRequest: true, action: { type: 'command', executable: process.execPath, argv: ['never-executed-policy'] } });
    await f.manager.trust('capacity-enforcer', (await f.manager.previewTrust('capacity-enforcer')).digest);
    await f.manager.toggle('capacity-enforcer', true);
    let calls = 0;
    assert.equal(await f.emit(() => { calls++; return 'allowed-once'; }), 'rejected');
    await f.flush();
    assert.equal(calls, 0); assert.equal(f.executions.length, 4);
    const record = f.manager.snapshot().records.find(r => r.ruleId === 'capacity-enforcer');
    assert.equal(record.status, 'busy'); assert.equal(record.policyOutcome, 'deny');
    f.manager.cancelSession(f.agent.id);
  } finally { await f.dispose(); }
});

test('unregistered Agent cannot borrow a live Session for observation', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    assert.equal(await f.emit(() => { calls++; return 'allowed-once'; }, undefined, { id: f.agent.id }), 'allowed-once');
    await f.flush(); assert.equal(calls, 1); assert.equal(f.executions.length, 0);
    assert.equal(f.manager.snapshot().records[0].status, 'cancelled');
  } finally { await f.dispose(); }
});

for (const identity of ['Agent', 'Session']) test(`fingerprint wait rechecks exact ${identity}`, async () => {
  let release, waiting = false;
  const f = await fixture({ fingerprint: async () => { if (waiting) await new Promise(resolve => { release = resolve; }); return { digest: 'fixture', files: [] }; } });
  try {
    waiting = true; await f.emit(); await f.flush(); assert.equal(typeof release, 'function');
    (identity === 'Agent' ? f.agents : f.sessions).set(f.agent.id, { id: f.agent.id });
    release(); await f.flush(); assert.equal(f.executions.length, 0); assert.equal(f.manager.snapshot().records[0].status, 'cancelled');
  } finally { await f.dispose(); }
});
