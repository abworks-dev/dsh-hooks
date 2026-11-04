import { Worker } from 'node:worker_threads';

export const MAX_MATCHER_LENGTH = 512;
const MAX_LENGTH = MAX_MATCHER_LENGTH;
const TARGETS = Object.freeze({
  PreToolUse: 'toolName', PostToolUse: 'toolName', PermissionRequest: 'toolName',
  SessionStart: 'source', SessionEnd: 'reason', PreCompact: 'trigger', PostCompact: 'trigger',
  SubagentStart: 'agentType', SubagentStop: 'agentType',
});
const IGNORED = new Set(['UserPromptSubmit', 'Stop', 'Interrupt', 'PreModelRequest', 'PostModelRequest']);
const ALIASES = Object.freeze({ apply_patch: ['Edit', 'Write'], spawn_agent: ['Agent'] });
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.once('message', ({ pattern, targets }) => {
  try { const regex = new RegExp(pattern); parentPort.postMessage({ result: targets.some(target => regex.test(target)) }); }
  catch { parentPort.postMessage({ error: true }); }
});
parentPort.postMessage({ ready: true });
`;

/** Synchronously validate shape/length and regex syntax only; never execute a user regex. Returns pattern or throws. */
export function validateMatcher(pattern, mode = 'glob') {
  if (mode !== 'glob' && mode !== 'regex') throw new TypeError('invalid_hook_matcher_mode');
  if (typeof pattern !== 'string' || pattern.length > MAX_LENGTH) throw new TypeError('invalid_hook_matcher');
  if (mode === 'glob' && !/^[A-Za-z0-9_.*?/-]+$/.test(pattern)) throw new TypeError('invalid_hook_matcher');
  if (mode === 'regex' && pattern !== '*' && pattern !== '') {
    try { new RegExp(pattern); } catch { throw new TypeError('invalid_hook_matcher'); }
  }
  return pattern;
}

// Same whole-string * / ? dynamic programming as the original matcher, without backtracking.
function globMatch(pattern, target) {
  let row = [true, ...Array(target.length).fill(false)];
  for (const c of pattern) {
    const next = Array(target.length + 1).fill(false);
    next[0] = c === '*' && row[0];
    for (let i = 1; i <= target.length; i++) next[i] = c === '*' ? row[i] || next[i - 1] : row[i - 1] && (c === '?' || c === target[i - 1]);
    row = next;
  }
  return row[target.length];
}

function aborted() {
  return Object.assign(new Error('hook_matcher_aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}
function timeout() {
  return Object.assign(new Error('hook_matcher_timeout'), { code: 'hook_matcher_timeout' });
}

function regexMatch(pattern, targets, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Do not settle until the thread has actually stopped, including runaway regex execution.
      worker.terminate().then(() => {
        worker.removeAllListeners();
        if (error) reject(error); else resolve(result);
      }, terminationError => { worker.removeAllListeners(); reject(error ?? terminationError); });
    };
    const onAbort = () => finish(aborted());
    timer = setTimeout(() => finish(timeout()), 2000);
    worker.on('message', message => {
      if (settled) return;
      if (message.ready) {
        clearTimeout(timer);
        timer = setTimeout(() => finish(timeout()), 100);
        worker.postMessage({ pattern, targets });
      } else if (message.error) finish(new TypeError('invalid_hook_matcher'));
      else finish(null, message.result === true);
    });
    worker.on('error', error => finish(error));
    worker.on('exit', () => { if (!settled) finish(new Error('hook_matcher_worker_exit')); });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Match an event against its metadata field. Promise<boolean>; timeout and cancellation reject, never silently pass. */
export async function matchEvent({ event, pattern, mode = 'glob', metadata = {}, signal }) {
  validateMatcher(pattern, mode);
  if (signal?.aborted) throw aborted();
  if (typeof event !== 'string' || event.length > MAX_LENGTH) throw new TypeError('invalid_hook_event');
  if (IGNORED.has(event)) return true;
  if (!Object.hasOwn(TARGETS, event)) return false;
  const field = TARGETS[event];
  const target = metadata?.[field] ?? '';
  if (typeof target !== 'string' || target.length > MAX_LENGTH) throw new TypeError('invalid_hook_matcher_target');
  const targets = [target, ...(field === 'toolName' && Object.hasOwn(ALIASES, target) ? ALIASES[target] : [])];
  if (mode === 'regex' && (pattern === '*' || pattern === '')) return true;
  return mode === 'glob' ? targets.some(value => globMatch(pattern, value)) : regexMatch(pattern, targets, signal);
}
