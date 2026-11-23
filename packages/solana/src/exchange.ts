// The Solana venue behind the runner's exchange interface (spot only). Pairs are "SYMBOL/USDC"; an "order" is one
// Jupiter swap from the agent's own wallet with the order's worst price enforced (swap.ts). The account of an agent
// is its wallet, carried in hex form inside the code (address.ts).
//
// Market data: prices from Jupiter (Price API v3), candles from GeckoTerminal with our own samples as a fallback, and
// a synthetic order book from price and pool liquidity (a constant-product estimate) for the liquidity guard; the
// swap itself re-checks the real route against the limit price before signing.
import type {
  AgentKeyRef,
  Candle,
  CandleInterval,
  ExchangeClient,
  ExchangeSpotMarket,
  OrderBook,
  OrderRequest,
  OrderResult,
  SpotBalance,
} from "@parallax/exchange";
import { Connection } from "@solana/web3.js";
import { type Hex, pubkeyOf, toBase58 } from "./address.js";
import { GeckoCandles, SampledCandles } from "./candles.js";
import { LAMPORTS_PER_SOL, type SolanaConfig, USDC_MINT, WSOL_MINT } from "./config.js";
import { JitoClient } from "./jito.js";
import { JupiterClient, type JupToken } from "./jupiter.js";
import { DEFAULT_UNIVERSE, loadUniverse, marketIdOf, type SolanaMarket, type UniverseLimits } from "./markets.js";
import { executeSwap, type SwapDeps, type SwapResult } from "./swap.js";
import { keypairFromSecret, walletBalances } from "./wallets.js";

export const QUOTE = "USDC";
const USDC_DECIMALS = 6;
const pairOf = (symbol: string) => `${symbol}/${QUOTE}`;

/** Decimal places that show ~6 significant digits of a price. */
export function priceDecimalsFor(px: number): number {
  if (!(px > 0)) return 6;
  return Math.max(0, Math.min(12, 5 - Math.floor(Math.log10(px))));
}

/**
 * Synthetic book: a constant-product pool holding `liquidityUsd` (half on each side) around `mid`, sampled at a few
 * sizes. Fine for the guard's spread/impact estimate; the real route is checked again when the swap is built.
 */
export function syntheticBook(mid: number, liquidityUsd: number, feeBps = 10): OrderBook {
  if (!(mid > 0)) return { bids: [], asks: [] };
  const side = Math.max(1000, liquidityUsd / 2);
  const steps = [0.0005, 0.002, 0.005, 0.01, 0.02, 0.05];
  const bids = [];
  const asks = [];
  let prevBid = 0;
  let prevAsk = 0;
  for (const f of steps) {
    // trading f of a side's depth in a constant-product pool moves the price by ≈ (1+f)^2 - 1
    const usd = side * f;
    const askPx = mid * (1 + feeBps / 10_000) * (1 + f) ** 2;
    const bidPx = (mid * (1 - feeBps / 10_000)) / (1 + f) ** 2;
    asks.push({ px: askPx, sz: (usd - prevAsk) / askPx });
    bids.push({ px: bidPx, sz: (usd - prevBid) / bidPx });
    prevAsk = usd;
    prevBid = usd;
  }
  return { bids, asks, time: Date.now() };
}

export interface SolanaExchangeOptions {
  config: SolanaConfig;
  universe?: UniverseLimits;
  /** Injected for tests. */
  connection?: Connection;
  jupiter?: JupiterClient;
  jito?: JitoClient;
  gecko?: GeckoCandles;
  swap?: (d: SwapDeps, signer: ReturnType<typeof keypairFromSecret>, req: Parameters<typeof executeSwap>[2]) => Promise<SwapResult>;
  coingeckoKey?: string;
}

export class SolanaExchange implements ExchangeClient {
  readonly quote = QUOTE;
  readonly kind = "solana" as const;
  readonly connection: Connection;
  readonly jupiter: JupiterClient;
  readonly jito: JitoClient;
  private readonly gecko: GeckoCandles;
  private readonly samples = new SampledCandles();
  private markets = new Map<string, SolanaMarket>(); // by symbol
  private byMint = new Map<string, SolanaMarket>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private lastMids: Record<string, number> = {};

  constructor(private readonly o: SolanaExchangeOptions) {
    const c = o.config;
    this.connection = o.connection ?? new Connection(c.rpcUrl, "confirmed");
    this.jupiter = o.jupiter ?? new JupiterClient(c.jupiterUrl, c.jupiterKey, { minGapMs: c.jupiterGapMs });
    this.jito = o.jito ?? new JitoClient(c.jitoUrl, c.jitoAuth);
    this.gecko = o.gecko ?? new GeckoCandles(c.geckoUrl, { coingeckoKey: o.coingeckoKey });
  }

  // ---------- markets ----------

  private addMarket(m: SolanaMarket) {
    this.markets.set(m.symbol, m);
    this.byMint.set(m.mint, m);
  }

  /** Reloads the universe at most every 10 minutes. Markets once seen are never dropped (held tokens stay sellable). */
  async ensureMarkets(force = false): Promise<void> {
    if (!force && this.markets.size && Date.now() - this.loadedAt < 10 * 60_000) return;
    if (!this.loading)
      this.loading = (async () => {
        try {
          const list = await loadUniverse(this.jupiter, this.o.universe ?? DEFAULT_UNIVERSE);
          const live = new Set(list.map((m) => m.mint));
          for (const m of list) this.addMarket(m);
          // markets that left the trending list: keep them, but with no volume they are not offered for buying
          for (const m of this.markets.values()) if (!live.has(m.mint)) m.dayVolumeUsd = 0;
          this.loadedAt = Date.now();
        } finally {
          this.loading = null;
        }
      })();
    await this.loading;
  }

  marketList(): SolanaMarket[] {
    return [...this.markets.values()];
  }

  marketOfPair(coin: string): SolanaMarket | undefined {
    return this.markets.get(coin.split("/")[0] ?? coin);
  }

  async spotMarkets(): Promise<ExchangeSpotMarket[]> {
    await this.ensureMarkets();
    return this.marketList().map((m) => ({
      marketId: m.marketId,
      pair: pairOf(m.symbol),
      base: m.symbol,
      quote: QUOTE,
      szDecimals: Math.min(m.decimals, 9),
      priceDecimals: priceDecimalsFor(this.lastMids[m.symbol] ?? m.usdPrice),
      minBaseAmount: 0,
      minQuoteAmount: 1,
      status: "active",
      isFrozen: false,
      startTimestamp: 0,
      endTimestamp: 0,
      lastPrice: this.lastMids[m.symbol] ?? m.usdPrice,
      dayQuoteVolume: m.dayVolumeUsd,
      dayPriceChangePct: m.dayChangePct,
    }));
  }

  async allMids(): Promise<Record<string, number>> {
    await this.ensureMarkets();
    const list = this.marketList();
    const prices = await this.jupiter.prices(list.map((m) => m.mint));
    const out: Record<string, number> = {};
    for (const m of list) {
      const px = prices[m.mint]?.usdPrice;
      if (px && px > 0) {
        out[pairOf(m.symbol)] = px;
        this.lastMids[m.symbol] = px;
        this.samples.record(m.symbol, px);
      }
    }
    return out;
  }

  async candles(coin: string, interval: CandleInterval, startTimeMs: number): Promise<Candle[]> {
    const m = this.marketOfPair(coin);
    if (!m) return [];
    const own = this.samples.candles(m.symbol, interval, startTimeMs);
    try {
      const c = await this.gecko.candles(m.mint, interval, startTimeMs);
      // the longer history wins (a sparse answer must not hide our own samples)
      if (c.length >= own.length) return c;
    } catch {}
    return own;
  }

  async l2Book(coin: string): Promise<OrderBook> {
    const m = this.marketOfPair(coin);
    if (!m) return { bids: [], asks: [] };
    const mid = this.lastMids[m.symbol] ?? m.usdPrice;
    return syntheticBook(mid, m.liquidityUsd);
  }

  // ---------- account = agent wallet ----------

  /**
   * Balances of an agent wallet by symbol. USDC is the quote; SOL counts above the gas reserve only (fees, tips and
   * token accounts are paid from it). A token outside the universe is looked up and added, so it stays sellable.
   */
  async spotBalances(wallet: Hex): Promise<SpotBalance[]> {
    await this.ensureMarkets();
    const bal = await walletBalances(this.connection, toBase58(wallet));
    const out: SpotBalance[] = [];
    let usdc = 0;
    let wsol = 0n;
    const unknown: { mint: string; amount: bigint; decimals: number }[] = [];
    for (const t of bal.tokens) {
      if (t.mint === USDC_MINT) usdc += Number(t.amount) / 10 ** USDC_DECIMALS;
      else if (t.mint === WSOL_MINT) wsol += t.amount;
      else if (this.byMint.has(t.mint)) {
        const m = this.byMint.get(t.mint)!;
        if (t.amount > 0n) out.push({ coin: m.symbol, total: Number(t.amount) / 10 ** t.decimals, hold: 0, entryNtl: 0 });
      } else if (t.amount > 0n) unknown.push(t);
    }
    if (unknown.length) {
      const info: JupToken[] = await this.jupiter.tokens(unknown.map((u) => u.mint)).catch(() => []);
      for (const u of unknown) {
        const t = info.find((x) => x.id === u.mint);
        const sym = t?.symbol?.replace(/[^A-Za-z0-9]/g, "");
        if (!t || !sym || this.markets.has(sym)) continue; // never shadow a known symbol
        this.addMarket({
          symbol: sym,
          mint: t.id,
          decimals: t.decimals,
          name: t.name,
          kind: "trending",
          liquidityUsd: Number(t.liquidity) || 0,
          dayVolumeUsd: 0,
          usdPrice: Number(t.usdPrice) || 0,
          dayChangePct: 0,
          marketId: marketIdOf(t.id),
        });
        out.push({ coin: sym, total: Number(u.amount) / 10 ** u.decimals, hold: 0, entryNtl: 0 });
      }
    }
    const reserve = this.o.config.gasReserveSol * LAMPORTS_PER_SOL;
    const sol = Math.max(0, bal.lamports - reserve) + Number(wsol);
    if (sol > 0) out.push({ coin: "SOL", total: sol / LAMPORTS_PER_SOL, hold: 0, entryNtl: 0 });
    out.push({ coin: QUOTE, total: usdc, hold: 0, entryNtl: 0 });
    return out;
  }

  /** Free SOL for fees in an agent wallet, lamports. */
  async gasLamports(wallet: Hex): Promise<number> {
    return this.connection.getBalance(pubkeyOf(wallet), "confirmed");
  }

  // ---------- orders ----------

  /**
   * One IOC "order" = one exact-input swap. Buy: spends size × limit price of USDC, needs at least that USDC ÷ limit
   * tokens back. Sell: sells `size` tokens, needs at least size × limit USDC back. The key is the agent wallet secret.
   */
  async placeOrder(key: AgentKeyRef, order: OrderRequest): Promise<OrderResult> {
    await this.ensureMarkets();
    const m = this.marketOfPair(order.coin);
    if (!m) return { status: "error", error: `unknown market ${order.coin}` };
    const limit = Number(order.price);
    const size = Number(order.size);
    if (!(limit > 0) || !(size > 0)) return { status: "error", error: "bad price or size" };
    const signer = keypairFromSecret(key.privateKey);
    const dec = m.decimals;
    const unit = 10 ** dec;
    let req: Parameters<typeof executeSwap>[2];
    if (order.isBuy) {
      const amountIn = BigInt(Math.floor(size * limit * 10 ** USDC_DECIMALS));
      const minOut = BigInt(Math.floor((Number(amountIn) / 10 ** USDC_DECIMALS / limit) * unit * 0.999999));
      req = { inputMint: USDC_MINT, outputMint: m.mint, amountIn, minOut, slippageBps: this.o.config.slippageBps };
    } else {
      const amountIn = BigInt(Math.floor(size * unit));
      const minOut = BigInt(Math.floor(size * limit * 10 ** USDC_DECIMALS * 0.999999));
      req = { inputMint: m.mint, outputMint: USDC_MINT, amountIn, minOut, slippageBps: this.o.config.slippageBps };
    }
    if (req.amountIn <= 0n) return { status: "error", error: "order too small" };
    const oid = Math.floor(Math.random() * 2 ** 47);
    let r: SwapResult;
    try {
      const deps: SwapDeps = {
        connection: this.connection,
        jupiter: this.jupiter,
        jito: this.jito,
        tip: { min: this.o.config.tipLamports, max: this.o.config.maxTipLamports },
        confirmTimeoutMs: this.o.config.confirmTimeoutMs,
      };
      r = await (this.o.swap ?? executeSwap)(deps, signer, req);
    } catch (e) {
      return { status: "error", oid, error: (e as Error).message.slice(0, 300) };
    }
    if (r.status !== "filled") return { status: r.status, oid, txHash: r.signature, error: r.error };
    const inA = Number(r.inAmount ?? req.amountIn);
    const outA = Number(r.outAmount ?? req.minOut);
    const base = order.isBuy ? outA / unit : inA / unit;
    const quote = order.isBuy ? inA / 10 ** USDC_DECIMALS : outA / 10 ** USDC_DECIMALS;
    if (!(base > 0)) return { status: "error", oid, txHash: r.signature, error: "swap landed but no amount moved" };
    return { status: "filled", oid, txHash: r.signature, filledSz: base, avgPx: quote / base, ...(order.isBuy ? { netBaseReceived: base } : {}) };
  }
}
