import { createHookManager, parseRule, sanitizeTokenUsage } from './core.js';
import { mountRpc } from './rpc.js';
import { parseSourceRegistry } from './source-registry.js';
import { startSourceChecks } from './source-poller.js';
export const inject = ['storageDomain', 'typert', 'typertGateway', 'connection', 'sessions', 'workingDirectory', 'agents'];

export function bindEvents(ctx, manager) {
  const off = [];
  // Retain only a sequence watermark per live Session, never its log or event data.
  const interruptSeq = new WeakMap();
  const agentSessions = new WeakMap();
  const rememberAgent = agent => {
    if (!agent || ctx.agents?.get(agent.id) !== agent) return;
    const session = ctx.sessions?.get(agent.id);
    if (session) agentSessions.set(agent, session);
  };
  for (const agent of ctx.agents?.list() ?? []) rememberAgent(agent);
  // Capture only the host's exact Session; lazy directory reads do not consult submitted IDs.
  const sessionScope = session => {
    if (!session || !ctx.workingDirectory || ctx.sessions?.get(session.id) !== session) return {};
    // Snapshot synchronously: asynchronous user hooks cannot retarget this event with cd.
    let directory;
    try { directory = ctx.workingDirectory.get(session); } catch { /* Unknown directory. */ }
    return { getEffectiveDirectory: () => directory, isSessionActive: () => ctx.sessions?.get(session.id) === session };
  };
  const agentScope = agent => {
    const scope = sessionScope(agent ? agentSessions.get(agent) : undefined);
    if (!scope.isSessionActive) return scope;
    return { ...scope, isSessionActive: () => Boolean(scope.isSessionActive() && ctx.agents?.get(agent.id) === agent) };
  };
  const hostIdScope = id => sessionScope(ctx.sessions?.get(id));
  const observeLifecycle = (event, metadata, signal) => { void manager.dispatch(event, metadata, signal).catch(error => ctx.logger?.warn?.('Hook observation failed: %s', error?.name ?? 'Error')); };
  // Never evaluate arguments unless a matching, enabled rule explicitly opts in.
  const meta = payload => ({ ...agentScope(payload?.agent), sessionId: payload?.agent?.id ?? '', toolName: payload?.name ?? payload?.toolName ?? '', getToolInput: () => payload?.arguments, readPayload: () => ({ tool_input: payload?.arguments }) });
  const childMeta = info => ({ ...hostIdScope(info.id), sessionId: info.id, childId: info.id, provider: info.provider, local: info.local, runId: info.runId });
  const observeChild = (event, info) => {
    const metadata = childMeta(info);
    if (event === 'SubagentStop') metadata.stopReason = info.stopReason;
    if (event === 'SubagentStart') {
      // The published child is available now, not necessarily when queued work runs.
      // Never bind an external child or retarget to a later Agent with the same ID.
      const childId = metadata.sessionId, agent = ctx.agents?.get(childId), scopeSession = metadata.isSessionActive;
      const local = info.local === true;
      metadata.isSessionActive = () => Boolean(local && agent && scopeSession?.() && ctx.agents?.get(childId) === agent);
    }
    void manager.dispatch(event, metadata).catch(error => ctx.logger?.warn?.('Hook observation failed: %s', error?.name ?? 'Error'));
  };
  const observe = (event, payload) => { void manager.dispatch(event, meta(payload), payload?.signal).catch(error => ctx.logger?.warn?.('Hook observation failed: %s', error?.name ?? 'Error')); };
  try {
    off.push(ctx.on('agent/created', payload => { rememberAgent(payload.agent); observeLifecycle('SessionStart', { ...agentScope(payload.agent), sessionId: payload.agent.id, source: payload.source }, payload.signal); }));
    off.push(ctx.on('agent/disposed', payload => { manager.cancelSession?.(payload.agent.id); observeLifecycle('SessionEnd', { ...agentScope(payload.agent), sessionId: payload.agent.id }); }));
    off.push(ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return;
      const reason = event.data.reason;
      if (reason.kind !== 'aborted' || reason.reason.kind !== 'user') return;
      if (Number.isSafeInteger(event.seq)) {
        if (event.seq <= (interruptSeq.get(session) ?? -1)) return;
        interruptSeq.set(session, event.seq);
      }
      const scope = sessionScope(session), agent = ctx.agents?.get(session.id);
      observeLifecycle('Interrupt', { ...scope, ...(scope.isSessionActive ? { isSessionActive: () => Boolean(agent && scope.isSessionActive() && ctx.agents?.get(session.id) === agent) } : {}), sessionId: session.id, reason: 'user' });
    }));
    off.push(ctx.on('agent/inbox/inserted', payload => { observe('UserPromptSubmit', payload); }));
    off.push(ctx.on('agent/status', payload => { if (payload.status === 'idle') observe('Stop', payload); }));
    off.push(ctx.on('tools/post-execute', async (exec, result, next) => {
      const metadata = { ...meta(exec), readPayload: () => ({ tool_input: exec.arguments, tool_response: result }) };
      const decision = await manager.dispatchProtocol('PostToolUse', metadata, exec.signal);
      if (decision.blocked) return { kind: 'block', feedback: decision.feedback };
      return next();
    }));
    off.push(ctx.on('llm/stream', async function* (options, next) {
      const sessionId = options.sessionId;
      if (!sessionId || options.purpose) { yield* next(); return; }
      const scope = hostIdScope(sessionId), agent = ctx.agents?.get(sessionId);
      const metadata = { ...scope, ...(scope.isSessionActive ? { isSessionActive: () => Boolean(agent && scope.isSessionActive() && ctx.agents?.get(sessionId) === agent) } : {}), sessionId, provider: options.provider, model: options.model };
      let status = 'closed', usage = null;
      try {
        void manager.dispatch('PreModelRequest', metadata, options.signal).catch(error => ctx.logger?.warn?.('Hook observation failed: %s', error?.name ?? 'Error'));
        for await (const chunk of next()) {
          const type = chunk.type;
          if (type === 'finish') status = chunk.reason?.kind ?? 'finished';
          if (type === 'usage') {
            try {
              const descriptor = Object.getOwnPropertyDescriptor(chunk, 'usage');
              const snapshot = descriptor && Object.hasOwn(descriptor, 'value') ? sanitizeTokenUsage(descriptor.value) : null;
              if (snapshot) usage = snapshot;
            } catch { /* Malformed usage must not affect the stream. */ }
          }
          yield chunk;
        }
      } catch (error) { status = options.signal?.aborted ? 'aborted' : 'error'; throw error; }
      finally { void manager.dispatch('PostModelRequest', { ...metadata, status, tokenUsage: usage }).catch(error => ctx.logger?.warn?.('Hook observation failed: %s', error?.name ?? 'Error')); }
    }));
    off.push(ctx.on('subagent/start', info => { observeChild('SubagentStart', info); }));
    off.push(ctx.on('subagent/end', info => { observeChild('SubagentStop', info); }));
    off.push(ctx.on('approval/request', async (request, next) => {
      const signal = request.signal;
      if (signal?.aborted) return 'cancelled';
      // Only the public agent/tool identity is available here. Never inspect request
      // arguments, reason/displayReason, or fabricate a tool_input in full mode.
      const metadata = { ...agentScope(request.agent), sessionId: request.agent.id, toolName: request.toolName };
      let abort;
      const cancelled = signal && new Promise(resolve => {
        abort = () => resolve({ cancelled: true });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      let decision;
      try {
        const enforcement = Promise.resolve().then(() => manager.dispatchPermissionRequest(metadata, signal));
        decision = await (cancelled ? Promise.race([enforcement, cancelled]) : enforcement);
      } catch {
        // Explicit enforced policies fail closed locally; never synthesize approval.
        decision = { blocked: true };
      } finally { if (abort) signal.removeEventListener('abort', abort); }
      if (signal?.aborted || decision?.cancelled) return 'cancelled';
      observeLifecycle('PermissionRequest', metadata, signal);
      if (signal?.aborted) return 'cancelled';
      if (decision.blocked) return 'rejected';
      if (!signal) return next();
      let abortNext;
      try {
        const aborted = new Promise(resolve => {
          abortNext = () => resolve('cancelled');
          signal.addEventListener('abort', abortNext, { once: true });
          if (signal.aborted) abortNext();
        });
        if (signal.aborted) return 'cancelled';
        const outcome = await Promise.race([next(), aborted]);
        return signal.aborted ? 'cancelled' : outcome;
      } finally { signal.removeEventListener('abort', abortNext); }
    }));
    off.push(ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await manager.dispatchDecision('PreToolUse', meta(exec), exec.signal);
      if (exec.signal?.aborted) return { kind: 'cancel' };
      if (decision.blocked) return { kind: 'deny', reason: decision.reason };
      return next();
    }));
  } catch (error) { for (const dispose of off.reverse()) dispose(); throw error; }
  return () => { for (const dispose of off.splice(0).reverse()) dispose(); };
}

export function createStateSchema(z) {
  // Preserve absence of legacy scope until the manager can invalidate old trust.
  const ruleSchema = z.unknown().transform(value => { const parsed = parseRule(value); if (!Object.hasOwn(value, 'scope')) delete parsed.scope; return parsed; });
  return z.object({ enabled: z.boolean(), rules: z.array(ruleSchema).max(100), sourceRegistrations: z.unknown().transform(parseSourceRegistry).optional() }).strict();
}

export async function apply(ctx) {
  const [{ z }, { TypertRemoteService }] = await Promise.all([import('zod'), import('@deepseek-ai/dsh-typert-protocol')]);
  const schema = createStateSchema(z);
  const domain = await ctx.storageDomain.open({ name: 'abworks_generic_hooks', version: 1, tables: {}, global: { schema, initial: { enabled: false, rules: [] } } });
  let manager, off, release, stopChecks, closed = false;
  const dispose = async () => {
    if (closed) return; closed = true;
    stopChecks?.(); manager?.dispose(); off?.();
    try { await release?.(); } finally { await domain.close(); }
  };
  try {
    manager = createHookManager({ initial: domain.global.get(), persist: value => domain.global.set(value) });
    // No hook listeners or owner RPC can observe a persisted source before its
    // first recheck commits. Startup failure disposes instead of running stale rules.
    stopChecks = await startSourceChecks(manager, { onError: () => ctx.logger?.warn?.('Hook source check failed') });
    off = bindEvents(ctx, manager);
    release = mountRpc(ctx, manager, TypertRemoteService);
    ctx.effect(() => dispose);
    return dispose;
  } catch (error) { await dispose(); throw error; }
}
