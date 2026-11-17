#!/bin/sh
# PreToolUse hook for invoke_subagent, installed by the Antigravity+ Paseo plugin.
# The plugin starts agy with ANTIGRAVITY_PLUS=1 and ANTIGRAVITY_PLUS_FLAGS=<dir>, and creates
# <dir>/<conversationId> while the agent's "agy subagents" switch is on.
# agy treats a reply without a decision as a block, so pass-through answers "allow". agy never
# asks permission for invoke_subagent (checked in its strictest Default mode), so "allow" keeps
# its behavior unchanged outside Antigravity+ and while the switch is on.
input=$(cat)
if [ "$ANTIGRAVITY_PLUS" != "1" ]; then
  printf '%s' '{"decision":"allow"}'
  exit 0
fi
conversation=$(printf '%s' "$input" | grep -o '"conversationId":"[0-9A-Za-z-]*"' | head -n 1 | sed 's/.*:"\(.*\)"/\1/')
if [ -n "$conversation" ] && [ -n "$ANTIGRAVITY_PLUS_FLAGS" ] && [ -e "$ANTIGRAVITY_PLUS_FLAGS/$conversation" ]; then
  printf '%s' '{"decision":"allow"}'
  exit 0
fi
printf '%s' '{"decision":"deny","reason":"invoke_subagent is turned off for this Paseo agent. Start the subagent with the Paseo create_agent tool instead (provider antigravity-plus with your current model, unless the user asked for another), so the user can see and control it in Paseo. The user can re-enable agy subagents for this agent with the \"agy subagents\" switch in the composer."}'
