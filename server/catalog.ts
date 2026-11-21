import type {
  ProviderMode,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";

/** Plugin-owned mode: agy runs in its Default mode and this plugin approves every request. */
export const BYPASS_MODE_ID = "bypass";
/** The agy mode Bypass runs on: it asks for everything and does not sandbox commands. */
export const BYPASS_NATIVE_MODE = "default";
/** New agents start in agy's native Default mode (asks before edits and commands). */
export const DEFAULT_MODE = BYPASS_NATIVE_MODE;

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

/**
 * Agents created while Antigravity+ had an "agy subagents" switch (2026-11-17) still carry this
 * option in Paseo's saved config. The adapter rejects unknown settings, so it is dropped.
 */
export const LEGACY_SUBAGENT_OPTION = "agySubagents";

const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LEVEL_LABELS: Record<(typeof LEVELS)[number], string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/** A model's thinking levels, or null when agy has not reported its model list yet. */
export function thinkingLevels(
  modelId: string,
  variantIds: readonly string[],
): Array<(typeof LEVELS)[number]> | null {
  const suffixes = LEVELS.map((level) => `-${level}`);
  // agy names effort variants like gemini-4-hydrogen-xhigh. If it ever stops, every model would
  // lose its levels, so treat a list without any variant as unknown.
  if (!variantIds.some((id) => suffixes.some((suffix) => id.endsWith(suffix)))) return null;
  const variants = new Set(variantIds);
  return LEVELS.filter((level) => variants.has(`${modelId}-${level}`));
}

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
  if (thinkingLevels("", variantIds) === null) return [...models];
  return models.map((model) => {
    const levels = thinkingLevels(model.id, variantIds) ?? [];
    const thinkingOptions: ProviderThinkingOption[] = levels.map((id) => ({
      id,
      label: LEVEL_LABELS[id],
    }));
    const defaultThinkingOptionId = levels.length === 0 ? undefined : levels.includes("medium") ? "medium" : levels[0];
    return { ...model, thinkingOptions, ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}) };
  });
}
