import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The companion agy plugin (agy-plugin/, symlinked into ~/.gemini/config/plugins) blocks
 * invoke_subagent in processes started with ANTIGRAVITY_PLUS=1, unless a flag file named after
 * the agy conversation exists here. Flags are recreated from the agent's options on every open.
 */
export const FLAGS_DIR = path.join(tmpdir(), "antigravity-plus", "allow-subagents");

export const AGY_ENV = {
  ANTIGRAVITY_PLUS: "1",
  ANTIGRAVITY_PLUS_FLAGS: FLAGS_DIR,
} as const;

/** Appended to agy's system prompt for every Antigravity+ session. */
export const SUBAGENT_GUIDANCE = [
  "You are running inside Paseo through the Antigravity+ provider.",
  "When you want a subagent, start it with Paseo's create_agent tool (provider antigravity-plus with your current model, unless the user asks for another) so the user can watch and control it in Paseo.",
  "agy's own invoke_subagent tool is blocked here unless the user turns on the \"agy subagents\" switch for this agent.",
].join(" ");

const SAFE_ID = /^[0-9A-Za-z-]{1,128}$/;

export async function setSubagentsAllowed(conversationId: string, allowed: boolean): Promise<void> {
  if (!SAFE_ID.test(conversationId)) return;
  const flag = path.join(FLAGS_DIR, conversationId);
  if (allowed) {
    await mkdir(FLAGS_DIR, { recursive: true });
    await writeFile(flag, "");
  } else {
    await rm(flag, { force: true });
  }
}
