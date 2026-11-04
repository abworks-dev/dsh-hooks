import { parentPort, workerData } from 'node:worker_threads';
import TOML from '@iarna/toml';

const MAX_BYTES = 256 * 1024;
const MAX_NODES = 32768;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const ordinary = value => value !== null && typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype;

function extract(document) {
  let parsed;
  try { parsed = TOML.parse(document); } catch { fail('toml_invalid_document'); }
  if (!Object.hasOwn(parsed, 'hooks')) fail('toml_hooks_missing');
  if (!ordinary(parsed.hooks)) fail('toml_hooks_invalid');
  let nodes = 0;
  function validate(value, depth) {
    if (++nodes > MAX_NODES) fail('toml_hooks_too_many_nodes');
    if (depth > 64) fail('toml_hooks_too_deep');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('toml_hooks_non_json');
      return;
    }
    if (typeof value !== 'object' || (!Array.isArray(value) && !ordinary(value))) fail('toml_hooks_non_json');
    // Inspect the parser result before any serialization can call Date.toJSON or drop values.
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('toml_hooks_unsafe_key');
      validate(value[key], depth + 1);
    }
  }
  validate(parsed.hooks, 0);
  const json = JSON.stringify({ hooks: parsed.hooks });
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) fail('toml_hooks_too_large');
  return json;
}

// Only fixed codes cross the worker boundary; parser exceptions are discarded.
try {
  parentPort.postMessage({ ok: true, json: extract(workerData) });
} catch (error) {
  const codes = new Set(['toml_invalid_document', 'toml_hooks_missing', 'toml_hooks_invalid',
    'toml_hooks_too_large', 'toml_hooks_too_deep', 'toml_hooks_too_many_nodes',
    'toml_hooks_non_json', 'toml_hooks_unsafe_key']);
  parentPort.postMessage({ ok: false, code: codes.has(error?.code) ? error.code : 'toml_worker_failed' });
}
