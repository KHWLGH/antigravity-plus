import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAntigravityPlusProvider } from "./server/provider.ts";
import { createAntigravityUsageSource } from "./server/quota.ts";
import { registerTitleSync } from "./server/title-sync.ts";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createAntigravityPlusProvider());
  server.registerUsageSource(createAntigravityUsageSource());
  const stopTitleSync = registerTitleSync(server);
  return () => {
    stopTitleSync();
  };
}
