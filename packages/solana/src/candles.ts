// Candles for Solana tokens. Source: GeckoTerminal (public, ~30 calls/min; a CoinGecko key raises the limit) —
// the OHLCV of the token's most liquid pool, priced in USD. When that fails, candles built from our own price
// samples (every allMids call) keep indicators going, with a shorter history.
import type { Candle, CandleInterval } from "@parallax/exchange";
import { fetchJson, type JsonClientOptions } from "./http.js";

const TF: Record<CandleInterval, { timeframe: "minute" | "hour" | "day"; aggregate: number; ms: number }> = {
  "5m": { timeframe: "minute", aggregate: 5, ms: 5 * 60_000 },
  "15m": { timeframe: "minute", aggregate: 15, ms: 15 * 60_000 },
  "1h": { timeframe: "hour", aggregate: 1, ms: 3_600_000 },
  "4h": { timeframe: "hour", aggregate: 4, ms: 4 * 3_600_000 },
  "1d": { timeframe: "day", aggregate: 1, ms: 86_400_000 },
};

export const intervalMs = (iv: CandleInterval) => TF[iv].ms;

export class GeckoCandles {
  private pools = new Map<string, { at: number; pool: string | null }>();

  private readonly base: string;

  /** With a CoinGecko key (free "demo" plan, ~30 calls/min) the same data comes from CoinGecko's on-chain API. */
  constructor(
    base: string,
    private readonly o: JsonClientOptions & { coingeckoKey?: string } = {},
  ) {
    this.base = o.coingeckoKey ? "https://api.coingecko.com/api/v3/onchain" : base;
  }

  private get headers(): Record<string, string> {
    return this.o.coingeckoKey ? { "x-cg-demo-api-key": this.o.coingeckoKey } : {};
  }

  /** The most liquid pool of a token (cached 6 h). */
  async poolOf(mint: string): Promise<string | null> {
    const hit = this.pools.get(mint);
    if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.pool;
    const r = await fetchJson<{ data?: { attributes?: { address?: string; reserve_in_usd?: string; volume_usd?: { h24?: string } } }[] }>(
      `${this.base}/networks/solana/tokens/${mint}/pools?page=1`,
      { ...this.o, headers: this.headers },
    );
    // the pool where the token actually trades (24 h volume), not the one with the biggest reserves: a deep but idle
    // pool has candles only for the rare hours with a trade (seen in practice: 2 hourly candles of SOL in 48 h)
    const pools = (r?.data ?? [])
      .map((p) => ({ address: p.attributes?.address, volume: Number(p.attributes?.volume_usd?.h24) || 0, reserve: Number(p.attributes?.reserve_in_usd) || 0 }))
      .filter((p): p is { address: string; volume: number; reserve: number } => !!p.address && p.reserve >= 50_000)
      .sort((a, b) => b.volume - a.volume);
    const pool = pools[0]?.address ?? null;
    this.pools.set(mint, { at: Date.now(), pool });
    return pool;
  }

  /** Candles of `mint` since startMs, ascending, in USD. */
  async candles(mint: string, iv: CandleInterval, startMs: number): Promise<Candle[]> {
    const pool = await this.poolOf(mint);
    if (!pool) return [];
    const tf = TF[iv];
    const want = Math.min(1000, Math.max(10, Math.ceil((Date.now() - startMs) / tf.ms) + 2));
    const r = await fetchJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
      `${this.base}/networks/solana/pools/${pool}/ohlcv/${tf.timeframe}?aggregate=${tf.aggregate}&limit=${want}&currency=usd&token=${mint}&include_empty_intervals=true`,
      { ...this.o, headers: this.headers },
    );
    return (r?.data?.attributes?.ohlcv_list ?? [])
      .map(([t, o, h, l, c, v]) => ({ t: Number(t) * 1000, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) }))
      .filter((c) => c.t >= startMs - tf.ms && c.c > 0)
      .sort((a, b) => a.t - b.t);
  }
}

/** Candles from our own price samples: 5-minute buckets kept for 3 days per symbol, rolled up for longer intervals. */
export class SampledCandles {
  private buckets = new Map<string, Candle[]>();
  private static readonly BUCKET = 5 * 60_000;
  private static readonly KEEP = (3 * 86_400_000) / (5 * 60_000);

  record(symbol: string, px: number, nowMs = Date.now()): void {
    if (!(px > 0)) return;
    const t = Math.floor(nowMs / SampledCandles.BUCKET) * SampledCandles.BUCKET;
    const list = this.buckets.get(symbol) ?? [];
    const last = list[list.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, px);
      last.l = Math.min(last.l, px);
      last.c = px;
    } else {
      list.push({ t, o: px, h: px, l: px, c: px, v: 0 });
      if (list.length > SampledCandles.KEEP) list.splice(0, list.length - SampledCandles.KEEP);
    }
    this.buckets.set(symbol, list);
  }

  candles(symbol: string, iv: CandleInterval, startMs: number): Candle[] {
    const base = (this.buckets.get(symbol) ?? []).filter((c) => c.t >= startMs);
    const ms = intervalMs(iv);
    if (ms <= SampledCandles.BUCKET) return base.map((c) => ({ ...c }));
    const out: Candle[] = [];
    for (const c of base) {
      const t = Math.floor(c.t / ms) * ms;
      const last = out[out.length - 1];
      if (last && last.t === t) {
        last.h = Math.max(last.h, c.h);
        last.l = Math.min(last.l, c.l);
        last.c = c.c;
      } else out.push({ ...c, t });
    }
    return out;
  }
}
