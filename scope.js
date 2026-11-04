import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

// Selection boundaries only: these rules do not sandbox commands or load project files.
export function parseScope(value) {
  if (value === undefined) return { kind: 'user' };
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('invalid_hook_scope');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new TypeError('invalid_hook_scope');
  if (value.kind === 'user' && keys.length === 1) return { kind: 'user' };
  if (value.kind !== 'project' || keys.length !== 2 || !keys.includes('root')) throw new TypeError('invalid_hook_scope');
  const root = value.root;
  if (typeof root !== 'string' || !root || root.length > 4096 || /[\x00-\x1f\x7f]/.test(root) || !path.isAbsolute(root)) throw new TypeError('invalid_hook_scope_root');
  if (process.platform === 'win32') {
    if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(root) || /^\\\\[?.]\\/.test(root) || /[. ](?:[\\/]|$)/.test(root) || root.slice(path.parse(root).root.length).includes(':')) throw new TypeError('invalid_hook_scope_root');
  }
  return { kind: 'project', root };
}
export function directoryIdentity(value, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  let normalized = api.normalize(value);
  const root = api.parse(normalized).root;
  while (normalized.length > root.length && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}
export async function canonicalDirectory(root) {
  const resolved = await realpath(root);
  if (!(await stat(resolved)).isDirectory()) throw new TypeError('invalid_hook_scope_directory');
  return resolved;
}
export async function canonicalizeScope(value) {
  const scope = parseScope(value);
  return scope.kind === 'user' ? scope : { kind: 'project', root: await canonicalDirectory(scope.root) };
}
// Fixed outcomes only: never return filesystem errors or directory values to diagnostics.
export async function evaluateScope(scope, effectiveDirectory) {
  if (scope.kind === 'user') return 'matched';
  let root;
  try {
    root = await canonicalDirectory(scope.root);
    // A deleted/replaced path or redirect must never silently expand selection.
    if (directoryIdentity(root) !== directoryIdentity(scope.root)) return 'scope_invalid';
  } catch { return 'scope_invalid'; }
  if (typeof effectiveDirectory !== 'string' || !path.isAbsolute(effectiveDirectory)) return 'scope_unavailable';
  return directoryIdentity(effectiveDirectory) === directoryIdentity(root) ? 'matched' : 'mismatch';
}
export async function matchesScope(scope, effectiveDirectory) {
  return await evaluateScope(scope, effectiveDirectory) === 'matched';
}
