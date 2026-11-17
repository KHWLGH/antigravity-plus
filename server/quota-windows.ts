import {
  toneFromUsedPct,
  windowFromReportedDuration,
  windowFromUsedPct,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";

/** `v1internal:retrieveUserQuotaSummary`: grouped limits with named windows. */
export const quotaSummarySchema = z.object({
  groups: z
    .array(
      z.object({
        displayName: z.string().default(""),
        description: z.string().optional(),
        buckets: z
          .array(
            z.object({
              bucketId: z.string(),
              displayName: z.string().optional(),
              window: z.string().optional(),
              resetTime: z.string().optional(),
              remainingFraction: z.number().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

/** `v1internal:fetchAvailableModels`: per-model quota without a reported window length. */
export const availableModelsSchema = z.object({
  models: z
    .record(
      z.string(),
      z.object({
        displayName: z.string().optional(),
        modelProvider: z.string().optional(),
        quotaInfo: z
          .object({ remainingFraction: z.number().optional(), resetTime: z.string().optional() })
          .optional(),
      }),
    )
    .default({}),
});

export type QuotaSummary = z.infer<typeof quotaSummarySchema>;
export type AvailableModels = z.infer<typeof availableModelsSchema>;

function usedPct(remainingFraction: number | undefined): number | null {
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return null;
  // One decimal: the API's six-digit fractions print as float noise in the CLI and app.
  return Math.round(Math.min(100, Math.max(0, (1 - remainingFraction) * 100)) * 10) / 10;
}

/** "Claude and GPT models" -> "Claude and GPT"; a shorter scope keeps sidebar labels readable. */
function scopeLabel(displayName: string): string {
  const trimmed = displayName.replace(/\s+models?$/i, "").trim();
  return trimmed || displayName || "Antigravity";
}

/** "3p-weekly" and "3p-5h" share the stable scope "3p". */
function scopeId(bucketIds: string[], displayName: string): string {
  const prefixes = new Set(bucketIds.map((id) => id.replace(/-[^-]+$/, "")));
  if (prefixes.size === 1) return `group-${[...prefixes][0]}`;
  return `group-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown"}`;
}

/** Durations the API spells as "5h", "30m", "1d". Named periods return null. */
function parseDuration(window: string | undefined): number | null {
  const match = /^(\d+)\s*([smhd])$/i.exec(window ?? "");
  if (!match) return null;
  const size = { s: 1, m: 60, h: 3600, d: 86400 }[match[2].toLowerCase() as "s" | "m" | "h" | "d"];
  return Number(match[1]) * size;
}

export function summaryWindows(summary: QuotaSummary): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const group of summary.groups) {
    const id = scopeId(
      group.buckets.map((bucket) => bucket.bucketId),
      group.displayName,
    );
    const label = scopeLabel(group.displayName);
    for (const bucket of group.buckets) {
      const used = usedPct(bucket.remainingFraction);
      const common = {
        utilizationPct: used,
        resetsAt: bucket.resetTime ?? null,
        summary: true,
        tone: toneFromUsedPct(used),
      };
      const period = bucket.window?.toLowerCase();
      if (period === "weekly" || period === "daily" || period === "monthly") {
        const names = {
          weekly: ["Weekly", "wk"],
          daily: ["Daily", "day"],
          monthly: ["Monthly", "mo"],
        }[period];
        windows.push(
          windowFromUsedPct({
            id: `${id}:${period}`,
            label: `${label} · ${names[0]}`,
            shortLabel: `${label} ${names[1]}`,
            ...common,
          }),
        );
        continue;
      }
      windows.push(
        windowFromReportedDuration({
          durationSeconds: parseDuration(bucket.window),
          scope: { id, label },
          // The bucket's own name is the only provider vocabulary when no length is reported.
          unknown: {
            id: bucket.bucketId,
            label: bucket.displayName ?? "Limit",
            shortLabel: "",
          },
          ...common,
        }),
      );
    }
  }
  return windows;
}

/**
 * Google models are absent from the quota summary today. fetchAvailableModels reports a
 * remaining fraction and reset per model with no window length, and every Google model
 * shares one pool, so publish one neutral window per distinct pool.
 */
export function googlePoolWindows(models: AvailableModels, summary: QuotaSummary): UsageWindow[] {
  const summaryCoversGoogle = summary.groups.some((group) =>
    /gemini|google/i.test(`${group.displayName} ${group.description ?? ""}`),
  );
  if (summaryCoversGoogle) return [];
  const pools = new Map<string, { remaining: number; reset: string; modelIds: string[] }>();
  for (const [modelId, model] of Object.entries(models.models)) {
    const quota = model.quotaInfo;
    if (model.modelProvider !== "MODEL_PROVIDER_GOOGLE") continue;
    // Models without a reset are tab-completion helpers, not agent models.
    if (!quota?.resetTime || typeof quota.remainingFraction !== "number") continue;
    const key = `${quota.remainingFraction}|${quota.resetTime}`;
    const pool = pools.get(key) ?? {
      remaining: quota.remainingFraction,
      reset: quota.resetTime,
      modelIds: [],
    };
    pool.modelIds.push(modelId);
    pools.set(key, pool);
  }
  const sorted = [...pools.values()].sort((left, right) => right.modelIds.length - left.modelIds.length);
  return sorted.map((pool, index) => {
    const used = usedPct(pool.remaining);
    const suffix = index === 0 ? "" : ` (${[...pool.modelIds].sort()[0]})`;
    return windowFromReportedDuration({
      durationSeconds: null,
      unknown: {
        id: index === 0 ? "google-models" : `google-models-${[...pool.modelIds].sort()[0]}`,
        label: `Google models${suffix}`,
        shortLabel: "Google",
      },
      utilizationPct: used,
      resetsAt: pool.reset,
      summary: index === 0,
      tone: toneFromUsedPct(used),
    });
  });
}
