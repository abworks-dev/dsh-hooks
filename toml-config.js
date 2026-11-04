import { Worker } from 'node:worker_threads';

const MAX_BYTES = 256 * 1024;
const WORKER_CODES = new Set([
  'toml_invalid_document', 'toml_hooks_missing', 'toml_hooks_invalid',
  'toml_hooks_too_large', 'toml_hooks_too_deep', 'toml_hooks_too_many_nodes',
  'toml_hooks_non_json', 'toml_hooks_unsafe_key',
]);
const fail = code => Object.assign(new Error(code), { code });

/** Parse data only, returning exactly the JSON envelope { hooks }. Never returns other TOML fields. */
export async function extractTomlHooks(document) {
  if (typeof document !== 'string') throw fail('toml_invalid_document');
  if (Buffer.byteLength(document, 'utf8') > MAX_BYTES) throw fail('toml_document_too_large');
  let worker;
  let timer;
  try {
    worker = new Worker(new URL('./toml-worker.js', import.meta.url), {
      workerData: document,
      // Do not inherit CLI preload/eval flags into the parser worker.
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(fail('toml_timeout')), 2000);
      worker.once('message', result => {
        if (result?.ok === true && typeof result.json === 'string' &&
            Buffer.byteLength(result.json, 'utf8') <= MAX_BYTES) resolve(result.json);
        else reject(fail(WORKER_CODES.has(result?.code) ? result.code : 'toml_worker_failed'));
      });
      worker.once('error', () => reject(fail('toml_worker_failed')));
      worker.once('exit', () => reject(fail('toml_worker_failed')));
    });
  } catch (error) {
    // Never expose Worker/parser messages, causes, source excerpts or file paths.
    const code = error?.code;
    throw fail(WORKER_CODES.has(code) || code === 'toml_timeout' ? code : 'toml_worker_failed');
  } finally {
    clearTimeout(timer);
    if (worker) {
      try { await worker.terminate(); } catch { /* Preserve the fixed public result. */ }
      worker.removeAllListeners();
    }
  }
}
