#!/bin/sh
# PreToolUse hook for invoke_subagent, installed by the Antigravity+ Paseo plugin.
# The plugin starts agy with ANTIGRAVITY_PLUS=1; there, agy's own subagents are blocked so that
# subagents are started as Paseo agents the user can see and control.
# agy treats a reply without a decision as a block, so other processes get "allow". agy never
# asks permission for invoke_subagent (checked in its strictest Default mode), so "allow" keeps
# its behavior unchanged outside Antigravity+.
cat > /dev/null
if [ "$ANTIGRAVITY_PLUS" = "1" ]; then
  printf '%s' '{"decision":"deny","reason":"invoke_subagent is turned off in Paseo. Start the subagent with the Paseo create_agent tool instead (provider antigravity-plus with your current model, unless the user asked for another), so the user can see and control it in Paseo."}'
else
  printf '%s' '{"decision":"allow"}'
fi
