import { constants } from 'node:fs';
import { lstat, stat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { extractTomlHooks } from './toml-config.js';

const MAX_BYTES = 256 * 1024;
const fail = (code) => Object.assign(new Error(code), { code });

/** Closed, descriptor-validated input; never consults environment or cwd. */
export function parseSourceRequest(request) {
  if (!request || typeof request !== 'object') throw fail('invalid_request');
  const proto = Object.getPrototypeOf(request);
  if (proto !== Object.prototype && proto !== null) throw fail('invalid_request');
  const keys = Reflect.ownKeys(request);
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('directory')) throw fail('invalid_request');
  const descriptors = Object.getOwnPropertyDescriptors(request);
  if (!('value' in descriptors.kind) || !('value' in descriptors.directory)) throw fail('invalid_request');
  const kind = descriptors.kind.value;
  const directory = descriptors.directory.value;
  if ((kind !== 'user' && kind !== 'project') || typeof directory !== 'string' ||
      !directory.length || directory.length > 4096 || directory.includes(String.fromCharCode(0)) || !path.isAbsolute(directory) ||
      (process.platform === 'win32' && (
        !(/^[a-zA-Z]:[\\/]/.test(directory) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(directory)) ||
        /^[\\/]{2}[?.][\\/]/.test(directory) ||
        directory.replace(/^[a-zA-Z]:/, '').includes(':') ||
        directory.split(/[\\/]/).some(part => /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))
      ))) {
    throw fail('invalid_request');
  }
  return { kind, directory };
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}
function sameFile(a, b) {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function samePath(a, b) {
  const normalize = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : value;
  return normalize(a) === normalize(b);
}
async function checkedDirectory(directory, expected) {
  const info = await lstat(directory, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory() || !sameIdentity(info, expected) ||
      !samePath(await realpath(directory), directory)) throw fail('path_redirected');
}

/**
 * Explicit discovery only: bounded TOML hooks extraction, no execution, import, persistence or scanning.
 * lstat/realpath/fd checks reduce races, but portable Node path opens are not an
 * atomic filesystem sandbox (especially against hostile concurrent renames).
 */
function parseReadOptions(options) {
  if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw fail('invalid_request');
  const fields = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['selectedNames', 'requireCanonicalRoot'].includes(key) || !fields[key].enumerable || !('value' in fields[key]))) throw fail('invalid_request');
  const requireCanonicalRoot = fields.requireCanonicalRoot ? fields.requireCanonicalRoot.value : false;
  if (typeof requireCanonicalRoot !== 'boolean') throw fail('invalid_request');
  const selected = fields.selectedNames ? fields.selectedNames.value : ['hooks.json', 'config.toml'];
  if (!Array.isArray(selected) || !selected.length || selected.length > 2) throw fail('invalid_request');
  const indices = Object.getOwnPropertyDescriptors(selected), names = [];
  if (Reflect.ownKeys(selected).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|1)$/.test(key) || Number(key) >= selected.length || !indices[key].enumerable || !('value' in indices[key])))) throw fail('invalid_request');
  for (let index = 0; index < selected.length; index++) {
    const field = indices[index];
    if (!field || !('value' in field) || !['hooks.json', 'config.toml'].includes(field.value) || names.includes(field.value)) throw fail('invalid_request');
    names.push(field.value);
  }
  return { names, requireCanonicalRoot };
}
export async function discoverCodexSources(request, options = {}) {
  const parsed = parseSourceRequest(request);
  const { names, requireCanonicalRoot } = parseReadOptions(options);
  let directory, root;
  try {
    directory = await realpath(parsed.directory);
    if (requireCanonicalRoot && !samePath(directory, parsed.directory)) throw fail('path_redirected');
    root = await stat(directory, { bigint: true });
    if (!root.isDirectory()) throw fail('invalid_directory');
    await checkedDirectory(directory, root);
  } catch {
    throw fail('invalid_directory');
  }
  const base = parsed.kind === 'project' ? path.join(directory, '.codex') : directory;
  const sources = [];
  for (const [name, format] of [['hooks.json', 'json'], ['config.toml', 'toml']]) {
    if (!names.includes(name)) continue;
    const filename = path.join(base, name);
    const source = { path: filename, format, status: 'rejected' };
    let handle, parent;
    let observedFile = false;
    try {
      await checkedDirectory(directory, root);
      if (base !== directory) {
        parent = await lstat(base, { bigint: true });
        if (parent.isSymbolicLink() || !parent.isDirectory() || !samePath(await realpath(base), base)) throw fail('path_redirected');
      }
      const before = await lstat(filename, { bigint: true });
      observedFile = true;
      if (before.isSymbolicLink()) throw fail('path_redirected');
      if (!before.isFile()) throw fail('not_regular_file');
      if (!samePath(await realpath(filename), filename)) throw fail('path_redirected');
      const verify = async (opened) => {
        await checkedDirectory(directory, root);
        if (parent) await checkedDirectory(base, parent);
        const after = await lstat(filename, { bigint: true });
        if (after.isSymbolicLink() || !after.isFile() || !samePath(await realpath(filename), filename) || !sameFile(before, after)) throw fail('file_changed');
        if (opened && !sameFile(before, opened)) throw fail('file_changed');
      };
      {
        if (before.size > BigInt(MAX_BYTES)) throw fail('too_large');
        handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || !sameFile(before, opened)) throw fail('file_changed');
        await verify(opened);
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let count = 0;
        while (count < buffer.length) {
          const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
          if (!bytesRead) break;
          count += bytesRead;
        }
        if (count > MAX_BYTES) throw fail('too_large');
        const after = await handle.stat({ bigint: true });
        await verify(after);
        if (!sameFile(opened, after) || BigInt(count) !== after.size) throw fail('file_changed');
        const bytes = buffer.subarray(0, count);
        let document;
        try { document = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw fail('invalid_utf8'); }
        // TOML is parsed inside a bounded worker; never expose unrelated settings.
        if (format === 'toml') document = await extractTomlHooks(document);
        source.status = 'available';
        source.document = document;
        source.sha256 = createHash('sha256').update(bytes).digest('hex');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // A disappearing/redirected root must not be reported as an ordinary miss.
        try {
          await checkedDirectory(directory, root);
          if (parent) await checkedDirectory(base, parent);
          if (observedFile) source.code = 'file_changed';
          else source.status = 'missing';
        } catch { source.code = 'path_redirected'; }
      } else {
        const allowed = ['path_redirected', 'not_regular_file', 'file_changed', 'too_large', 'invalid_utf8', 'toml_invalid_document', 'toml_document_too_large', 'toml_hooks_missing', 'toml_hooks_invalid', 'toml_hooks_too_large', 'toml_hooks_too_deep', 'toml_hooks_too_many_nodes', 'toml_hooks_non_json', 'toml_hooks_unsafe_key', 'toml_timeout', 'toml_worker_failed'];
        source.code = allowed.includes(error?.code) ? error.code : 'read_failed';
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    sources.push(source);
  }
  return { directory, kind: parsed.kind, sources };
}
