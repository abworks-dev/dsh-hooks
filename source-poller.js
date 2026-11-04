/** Check current manager registrations without retaining roots or source contents. */
export async function startSourceChecks(manager, {
  intervalMs = 30000,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  onError = () => {},
} = {}) {
  if (!manager || typeof manager.checkSources !== 'function') throw new TypeError('invalid_source_check_manager');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new RangeError('invalid_source_check_interval');
  if (typeof setTimeout !== 'function' || typeof clearTimeout !== 'function' || typeof onError !== 'function') throw new TypeError('invalid_source_check_functions');

  // Startup failure belongs to the caller: do not bind timers or report it twice.
  await manager.checkSources();
  let stopped = false;
  let timer;
  let pending = false;
  function schedule() {
    if (stopped) return;
    pending = true;
    timer = setTimeout(poll, intervalMs);
    timer?.unref?.();
  }
  async function poll() {
    if (stopped || !pending) return;
    pending = false;
    timer = undefined;
    try {
      await manager.checkSources();
    } catch {
      if (!stopped) {
        // Neither the raw failure nor a failing reporter may escape this boundary.
        try { await onError(); } catch {}
      }
    } finally {
      schedule();
    }
  }
  schedule();
  return function stop() {
    if (stopped) return;
    stopped = true;
    if (pending) clearTimeout(timer);
    pending = false;
    timer = undefined;
    // In-flight filesystem work is not cancelled; its completion is ignored.
  };
}
