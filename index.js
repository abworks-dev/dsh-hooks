import { createHookManager, parseRule } from './core.js';
import { mountRpc } from './rpc.js';
export const inject = ['storageDomain', 'typert', 'typertGateway', 'connection'];

export function bindEvents(ctx, manager) {
  const off = [];
  const meta = payload => ({ sessionId: payload?.agent?.id ?? '', toolName: payload?.name ?? payload?.toolName ?? '' });
  const observe = (event, payload) => { void manager.dispatch(event, meta(payload), payload?.signal).catch(error => ctx.logger?.warn?.('Hook observation failed: %s', error?.name ?? 'Error')); };
  try {
    off.push(ctx.on('agent/created', payload => { observe('SessionStart', payload); }));
    off.push(ctx.on('agent/disposed', payload => { observe('SessionEnd', payload); }));
    off.push(ctx.on('agent/inbox/inserted', payload => { observe('UserPromptSubmit', payload); }));
    off.push(ctx.on('agent/status', payload => { if (payload.status === 'idle') observe('Stop', payload); }));
    off.push(ctx.on('tools/result', exec => { observe('PostToolUse', exec); }));
    off.push(ctx.on('approval/request', (request, next) => { observe('PermissionRequest', request); return next(); }));
    off.push(ctx.on('tools/pre-execute', async (exec, next) => {
      const denied = await manager.dispatch('PreToolUse', meta(exec), exec.signal);
      if (exec.signal?.aborted) return { kind: 'cancel' };
      if (denied) return { kind: 'deny', reason: 'Blocked by a configured local hook (exit 2 or hook execution failure).' };
      return next();
    }));
  } catch (error) { for (const dispose of off.reverse()) dispose(); throw error; }
  return () => { for (const dispose of off.splice(0).reverse()) dispose(); };
}

export async function apply(ctx) {
  const [{ z }, { TypertRemoteService }] = await Promise.all([import('zod'), import('@deepseek-ai/dsh-typert-protocol')]);
  const ruleSchema = z.unknown().transform(value => parseRule(value));
  const schema = z.object({ enabled: z.boolean(), rules: z.array(ruleSchema).max(100) }).strict();
  const domain = await ctx.storageDomain.open({ name: 'abworks_generic_hooks', version: 1, tables: {}, global: { schema, initial: { enabled: false, rules: [] } } });
  let manager, off, release, closed = false;
  const dispose = async () => {
    if (closed) return; closed = true;
    manager?.dispose(); off?.();
    try { await release?.(); } finally { await domain.close(); }
  };
  try {
    manager = createHookManager({ initial: domain.global.get(), persist: value => domain.global.set(value) });
    off = bindEvents(ctx, manager);
    release = mountRpc(ctx, manager, TypertRemoteService);
    ctx.effect(() => dispose);
    return dispose;
  } catch (error) { await dispose(); throw error; }
}
