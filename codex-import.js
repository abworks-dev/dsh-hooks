import path from 'node:path';
import { createHash } from 'node:crypto';
import { EVENTS, supportsAsyncEvent } from './core.js';
import { parseScope } from './scope.js';
import { MAX_MATCHER_LENGTH, validateMatcher } from './matcher.js';

const MAX_BYTES = 256 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4096) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const pointerKey = key => key.replaceAll('~', '~0').replaceAll('/', '~1');
const unknown = (value, allowed) => Object.keys(value).filter(key => !allowed.includes(key));
const closedOptions = (value, allowed) => object(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && allowed.includes(key) && descriptor.enumerable && 'value' in descriptor;
  });
const denseArguments = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= 63
  && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor?.enumerable && 'value' in descriptor && text(descriptor.value);
  }).every(Boolean);
const nativeAbsolute = executable => path.isAbsolute(executable)
  && (process.platform !== 'win32' || /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(executable));
function validateJson(value, depth = 0) {
  if (depth > 64) throw new TypeError('codex_import_depth_limit');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new TypeError('codex_import_json_required');
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('codex_import_json_required');
    validateJson(descriptor.value, depth + 1);
  }
}

// Validate the entire shallow transport envelope before parsing any document JSON.
export function parseCodexSourcesRequest(request) {
  const fail = () => { throw new TypeError('codex_sources_invalid_request'); };
  if (!closedOptions(request, ['documents', 'options']) || !Object.hasOwn(request, 'documents')) fail();
  const documents = request.documents;
  if (!Array.isArray(documents) || Object.getPrototypeOf(documents) !== Array.prototype || documents.length < 1 || documents.length > 2 || Reflect.ownKeys(documents).length !== documents.length + 1) fail();
  const sources = new Set();
  const copied = [];
  for (let index = 0; index < documents.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(documents, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
    const entry = descriptor.value;
    if (!closedOptions(entry, ['document', 'source']) || !Object.hasOwn(entry, 'document') || !Object.hasOwn(entry, 'source')) fail();
    if (typeof entry.document !== 'string' || Buffer.byteLength(entry.document, 'utf8') > MAX_BYTES) fail();
    if (typeof entry.source !== 'string' || !/^codex-file:[a-f0-9]{64}$/.test(entry.source) || sources.has(entry.source)) fail();
    sources.add(entry.source);
    copied.push({ document: entry.document, source: entry.source });
  }
  const options = request.options === undefined ? {} : request.options;
  if (!closedOptions(options, ['interpreter', 'platform', 'scope'])) throw new TypeError('codex_import_invalid_options');
  const scope = parseScope(options.scope);
  const platform = options.platform === undefined ? process.platform : options.platform;
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new TypeError('codex_import_invalid_platform');
  if (platform !== process.platform) throw new TypeError('codex_import_platform_mismatch');
  const interpreter = options.interpreter;
  if (interpreter !== undefined && (!closedOptions(interpreter, ['executable', 'argvPrefix']) || !text(interpreter.executable) || !nativeAbsolute(interpreter.executable) || /\.(cmd|bat)$/i.test(interpreter.executable) || !denseArguments(interpreter.argvPrefix))) throw new TypeError('codex_import_invalid_interpreter');
  return { documents: copied, options: { scope, platform, ...(interpreter === undefined ? {} : { interpreter: { executable: interpreter.executable, argvPrefix: [...interpreter.argvPrefix] } }) } };
}

/** Cumulative explicit source preview; no discovery, persistence, trust or execution. */
export function previewCodexSources(request) {
  request = parseCodexSourcesRequest(request);
  const result = { rules: [], warnings: [], unsupported: [] };
  const ids = new Set();
  let count = 0;
  for (const { document, source } of request.documents) {
    const preview = previewCodexImport(document, { ...request.options, source });
    count += preview.rules.length + preview.unsupported.length;
    if (count > 100) throw new TypeError('codex_import_handler_limit');
    for (const rule of preview.rules) {
      if (ids.has(rule.id)) throw new TypeError('codex_import_duplicate_id');
      ids.add(rule.id);
    }
    result.rules.push(...preview.rules);
    result.warnings.push(...preview.warnings);
    result.unsupported.push(...preview.unsupported);
  }
  return result;
}

/** Preview only: never reads files, executes commands, or enables imported rules. */
export function previewCodexImport(document, options = {}) {
  if (typeof document === 'string') {
    if (Buffer.byteLength(document, 'utf8') > MAX_BYTES) throw new TypeError('codex_import_size_limit');
    try { document = JSON.parse(document); } catch { throw new TypeError('codex_import_invalid_json'); }
  }
  validateJson(document);
  const serialized = JSON.stringify(document);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) throw new TypeError('codex_import_size_limit');
  document = JSON.parse(serialized);
  if (!object(document) || unknown(document, ['description', 'hooks']).length || !object(document.hooks) || (document.description !== undefined && !text(document.description, MAX_BYTES))) throw new TypeError('codex_import_invalid_document');
  if (!closedOptions(options, ['interpreter', 'platform', 'source', 'scope'])) throw new TypeError('codex_import_invalid_options');
  const scope = parseScope(options.scope);
  const platform = options.platform === undefined ? process.platform : options.platform;
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new TypeError('codex_import_invalid_platform');
  if (platform !== process.platform) throw new TypeError('codex_import_platform_mismatch');
  const source = options.source === undefined ? 'codex-import' : options.source;
  if (!text(source, 256) || !source.trim()) throw new TypeError('codex_import_invalid_source');
  const interpreter = options.interpreter;
  if (interpreter !== undefined && (!closedOptions(interpreter, ['executable', 'argvPrefix']) || !text(interpreter.executable) || !nativeAbsolute(interpreter.executable) || /\.(cmd|bat)$/i.test(interpreter.executable) || !denseArguments(interpreter.argvPrefix))) throw new TypeError('codex_import_invalid_interpreter');
  const rules = [], unsupported = [], warnings = [{ pointer: '', code: 'metadata_only', message: 'Imported hooks receive metadata only, not Codex prompts, tool arguments, results or transcripts.' }];
  const events = new Set(EVENTS.map(event => event.name));
  let count = 0;
  for (const [event, groups] of Object.entries(document.hooks)) {
    const eventPointer = `/hooks/${pointerKey(event)}`;
    if (!Array.isArray(groups)) throw new TypeError(`codex_import_invalid_groups:${eventPointer}`);
    groups.forEach((group, groupIndex) => {
      const groupPointer = `${eventPointer}/${groupIndex}`;
      if (!object(group) || !Array.isArray(group.hooks)) throw new TypeError(`codex_import_invalid_group:${groupPointer}`);
      const groupErrors = unknown(group, ['matcher', 'hooks']).map(key => `unsupported_group_field:${key}`);
      const matcher = group.matcher === undefined ? '*' : group.matcher;
      if (!text(matcher, MAX_MATCHER_LENGTH)) groupErrors.push('invalid_matcher');
      else {
        try { validateMatcher(matcher, 'regex'); }
        catch { groupErrors.push('invalid_matcher_regex'); }
      }
      group.hooks.forEach((handler, handlerIndex) => {
        if (++count > 100) throw new TypeError('codex_import_handler_limit');
        const pointer = `${groupPointer}/hooks/${handlerIndex}`;
        const definition = { event, matcher, handler };
        const review = { source, pointer, definition, ...(document.description !== undefined ? { description: document.description } : {}) };
        const reasons = [...groupErrors];
        if (!events.has(event)) reasons.push('unsupported_event');
        if (!object(handler)) reasons.push('invalid_handler');
        else {
          reasons.push(...unknown(handler, ['type', 'command', 'commandWindows', 'timeout', 'statusMessage', 'async', 'additionalContextLimit']).map(key => `unsupported_handler_field:${key}`));
          if (handler.type !== 'command') reasons.push(`unsupported_handler_type:${String(handler.type)}`);
          if (!text(handler.command) || !handler.command.length) reasons.push('invalid_command');
          if (handler.commandWindows !== undefined && (!text(handler.commandWindows) || !handler.commandWindows.length)) reasons.push('invalid_command_windows');
          if (handler.async !== undefined && (typeof handler.async !== 'boolean' || (handler.async === true && !supportsAsyncEvent(event)))) reasons.push('unsupported_async');
          if (handler.additionalContextLimit !== undefined) reasons.push('unsupported_additional_context_limit');
          if (handler.statusMessage !== undefined && !text(handler.statusMessage, 4096)) reasons.push('invalid_status_message');
          const timeout = handler.timeout === undefined ? (['SessionEnd', 'Interrupt'].includes(event) ? 1 : 600) : handler.timeout;
          if (!Number.isInteger(timeout) || timeout < 1 || timeout > (['SessionEnd', 'Interrupt'].includes(event) ? 3 : 600)) reasons.push('unsupported_timeout');
          if (!interpreter) reasons.push('explicit_interpreter_required');
          if (!reasons.length) {
            const command = platform === 'win32' && handler.commandWindows !== undefined ? handler.commandWindows : handler.command;
            const id = createHash('sha256').update(JSON.stringify({ review, scope })).digest('hex').slice(0, 32);
            rules.push({ scope, id, name: `${event} ${groupIndex + 1}.${handlerIndex + 1}`, event, ...(handler.async === true ? { async: true } : {}), enabled: false, matcher, matcherMode: 'regex', payloadMode: 'metadata', source, review, action: { type: 'command', executable: interpreter.executable, argv: [...interpreter.argvPrefix, command], timeoutMs: timeout * 1000, maxOutputBytes: 4096 } });
            if (handler.statusMessage !== undefined) warnings.push({ pointer, code: 'status_message_review_only', message: 'statusMessage is retained in the review definition but is not displayed during execution.' });
            warnings.push({ pointer, code: 'review_required', message: 'Review the original shell command and explicit interpreter; this rule remains disabled and does not provide full Codex output or lifecycle semantics.' });
          }
        }
        if (reasons.length) unsupported.push({ ...review, reasons });
      });
    });
  }
  return { rules, warnings, unsupported };
}
