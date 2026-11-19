import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { ProviderConnection, ProviderInput } from "@getpaseo/plugin/server/provider";

const transition = "An Antigravity+ account change is in progress. Please retry when it finishes.";

type AccountGate = {
  allowOpen: boolean;
  allowTurn: boolean;
};

function busy(agent: PaseoAgent) {
  return agent.activeTurn || agent.status === "running" || agent.status === "initializing" ||
    agent.pendingPermissions.length > 0 || (agent.backgroundWork?.count ?? 0) > 0;
}

export class AccountRuntime {
  private host?: PaseoApi;
  private readonly reopen = new Set<string>();
  private readonly connections = new Set<Set<string>>();

  attach(paseo: PaseoApi) {
    this.host = paseo;
  }

  private async agents() {
    if (!this.host) throw new Error("Open the Antigravity+ accounts page to connect to Paseo.");
    const agents: PaseoAgent[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.host.agents.list({page: {limit: 200, cursor}});
      agents.push(...page.entries.map(entry => entry.agent)
        .filter(agent => agent.provider === "antigravity-plus" && !agent.archivedAt && agent.status !== "closed"));
      if (!page.pageInfo.hasMore) break;
      cursor = page.pageInfo.nextCursor ?? undefined;
      if (!cursor || cursors.has(cursor)) throw new Error("Paseo returned an incomplete agent list");
      cursors.add(cursor);
    } while (cursor);
    return agents;
  }

  async busyAgents() {
    const agents = await this.agents();
    return [...new Set([...this.connections].flatMap(set => [...set]).concat(
      agents.filter(busy).map(agent => agent.title || agent.id)
    ))];
  }

  async rememberOpenAgents() {
    for (const agent of await this.agents()) {
      if (busy(agent)) throw new Error(`Agent is busy: ${agent.title || agent.id}`);
      this.reopen.add(agent.id);
    }
    return [...this.reopen];
  }

  async reload(remembered: readonly string[] = []) {
    for (const id of remembered) this.reopen.add(id);
    const ids = new Set([...(await this.agents()).map(agent => agent.id), ...this.reopen]);
    for (const id of ids) {
      const handle = this.host!.agents.ref(id);
      const latest = (await handle.refresh())?.agent;
      if (!latest || latest.archivedAt || (latest.status === "closed" && !this.reopen.has(id))) continue;
      if (busy(latest)) throw new Error(`Agent is busy: ${latest.title || latest.id}`);
      if (!await handle.reload()) throw new Error(`Unable to reopen ${latest.title || latest.id}`);
    }
    this.reopen.clear();
  }

  guard(inner: ProviderConnection, gate: AccountGate): ProviderConnection {
    const sessions = new Set<string>();
    const pending = new Map<string, string>();
    this.connections.add(sessions);
    const turns = new Set<string>();
    function update(id: string) {
      if (turns.has(id) || [...pending.values()].includes(id)) sessions.add(id);
      else sessions.delete(id);
    }
    inner.onEvent(event => {
      if (event.type === "session.prompt_result") {
        pending.delete(event.clientMessageId);
        if (event.result.type === "turn") turns.add(event.sessionId);
        update(event.sessionId);
      }
      if (event.type === "session.turn") {
        if (event.state === "started") turns.add(event.sessionId);
        else turns.delete(event.sessionId);
        update(event.sessionId);
      }
      if (event.type === "session.closed" || event.type === "session.runtime_failed") {
        for (const [key, id] of pending) if (id === event.sessionId) pending.delete(key);
        turns.delete(event.sessionId);
        update(event.sessionId);
      }
    });
    return {
      ...inner,
      async send(input: ProviderInput) {
        if (input.type === "session.prompt") {
          if (!gate.allowTurn) throw new Error(transition);
          pending.set(input.prompt.clientMessageId, input.sessionId);
          update(input.sessionId);
          try {
            await inner.send(input);
          } catch (error) {
            pending.delete(input.prompt.clientMessageId);
            update(input.sessionId);
            throw error;
          }
          return;
        }
        if (["session.open", "catalog", "sessions"].includes(input.type) && !gate.allowOpen) throw new Error(transition);
        return inner.send(input);
      },
      close: async () => {
        await inner.close();
        this.connections.delete(sessions);
      },
    };
  }
}
