import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const EVENTS = Object.freeze([
  { name: 'SessionStart', source: 'agent/created', timing: 'agent ready; observation only', blocking: false },
  { name: 'SessionEnd', source: 'agent/disposed', timing: 'after agent disposal; observation only', blocking: false },
  { name: 'UserPromptSubmit', source: 'agent/inbox/inserted', timing: 'after inbox insertion, not before submission', blocking: false },
  { name: 'PreToolUse', source: 'tools/pre-execute', timing: 'awaited before dispatch; exit 2 denies', blocking: true },
  { name: 'PostToolUse', source: 'tools/result', timing: 'after frozen final tool result', blocking: false },
  { name: 'Stop', source: 'agent/status', timing: 'after status becomes idle; not a stop veto', blocking: false },
  { name: 'PermissionRequest', source: 'approval/request', timing: 'observation at approval request; never answers approval', blocking: false },
]);
const names = new Set(EVENTS.map(e => e.name));
const string = (v, max = 256) => { if (typeof v !== 'string' || !v.length || v.length > max || v.includes('\0')) throw new TypeError('invalid_hook_string'); return v; };
export const parseId = v => { string(v, 80); if (!/^[a-zA-Z0-9_-]+$/.test(v)) throw new TypeError('invalid_hook_id'); return v; };
export const parseBoolean = v => { if (typeof v !== 'boolean') throw new TypeError('invalid_hook_boolean'); return v; };
const integer = (v, fallback, min, max) => { v ??= fallback; if (!Number.isInteger(v) || v < min || v > max) throw new TypeError('invalid_hook_limit'); return v; };
export function parseRule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_hook_rule');
  const a = value.action;
  if (!names.has(value.event) || !a || a.type !== 'command') throw new TypeError('invalid_hook_event_or_action');
  const executable = string(a.executable, 4096);
  if (!path.isAbsolute(executable) || /\.(cmd|bat)$/i.test(executable)) throw new TypeError('absolute_native_executable_required');
  const argv = a.argv ?? [];
  if (!Array.isArray(argv) || argv.length > 64 || argv.some(v => typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) throw new TypeError('invalid_hook_argv');
  const matcher = value.matcher ?? '*';
  if (typeof matcher !== 'string' || matcher.length > 128 || !/^[A-Za-z0-9_.*?/-]+$/.test(matcher)) throw new TypeError('invalid_hook_matcher');
  return { id: parseId(value.id), name: string(value.name), event: value.event, enabled: value.enabled === undefined ? false : parseBoolean(value.enabled), matcher,
    action: { type: 'command', executable, argv: [...argv], timeoutMs: integer(a.timeoutMs, 5000, 100, 30000), maxOutputBytes: integer(a.maxOutputBytes, 4096, 256, 65536) } };
}
// Bounded dynamic programming: no user-supplied regular expressions or recursive backtracking.
export function matches(pattern, name) {
  if (typeof name !== 'string' || name.length > 256) return false;
  let row = [true, ...Array(name.length).fill(false)];
  for (const c of pattern) {
    const next = Array(name.length + 1).fill(false); next[0] = c === '*' && row[0];
    for (let i = 1; i <= name.length; i++) next[i] = c === '*' ? row[i] || next[i - 1] : row[i - 1] && (c === '?' || c === name[i - 1]);
    row = next;
  }
  return row[name.length];
}
export function runCommand(action, payload, { signal, spawnProcess = spawn, children = new Set() } = {}) {
  if (signal?.aborted) return Promise.resolve({ status: 'cancelled', exitCode: null, stdout: '', stderr: '' });
  return new Promise(resolve => {
    let child, timer, settled = false, status = 'completed', bytes = 0;
    const chunks = { stdout: [], stderr: [] };
    const done = (code = null) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (child) children.delete(child); resolve({ status, exitCode: code, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') }); };
    const stop = why => { status = why; try { child?.kill('SIGKILL'); } catch {} done(); };
    const abort = () => stop('cancelled');
    try {
      child = spawnProcess(action.executable, action.argv, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
      children.add(child);
      for (const key of ['stdout', 'stderr']) child[key].on('data', data => {
        const buffer = Buffer.from(data), left = action.maxOutputBytes - bytes;
        if (left > 0) chunks[key].push(buffer.subarray(0, left)); bytes += buffer.length;
        if (bytes > action.maxOutputBytes) stop('output_limit');
      });
      child.once('error', () => { status = 'spawn_error'; done(); });
      child.once('close', code => done(code));
      child.stdin.on('error', () => {});
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('timeout'), action.timeoutMs); timer.unref?.();
      child.stdin.end(JSON.stringify(payload) + '\n');
      if (signal?.aborted) abort();
    } catch { status = 'spawn_error'; done(); }
  });
}
export function createHookManager({ initial = { enabled: false, rules: [] }, persist, execute = runCommand, maxRecords = 100 }) {
  let state = { enabled: parseBoolean(initial.enabled), rules: initial.rules.map(parseRule) }, closed = false, active = 0, queue = Promise.resolve();
  const records = [], children = new Set(), controller = new AbortController();
  const snapshot = () => structuredClone({ ...state, records, events: EVENTS });
  const mutate = fn => { const pending = queue.then(async () => { if (closed) throw new Error('hooks_disposed'); const next = structuredClone(state); fn(next); await persist(next); state = next; return snapshot(); }); queue = pending.catch(() => {}); return pending; };
  return {
    snapshot,
    configure: value => { if (!value || Object.keys(value).some(k => k !== 'enabled')) throw new TypeError('invalid_hook_configuration'); const enabled = parseBoolean(value.enabled); return mutate(s => { s.enabled = enabled; }); },
    upsert: value => { const rule = { ...parseRule(value), enabled: false }; return mutate(s => { const index = s.rules.findIndex(r => r.id === rule.id); if (index < 0) { if (s.rules.length >= 100) throw new Error('hook_rule_limit'); s.rules.push(rule); } else s.rules[index] = rule; }); },
    remove: id => { parseId(id); return mutate(s => { s.rules = s.rules.filter(r => r.id !== id); }); },
    toggle: (id, enabled) => { parseId(id); parseBoolean(enabled); return mutate(s => { const rule = s.rules.find(r => r.id === id); if (!rule) throw new Error('hook_rule_not_found'); rule.enabled = enabled; }); },
    clearRecords: () => { records.length = 0; return snapshot(); },
    async dispatch(event, metadata = {}, signal) {
      if (!names.has(event)) throw new TypeError('invalid_hook_event');
      if (closed || !state.enabled) return false;
      let blocked = false;
      for (const rule of state.rules.filter(r => r.enabled && r.event === event && matches(r.matcher, metadata.toolName ?? ''))) {
        if (closed || signal?.aborted) break;
        const startedAt = Date.now();
        const record = { id: randomUUID(), ruleId: rule.id, event, startedAt, toolName: metadata.toolName ?? '', sessionId: metadata.sessionId ?? '' };
        if (active >= 4) Object.assign(record, { status: 'busy', exitCode: null, durationMs: 0 });
        else {
          active++;
          try {
            const payload = { hook_event_name: event, session_id: record.sessionId, tool_name: record.toolName, timestamp: startedAt, source: 'dsh', payload_version: 1 };
            Object.assign(record, await execute(rule.action, payload, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, children }));
          } catch { Object.assign(record, { status: 'internal_error', exitCode: null, stdout: '', stderr: '' }); }
          finally { active--; }
          record.durationMs = Date.now() - startedAt;
        }
        records.unshift(record); records.length = Math.min(records.length, maxRecords);
        if (event === 'PreToolUse' && record.status === 'completed' && record.exitCode === 2) { blocked = true; break; }
        if (event === 'PreToolUse' && record.status !== 'completed') { blocked = true; break; }
      }
      return blocked;
    },
    dispose() { closed = true; controller.abort(); for (const child of children) { try { child.kill('SIGKILL'); } catch {} } children.clear(); },
  };
}
