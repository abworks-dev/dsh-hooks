import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const FILE_LIMIT = 128 * 1024 * 1024;
const TOTAL_LIMIT = 256 * 1024 * 1024;
const fail = message => { throw new TypeError(message); };
function absolute(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) fail('invalid_hook_trust_absolute_path');
  // Accept separator spelling without changing the action string or command semantics.
  const spelling = process.platform === 'win32' ? value.replaceAll('/', '\\') : value;
  if (path.normalize(spelling) !== spelling || (process.platform === 'win32' &&
    (/[. ](?:[\\/]|$)/.test(value) || spelling.slice(path.parse(spelling).root.length).includes(':') || /^\\\\[?.]\\/.test(spelling)))) fail('invalid_hook_trust_noncanonical_path');
  return value;
}
function limit(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`invalid_hook_trust_${name}`);
  return value;
}
function snapshot(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) fail('invalid_hook_trust_action');
  const allowed = new Set(['type', 'executable', 'argv', 'timeoutMs', 'maxOutputBytes', 'async', 'trustFiles']);
  if (Object.keys(action).some(key => !allowed.has(key)) || (action.type !== undefined && action.type !== 'command')) fail('invalid_hook_trust_action');
  const executable = absolute(action.executable);
  const argv = action.argv === undefined ? [] : action.argv;
  if (!Array.isArray(argv) || argv.length > 64 || Array.from(argv).some(v => typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) fail('invalid_hook_trust_argv');
  const trustFiles = action.trustFiles === undefined ? [] : action.trustFiles;
  if (!Array.isArray(trustFiles) || trustFiles.length > 16) fail('invalid_hook_trust_files');
  const files = Array.from(trustFiles, absolute);
  if (action.async !== undefined && action.async !== false) fail('invalid_hook_trust_async');
  return { type: 'command', executable, argv: [...argv], timeoutMs: limit(action.timeoutMs, 5000, 100, 600000, 'timeoutMs'),
    maxOutputBytes: limit(action.maxOutputBytes, 4096, 256, 65536, 'maxOutputBytes'), async: action.async ?? false, trustFiles: files };
}
const stable = (a, b) => (a.isDirectory() ? ['dev', 'ino', 'mode'] : ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']).every(key => a[key] === b[key]);
async function inspect(file) {
  // Inspection canonicalizes separators; action digest and returned paths stay raw.
  file = path.normalize(file);
  const parsed = path.parse(file);
  let current = parsed.root;
  const chain = [current];
  for (const component of file.slice(current.length).split(path.sep)) {
    current = path.join(current, component); chain.push(current);
  }
  const stats = [];
  for (let i = 0; i < chain.length; i++) {
    const stat = await lstat(chain[i], { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('hook_trust_symlink_rejected');
    if (i < chain.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('hook_trust_regular_file_required');
    stats.push(stat);
  }
  const resolved = await realpath(file);
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (comparable(resolved) !== comparable(file)) throw new Error('hook_trust_path_redirected');
  return stats;
}

/** Hash only executable + explicit trustFiles, never argv-derived files; never execute.
 * Rejects lstat-identified symlinks/junctions and realpath redirection.
 * Node cannot identify every Windows reparse type; this is NOT a reparse sandbox.
 * This is a point-in-time fingerprint, not an atomic execution-time guarantee.
 * @returns {Promise<{digest: string, files: Array<{path: string, sha256: string, size: number}>}>}
 */
export async function fingerprintAction(action) {
  const canonical = snapshot(action);
  if (process.platform !== 'win32' && !constants.O_NOFOLLOW) throw new Error('hook_trust_nofollow_unavailable');
  const files = [], observations = [];
  let total = 0;
  for (const file of [canonical.executable, ...canonical.trustFiles]) {
    const before = await inspect(file), initial = before.at(-1);
    if (initial.size > BigInt(FILE_LIMIT)) throw new Error('hook_trust_file_limit');
    if (BigInt(total) + initial.size > BigInt(TOTAL_LIMIT)) throw new Error('hook_trust_total_limit');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !stable(initial, opened)) throw new Error('hook_trust_file_changed');
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > FILE_LIMIT) throw new Error('hook_trust_file_limit');
        if (total + size > TOTAL_LIMIT) throw new Error('hook_trust_total_limit');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true }), chain = await inspect(file);
      if (BigInt(size) !== initial.size || !stable(initial, after) || before.some((s, i) => !stable(s, chain[i]))) throw new Error('hook_trust_file_changed');
      files.push({ path: file, sha256: hash.digest('hex'), size });
      observations.push({ file, chain }); total += size;
    } finally { await handle.close(); }
  }
  // Detect earlier files changing while later files were being hashed.
  for (const { file, chain } of observations) {
    const final = await inspect(file);
    if (chain.some((s, i) => !stable(s, final[i]))) throw new Error('hook_trust_file_changed');
  }
  const digest = createHash('sha256').update(JSON.stringify({ version: 1, action: canonical, files })).digest('hex');
  return { digest, files };
}
