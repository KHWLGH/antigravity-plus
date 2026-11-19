import { execCommand } from "@getpaseo/plugin/server";
import {
  hashAccountKey,
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import {
  availableModelsSchema,
  googlePoolWindows,
  quotaSummarySchema,
  summaryCoversGoogle,
  summaryWindows,
} from "./quota-windows.ts";

/** agy stores its Google login in the macOS Keychain under this service, via go-keyring. */
const KEYCHAIN_SERVICE = "gemini";
const API_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal";
/** Fallback CLI version when `agy --version` cannot be read; backend gates Gemini/Argon groups on `antigravity/cli/`. */
const FALLBACK_CLI_VERSION = "1.5.11";
/** Providers whose sessions run on agy's own login. */
const AGY_PROVIDERS = new Set(["antigravity-plus", "antigravity"]);
/** Treat a token this close to expiry as expired; a fetch takes a few seconds. */
const EXPIRY_MARGIN_MS = 60_000;
/** Paseo gives each login fetch 20 seconds, so the agy refresh must finish well inside it. */
const REFRESH_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 6_000;

const input = z.object({ store: z.literal("keychain"), service: z.literal(KEYCHAIN_SERVICE) }).strict();

const credentialSchema = z.object({
  token: z.object({ access_token: z.string().min(1), expiry: z.string().optional() }),
  id_token_email: z.string().optional(),
  auth_method: z.string().optional(),
});
type Credential = z.infer<typeof credentialSchema>;

class LoginMissing extends Error {}

async function readCredential(): Promise<Credential> {
  if (process.platform !== "darwin") throw new LoginMissing("Antigravity quota needs macOS");
  let raw: string;
  try {
    raw = (
      await execCommand("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
        timeout: 5_000,
      })
    ).stdout.trim();
  } catch {
    throw new LoginMissing("No agy login in the Keychain");
  }
  const prefix = "go-keyring-base64:";
  const json = raw.startsWith(prefix)
    ? Buffer.from(raw.slice(prefix.length), "base64").toString("utf8")
    : raw;
  return credentialSchema.parse(JSON.parse(json));
}

function expiresAt(credential: Credential): number | null {
  const parsed = credential.token.expiry ? Date.parse(credential.token.expiry) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isExpired(credential: Credential): boolean {
  const expiry = expiresAt(credential);
  return expiry !== null && expiry - EXPIRY_MARGIN_MS <= Date.now();
}

/**
 * Lets agy refresh its own login by running a cheap agy command. The plugin
 * never uses the refresh token or writes the Keychain; agy does both itself.
 */
let refreshing: Promise<void> | null = null;

function refreshThroughAgy(): Promise<void> {
  // Concurrent fetches share one agy run.
  refreshing ??= runAgyRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function agyCandidates(): string[] {
  const home = process.env.HOME ?? "";
  return ["agy", "/opt/homebrew/bin/agy", "/usr/local/bin/agy", `${home}/.local/bin/agy`];
}

let resolvedUserAgent: Promise<string> | null = null;

function agyUserAgent(): Promise<string> {
  resolvedUserAgent ??= readAgyVersion().then((version) => `antigravity/cli/${version}`);
  return resolvedUserAgent;
}

async function readAgyVersion(): Promise<string> {
  for (const command of agyCandidates()) {
    try {
      const { stdout } = await execCommand(command, ["--version"], {
        env: process.env,
        timeout: 5_000,
      });
      const match = /(\d+\.\d+\.\d+)/.exec(stdout);
      if (match) return match[1];
      return FALLBACK_CLI_VERSION;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return FALLBACK_CLI_VERSION;
    }
  }
  return FALLBACK_CLI_VERSION;
}

async function runAgyRefresh(): Promise<void> {
  for (const command of agyCandidates()) {
    try {
      await execCommand(command, ["models"], { env: process.env, timeout: REFRESH_TIMEOUT_MS });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return;
    }
  }
}

class HttpRejected extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Antigravity quota request was rejected (${status})`);
    this.status = status;
  }
}

async function post(method: string, token: string, body: unknown, userAgent: string): Promise<unknown> {
  const response = await fetch(`${API_BASE}:${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": userAgent,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) throw new HttpRejected(response.status);
  if (!response.ok) throw new Error(`Antigravity quota request ${method} failed (${response.status})`);
  return response.json();
}

async function fetchReport(): Promise<UsageReport> {
  let credential = await readCredential();
  if (isExpired(credential)) {
    await refreshThroughAgy();
    credential = await readCredential();
  }
  if (isExpired(credential)) {
    return unavailable({
      kind: "expired",
      expiresAt: new Date(expiresAt(credential) ?? Date.now()).toISOString(),
      refreshedBy: "agy",
    });
  }
  try {
    return await requestReport(credential.token.access_token);
  } catch (error) {
    if (!(error instanceof HttpRejected)) throw error;
  }
  // Rejected before the stored expiry (revoked token, clock skew): let agy refresh once.
  await refreshThroughAgy();
  const refreshed = await readCredential();
  if (refreshed.token.access_token === credential.token.access_token) {
    return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
  }
  try {
    return await requestReport(refreshed.token.access_token);
  } catch (error) {
    if (error instanceof HttpRejected) {
      return unavailable({ kind: "rejected", status: error.status, refreshedBy: "agy" });
    }
    throw error;
  }
}

async function requestReport(token: string): Promise<UsageReport> {
  const userAgent = await agyUserAgent();
  const [summaryRaw, tierRaw] = await Promise.all([
    post("retrieveUserQuotaSummary", token, {}, userAgent),
    post(
      "loadCodeAssist",
      token,
      { metadata: { ideType: "ANTIGRAVITY", pluginType: "GEMINI" } },
      userAgent,
    ).catch(() => null),
  ]);
  const summary = quotaSummarySchema.parse(summaryRaw);
  const tier = z
    .object({
      paidTier: z.object({ name: z.string() }).optional(),
      currentTier: z.object({ name: z.string() }).optional(),
    })
    .safeParse(tierRaw);
  const windows = [...summaryWindows(summary)];
  if (!summaryCoversGoogle(summary)) {
    const modelsRaw = await post("fetchAvailableModels", token, {}, userAgent).catch(() => null);
    if (modelsRaw !== null) {
      windows.push(...googlePoolWindows(availableModelsSchema.parse(modelsRaw), summary));
    }
  }
  if (windows.length === 0) {
    return unavailable({ kind: "no_quota", detail: "Antigravity reported no quota windows" });
  }
  return {
    status: "available",
    planLabel: tier.success ? (tier.data.paidTier?.name ?? tier.data.currentTier?.name) : undefined,
    windows,
  };
}

async function discoverAccounts(scope: UsageScope): Promise<UsageAccount[]> {
  if (scope.kind === "session") {
    if (!AGY_PROVIDERS.has(scope.provider)) return [];
    // An API-key session is not metered against the Google login's plan quota.
    if (scope.env.GEMINI_API_KEY) return [];
  }
  let credential: Credential;
  try {
    credential = await readCredential();
  } catch {
    return [];
  }
  const email = credential.id_token_email?.trim() || undefined;
  return [
    {
      key: hashAccountKey(`antigravity:${email ?? KEYCHAIN_SERVICE}`),
      label: email,
      harness: "Antigravity",
      input: { store: "keychain", service: KEYCHAIN_SERVICE },
    },
  ];
}

export function createAntigravityUsageSource(): UsageSourceRegistration {
  return {
    id: "antigravity-quota",
    label: "Antigravity",
    icon: "icon.svg",
    input,
    discover: discoverAccounts,
    async fetch(value) {
      input.parse(value);
      return fetchReport();
    },
  };
}
