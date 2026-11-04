import { parseBoolean, parseId, parseRule } from './core.js';
import { previewCodexImport, previewCodexSources, parseCodexSourcesRequest } from './codex-import.js';
import { discoverCodexSources, parseSourceRequest } from './config-sources.js';
import { parseSourceRegistrationRequest, parseSourceRefreshRequest, parseSourceDetachRequest } from './source-registry.js';
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('invalid_hook_trust'); return value; };
const digestCodec = { mode: 'strict', typeSymbol: '@abworks/dsh-hooks#Digest', create: () => ({ parse: digest }) };
const PACKAGE = '@abworks/dsh-hooks';
const codec = (name, parse) => ({ mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => ({ parse }) });
const json = codec('Snapshot', value => JSON.parse(JSON.stringify(value)));
const id = codec('Id', parseId), bool = codec('Boolean', parseBoolean), rule = codec('Rule', parseRule);
const configuration = codec('Configuration', v => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1 || !Object.hasOwn(v, 'enabled')) throw new TypeError('invalid_hook_configuration'); return { enabled: parseBoolean(v.enabled) }; });
function parseImportRequest(value) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || !Object.hasOwn(value, 'document') || !Reflect.ownKeys(value).every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return typeof key === 'string' && ['document', 'options'].includes(key) && d.enumerable && 'value' in d; })) throw new TypeError('invalid_hook_import_request');
  // The pure importer validates bounded JSON and closed interpreter/options before serialization.
  previewCodexImport(value.document, value.options);
  return JSON.parse(JSON.stringify(value));
}
const importRequest = codec('ImportRequest', parseImportRequest);
const sourceRequest = codec('SourceRequest', parseSourceRequest);
const sourceImportsRequest = codec('SourceImportsRequest', parseCodexSourcesRequest);
const sourceRegistrationRequest = codec('SourceRegistrationRequest', parseSourceRegistrationRequest);
const sourceRefreshRequest = codec('SourceRefreshRequest', parseSourceRefreshRequest);
const sourceDetachRequest = codec('SourceDetachRequest', parseSourceDetachRequest);
const arg = (name, type) => ({ name, wire: name, source: 'json', codec: type });
export const descriptors = [
  ['snapshot', []], ['configure', [arg('configuration', configuration)]], ['upsert', [arg('rule', rule)]],
  ['remove', [arg('id', id)]], ['toggle', [arg('id', id), arg('enabled', bool)]], ['clearRecords', []],
  ['previewTrust', [arg('id', id)]], ['trust', [arg('id', id), arg('digest', digestCodec)]],
  ['previewImport', [arg('request', importRequest)]], ['importCodex', [arg('request', importRequest)]],
  ['discoverSources', [arg('request', sourceRequest)]],
  ['previewSourceImports', [arg('request', sourceImportsRequest)]], ['importSources', [arg('request', sourceImportsRequest)]],
  ['registerSource', [arg('request', sourceRegistrationRequest)]], ['checkSources', []],
  ['previewSourceRefresh', [arg('request', sourceDetachRequest)]],
  ['refreshSource', [arg('request', sourceRefreshRequest)]], ['detachSource', [arg('request', sourceDetachRequest)]],
].map(([method, parameters]) => ({ id: `${PACKAGE}#genericHooks/${method}`, service: 'genericHooks', namespace: 'genericHooks', method,
  invocation: { kind: 'direct' }, parameters, result: json }));
export function mountRpc(ctx, manager, TypertRemoteService) {
  class GenericHooksService extends TypertRemoteService {
    constructor() { super(ctx, 'genericHooks'); }
    requireOwner() {
      const peer = this.ctx.invocation?.peer;
      if (!peer || peer.principal?.kind !== 'owner' || peer !== ctx.connection.browserPeer) throw new Error('local_owner_client_required');
    }
    snapshot() { this.requireOwner(); return manager.snapshot(); }
    configure(configuration) { this.requireOwner(); return manager.configure(configuration); }
    upsert(rule) { this.requireOwner(); return manager.upsert(rule); }
    remove(id) { this.requireOwner(); return manager.remove(id); }
    toggle(id, enabled) { this.requireOwner(); return manager.toggle(id, enabled); }
    clearRecords() { this.requireOwner(); return manager.clearRecords(); }
    previewTrust(id) { this.requireOwner(); return manager.previewTrust(id); }
    trust(id, digest) { this.requireOwner(); return manager.trust(id, digest); }
    discoverSources(request) { this.requireOwner(); return discoverCodexSources(parseSourceRequest(request)); }
    registerSource(request) { this.requireOwner(); return manager.registerSource(parseSourceRegistrationRequest(request)); }
    checkSources() { this.requireOwner(); return manager.checkSources(); }
    previewSourceRefresh(request) { this.requireOwner(); return manager.previewSourceRefresh(parseSourceDetachRequest(request)); }
    refreshSource(request) { this.requireOwner(); return manager.refreshSource(parseSourceRefreshRequest(request)); }
    detachSource(request) { this.requireOwner(); return manager.detachSource(parseSourceDetachRequest(request)); }
    previewSourceImports(request) { this.requireOwner(); return previewCodexSources(request); }
    importSources(request) { this.requireOwner(); const preview = previewCodexSources(request); if (preview.unsupported.length) throw new Error('hook_import_contains_unsupported'); return manager.importRules(preview.rules); }
    previewImport(request) { this.requireOwner(); request = parseImportRequest(request); return previewCodexImport(request.document, request.options); }
    importCodex(request) { this.requireOwner(); request = parseImportRequest(request); const preview = previewCodexImport(request.document, request.options); if (preview.unsupported.length) throw new Error('hook_import_contains_unsupported'); return manager.importRules(preview.rules); }
  }
  new GenericHooksService();
  return ctx.typert.register({ package: PACKAGE, face: 'host', model: { services: [], events: [], objects: [] }, schemas: [], invocations: descriptors });
}
