import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fingerprintAction } from './trust.js';
import { createAsyncQueue } from './async-queue.js';
import { parseScope, canonicalizeScope, canonicalDirectory, evaluateScope } from './scope.js';
import { validateMatcher, matchEvent } from './matcher.js';
import { discoverCodexSources } from './config-sources.js';
import { createSourceMonitor } from './source-monitor.js';
import { previewCodexSources } from './codex-import.js';
import { parseSourceRegistry, parseSourceRegistrationRequest, parseSourceRefreshRequest, parseSourceDetachRequest, sourceDefinitionDigest } from './source-registry.js';
import { directoryIdentity } from './scope.js';
export const EVENTS = Object.freeze([
  { name: 'SessionStart', source: 'agent/created', timing: 'during agent creation initialization; observation only, not an initialization barrier', blocking: false },
  { name: 'SessionEnd', source: 'agent/disposed', timing: 'after agent disposal; observation only', blocking: false },
  { name: 'UserPromptSubmit', source: 'agent/inbox/inserted', timing: 'after inbox insertion, not before submission', blocking: false },
  { name: 'PreToolUse', source: 'tools/pre-execute', timing: 'awaited before dispatch; exit 2 denies', blocking: true },
  { name: 'PostToolUse', source: 'tools/post-execute', timing: 'after tool body; JSON feedback can replace result, never undo effects', blocking: true },
  { name: 'Stop', source: 'agent/status', timing: 'after status becomes idle; not a stop veto', blocking: false },
  { name: 'Interrupt', source: 'session/event', timing: 'after committed user-aborted turn end; metadata observation only, no restart or veto', blocking: false },
  { name: 'PermissionRequest', source: 'approval/request', timing: 'observation by default; explicit deny-only opt-in can reject, never approve', blocking: false },
  { name: 'SubagentStart', source: 'subagent/start', timing: 'after published child activation; observation only', blocking: false },
  { name: 'SubagentStop', source: 'subagent/end', timing: 'after child settles; observation only', blocking: false },
  { name: 'PreModelRequest', source: 'llm/stream', timing: 'before iterating an agent model request; observation only', blocking: false },
  { name: 'PostModelRequest', source: 'llm/stream', timing: 'after agent model stream finish/error/abort/early close; observation only', blocking: false },
]);
const names = new Set(EVENTS.map(e => e.name));
// Explicit notification-only subset; nonblocking alone is not async eligibility.
export const supportsAsyncEvent = event => ['Stop', 'UserPromptSubmit', 'SessionStart', 'Interrupt', 'PreModelRequest', 'PostModelRequest', 'SubagentStart', 'PostToolUse', 'PreToolUse', 'PermissionRequest'].includes(event);
const string = (v, max = 256) => { if (typeof v !== 'string' || !v.length || v.length > max || v.includes('\0')) throw new TypeError('invalid_hook_string'); return v; };
export const parseId = v => { string(v, 80); if (!/^[a-zA-Z0-9_-]+$/.test(v)) throw new TypeError('invalid_hook_id'); return v; };
export const parseBoolean = v => { if (typeof v !== 'boolean') throw new TypeError('invalid_hook_boolean'); return v; };
const integer = (v, fallback, min, max) => { v ??= fallback; if (!Number.isInteger(v) || v < min || v > max) throw new TypeError('invalid_hook_limit'); return v; };
export function parseRule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_hook_rule');
  const a = value.action;
  if (!names.has(value.event) || !a || a.type !== 'command') throw new TypeError('invalid_hook_event_or_action');
  if (a.async !== undefined && a.async !== false || value.async !== undefined && value.async !== false && value.async !== true) throw new TypeError('unsupported_async_hook');
  const retained = {};
  if (value.async === true) {
    if (!supportsAsyncEvent(value.event) || (value.payloadMode ?? 'metadata') !== 'metadata' || (value.includeToolInput ?? false) !== false || value.denyPermissionRequest === true) throw new TypeError('unsupported_async_hook');
    retained.async = true;
  }
  if (value.denyPermissionRequest !== undefined) {
    const deny = parseBoolean(value.denyPermissionRequest);
    if (deny && value.event !== 'PermissionRequest') throw new TypeError('permission_request_event_required');
    // Absence is significant: legacy definitions and trust digests stay byte-identical.
    if (deny) retained.denyPermissionRequest = true;
  }
  if (value.trust !== undefined) {
    if (!plainObject(value.trust) || Object.keys(value.trust).some(key => key !== 'digest') || !/^[a-f0-9]{64}$/.test(value.trust.digest)) throw new TypeError('invalid_hook_trust');
    retained.trust = { digest: value.trust.digest };
  }
  for (const key of ['source', 'review']) if (value[key] !== undefined) retained[key] = copyHookPayload(value[key]);
  const executable = string(a.executable, 4096);
  if (!path.isAbsolute(executable) || /\.(cmd|bat)$/i.test(executable)) throw new TypeError('absolute_native_executable_required');
  const argv = a.argv ?? [];
  if (!Array.isArray(argv) || argv.length > 64 || argv.some(v => typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) throw new TypeError('invalid_hook_argv');
  const matcherMode = value.matcherMode ?? 'glob';
  const matcher = validateMatcher(value.matcher ?? '*', matcherMode);
  const includeToolInput = value.includeToolInput === undefined ? false : parseBoolean(value.includeToolInput);
  if (includeToolInput && !['PreToolUse', 'PostToolUse'].includes(value.event)) throw new TypeError('tool_input_event_required');
  const payloadMode = value.payloadMode ?? 'metadata';
  if (!['metadata', 'full'].includes(payloadMode)) throw new TypeError('invalid_hook_payload_mode');
  const trustFiles = a.trustFiles ?? [];
  if (!Array.isArray(trustFiles) || trustFiles.length > 16 || trustFiles.some(file => typeof file !== 'string' || !file.length || file.length > 4096 || file.includes('\0') || !path.isAbsolute(file))) throw new TypeError('invalid_hook_trust_files');
  return { ...retained, scope: parseScope(value.scope), id: parseId(value.id), name: string(value.name), event: value.event, enabled: value.enabled === undefined ? false : parseBoolean(value.enabled), matcher, matcherMode, payloadMode, includeToolInput,
    action: { type: 'command', executable, argv: [...argv], timeoutMs: value.async === true && value.event === 'Interrupt' ? integer(a.timeoutMs, 1000, 100, 3000) : integer(a.timeoutMs, 5000, 100, 600000), maxOutputBytes: integer(a.maxOutputBytes, 4096, 256, 65536), trustFiles: [...trustFiles] } };
}
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
  if (children.size >= 4) return Promise.resolve({ status: 'busy', exitCode: null, stdout: '', stderr: '' });
  return new Promise(resolve => {
    let child, timer, settled = false, status = 'completed', bytes = 0;
    const chunks = { stdout: [], stderr: [] };
    const done = (code = null) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ status, exitCode: code, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') }); };
    // Result settlement is bounded; only close releases direct-child capacity.
    const stop = why => { if (settled) return; status = why; try { child?.kill('SIGKILL'); } catch {} done(); };
    const abort = () => stop('cancelled');
    try {
      child = spawnProcess(action.executable, action.argv, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
      children.add(child);
      child.once('close', (code, signal) => { children.delete(child); if (status === 'completed' && (signal || !Number.isInteger(code) || code < 0)) status = 'terminated'; done(code); });
      for (const key of ['stdout', 'stderr']) child[key].on('data', data => {
        if (settled) return;
        const buffer = Buffer.from(data), left = action.maxOutputBytes - bytes;
        if (left > 0) chunks[key].push(buffer.subarray(0, left)); bytes += buffer.length;
        if (bytes > action.maxOutputBytes) stop('output_limit');
      });
      child.once('error', () => { status = 'spawn_error'; done(); });
      child.stdin.on('error', () => {});
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('timeout'), action.timeoutMs); timer.unref?.();
      child.stdin.end(JSON.stringify(payload) + '\n');
      if (signal?.aborted) abort();
    } catch { stop('spawn_error'); }
  });
}
// Serialize incrementally so oversized/cyclic/non-JSON inputs fail before spawning a command.
export function cloneToolInput(value) {
  let bytes = 0;
  const seen = new Set();
  const add = text => { bytes += Buffer.byteLength(text); if (bytes > 65536) throw new TypeError('invalid_tool_input'); return text; };
  const encode = (v, depth = 0) => {
    if (depth > 64) throw new TypeError('invalid_tool_input');
    if (v === null || typeof v === 'boolean') return add(JSON.stringify(v));
    if (typeof v === 'string') { if (v.length > 65536) throw new TypeError('invalid_tool_input'); return add(JSON.stringify(v)); }
    if (typeof v === 'number' && Number.isFinite(v)) return add(String(v));
    if (!v || typeof v !== 'object' || seen.has(v)) throw new TypeError('invalid_tool_input');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError('invalid_tool_input');
    seen.add(v);
    const parts = [add(array ? '[' : '{')];
    const keys = array ? Array.from({ length: Math.min(v.length, 65537) }, (_, i) => String(i)) : Object.keys(v);
    if (keys.length > 65536 || (array && v.length > 65536)) throw new TypeError('invalid_tool_input');
    for (const [i, key] of keys.entries()) {
      if (i) parts.push(add(','));
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !('value' in descriptor)) throw new TypeError('invalid_tool_input');
      if (!array) { if (key.length > 65536) throw new TypeError('invalid_tool_input'); parts.push(add(JSON.stringify(key)), add(':')); }
      parts.push(encode(descriptor.value, depth + 1));
    }
    parts.push(add(array ? ']' : '}')); seen.delete(v); return parts.join('');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_tool_input');
  return JSON.parse(encode(value));
}

const CONTROL_TEXT_LIMIT = 16000;
const textControl = value => { if (typeof value !== 'string' || value.length > CONTROL_TEXT_LIMIT) throw new TypeError('invalid_hook_output'); return value; };
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closedOutput = (value, keys) => { if (!plainObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('unsupported_hook_output'); };
export function parseHookOutput(event, result) {
  const output = { blocked: false, reason: '', feedback: [] };
  if (result.status !== 'completed') return output;
  if (result.exitCode === 2 && ['PreToolUse', 'PostToolUse'].includes(event)) {
    output.blocked = true; output.reason = 'Blocked by a configured local hook (exit 2).'; return output;
  }
  if (result.exitCode !== 0) return output;
  const raw = (result.stdout ?? '').trim();
  if (!raw || !raw.startsWith('{') && !raw.startsWith('[')) return output;
  let value; try { value = JSON.parse(raw); } catch { throw new TypeError('invalid_hook_output'); }
  if (event === 'PermissionRequest') {
    closedOutput(value, ['hookSpecificOutput']);
    const specific = value.hookSpecificOutput;
    if (specific === undefined) return output;
    closedOutput(specific, ['hookEventName', 'decision']);
    if (specific.hookEventName !== event) throw new TypeError('hook_output_event_mismatch');
    if (specific.decision === undefined) return output;
    closedOutput(specific.decision, ['behavior', 'message']);
    const { behavior, message } = specific.decision;
    if (!['deny', 'allow'].includes(behavior)) throw new TypeError('unsupported_hook_output');
    if (message !== undefined && (typeof message !== 'string' || message.length > 1024 || /[\x00-\x1f\x7f]/.test(message))) throw new TypeError('invalid_hook_output');
    output.blocked = behavior === 'deny';
    output.reason = output.blocked ? message || 'Denied by a configured local PermissionRequest policy.' : '';
    return output;
  }
  closedOutput(value, ['decision', 'reason', 'continue', 'stopReason', 'hookSpecificOutput']);
  const specific = value.hookSpecificOutput;
  if (specific !== undefined) {
    closedOutput(specific, ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    if (specific.hookEventName !== event) throw new TypeError('hook_output_event_mismatch');
  }
  if (value.reason !== undefined) textControl(value.reason);
  if (value.stopReason !== undefined) textControl(value.stopReason);
  if (specific?.permissionDecisionReason !== undefined) { const reason = textControl(specific.permissionDecisionReason); if (!reason.trim() || reason.length > 1024 || /[\x00-\x1f\x7f]/.test(reason)) throw new TypeError('invalid_hook_output'); }
  if (event === 'PreToolUse' && Object.keys(value).length === 0) throw new TypeError('unsupported_hook_output');
  if (value.decision !== undefined && value.decision !== 'block') throw new TypeError('unsupported_hook_output');
  if (value.continue !== undefined && typeof value.continue !== 'boolean') throw new TypeError('invalid_hook_output');
  if (event === 'PreToolUse') {
    if (value.continue !== undefined) throw new TypeError('unsupported_hook_output');
    if (specific?.permissionDecision !== undefined && !['allow', 'deny'].includes(specific.permissionDecision)) throw new TypeError('unsupported_hook_output');
    output.blocked = value.decision === 'block' || specific?.permissionDecision === 'deny';
    output.reason = specific?.permissionDecisionReason || value.reason || 'Blocked by a configured hook.';
  } else if (event === 'PostToolUse') {
    if (specific?.permissionDecision !== undefined || specific?.permissionDecisionReason !== undefined) throw new TypeError('unsupported_hook_output');
    output.blocked = value.decision === 'block' || value.continue === false;
    output.reason = value.reason || value.stopReason || 'Tool result blocked by a configured hook; its side effects were not undone.';
  } else if (Object.keys(value).some(key => key !== 'hookSpecificOutput') || specific && Object.keys(specific).length > 1) throw new TypeError('unsupported_hook_output');
  return output;
}
export function copyHookPayload(value) {
  let nodes = 0; const seen = new Set();
  const copy = (input, depth) => {
    if (++nodes > 4096 || depth > 12) throw new TypeError('hook_payload_limit');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') { if (input.length > 65536) throw new TypeError('hook_payload_limit'); return input; }
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object' || seen.has(input) || !Array.isArray(input) && !plainObject(input)) throw new TypeError('invalid_hook_payload');
    seen.add(input);
    const out = Array.isArray(input) ? [] : Object.create(null);
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('invalid_hook_payload');
      Object.defineProperty(out, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(input); return out;
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new TypeError('hook_payload_limit');
  return result;
}
// DSH-local count projection, not a claim about official wire key names.
export function sanitizeTokenUsage(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const snapshot = {};
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        if (key === 'inputTokens' || key === 'outputTokens') return null;
        continue;
      }
      if (!Object.hasOwn(descriptor, 'value') || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return null;
      snapshot[key] = descriptor.value === 0 ? 0 : descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch { return null; }
}
function payloadFor(rule, event, metadata, record) {
  const payload = { hook_event_name: event, session_id: record.sessionId, tool_name: record.toolName, timestamp: record.startedAt, source: 'dsh', payload_version: 1 };
  for (const field of ['source', 'reason', 'agentType', 'provider', 'model', 'status', 'runId']) {
    if (typeof metadata[field] === 'string' && metadata[field].length <= 512) payload[field === 'source' ? 'session_source' : field] = metadata[field];
  }
  if (event === 'PostModelRequest') {
    let usage;
    try { const descriptor = Object.getOwnPropertyDescriptor(metadata, 'tokenUsage'); if (descriptor && Object.hasOwn(descriptor, 'value')) usage = descriptor.value; } catch { /* Invalid metadata has no usage. */ }
    payload.token_usage = sanitizeTokenUsage(usage);
  }
  if (rule.includeToolInput) payload.tool_input = cloneToolInput(metadata.getToolInput());
  for (const [key, field] of [['child_id', 'childId'], ['run_id', 'runId'], ['stop_reason', 'stopReason']]) if (typeof metadata[field] === 'string') payload[key] = metadata[field].slice(0, 256);
  if (typeof metadata.local === 'boolean') payload.local = metadata.local;
  if (event !== 'PermissionRequest' && rule.payloadMode === 'full' && typeof metadata.readPayload === 'function') {
    try {
      const selected = metadata.readPayload();
      for (const key of ['tool_input', 'tool_response']) if (Object.hasOwn(selected, key)) payload[key] = copyHookPayload(selected[key]);
    } catch (error) { if (event === 'PreToolUse') throw error; payload.payload_omitted = true; }
  }
  return cloneToolInput(payload);
}
export function createHookManager({ initial = { enabled: false, rules: [] }, persist, execute = runCommand, fingerprint = fingerprintAction, maxRecords = 100, sourceReader = discoverCodexSources }) {
  if (!Array.isArray(initial.rules) || initial.rules.length > 100) throw new TypeError('hook_rule_limit');
  const initialRules = initial.rules.map(value => { const rule = parseRule(value); if (!Object.hasOwn(value, 'scope')) { delete rule.trust; rule.enabled = false; } if (!rule.trust) rule.enabled = false; return rule; });
  if (new Set(initialRules.map(rule => rule.id)).size !== initialRules.length) throw new TypeError('duplicate_hook_id');
  const registry = Object.getOwnPropertyDescriptor(initial, 'sourceRegistrations');
  if (registry && !('value' in registry)) throw new TypeError('invalid_source_registry');
  let state = { enabled: parseBoolean(initial.enabled), rules: initialRules, ...(registry ? { sourceRegistrations: parseSourceRegistry(registry.value) } : {}) }, closed = false, active = 0, queue = Promise.resolve();
  let sourceCheck;
  // Observation revokes runtime eligibility even if durable persistence later fails.
  const invalidatedSourceRules = new Set();
  const invalidationVersions = new Map();
  const invalidateSource = id => { invalidatedSourceRules.add(id); invalidationVersions.set(id, (invalidationVersions.get(id) ?? 0) + 1); };
  const recoveryEntry = (s, input) => {
    const entry = s.sourceRegistrations?.find(entry => entry.id === input.id);
    if (!entry) throw new Error('source_registration_not_found');
    if (entry.revision !== input.revision) throw new Error('source_revision_changed');
    return entry;
  };
  // Incarnations survive unrelated config clones, but never detach/re-register ABA.
  const sourceIdentities = new Map((state.sourceRegistrations ?? []).map(entry => [entry.id, randomUUID()]));
  const records = [], children = new Set(), controller = new AbortController();
  const background = createAsyncQueue();
  const internalRun = Symbol('async_stop_execution');
  const live = metadata => { try { return typeof metadata.sessionId === 'string' && metadata.sessionId.trim().length > 0 && typeof metadata.isSessionActive === 'function' && metadata.isSessionActive() === true; } catch { return false; } };
  const recordStatus = (rule, metadata, status) => {
    records.unshift({ id: randomUUID(), ruleId: rule.id, event: rule.event, sessionId: metadata.sessionId ?? '', startedAt: Date.now(), durationMs: 0, status, exitCode: null });
    records.length = Math.min(records.length, maxRecords);
  };
  const snapshot = () => structuredClone({ ...state, records, events: EVENTS });
  const mutate = (fn, committed) => { const pending = queue.then(async () => { if (closed) throw new Error('hooks_disposed'); const next = structuredClone(state); if (await fn(next) === false) return snapshot(); if (closed) throw new Error('hooks_disposed'); await persist(next); for (const entry of next.sourceRegistrations ?? []) { const previous = state.sourceRegistrations?.find(old => old.id === entry.id); if (!previous || JSON.stringify(previous) !== JSON.stringify(entry)) sourceIdentities.set(entry.id, randomUUID()); } for (const id of sourceIdentities.keys()) if (!next.sourceRegistrations?.some(entry => entry.id === id)) sourceIdentities.delete(id); state = next; committed?.(); return snapshot(); }); queue = pending.catch(() => {}); return pending; };
  const find = (rules, id) => { parseId(id); const rule = rules.find(rule => rule.id === id); if (!rule) throw new Error('hook_rule_not_found'); return rule; };
  const fingerprintRule = async rule => {
    if (closed) throw new Error('hooks_disposed');
    const { enabled: _enabled, trust: _trust, ...definition } = parseRule(rule);
    const result = await fingerprint(definition.action);
    if (closed) throw new Error('hooks_disposed');
    const digest = createHash('sha256').update(JSON.stringify({ version: 1, rule: definition, fingerprint: result.digest, files: result.files })).digest('hex');
    return { id: rule.id, digest, files: structuredClone(result.files), rule: structuredClone(definition) };
  };
  const verify = async rule => {
    sourceReady(state, rule.id);
    if (!rule.trust) throw new Error('hook_trust_required');
    if ((await fingerprintRule(rule)).digest !== rule.trust.digest) throw new Error('hook_trust_changed');
    sourceReady(state, rule.id);
  };
  const untrusted = value => { const { trust: _trust, ...rest } = value; return { ...parseRule(rest), enabled: false }; };
  const sourceReady = (s, id) => {
    if (invalidatedSourceRules.has(id) || s.sourceRegistrations?.some(entry => entry.status !== 'current' && entry.owners.some(owner => owner.id === id))) throw new Error('source_review_required');
  };
  const breakSourceOwnership = (s, id) => {
    for (const entry of s.sourceRegistrations ?? []) {
      if (entry.status === 'conflict' || !entry.owners.some(owner => owner.id === id)) continue;
      if (entry.revision >= Number.MAX_SAFE_INTEGER) throw new Error('source_revision_limit');
      entry.status = 'conflict'; entry.revision++;
    }
  };
  return {
    snapshot,
    registerSource(value) {
      const registration = parseSourceRegistrationRequest(value);
      return mutate(async s => {
        if ((s.sourceRegistrations?.length ?? 0) >= 8) throw new Error('source_registration_limit');
        if (s.sourceRegistrations?.some(entry => entry.id === registration.id)) throw new Error('duplicate_source_registration_id');
        const root = await canonicalDirectory(registration.request.directory);
        if (directoryIdentity(root) !== directoryIdentity(registration.request.directory)) throw new Error('source_root_not_canonical');
        registration.request.directory = root;
        registration.options.scope = await canonicalizeScope(registration.options.scope);
        const selectedNames = Object.keys(registration.accepted);
        const result = await sourceReader({ ...registration.request }, { selectedNames, requireCanonicalRoot: true });
        if (result?.kind !== registration.request.kind || typeof result.directory !== 'string' || directoryIdentity(result.directory) !== directoryIdentity(root) || !Array.isArray(result.sources)) throw new Error('source_registration_read_failed');
        const documents = selectedNames.map(name => {
          const candidates = result.sources.filter(source => source?.format === (name === 'hooks.json' ? 'json' : 'toml'));
          if (candidates.length !== 1 || candidates[0].status !== 'available' || candidates[0].sha256 !== registration.accepted[name] || typeof candidates[0].document !== 'string') throw new Error('source_registration_changed');
          return { document: candidates[0].document, source: `codex-file:${candidates[0].sha256}` };
        });
        const preview = previewCodexSources({ documents, options: registration.options });
        if (preview.unsupported.length) throw new Error('source_import_unsupported');
        const rules = preview.rules.map(untrusted);
        // Registration must not silently retarget the reviewed project while source I/O waits.
        const targetScope = await canonicalizeScope(registration.options.scope);
        if (targetScope.kind !== registration.options.scope.kind || targetScope.kind === 'project' && directoryIdentity(targetScope.root) !== directoryIdentity(registration.options.scope.root)) throw new Error('source_target_scope_changed');
        if (directoryIdentity(await canonicalDirectory(root)) !== directoryIdentity(root)) throw new Error('source_root_not_canonical');
        for (const rule of rules) {
          const scope = await canonicalizeScope(rule.scope);
          if (scope.kind !== targetScope.kind || scope.kind === 'project' && directoryIdentity(scope.root) !== directoryIdentity(targetScope.root)) throw new Error('source_target_scope_changed');
          rule.scope = scope;
        }
        if (s.rules.length + rules.length > 100) throw new Error('hook_rule_limit');
        const reserved = new Set([ ...s.rules.map(rule => rule.id), ...(s.sourceRegistrations ?? []).flatMap(entry => entry.owners.map(owner => owner.id)) ]);
        if (rules.some(rule => reserved.has(rule.id))) throw new Error('duplicate_hook_id');
        const entry = { ...registration, revision: 1, owners: rules.map(rule => ({ id: rule.id, digest: sourceDefinitionDigest(rule) })), status: 'current' };
        s.sourceRegistrations = parseSourceRegistry([...(s.sourceRegistrations ?? []), entry]);
        s.rules.push(...rules);
      });
    },
    async previewSourceRefresh(value) {
      const input = parseSourceDetachRequest(value);
      if (closed) throw new Error('hooks_disposed');
      const entry = structuredClone(recoveryEntry(state, input));
      const identity = sourceIdentities.get(input.id);
      const check = () => {
        if (closed) throw new Error('hooks_disposed');
        if (sourceIdentities.get(input.id) !== identity) throw new Error('source_revision_changed');
        const current = recoveryEntry(state, input);
        if (current.status === 'conflict' || current.owners.some(owner => {
          const rule = state.rules.find(rule => rule.id === owner.id);
          return !rule || sourceDefinitionDigest(rule) !== owner.digest;
        })) throw new Error('source_ownership_conflict');
      };
      const checkPaths = async () => {
        const root = await canonicalDirectory(entry.request.directory);
        if (directoryIdentity(root) !== directoryIdentity(entry.request.directory)) throw new Error('source_root_not_canonical');
        const scope = await canonicalizeScope(entry.options.scope);
        if (scope.kind !== entry.options.scope.kind || scope.kind === 'project' && directoryIdentity(scope.root) !== directoryIdentity(entry.options.scope.root)) throw new Error('source_target_scope_changed');
      };
      check();
      try { await checkPaths(); } catch (error) { check(); throw new Error(['source_root_not_canonical', 'source_target_scope_changed'].includes(error?.message) ? error.message : 'source_registration_read_failed'); }
      check();
      const selectedNames = Object.keys(entry.accepted);
      let result;
      try { result = await sourceReader({ ...entry.request }, { selectedNames, requireCanonicalRoot: true }); }
      catch (error) { check(); throw new Error(['source_root_not_canonical', 'source_target_scope_changed'].includes(error?.message) ? error.message : 'source_registration_read_failed'); }
      check();
      if (result?.kind !== entry.request.kind || typeof result.directory !== 'string' || directoryIdentity(result.directory) !== directoryIdentity(entry.request.directory) || !Array.isArray(result.sources)) throw new Error('source_registration_read_failed');
      if (result.sources.length !== selectedNames.length) throw new Error('source_file_set_changed');
      const accepted = {};
      const documents = selectedNames.map(name => {
        const candidates = result.sources.filter(source => source?.format === (name === 'hooks.json' ? 'json' : 'toml'));
        const source = candidates[0];
        if (candidates.length !== 1 || source.status !== 'available' || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256) || typeof source.document !== 'string') throw new Error('source_registration_changed');
        accepted[name] = source.sha256;
        return { document: source.document, source: `codex-file:${source.sha256}` };
      });
      const preview = previewCodexSources({ documents, options: entry.options });
      const rules = preview.rules.map(untrusted);
      const oldIds = new Set(entry.owners.map(owner => owner.id));
      const remaining = state.rules.filter(rule => !oldIds.has(rule.id));
      const reserved = new Set([...remaining.map(rule => rule.id), ...(state.sourceRegistrations ?? []).filter(other => other.id !== entry.id).flatMap(other => other.owners.map(owner => owner.id))]);
      if (remaining.length + rules.length > 100) throw new Error('hook_rule_limit');
      if (rules.some(rule => reserved.has(rule.id))) throw new Error('duplicate_hook_id');
      try { await checkPaths(); } catch (error) { check(); throw new Error(['source_root_not_canonical', 'source_target_scope_changed'].includes(error?.message) ? error.message : 'source_registration_read_failed'); }
      check();
      // Recheck collisions after the final filesystem await as well.
      const currentRemaining = state.rules.filter(rule => !oldIds.has(rule.id));
      const currentReserved = new Set([...currentRemaining.map(rule => rule.id), ...(state.sourceRegistrations ?? []).filter(other => other.id !== entry.id).flatMap(other => other.owners.map(owner => owner.id))]);
      if (currentRemaining.length + rules.length > 100) throw new Error('hook_rule_limit');
      if (rules.some(rule => currentReserved.has(rule.id))) throw new Error('duplicate_hook_id');
      return { request: { ...input, accepted, previewToken: identity }, rules, unsupported: preview.unsupported, warnings: preview.warnings };
    },
    refreshSource(value) {
      const input = parseSourceRefreshRequest(value);
      const accepted = input.accepted;
      let versions;
      return mutate(async s => {
        const entry = recoveryEntry(s, input);
        if (input.previewToken !== undefined && input.previewToken !== sourceIdentities.get(input.id)) throw new Error('source_revision_changed');
        if (entry.status === 'conflict' || entry.owners.some(owner => {
          const rule = s.rules.find(rule => rule.id === owner.id);
          return !rule || sourceDefinitionDigest(rule) !== owner.digest;
        })) throw new Error('source_ownership_conflict');
        if (entry.revision >= Number.MAX_SAFE_INTEGER) throw new Error('source_revision_limit');
        const checkPaths = async () => {
          try {
            const scope = await canonicalizeScope(entry.options.scope);
            if (scope.kind !== entry.options.scope.kind || scope.kind === 'project' && directoryIdentity(scope.root) !== directoryIdentity(entry.options.scope.root)) throw new Error('source_target_scope_changed');
            const root = await canonicalDirectory(entry.request.directory);
            if (directoryIdentity(root) !== directoryIdentity(entry.request.directory)) throw new Error('source_root_not_canonical');
          } catch (error) {
            throw new Error(['source_root_not_canonical', 'source_target_scope_changed'].includes(error?.message) ? error.message : 'source_registration_read_failed');
          }
        };
        await checkPaths();
        const selectedNames = Object.keys(entry.accepted);
        if (JSON.stringify([...selectedNames].sort()) !== JSON.stringify(Object.keys(accepted).sort())) throw new Error('source_file_set_changed');
        // Checks run outside the queue: preserve every invalidation observed after
        // this read starts, including observations while persistence is pending.
        const observed = new Map(invalidationVersions);
        const result = await sourceReader({ ...entry.request }, { selectedNames, requireCanonicalRoot: true });
        if (result?.kind !== entry.request.kind || typeof result.directory !== 'string' || directoryIdentity(result.directory) !== directoryIdentity(entry.request.directory) || !Array.isArray(result.sources)) throw new Error('source_registration_read_failed');
        if (result.sources.length !== selectedNames.length) throw new Error('source_file_set_changed');
        const documents = selectedNames.map(name => {
          const candidates = result.sources.filter(source => source?.format === (name === 'hooks.json' ? 'json' : 'toml'));
          if (candidates.length !== 1 || candidates[0].status !== 'available' || candidates[0].sha256 !== accepted[name] || typeof candidates[0].document !== 'string') throw new Error('source_registration_changed');
          return { document: candidates[0].document, source: `codex-file:${candidates[0].sha256}` };
        });
        // Empty updates must verify the reviewed paths too, not only imported rules.
        await checkPaths();
        const preview = previewCodexSources({ documents, options: entry.options });
        if (preview.unsupported.length) throw new Error('source_import_unsupported');
        const rules = preview.rules.map(untrusted);
        for (const rule of rules) {
          const scope = await canonicalizeScope(rule.scope);
          if (scope.kind !== entry.options.scope.kind || scope.kind === 'project' && directoryIdentity(scope.root) !== directoryIdentity(entry.options.scope.root)) throw new Error('source_target_scope_changed');
          rule.scope = scope;
        }
        // Recheck after all per-rule filesystem awaits, before publishing the replacement.
        await checkPaths();
        const oldIds = new Set(entry.owners.map(owner => owner.id));
        const remaining = s.rules.filter(rule => !oldIds.has(rule.id));
        if (remaining.length + rules.length > 100) throw new Error('hook_rule_limit');
        const reserved = new Set([...remaining.map(rule => rule.id), ...(s.sourceRegistrations ?? []).filter(other => other.id !== entry.id).flatMap(other => other.owners.map(owner => owner.id))]);
        if (rules.some(rule => reserved.has(rule.id))) throw new Error('duplicate_hook_id');
        versions = new Map([...oldIds, ...rules.map(rule => rule.id)].map(id => [id, observed.get(id) ?? 0]));
        s.rules = [...remaining, ...rules];
        entry.owners = rules.map(rule => ({ id: rule.id, digest: sourceDefinitionDigest(rule) }));
        entry.accepted = accepted; entry.status = 'current'; entry.revision++;
      }, () => {
        // Synchronous commit callback: no later mutation/check can interleave
        // between publishing the exact new revision and clearing old blocks.
        for (const [id, version] of versions) {
          if (!state.sourceRegistrations?.some(entry => entry.owners.some(owner => owner.id === id))) {
            invalidatedSourceRules.delete(id); invalidationVersions.delete(id);
          } else if ((invalidationVersions.get(id) ?? 0) === version) invalidatedSourceRules.delete(id);
        }
      });
    },
    detachSource(value) {
      const input = parseSourceDetachRequest(value);
      let ids;
      return mutate(s => {
        const entry = recoveryEntry(s, input);
        ids = entry.owners.map(owner => owner.id);
        for (const owner of entry.owners) {
          const rule = s.rules.find(rule => rule.id === owner.id);
          if (rule && sourceDefinitionDigest(rule) === owner.digest) { rule.enabled = false; delete rule.trust; }
        }
        s.sourceRegistrations = s.sourceRegistrations.filter(other => other.id !== entry.id);
        if (!s.sourceRegistrations.length) delete s.sourceRegistrations;
      }, () => { for (const id of ids) { invalidatedSourceRules.delete(id); invalidationVersions.delete(id); } });
    },
    checkSources() {
      if (sourceCheck) return sourceCheck;
      sourceCheck = (async () => {
        await queue;
        if (closed) throw new Error('hooks_disposed');
        const selected = structuredClone(state.sourceRegistrations ?? []);
        const incarnations = new Map(selected.map(entry => [entry.id, sourceIdentities.get(entry.id)]));
        if (!selected.length) return snapshot();
        const monitor = createSourceMonitor(selected.map(({ id, request, accepted }) => ({ id, request, accepted })), { discover: sourceReader });
        let results;
        try { results = await monitor.check(); } finally { monitor.dispose(); }
        // Revoke eligibility before waiting behind any already-queued durable mutation.
        for (const captured of selected) {
          const entry = state.sourceRegistrations?.find(entry => entry.id === captured.id);
          if (!entry || sourceIdentities.get(entry.id) !== incarnations.get(entry.id) || JSON.stringify(entry) !== JSON.stringify(captured)) continue;
          const result = results.find(result => result.id === entry.id);
          if (entry.status !== 'current' || result?.status !== 'unchanged' || entry.owners.some(owner => {
            const rule = state.rules.find(rule => rule.id === owner.id);
            return !rule || sourceDefinitionDigest(rule) !== owner.digest;
          })) for (const owner of entry.owners) invalidateSource(owner.id);
        }
        return mutate(s => {
          let changed = false;
          for (const captured of selected) {
            const entry = s.sourceRegistrations?.find(entry => entry.id === captured.id);
            if (!entry || sourceIdentities.get(entry.id) !== incarnations.get(entry.id) || JSON.stringify(entry) !== JSON.stringify(captured)) continue;
            const result = results.find(result => result.id === entry.id);
            const conflicts = entry.owners.some(owner => {
              const rule = s.rules.find(rule => rule.id === owner.id);
              return !rule || sourceDefinitionDigest(rule) !== owner.digest;
            });
            const status = conflicts || entry.status === 'conflict' ? 'conflict' : result?.status !== 'unchanged' || entry.owners.some(owner => invalidatedSourceRules.has(owner.id)) ? 'review' : entry.status;
            let modified = status !== entry.status;
            if (status !== 'current') {
              for (const owner of entry.owners) invalidateSource(owner.id);
              for (const owner of entry.owners) {
                const rule = s.rules.find(rule => rule.id === owner.id);
                if (!rule || sourceDefinitionDigest(rule) !== owner.digest) continue;
                if (rule.enabled || rule.trust) { rule.enabled = false; delete rule.trust; modified = true; }
              }
            }
            if (modified) {
              if (entry.revision >= Number.MAX_SAFE_INTEGER) throw new Error('source_revision_limit');
              entry.status = status; entry.revision++; changed = true;
            }
          }
          return changed;
        });
      })().finally(() => { sourceCheck = undefined; });
      return sourceCheck;
    },
    configure: value => { if (!value || Object.keys(value).some(k => k !== 'enabled')) throw new TypeError('invalid_hook_configuration'); const enabled = parseBoolean(value.enabled); return mutate(s => { s.enabled = enabled; }); },
    upsert: value => { const rule = untrusted(value); return mutate(async s => { rule.scope = await canonicalizeScope(rule.scope); breakSourceOwnership(s, rule.id); const index = s.rules.findIndex(r => r.id === rule.id); if (index < 0) { if (s.rules.length >= 100) throw new Error('hook_rule_limit'); s.rules.push(rule); } else s.rules[index] = rule; }); },
    async previewTrust(id) { await queue; return fingerprintRule(structuredClone(find(state.rules, id))); },
    trust: (id, digest) => { parseId(id); if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('invalid_hook_trust'); return mutate(async s => {
      sourceReady(s, id);
      const rule = find(s.rules, id), preview = await fingerprintRule(rule);
      sourceReady(s, id);
      if (preview.digest !== digest) throw new Error('hook_trust_changed');
      rule.trust = { digest }; rule.enabled = false;
    }); },
    importRules: values => {
      if (!Array.isArray(values) || values.length > 100) throw new TypeError('hook_rule_limit');
      const rules = values.map(untrusted);
      if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new TypeError('duplicate_hook_id');
      return mutate(async s => {
        for (const rule of rules) rule.scope = await canonicalizeScope(rule.scope);
        if (s.rules.length + rules.length > 100) throw new Error('hook_rule_limit');
        if (rules.some(rule => s.rules.some(existing => existing.id === rule.id) || s.sourceRegistrations?.some(entry => entry.owners.some(owner => owner.id === rule.id)))) throw new Error('duplicate_hook_id');
        s.rules.push(...rules);
      });
    },
    remove: id => { parseId(id); return mutate(s => { breakSourceOwnership(s, id); s.rules = s.rules.filter(r => r.id !== id); }); },
    toggle: (id, enabled) => { parseId(id); parseBoolean(enabled); return mutate(async s => { const rule = find(s.rules, id); if (enabled) { sourceReady(s, id); await verify(rule); } rule.enabled = enabled; }); },
    clearRecords: () => { records.length = 0; return snapshot(); },
    async dispatch(event, metadata = {}, signal) { return (await this.dispatchProtocol(event, metadata, signal)).blocked; },
    async dispatchDecision(event, metadata = {}, signal) { const { blocked, reason } = await this.dispatchProtocol(event, metadata, signal); return { blocked, reason: blocked ? reason : '' }; },
    async dispatchPermissionRequest(metadata = {}, signal) { return this.dispatchProtocol('PermissionRequest', metadata, signal, true); },
    cancelSession: sessionId => background.cancelSession(sessionId),
    async dispatchProtocol(event, metadata = {}, signal, enforcePermission = false, token, selected) {
      if (!names.has(event)) throw new TypeError('invalid_hook_event');
      const outcome = { blocked: false, reason: '', feedback: [] };
      const enforcing = event === 'PermissionRequest' && enforcePermission;
      if (closed) return enforcing ? { ...outcome, cancelled: true } : outcome;
      if (!state.enabled) return outcome;
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const backgroundRun = token === internalRun;
      const candidates = state.rules.filter(r => r.enabled && r.event === event && (!backgroundRun || r === selected) && (event !== 'PermissionRequest' || Boolean(r.denyPermissionRequest) === enforcing));
      let effectiveDirectory;
      if (candidates.some(rule => rule.scope.kind === 'project')) {
        try {
          const committed = metadata.getEffectiveDirectory?.();
          if (typeof committed === 'string' && path.isAbsolute(committed)) effectiveDirectory = await canonicalDirectory(committed);
        } catch { /* Unknown subject cannot select project rules. */ }
      }
      for (const rule of candidates.sort((a, b) => Number(a.scope.kind === 'project') - Number(b.scope.kind === 'project'))) {
        if (closed || combined.aborted) break;
        if (rule.scope.kind === 'project') {
          const selection = await evaluateScope(rule.scope, effectiveDirectory);
          if (closed || combined.aborted) break;
          if (selection !== 'matched') {
            if (selection !== 'mismatch') {
              records.unshift({ id: randomUUID(), ruleId: rule.id, event, startedAt: Date.now(), status: selection, exitCode: null, durationMs: 0 });
              records.length = Math.min(records.length, maxRecords);
            }
            continue;
          }
        }
        if (rule.async && !backgroundRun) {
          // Scope selection awaited: never enqueue a stale or disabled definition.
          if (closed || combined.aborted) break;
          if (!state.enabled || !state.rules.includes(rule) || !rule.enabled) { recordStatus(rule, metadata, 'trust_error'); continue; }
          if (!live(metadata)) { recordStatus(rule, metadata, 'cancelled'); continue; }
          const result = background.enqueue({ sessionId: metadata.sessionId, signal: combined,
            cancel: () => recordStatus(rule, metadata, 'cancelled'),
            run: async jobSignal => {
              if (!live(metadata) || closed || jobSignal.aborted) { recordStatus(rule, metadata, 'cancelled'); return; }
              if (!state.enabled || !state.rules.includes(rule) || !rule.enabled) { recordStatus(rule, metadata, 'trust_error'); return; }
              await this.dispatchProtocol(event, metadata, jobSignal, false, internalRun, rule);
            },
          });
          if (result !== 'queued') recordStatus(rule, metadata, result);
          continue;
        }
        if (backgroundRun && !live(metadata)) { recordStatus(rule, metadata, 'cancelled'); continue; }
        const startedAt = Date.now();
        const record = { id: randomUUID(), ruleId: rule.id, event, startedAt, toolName: metadata.toolName ?? '', sessionId: metadata.sessionId ?? '' };
        let parsed, reserved = false;
        try {
          if (active >= 4 || children.size >= 4) Object.assign(record, { status: 'busy', exitCode: null });
          else {
            active++; reserved = true;
            if (!await matchEvent({ event, pattern: rule.matcher, mode: rule.matcherMode, metadata, signal: combined })) continue;
            await verify(rule);
            if (backgroundRun && rule.scope.kind === 'project' && await evaluateScope(rule.scope, effectiveDirectory) !== 'matched') throw new Error('hook_trust_changed');
            if (!state.enabled || !state.rules.includes(rule) || !rule.enabled) throw new Error('hook_trust_changed');
            if (combined.aborted || backgroundRun && !live(metadata)) throw new Error('hook_cancelled');
            sourceReady(state, rule.id);
            // Verification/matching await: another job may have left a live child meanwhile.
            if (children.size >= 4) Object.assign(record, { status: 'busy', exitCode: null });
            else Object.assign(record, await execute(rule.action, payloadFor(rule, event, metadata, record), { signal: combined, children }));
          }
          try { if (!backgroundRun) parsed = parseHookOutput(event, record); }
          catch { record.status = 'protocol_error'; }
        } catch (error) {
          Object.assign(record, { status: error?.code === 'hook_matcher_timeout' ? 'matcher_timeout' : combined.aborted || error?.message === 'hook_cancelled' ? 'cancelled' : /hook_trust|source_review_required/.test(error?.message ?? '') ? 'trust_error' : 'internal_error', exitCode: null, stdout: '', stderr: '' });
        } finally { if (reserved) active--; }
        record.durationMs = Date.now() - startedAt;
        if (rule.includeToolInput || rule.payloadMode === 'full') { record.stdout = ''; record.stderr = ''; }
        const cancelled = enforcing && (combined.aborted || record.status === 'cancelled');
        const blocked = !backgroundRun && (parsed?.blocked && (event !== 'PermissionRequest' || enforcing) || event === 'PreToolUse' && record.status !== 'completed' || enforcing && (record.status !== 'completed' || record.exitCode !== 0));
        // This is this rule's evaluation, never the Host's final approval outcome.
        if (enforcing) record.policyOutcome = cancelled ? 'cancelled' : blocked ? 'deny' : 'abstain';
        if (cancelled) outcome.cancelled = true;
        else if (blocked) {
          outcome.blocked = true;
          // Local opt-in failure policy, not a claim about Codex exit-2 semantics.
          outcome.reason = parsed?.reason || 'Blocked by a configured local hook (execution or protocol failure).';
          if (enforcing) record.diagnostic = outcome.reason;
          outcome.feedback = [{ type: 'text', text: outcome.reason }];
        }
        records.unshift(record); records.length = Math.min(records.length, maxRecords);
        if (cancelled || blocked) break;
      }
      if (enforcing && combined.aborted) return { blocked: false, reason: '', feedback: [], cancelled: true };
      return outcome;
    },
    dispose() { closed = true; background.dispose(); controller.abort(); for (const child of children) { try { child.kill('SIGKILL'); } catch {} } },
  };
}
