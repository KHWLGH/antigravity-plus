import { createHash } from "node:crypto";
import { execCommand } from "@getpaseo/plugin/server";
import { runAcpProvider, type AcpTransformer } from "@getpaseo/plugin/server/acp";
import type {
  ProviderInput,
  ProviderLaunch,
  ProviderRegistration,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { openAgyStream } from "./agy-stream.ts";
import { launchContext, wrapConnection } from "./multiplex.ts";

export const PROVIDER_ID = "antigravity-plus";
const LABEL = "Antigravity+";
/** agy 1.5.8 added context window updates to ACP sessions; earlier ACP lacks them. */
const MIN_AGY = [1, 5, 8] as const;
/** Auto is the starting mode: edits and safe commands run, risky ones ask. */
export const DEFAULT_MODE = "auto";

type SessionOpen = Extract<ProviderInput, { type: "session.open" }>;

const defaultModeTransformer: AcpTransformer = {
  discover(catalog) {
    if (!catalog.modes.some((mode) => mode.id === DEFAULT_MODE)) return catalog;
    return { ...catalog, defaultMode: DEFAULT_MODE };
  },
};

/** A brand-new session without an explicit mode starts in Auto; resumed ones keep agy's mode. */
export function withDefaultMode(input: SessionOpen): SessionOpen {
  if (input.persistence || input.config.mode) return input;
  return { ...input, config: { ...input.config, mode: DEFAULT_MODE } };
}

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
    const { stdout } = await execCommand(launch.command, ["--version"], {
      env: launch.env,
      timeout: 10_000,
    });
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

export function createAntigravityPlusProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: LABEL,
    icon: "icon.svg",
    command: ["agy", "acp"],
    description: "Antigravity CLI through its ACP server, with history, permissions and skills",
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic: "agy not found on PATH. Install Antigravity, then run `agy` and sign in.",
        };
      }
      return getStatus(launch);
    },
    async getCatalogCacheKey({ launch }) {
      if (!launch) return undefined;
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(JSON.stringify([PROVIDER_ID, launch.command, launch.args, env]))
        .digest("hex");
    },
    async connect(request) {
      const launch = request.launch;
      if (!launch) throw new Error("The daemon must supply the agy launch command");
      const inner = await runAcpProvider({
        id: PROVIDER_ID,
        label: LABEL,
        icon: "icon.svg",
        connector: () => {
          const context = launchContext.getStore();
          const agy = openAgyStream(launch, context?.env ?? {});
          context?.register(agy);
          return agy.stream;
        },
        transformers: [defaultModeTransformer],
        // agy sends commands and skills right after session/new|load; wait so the composer has them.
        acpOptions: { waitForInitialCommands: true },
      }).connect(request);
      return wrapConnection(inner, request.capabilities, withDefaultMode);
    },
  };
}
