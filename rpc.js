import { parseBoolean, parseId, parseRule } from './core.js';
const PACKAGE = '@abworks/dsh-hooks';
const codec = (name, parse) => ({ mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => ({ parse }) });
const json = codec('Snapshot', value => JSON.parse(JSON.stringify(value)));
const id = codec('Id', parseId), bool = codec('Boolean', parseBoolean), rule = codec('Rule', parseRule);
const configuration = codec('Configuration', v => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1 || !Object.hasOwn(v, 'enabled')) throw new TypeError('invalid_hook_configuration'); return { enabled: parseBoolean(v.enabled) }; });
const arg = (name, type) => ({ name, wire: name, source: 'json', codec: type });
export const descriptors = [
  ['snapshot', []], ['configure', [arg('configuration', configuration)]], ['upsert', [arg('rule', rule)]],
  ['remove', [arg('id', id)]], ['toggle', [arg('id', id), arg('enabled', bool)]], ['clearRecords', []],
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
  }
  new GenericHooksService();
  return ctx.typert.register({ package: PACKAGE, face: 'host', model: { services: [], events: [], objects: [] }, schemas: [], invocations: descriptors });
}
