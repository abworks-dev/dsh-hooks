import { isMain, readEvent } from './event.mjs';
const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
// Illustrative patterns only. This is NOT a shell parser or a security sandbox.
export function evaluate(event) {
  if (event.hook_event_name !== 'PreToolUse') throw new Error('pretool_event_required');
  if (!event.tool_input || typeof event.tool_input.command !== 'string') return deny('This example needs an explicitly shared tool_input.command; review the rule and tool schema.');
  const command = event.tool_input.command;
  if (/\brm\b[^\r\n]*\s-[A-Za-z]*r[A-Za-z]*f|\brm\b[^\r\n]*\s-[A-Za-z]*f[A-Za-z]*r/i.test(command)
    || /\bgit\s+push\b[^\r\n]*(?:--force\b|(?:^|\s)-f(?:\s|$))/i.test(command)
    || /\bRemove-Item\b[^\r\n]*-Recurse\b[^\r\n]*-Force\b/i.test(command)) return deny('Illustrative policy: destructive deletion or force push requires manual review.');
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
}
if (isMain(import.meta.url)) readEvent().then(event => console.log(JSON.stringify(evaluate(event)))).catch(error => { console.error(error.message); process.exitCode = 2; });
