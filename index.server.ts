import { homedir } from "node:os";
import { join } from "node:path";
import { execCommand, type PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { accountsRpc } from "./shared/accounts-rpc.ts";
import { AccountManager } from "./server/accounts.ts";
import { AccountRuntime } from "./server/account-runtime.ts";
import { captureAgyProcesses, resetObservedModels } from "./server/agy-stream.ts";
import { MacKeychainStore } from "./server/keychain.ts";
import { createAntigravityPlusProvider } from "./server/provider.ts";
import { AccountQuota, createAntigravityUsageSource } from "./server/quota.ts";
import { drainSessionListProbe, refreshSessionList } from "./server/session-list.ts";
import { AGY_ENV } from "./server/subagents.ts";
import { registerTitleSync } from "./server/title-sync.ts";

export default function contribute(server: PluginServerContext) {
  const runtime = new AccountRuntime();
  const keychain = new MacKeychainStore();
  const quota = new AccountQuota(keychain);
  let launch: ProviderLaunch | undefined;
  let quotaError = false;
  const accounts = new AccountManager({
    keychain,
    file: join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "antigravity-plus", "accounts.json"),
    busyAgents: () => runtime.busyAgents(),
    beforeSlotChange: async () => {
      await Promise.all([quota.drainRefreshes(), drainSessionListProbe(), captureAgyProcesses(true).wait()]);
    },
    beforeReplace: async remember => {
      remember(await runtime.rememberOpenAgents());
      const old = captureAgyProcesses();
      old.stop();
      await old.wait();
    },
    login: async () => {
      try {
        await execCommand(launch?.command ?? "agy", ["acp", "--login"], {
          env: { ...process.env, ...launch?.env }, timeout: 300_000, killSignal: "SIGKILL",
        });
      } catch {
        throw new Error("Antigravity login failed, was cancelled, or timed out.");
      }
    },
    reset: () => {
      quotaError = false;
      quota.reset();
      resetObservedModels();
    },
    reload: async ids => {
      const oldProcesses = captureAgyProcesses();
      await runtime.reload(ids);
      await oldProcesses.wait();
      if (launch) await refreshSessionList(launch, AGY_ENV);
    },
    verify: id => quota.verify(id),
  });
  const supported = process.platform === "darwin";
  let initialized = false;
  let starting: Promise<void> | undefined;
  function ready() {
    if (!supported || initialized) return Promise.resolve();
    starting ??= accounts.initialize().then(() => { initialized = true; }).finally(() => { starting = undefined; });
    return starting;
  }
  void ready().catch(() => { /* Retry on the next request, where Paseo can display the error. */ });

  server.registerProvider(createAntigravityPlusProvider(supported ? {
    async ready() {
      if (accounts.busy && accounts.allowOpen) return; // The recovery itself is reopening an agent.
      try {
        await ready();
      } catch (error) {
        // Standalone provider use (including API-key sessions) does not require the vault.
        // An outstanding account transition must finish before any provider process starts.
        if (accounts.busy) throw error;
      }
    },
    activeId: () => accounts.snapshot().activeAccountId,
    canOpen: () => accounts.allowOpen,
    rememberLaunch: value => { launch = value; },
    guard: connection => {
      connection.onEvent(event => {
        if (event.type === "session.turn" && event.state === "failed" &&
          /quota|resource[_ ]exhausted|rate limit|\b429\b/i.test(event.error?.message ?? "")) quotaError = true;
        if (event.type === "session.turn" && event.state === "completed") quotaError = false;
      });
      return runtime.guard(connection, accounts);
    },
  } : undefined));
  const source = createAntigravityUsageSource(accounts, quota);
  server.registerUsageSource({
    ...source,
    async discover(scope) { if (!supported) return []; await ready(); return source.discover(scope); },
  });
  let lastPoll = 0;
  let lastAccount: string | null = null;
  let reading: Promise<void> | undefined;
  const view = async () => {
    await ready();
    if (supported) await accounts.reconcile();
    const state = accounts.snapshot();
    const id = state.activeAccountId;
    if (id && !state.busy && !reading && (id !== lastAccount || Date.now() - lastPoll >= 60_000)) {
      lastAccount = id;
      lastPoll = Date.now();
      reading = source.fetch({ accountId: id }).then(() => {}, () => {}).finally(() => { reading = undefined; });
    }
    return { ...state, quotaError };
  };
  server.handle(accountsRpc.list, (_, ctx) => { runtime.attach(ctx.paseo); return view(); });
  server.handle(accountsRpc.status, (_, ctx) => { runtime.attach(ctx.paseo); return view(); });
  const mutate = async (work: () => Promise<void>) => {
    if (!supported) throw new Error("Antigravity+ account management requires macOS");
    await ready();
    await work();
    return {ok: true as const};
  };
  server.handle(accountsRpc.switch, ({id}, ctx) => { runtime.attach(ctx.paseo); return mutate(() => accounts.switch(id)); });
  server.handle(accountsRpc.add, ({makeActive}, ctx) => { runtime.attach(ctx.paseo); return mutate(() => accounts.add(makeActive)); });
  server.handle(accountsRpc.remove, ({id}, ctx) => { runtime.attach(ctx.paseo); return mutate(() => accounts.remove(id)); });
  server.handle(accountsRpc.rename, ({id, nickname}, ctx) => {
    runtime.attach(ctx.paseo);
    return mutate(() => accounts.rename(id, nickname));
  });
  const detachOpen = server.addHook("agent.open.before", async (_, ctx) => { runtime.attach(ctx.paseo); });
  const stopTitleSync = registerTitleSync(server);
  return () => { detachOpen(); stopTitleSync(); };
}
