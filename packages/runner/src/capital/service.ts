// Store-backed glue between the pure capital ledger (ledger.ts) and the runner.
import type { PresetInfo, StrategySpec } from "@parallax/strategy";
import type { RunnerStore } from "../store.js";
import { type AgentRecord, lc } from "../types.js";
import { type CapitalParticipant, type CapitalResult, capitalView } from "./ledger.js";

/** The agent manages "ownerless" wallet tokens: the preset flag; a boolean params.manageExistingHoldings overrides it. */
export function managesExistingHoldings(preset: Pick<PresetInfo, "manageExistingHoldings"> | undefined, spec: Pick<StrategySpec, "params"> | null): boolean {
  const p = spec?.params?.manageExistingHoldings;
  if (typeof p === "boolean") return p;
  return preset?.manageExistingHoldings === true;
}

export function isRunning(a: AgentRecord): boolean {
  return a.activated && a.chainStatus === 0 && a.offchainStatus === "ok";
}

export function isReserving(a: AgentRecord): boolean {
  return a.activated && a.chainStatus !== 2 && a.offchainStatus !== "killed";
}

export function participantOf(store: RunnerStore, a: AgentRecord): CapitalParticipant {
  const cap = store.getCapital(a.id);
  const preset = store.getPresetById(a.presetId);
  const buys = preset?.allowsBuy ?? true;
  return {
    agentId: a.id,
    // a never-buy agent holds no cash allocation, even if one was stored for it (it would block the next agent)
    allocationUsd: !buys && cap?.allocationUsd ? 0 : (cap?.allocationUsd ?? null),
    trades: store.allTradesAsc(a.id).map((t) => ({ side: t.side, market: t.market, sizeUsd: t.sizeUsd, sizeBase: t.sizeBase })),
    buys,
    running: isRunning(a),
    reserving: isReserving(a),
  };
}

/** Every activated agent on this wallet, except exceptId. With one wallet per agent this is empty. */
export function agentsOnWallet(store: RunnerStore, wallet: string, exceptId?: number): AgentRecord[] {
  return store.listAgents({ activatedOnly: true }).filter((a) => lc(a.wallet) === lc(wallet) && a.id !== exceptId);
}

/** The agent's capital given the real free wallet balances (total - hold). */
export function computeAgentCapital(store: RunnerStore, agent: AgentRecord, real: { usdc: number; tokens: Record<string, number> }): CapitalResult {
  const preset = store.getPresetById(agent.presetId);
  const self = { ...participantOf(store, agent), manageExistingHoldings: managesExistingHoldings(preset, agent.spec) };
  const others = agentsOnWallet(store, agent.wallet, agent.id).map((a) => participantOf(store, a));
  return capitalView({ self, others, real });
}
