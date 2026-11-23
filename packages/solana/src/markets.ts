// The Solana markets agents may trade, all quoted in USDC:
//   - majors: fixed mints (SOL, JUP, BONK, WIF, JTO, PYTH, RAY);
//   - tokenized stocks: SOLANA_STOCK_SYMBOLS resolved to their verified mint (highest liquidity wins);
//   - trending coins: Jupiter's top traded / trending tokens of the last 24 h, kept only when Jupiter verifies them,
//     their organic score is high, mint and freeze authority are off and liquidity is deep: momentum coins without the
//     rugs. An unverified token or one whose creator can still mint or freeze is never offered.
import { SOLANA_STOCK_SYMBOLS } from "@parallax/strategy";
import { USDC_MINT, WSOL_MINT } from "./config.js";
import type { JupiterClient, JupToken } from "./jupiter.js";

export interface SolanaMarket {
  symbol: string;
  mint: string;
  decimals: number;
  name: string;
  kind: "major" | "stock" | "trending";
  liquidityUsd: number;
  dayVolumeUsd: number;
  usdPrice: number;
  dayChangePct: number;
  /** Stable numeric id (orders and the market table use numbers): first 31 bits of the mint. */
  marketId: number;
}

export const MAJORS: readonly { symbol: string; mint: string }[] = [
  { symbol: "SOL", mint: WSOL_MINT },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { symbol: "JTO", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" },
  { symbol: "PYTH", mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" },
  { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
];

export interface UniverseLimits {
  /** Trending coins kept (most liquid first). */
  maxTrending: number;
  minTrendingLiquidityUsd: number;
  minStockLiquidityUsd: number;
}

export const DEFAULT_UNIVERSE: UniverseLimits = { maxTrending: 20, minTrendingLiquidityUsd: 500_000, minStockLiquidityUsd: 100_000 };

export function marketIdOf(mint: string): number {
  let h = 2166136261;
  for (let i = 0; i < mint.length; i++) h = Math.imul(h ^ mint.charCodeAt(i), 16777619);
  return (h >>> 1) & 0x7fffffff;
}

const vol = (t: JupToken) => (Number(t.stats24h?.buyVolume) || 0) + (Number(t.stats24h?.sellVolume) || 0);

function row(t: JupToken, symbol: string, kind: SolanaMarket["kind"]): SolanaMarket {
  return {
    symbol,
    mint: t.id,
    decimals: t.decimals,
    name: t.name,
    kind,
    liquidityUsd: Number(t.liquidity) || 0,
    dayVolumeUsd: vol(t),
    usdPrice: Number(t.usdPrice) || 0,
    dayChangePct: Number(t.stats24h?.priceChange) || 0,
    marketId: marketIdOf(t.id),
  };
}

/** A safe trending coin: verified, high organic score, no mint/freeze authority, not flagged, deep enough. */
export function isSafeTrending(t: JupToken, minLiquidityUsd: number): boolean {
  if (!t.isVerified || t.organicScoreLabel !== "high") return false;
  if (t.audit?.isSus) return false;
  if (t.audit && (t.audit.mintAuthorityDisabled === false || t.audit.freezeAuthorityDisabled === false)) return false;
  if (!(Number(t.liquidity) >= minLiquidityUsd)) return false;
  if (t.id === USDC_MINT || t.tags?.includes("stablecoin")) return false;
  if (isTokenizedStock(t)) return false;
  return true;
}

/**
 * Tokenized stocks and other real-world assets from any issuer (xStocks, Ondo, Backpack, PreStocks…) are not crypto:
 * they never enter the trending crypto list (seen in practice: TTWO, SPCX and TSLAx among "top traded").
 */
export function isTokenizedStock(t: Pick<JupToken, "name" | "symbol" | "tags">): boolean {
  if ((t.tags ?? []).some((x) => /stock|equit|rwa|xstock|ondo|backed|pre-?ipo/i.test(x))) return true;
  if (/stock|tokeni[sz]ed|shares|equity|pre-?ipo|ondo|\(backed\)|global markets/i.test(t.name ?? "")) return true;
  return /^[A-Z]{1,5}x$/.test(t.symbol ?? "");
}

/** Ticker usable as a market symbol: letters and digits only, 2–12 characters. */
export function cleanSymbol(s: string): string | null {
  const c = s.replace(/[^A-Za-z0-9]/g, "");
  return c.length >= 2 && c.length <= 12 ? c : null;
}

/** Builds the universe from Jupiter. Missing pieces (a failed search) are skipped, majors are always present. */
export async function loadUniverse(jup: JupiterClient, limits: UniverseLimits = DEFAULT_UNIVERSE): Promise<SolanaMarket[]> {
  const out = new Map<string, SolanaMarket>();
  const taken = new Set<string>();
  const add = (m: SolanaMarket) => {
    const k = m.symbol.toUpperCase();
    if (taken.has(k) || [...out.values()].some((x) => x.mint === m.mint)) return;
    taken.add(k);
    out.set(m.mint, m);
  };
  // majors
  const majorInfo = await jup.tokens(MAJORS.map((m) => m.mint)).catch(() => [] as JupToken[]);
  for (const m of MAJORS) {
    const t = majorInfo.find((x) => x.id === m.mint);
    add(row(t ?? { id: m.mint, symbol: m.symbol, name: m.symbol, decimals: m.mint === WSOL_MINT ? 9 : 6 }, m.symbol, "major"));
  }
  // tokenized stocks
  for (const sym of SOLANA_STOCK_SYMBOLS) {
    try {
      const hits = (await jup.search(sym)).filter((t) => t.symbol === sym && t.isVerified && Number(t.liquidity) >= limits.minStockLiquidityUsd);
      hits.sort((a, b) => (Number(b.liquidity) || 0) - (Number(a.liquidity) || 0));
      if (hits[0]) add(row(hits[0], sym, "stock"));
    } catch {}
  }
  // trending
  const pool = new Map<string, JupToken>();
  for (const [cat, iv] of [
    ["toptraded", "24h"],
    ["toptrending", "24h"],
  ] as const) {
    try {
      for (const t of await jup.category(cat, iv, 100)) pool.set(t.id, t);
    } catch {}
  }
  const stocksUpper = new Set(SOLANA_STOCK_SYMBOLS.map((s) => s.toUpperCase()));
  const trending = [...pool.values()]
    .filter((t) => isSafeTrending(t, limits.minTrendingLiquidityUsd))
    .sort((a, b) => (Number(b.liquidity) || 0) - (Number(a.liquidity) || 0));
  let n = 0;
  for (const t of trending) {
    if (n >= limits.maxTrending) break;
    const sym = cleanSymbol(t.symbol);
    if (!sym || stocksUpper.has(sym.toUpperCase())) continue;
    const before = out.size;
    add(row(t, sym, "trending"));
    if (out.size > before) n++;
  }
  return [...out.values()];
}
