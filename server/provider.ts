import { createHash } from "node:crypto";
import { runAcpProvider, type AcpTransformer } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderLaunch,
  ProviderRegistration,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { latestModelIds, openAgyStream } from "./agy-stream.ts";
import { execAgy, installedWindowsAgy, resolveAgyLaunch } from "./agy-launch.ts";
import { refreshSessionList } from "./session-list.ts";
import { DEFAULT_MODE, withBypassMode, withModelThinking } from "./catalog.ts";
import { launchContext, wrapConnection } from "./session-wrapper.ts";
import { AGY_ENV, SUBAGENT_GUIDANCE } from "./subagents.ts";

export const PROVIDER_ID = "antigravity-plus";
const LABEL = "Antigravity+";
/** agy 1.5.8 added context window updates to ACP sessions; earlier ACP lacks them. */
const MIN_AGY = [1, 5, 8] as const;
/** Bump when the catalog this plugin builds changes shape, so Paseo drops its cached copy. */
const CATALOG_REVISION = 2;

/** Adds Bypass (the default for new agents) and each model's own thinking levels. */
const catalogTransformer: AcpTransformer = {
  discover(catalog) {
    return {
      ...catalog,
      modes: withBypassMode(catalog.modes),
      defaultMode: DEFAULT_MODE,
      models: withModelThinking(catalog.models, latestModelIds()),
    };
  },
};

function compareVersion(version: string): number | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== MIN_AGY[index]) return parts[index] - MIN_AGY[index];
  }
  return 0;
}

async function getStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  try {
    const { stdout } = await execAgy(["--version"], 10_000, launch);
    const version = stdout.trim();
    const comparison = compareVersion(version);
    if (comparison === null) {
      return { available: false, diagnostic: `Could not read the agy version from "${version}".` };
    }
    if (comparison < 0) {
      return {
        available: false,
        diagnostic: `agy ${version} is too old for Antigravity+. Run \`agy update\` to get ${MIN_AGY.join(".")} or later.`,
      };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      diagnostic: `agy did not start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface ProviderAccounts {
  ready(): Promise<void>;
  activeId(): string | null;
  canOpen(): boolean;
  guard(connection: ProviderConnection): ProviderConnection;
  rememberLaunch(launch: ProviderLaunch): void;
}

export function createAntigravityPlusProvider(accounts?: ProviderAccounts): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: LABEL,
    icon: "icon.svg",
    command: [installedWindowsAgy() ?? "agy", "acp"],
    description: "Antigravity CLI through its ACP server, with history, permissions and skills",
    async status(request) {
      const launch = resolveAgyLaunch(request.launch);
      if (!launch) {
        return {
          available: false,
          diagnostic: "agy not found on PATH. Install Antigravity, then run `agy` and sign in.",
        };
      }
      accounts?.rememberLaunch(launch);
      return getStatus(launch);
    },
    async getCatalogCacheKey(request) {
      const launch = resolveAgyLaunch(request.launch);
      if (!launch) return undefined;
      await accounts?.ready();
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(JSON.stringify([PROVIDER_ID, CATALOG_REVISION, accounts?.activeId(), launch.command, launch.args, env]))
        .digest("hex");
    },
    async connect(request) {
      const launch = resolveAgyLaunch(request.launch);
      if (!launch) throw new Error("The daemon must supply the agy launch command");
      await accounts?.ready();
      if (accounts && !accounts.canOpen()) throw new Error("Account change in progress");
      accounts?.rememberLaunch(launch);
      // Fill the Import session list in the background so the dialog opens without agy's start-up wait.
      void refreshSessionList(launch, AGY_ENV);
      const inner = await runAcpProvider({
        id: PROVIDER_ID,
        label: LABEL,
        icon: "icon.svg",
        connector: () => {
          if (accounts && !accounts.canOpen()) throw new Error("Account change in progress");
          const context = launchContext.getStore();
          const agy = openAgyStream(launch, context?.env ?? { ...AGY_ENV }, {
            canProbe: accounts?.canOpen,
            policy: context?.policy,
            cwd: context?.cwd,
            appendSystemPrompt: SUBAGENT_GUIDANCE,
          });
          context?.register?.(agy);
          return agy.stream;
        },
        transformers: [catalogTransformer],
        // agy sends commands and skills right after session/new|load; wait so the composer has them.
        acpOptions: { waitForInitialCommands: true },
      }).connect({ ...request, launch });
      const connection = wrapConnection(inner, request.capabilities, {
        modelIds: latestModelIds,
        env: AGY_ENV,
      });
      return accounts?.guard(connection) ?? connection;
    },
  };
}
