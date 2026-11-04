import path from 'node:path';
import { parseSourceRequest, discoverCodexSources } from './config-sources.js';

const fail = () => new TypeError('invalid_source_registration');
function data(value, allowed) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !descriptors[key].enumerable || !('value' in descriptors[key]))) throw fail();
  return descriptors;
}
export function parseSourceAccepted(value) {
  const accepted = data(value, ['hooks.json', 'config.toml']);
  if (!Object.keys(accepted).length) throw fail();
  const hashes = {};
  for (const name of Object.keys(accepted)) {
    const hash = accepted[name].value;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw fail();
    hashes[name] = hash;
  }
  return hashes;
}
export function parseSourceRegistrations(values) {
  if (!Array.isArray(values) || values.length > 8) throw fail();
  const array = Object.getOwnPropertyDescriptors(values);
  if (Reflect.ownKeys(values).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= values.length || !('value' in array[key])))) throw fail();
  const ids = new Set(), parsed = [];
  for (let i = 0; i < values.length; i++) {
    if (!array[i] || !('value' in array[i])) throw fail();
    const fields = data(array[i].value, ['id', 'request', 'accepted']);
    if (Object.keys(fields).length !== 3) throw fail();
    const id = fields.id.value;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw fail();
    ids.add(id);
    const request = parseSourceRequest(fields.request.value);
    const accepted = parseSourceAccepted(fields.accepted.value);
    parsed.push({ id, request, accepted });
  }
  return parsed;
}
const identity = directory => process.platform === 'win32' ? path.normalize(directory).toLowerCase() : path.normalize(directory);

/** Read-only foundation: no timers, persistence, rule mutation, imports or execution. */
export function createSourceMonitor(registrations, { discover = discoverCodexSources } = {}) {
  const selected = parseSourceRegistrations(registrations);
  let closed = false, pending;
  const unavailable = entry => ({ id: entry.id, status: 'unavailable', files: Object.keys(entry.accepted).map(name => ({ name, status: 'unavailable' })) });
  async function inspect(entry) {
    try {
      const result = await discover({ ...entry.request }, { selectedNames: Object.keys(entry.accepted), requireCanonicalRoot: true });
      // Registrations must already contain canonical roots; never follow a moved root.
      if (typeof result?.directory !== 'string' || identity(result.directory) !== identity(entry.request.directory) || result.kind !== entry.request.kind || !Array.isArray(result.sources)) return unavailable(entry);
      const files = Object.entries(entry.accepted).map(([name, hash]) => {
        const format = name === 'hooks.json' ? 'json' : 'toml';
        const candidates = result.sources.filter(source => source?.format === format);
        if (candidates.length !== 1) return { name, status: 'unavailable' };
        const source = candidates[0];
        if (source.status === 'missing' || source.status === 'rejected') return { name, status: source.status };
        if (source.status !== 'available' || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) return { name, status: 'unavailable' };
        return { name, status: source.sha256 === hash ? 'unchanged' : 'changed', sha256: source.sha256 };
      });
      const status = ['unavailable', 'rejected', 'missing', 'changed'].find(status => files.some(file => file.status === status)) ?? 'unchanged';
      return { id: entry.id, status, files };
    } catch { return unavailable(entry); }
  }
  return {
    check() {
      if (closed) return Promise.resolve([]);
      if (pending) return pending;
      pending = (async () => {
        const results = [];
        for (const entry of selected) {
          if (closed) return [];
          results.push(await inspect(entry));
        }
        return closed ? [] : results;
      })().finally(() => { pending = undefined; });
      return pending;
    },
    dispose() { closed = true; },
  };
}
