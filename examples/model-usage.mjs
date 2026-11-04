#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isMain, readEvent } from './event.mjs';

// Usage: node examples/model-usage.mjs /absolute/path/to/usage.jsonl
// Metadata-only PostModelRequest hook. Never copy arbitrary payload properties,
// provider/model identifiers, errors, prompts, bodies, or response content.
const counts = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const statuses = new Set(['stop', 'length', 'tool_calls', 'error', 'cancelled', 'aborted', 'completed', 'success']);
export function usageRecord(event) {
  if (!event || Array.isArray(event) || event.source !== 'dsh' || event.hook_event_name !== 'PostModelRequest') throw new Error('invalid_event');
  const usage = event.token_usage;
  let tokenUsage = null;
  if (usage !== null) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('invalid_usage');
    tokenUsage = {};
    for (const key of counts) {
      if (!Object.hasOwn(usage, key)) {
        if (key === 'inputTokens' || key === 'outputTokens') throw new Error('invalid_usage');
        continue;
      }
      if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error('invalid_usage');
      tokenUsage[key] = usage[key] === 0 ? 0 : usage[key];
    }
  }
  const record = { hook_event_name: 'PostModelRequest', source: 'dsh', token_usage: tokenUsage };
  if (event.payload_version === 1) record.payload_version = 1;
  if (Number.isSafeInteger(event.timestamp) && event.timestamp >= 0) record.timestamp = event.timestamp;
  if (statuses.has(event.status)) record.status = event.status;
  return record;
}
export async function main() {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination || !isAbsolute(destination) || extra.length) throw new Error('absolute_log_path_required');
  const record = usageRecord(await readEvent()); // Bounded to 70,000 input bytes.
  await appendFile(destination, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
}
if (isMain(import.meta.url)) main().catch(() => {
  // Neither JSON parser excerpts nor filesystem paths may reach hook diagnostics.
  console.error('model_usage_failed');
  process.exitCode = 1;
});
