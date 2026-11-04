import { createHash } from 'node:crypto';
import { parseRule } from './core.js';
import { parseSourceRegistrations, parseSourceAccepted } from './source-monitor.js';
import { parseCodexSourcesRequest } from './codex-import.js';

const fail = () => new TypeError('invalid_source_registry');
function fields(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) throw fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function array(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw fail();
  return Array.from({ length: value.length }, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !('value' in descriptor)) throw fail();
    return descriptor.value;
  });
}
export function parseSourceRegistrationRequest(value) {
  const input = fields(value, ['id', 'request', 'accepted', 'options']);
  const request = fields(input.request, ['kind', 'directory']);
  const [registration] = parseSourceRegistrations([{ id: input.id, request, accepted: input.accepted }]);
  // Reuse the importer's closed descriptor validation and defaults, without importing content.
  const { options } = parseCodexSourcesRequest({ documents: [{ document: '{"hooks":{}}', source: `codex-file:${'0'.repeat(64)}` }], options: input.options });
  if (!options.interpreter) throw fail();
  return { ...registration, options };
}
export function parseSourceRegistry(values) {
  const ids = new Set(), owners = new Set();
  return array(values, 8).map(value => {
    const input = fields(value, ['id', 'request', 'accepted', 'options', 'revision', 'owners', 'status']);
    const registration = parseSourceRegistrationRequest({ id: input.id, request: input.request, accepted: input.accepted, options: input.options });
    if (ids.has(registration.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !['current', 'review', 'conflict'].includes(input.status)) throw fail();
    ids.add(registration.id);
    const parsedOwners = array(input.owners, 100).map(value => {
      const owner = fields(value, ['id', 'digest']);
      if (typeof owner.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(owner.id) || owners.has(owner.id) || typeof owner.digest !== 'string' || !/^[a-f0-9]{64}$/.test(owner.digest)) throw fail();
      owners.add(owner.id);
      if (owners.size > 100) throw fail();
      return owner;
    });
    return { ...registration, revision: input.revision, owners: parsedOwners, status: input.status };
  });
}
function sourceReference(value, keys) {
  const input = fields(value, keys);
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1) throw fail();
  return input;
}
export function parseSourceRefreshRequest(value) {
  const hasToken = value && typeof value === 'object' && Object.hasOwn(value, 'previewToken');
  const input = sourceReference(value, hasToken ? ['id', 'revision', 'accepted', 'previewToken'] : ['id', 'revision', 'accepted']);
  if (hasToken && (typeof input.previewToken !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.previewToken))) throw fail();
  return { id: input.id, revision: input.revision, accepted: parseSourceAccepted(input.accepted), ...(hasToken ? { previewToken: input.previewToken } : {}) };
}
export function parseSourceDetachRequest(value) {
  const input = sourceReference(value, ['id', 'revision']);
  return { id: input.id, revision: input.revision };
}
export function sourceDefinitionDigest(value) {
  const { enabled: _enabled, trust: _trust, ...definition } = parseRule(value);
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}
