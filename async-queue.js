// Process-local bounded FIFO; cancellation settles work, not direct-child close.
export function createAsyncQueue({ concurrency = 4, maxPending = 32 } = {}) {
  const pending = [], active = new Set();
  let closed = false;
  const pump = () => {
    while (!closed && active.size < concurrency && pending.length) {
      const job = pending.shift();
      if (job.signal?.aborted) { job.cancel?.(); continue; }
      const controller = new AbortController();
      job.controller = controller;
      active.add(job);
      Promise.resolve().then(() => job.run(job.signal ? AbortSignal.any([job.signal, controller.signal]) : controller.signal))
        .catch(() => { try { job.cancel?.(); } catch {} })
        .finally(() => { active.delete(job); pump(); });
    }
  };
  const cancel = predicate => {
    for (let i = pending.length - 1; i >= 0; i--) if (predicate(pending[i])) { const [job] = pending.splice(i, 1); job.cancel?.(); }
    for (const job of active) if (predicate(job)) job.controller.abort();
  };
  return {
    enqueue(job) {
      if (closed || job.signal?.aborted) return 'cancelled';
      if (active.size >= concurrency && pending.length >= maxPending) return 'busy';
      pending.push(job); pump(); return 'queued';
    },
    cancelSession: sessionId => cancel(job => job.sessionId === sessionId),
    dispose() { closed = true; cancel(() => true); },
    snapshot: () => ({ active: active.size, pending: pending.length }),
  };
}
