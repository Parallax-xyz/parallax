// Performance without deposits and withdrawals.
//
// On Solana an agent's capital is its whole wallet, so money the owner puts in (Add funds, gas top-ups, private
// funding, plain transfers from anywhere) or takes out (Withdraw all, transfers out) changes its equity without being
// a profit or a loss. The rule:
//
//  - An external flow is a change of the agent's wallet that its own trades do not explain. Every runner tick compares
//    the wallet (quote + every token, priced at the tick's mids) with the previous tick, after removing what the
//    agent's own trades since then moved: flow = Σ (qty now − qty before − own trades' qty) × price now. Fees paid in
//    SOL around own swaps (fee, Jito tip, token account rent) stay costs. It catches transfers made from anywhere.
//  - Returns are time-weighted (TWR): every tick chains r = (equity now − flow) / equity before, so the flow is taken
//    out of the end of the sub-period ("flow at the end" variant). Equity now − flow = the previous holdings (plus own
//    trades) valued at today's prices: a deposit or a withdrawal never moves the index, whatever its size. The index
//    is stored with every hourly snapshot (EpochRow.perfIndex); any window's return is index_end / index_start − 1.
//  - Owner's dollar result = equity − equity at the start − net flows (deposits − withdrawals).
//  - Private mode sweeps stay counted in the performance equity (Runner.equityOffset): the swept part leaves the wallet
//    but the offset grows by the same amount, so a sweep is neither a flow nor a loss.
//  - The daily loss limit uses the index too: a deposit cannot hide a loss and a withdrawal cannot look like one.
import type { TradeRow } from "./types.js";

/** What the previous tick saw (AgentState.perf). */
export interface PerfState {
  /** Time-weighted performance index, 1 = the start. */
  index: number;
  /** Performance equity (wallet + equityOffset) at that tick, USD. */
  equity: number;
  usdc: number;
  tokens: Record<string, number>;
  /** equityOffset (Private mode: USD swept out as profit) at that tick. */
  offset: number;
  /** Highest trade id of the agent when that tick read the wallet: later trades are "own trades since". */
  tradeId: number;
  at: number;
  /** Flows not written to the flows table yet (small, or seen next to own trades), USD. */
  pendingUsd?: number;
}

export interface WalletView {
  usdc: number;
  tokens: Record<string, number>;
}

/** SOL a single own swap may burn on fees, the Jito tip and a new token account's rent (≈ 0.0021 SOL), with headroom. */
export const FEE_ALLOWANCE_PER_TRADE = 0.005;
/** A flow below this (USD) is still taken out of the return but is not written as a row of its own. */
export const FLOW_ROW_MIN_USD = 0.01;

/**
 * Wallet value in USD: quote + every token at its price now, dust included (a position shrinking under the dust line
 * must not look like a withdrawal). A token without a price counts 0 until its price is back: a gap and its return
 * cancel out in the index.
 */
export function walletEquity(w: WalletView, mids: Record<string, number>): number {
  let eq = Math.max(0, w.usdc);
  for (const [sym, q] of Object.entries(w.tokens)) {
    const px = mids[sym] ?? 0;
    if (q > 0 && px > 0) eq += q * px;
  }
  return eq;
}

export interface FlowResult {
  /** Net external flow, USD (+ in, − out). */
  usd: number;
  /** Unexplained quantity change by asset ("USDC" = the quote), for the record. */
  qty: Record<string, number>;
  /** Own trades in the interval. */
  ownTrades: number;
}

/**
 * The external flow between the previous tick and now: wallet changes that the agent's own trades (ids above
 * prev.tradeId) do not explain. `feeCoin` (SOL on Solana) pays the fees of own swaps: a drop of it up to
 * FEE_ALLOWANCE_PER_TRADE per own trade is a cost, not a withdrawal.
 */
export function externalFlow(
  prev: Pick<PerfState, "usdc" | "tokens" | "tradeId">,
  cur: WalletView,
  mids: Record<string, number>,
  trades: Pick<TradeRow, "id" | "side" | "market" | "sizeUsd" | "sizeBase">[],
  feeCoin?: string,
): FlowResult {
  const own = trades.filter((t) => t.id > prev.tradeId);
  let dUsdc = Math.max(0, cur.usdc) - Math.max(0, prev.usdc);
  const dTok: Record<string, number> = {};
  for (const sym of new Set([...Object.keys(prev.tokens), ...Object.keys(cur.tokens)]))
    dTok[sym] = Math.max(0, cur.tokens[sym] ?? 0) - Math.max(0, prev.tokens[sym] ?? 0);
  for (const t of own) {
    const q = Math.max(0, t.sizeBase);
    if (t.side === "buy") {
      dUsdc += t.sizeUsd;
      dTok[t.market] = (dTok[t.market] ?? 0) - q;
    } else {
      dUsdc -= t.sizeUsd;
      dTok[t.market] = (dTok[t.market] ?? 0) + q;
    }
  }
  if (feeCoin && own.length > 0 && (dTok[feeCoin] ?? 0) < 0) dTok[feeCoin] = Math.min(0, dTok[feeCoin]! + own.length * FEE_ALLOWANCE_PER_TRADE);
  const qty: Record<string, number> = {};
  let usd = dUsdc;
  if (Math.abs(dUsdc) > 1e-9) qty.USDC = dUsdc;
  for (const [sym, d] of Object.entries(dTok)) {
    if (Math.abs(d) <= 1e-12) continue;
    qty[sym] = d;
    const px = mids[sym] ?? 0;
    if (px > 0) usd += d * px; // priced exactly as walletEquity prices the wallet
  }
  return { usd, qty, ownTrades: own.length };
}

/**
 * One TWR step: index × (equity − flow) / previous equity. An empty previous wallet has no return to chain (the
 * index waits for money); a nonsensical ratio (no prices) leaves the index as it was.
 */
export function chainIndex(index: number, prevEquity: number, equity: number, flowUsd: number): number {
  if (!(prevEquity > 0)) return index;
  const r = (equity - flowUsd) / prevEquity;
  if (!Number.isFinite(r) || r < 0) return index;
  return index * r;
}

/** An hourly snapshot as the return readers need it. */
export interface PerfPoint {
  ts: number;
  equityUsd: number;
  /** null: a row written before the index existed and not backfilled (then the dollar equity is used). */
  perfIndex?: number | null;
}

/** Return in % from snapshot a to snapshot b: by the performance index, or by equity for rows without one. */
export function returnBetween(a: PerfPoint, b: PerfPoint): number | null {
  let r: number;
  if (a.perfIndex != null && b.perfIndex != null && a.perfIndex > 0) r = (b.perfIndex / a.perfIndex - 1) * 100;
  else if (a.equityUsd > 0) r = ((b.equityUsd - a.equityUsd) / a.equityUsd) * 100;
  else return null;
  return Math.round(r * 1e6) / 1e6; // a chained index carries float dust: 1e-6 % is far below anything shown
}

/**
 * Index of a snapshot written without one (rows from before the index existed): chained from the previous
 * snapshot on equity alone, as the returns were computed before. An empty side does not chain.
 */
export function epochIndexFromEquity(prev: { equityUsd: number; perfIndex: number | null } | undefined, equityUsd: number): number {
  const pi = prev?.perfIndex ?? 1;
  if (!prev || !(prev.equityUsd > 0) || !(equityUsd > 0)) return pi;
  return (pi * equityUsd) / prev.equityUsd;
}
