// Runner domain records. Persistence is behind RunnerStore (store.ts); these are plain data.
import type { AgentAction, AgentDecision, RiskBox, StrategySpec } from "@parallax/strategy";
import type { PerfState } from "./flows.js";

export type Hex = `0x${string}`;
export const lc = (a: string) => a.toLowerCase() as Hex;

/** Off-chain status set by the platform: "paused" by the runner itself (no gas, no allocation) or the owner. */
export type OffchainStatus = "ok" | "paused" | "stopped" | "killed";

/** Mutable per-agent loop state, persisted after every tick. */
export interface AgentState {
  lastDecisionAt?: number;
  lastDecisionMids?: Record<string, number>;
  /** Highest price since a position was opened (for trailing stops). */
  peaks?: Record<string, number>;
  /** Day baseline. `index`: the performance index then (flows.ts): the daily loss is measured on it, so deposits and withdrawals do not count. */
  dayStart?: { day: string; equity: number; index?: number };
  /** Capital accounting mode in which dayStart/initialEquity were recorded ("ledger" | "whole_account"). A change resets them. */
  capitalMode?: string;
  initialEquity?: number;
  lastEquity?: number;
  lastEquityAt?: number;
  lastEpochAt?: number;
  lastTradeAt?: number;
  lastLlmError?: string;
  /** SOL for fees in the agent wallet at the last pass, lamports, and when it was read (gas.ts). */
  gasLamports?: number;
  gasAt?: number;
  /** Performance accounting without deposits and withdrawals (flows.ts): what the last tick saw. */
  perf?: PerfState;
  /** Net external flows since initialEquity was set (deposits − withdrawals), USD. Result = equity − initialEquity − this. */
  netFlowUsd?: number;
}

/** Who made a trade: the AI, or a code rule (protective stops and preset exit rules). */
export type TradeSource = "llm" | "protect";

/**
 * An agent as the runner sees it: its registry fields (owner, wallet, preset, status) plus the off-chain spec and loop
 * state. `wallet` is the agent's own wallet: it holds the agent's money and signs its swaps.
 */
export interface AgentRecord {
  id: number;
  owner: Hex;
  presetId: number;
  chainStatus: number; // registry status: 0 Active, 1 Paused, 2 Stopped
  intervalSec: number;
  createdAt: number;
  specHash: Hex;
  modelId: Hex;
  wallet: Hex; // the agent wallet (hex form of its public key, see @parallax/solana address.ts)
  risk: RiskBox;
  spec: StrategySpec | null;
  activated: boolean;
  activatedAt: number | null;
  offchainStatus: OffchainStatus;
  pauseReason: string | null;
  protectOnly: boolean;
  state: AgentState;
}

export interface TradeRow {
  id: number;
  agentId: number;
  owner: Hex;
  side: "buy" | "sell";
  market: string;
  sizeUsd: number;
  sizeBase: number; // net of any fee charged in the received token (buys)
  price: number;
  reason: string;
  /** Order id the exchange adapter assigned. */
  orderId: number;
  timestamp: number;
  source: TradeSource; // protect = executed by code
  /** Exchange order id and transaction signature, when the venue reports them. */
  exchangeOrderId?: string | null;
  exchangeTxHash?: string | null;
}

export type NewTrade = Omit<TradeRow, "id">;

export interface EpochRow {
  id: number;
  agentId: number;
  equityUsd: number;
  pnlBps: number;
  ts: number;
  /** Time-weighted performance index at this snapshot (flows.ts); a window's return is index_end / index_start − 1. */
  perfIndex: number | null;
}

/**
 * A deposit into or a withdrawal from an agent's wallet that its own trades do not explain (flows.ts). Owner data
 * only: public views never show it.
 */
export interface FlowRow {
  agentId: number;
  /** Start of the runner interval in which it was seen (with agentId: the row's unique key, so a retry is ignored). */
  fromTs: number;
  ts: number;
  /** USD at that tick's prices: + in, − out. */
  amountUsd: number;
  kind: "deposit" | "withdraw" | "gas";
  /** Unexplained quantity change by asset ("USDC" = the quote). */
  qty: Record<string, number>;
}

/** One entry of the decision log: what the AI (or the code) proposed and what the risk engine rejected. */
export interface DecisionRow {
  id: number;
  agentId: number;
  ts: number;
  provider: string; // LLM provider, or "code" for protective exits
  model: string; // model id, or "protection"
  decision: AgentDecision;
  rejections: { index: number; action: AgentAction; code: string; message: string }[];
}

/** Capital of an agent (see capital/ledger.ts): an allocation when several agents share one wallet, else the whole wallet. */
export interface AgentCapital {
  agentId: number;
  allocationUsd: number | null; // null = the whole wallet
  adopted: Record<string, number>; // holdings adopted under manageExistingHoldings
  updatedAt: number;
}
