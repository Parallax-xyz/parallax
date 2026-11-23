// Markets = the spot pairs of a venue quoted in its quote asset (USDC on Solana).
// Market symbol = base asset (SOL, JUP, SPYx, ...); coin = the pair ("SOL/USDC"); marketId = the numeric id the
// adapter assigns.
//
// A market is OPEN when its status is "active", it is not frozen and the time is inside its optional start/end window.
// The runner skips buys on closed markets and tells the AI which markets are closed; held positions stay sellable.
import type { MarketInfo, MarketTier } from "@parallax/strategy";
import type { ExchangeSpotMarket } from "./types.js";

/** A market as the platform keeps it: the public MarketInfo plus the exchange fields the runner needs. */
export interface ResolvedMarket extends MarketInfo {
  coin: string; // pair symbol, the key for market data: "SOL/USDC"
  resolved: boolean; // listed by the exchange right now
  markPx?: number;
  prevDayPx?: number;
  isCanonical?: boolean;
  isFrozen?: boolean;
  minBaseAmount?: number;
  startTs?: number; // ms, 0 = none
  endTs?: number; // ms, 0 = none
}

/** A market from the exchange, ready to sync into the platform's market list (which owns `enabled`). */
export type SyncedMarket = Omit<ResolvedMarket, "enabled" | "lastSyncAt" | "tier">;

/** Spot pairs to `quote`, sorted by 24h volume (descending). One pair per base symbol. */
export function parseSpotMarkets(rows: ExchangeSpotMarket[], quote: string): SyncedMarket[] {
  const best = new Map<string, SyncedMarket>();
  for (const r of rows) {
    if (r.quote !== quote || !r.base) continue;
    const prevDay = r.lastPrice > 0 && Number.isFinite(r.dayPriceChangePct) && r.dayPriceChangePct > -100 ? r.lastPrice / (1 + r.dayPriceChangePct / 100) : 0;
    const m: SyncedMarket = {
      symbol: r.base,
      pair: r.pair,
      marketId: r.marketId,
      szDecimals: r.szDecimals,
      priceDecimals: r.priceDecimals,
      coin: r.pair,
      resolved: true,
      dayVolumeUsd: r.dayQuoteVolume,
      midUsd: r.lastPrice,
      markPx: r.lastPrice,
      prevDayPx: prevDay,
      isCanonical: true,
      status: r.status,
      isFrozen: r.isFrozen,
      minBaseAmount: r.minBaseAmount,
      startTs: r.startTimestamp,
      endTs: r.endTimestamp,
    };
    // one pair per base symbol: keep the active one, then the larger volume
    const prev = best.get(m.symbol);
    const score = (x: SyncedMarket) => (x.status === "active" ? 1e15 : 0) + (x.dayVolumeUsd ?? 0);
    if (!prev || score(m) > score(prev)) best.set(m.symbol, m);
  }
  return [...best.values()].sort((a, b) => (b.dayVolumeUsd ?? 0) - (a.dayVolumeUsd ?? 0) || a.symbol.localeCompare(b.symbol));
}

export interface MarketOpenState {
  open: boolean;
  reason?: string;
}

/** Is the market open for trading now (ms)? */
export function marketOpenState(m: Pick<ResolvedMarket, "status" | "isFrozen" | "startTs" | "endTs" | "resolved">, nowMs: number): MarketOpenState {
  if (m.resolved === false) return { open: false, reason: "delisted" };
  const status = m.status ?? "active";
  if (status !== "active") return { open: false, reason: `status:${status}` };
  if (m.isFrozen) return { open: false, reason: "frozen" };
  if (m.startTs && m.startTs > 0 && nowMs < m.startTs) return { open: false, reason: "not_started" };
  if (m.endTs && m.endTs > 0 && nowMs >= m.endTs) return { open: false, reason: "ended" };
  return { open: true };
}

export interface TierThresholds {
  minMarketDayVolumeUsd: number;
  liquidDayVolumeUsd: number;
}

export function marketTier(dayVolumeUsd: number | undefined, t: TierThresholds): MarketTier {
  const v = dayVolumeUsd ?? 0;
  if (v >= t.liquidDayVolumeUsd) return "liquid";
  if (v >= t.minMarketDayVolumeUsd) return "thin";
  return "illiquid";
}

/** For an API: a market with its tier and open state. */
export function withTier(m: ResolvedMarket, t: TierThresholds, nowMs = Date.now()): ResolvedMarket {
  const st = marketOpenState(m, nowMs);
  return { ...m, tier: marketTier(m.dayVolumeUsd, t), open: st.open, ...(st.reason ? { closedReason: st.reason } : {}) };
}
