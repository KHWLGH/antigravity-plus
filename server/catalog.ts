import type {
  ProviderMode,
  ProviderModel,
  ProviderOptionControl,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";

/** Plugin-owned mode: agy runs in its Default mode and this plugin approves every request. */
export const BYPASS_MODE_ID = "bypass";
/** New agents start in Bypass; any agent can switch to a mode that asks first. */
export const DEFAULT_MODE = BYPASS_MODE_ID;
/** The agy mode Bypass runs on: it asks for everything and does not sandbox commands. */
export const BYPASS_NATIVE_MODE = "default";

export const BYPASS_MODE: ProviderMode = {
  id: BYPASS_MODE_ID,
  label: "Bypass",
  description: "Approve every edit and command without asking, outside the terminal sandbox.",
  icon: "ShieldOff",
  colorTier: "dangerous",
  isUnattended: true,
};

export function withBypassMode(modes: readonly ProviderMode[]): ProviderMode[] {
  if (modes.some((mode) => mode.id === BYPASS_MODE_ID)) return [...modes];
  return [...modes, BYPASS_MODE];
}

/** Composer switch for agy's own invoke_subagent; off sends subagents through Paseo. */
export const SUBAGENT_OPTION = "agySubagents";
export const SUBAGENT_CONTROL: ProviderOptionControl = {
  type: "toggle",
  key: SUBAGENT_OPTION,
  label: "agy subagents",
  description:
    "Let agy start its own subagents, which Paseo cannot show or control. Needed for /teamwork and /boost. Off: agy is told to start Paseo agents instead.",
  icon: "Network",
  defaultValue: false,
};

const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LEVEL_LABELS: Record<(typeof LEVELS)[number], string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/**
 * agy's ACP config reports thinking levels only for the session's current model (Argon:
 * low/medium/high), but its model list names every variant, such as
 * `gemini-4-hydrogen-xhigh`. Give each model its own levels from that list; a model with no
 * level variants (GPT-OSS, Orchestrator) has none.
 */
export function withModelThinking<T extends ProviderModel>(
  models: readonly T[],
  variantIds: readonly string[],
): T[] {
  if (variantIds.length === 0) return [...models];
  const variants = new Set(variantIds);
  return models.map((model) => {
    const levels = LEVELS.filter((level) => variants.has(`${model.id}-${level}`));
    const thinkingOptions: ProviderThinkingOption[] = levels.map((id) => ({
      id,
      label: LEVEL_LABELS[id],
    }));
    const defaultThinkingOptionId = levels.length === 0 ? undefined : levels.includes("medium") ? "medium" : levels[0];
    return { ...model, thinkingOptions, ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}) };
  });
}
