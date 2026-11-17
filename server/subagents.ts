/**
 * The companion agy plugin (agy-plugin/, symlinked into ~/.gemini/config/plugins) blocks
 * invoke_subagent in every agy process started with ANTIGRAVITY_PLUS=1, so subagents are
 * started as Paseo agents that the user can see and control.
 */
export const AGY_ENV = {
  ANTIGRAVITY_PLUS: "1",
} as const;

/** Appended to agy's system prompt for every Antigravity+ session. */
export const SUBAGENT_GUIDANCE = [
  "You are running inside Paseo through the Antigravity+ provider.",
  "When you want a subagent, start it with Paseo's create_agent tool (provider antigravity-plus with your current model, unless the user asks for another) so the user can watch and control it in Paseo.",
  "agy's own invoke_subagent tool is blocked here.",
].join(" ");
