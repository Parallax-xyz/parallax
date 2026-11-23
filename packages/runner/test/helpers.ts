// Test fakes: a paper exchange, an agent registry and LLM providers. No network calls anywhere.
//
// Markets are synthetic pairs chosen so the rounding in the assertions is easy to follow:
// NVDA/USDC (size 2 decimals, price 3 decimals, $40) and SPY/USDC (size 5 decimals, price 0 decimals, $100000).
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
import { type ModelInfo, PRESETS, type StrategySpec } from "@parallax/strategy";
import { runnerConfig } from "../src/config.js";
import { EncryptedKeyVault } from "../src/keys.js";
import { LlmRouter } from "../src/llm/router.js";
import { type LlmCompletion, type LlmCompletionRequest, LlmError, type LlmProvider } from "../src/llm/types.js";
import { type AgentRegistry, Runner, type RunnerDeps } from "../src/runner.js";
import { MemoryStore } from "../src/store.js";
import { lc } from "../src/types.js";

export type Hex = `0x${string}`;
/** A fake master key and fake addresses: nothing here is a real key or wallet. */
export const MASTER_KEY = "ab".repeat(32);
export const OWNER = `0x${"e1".repeat(32)}` as Hex;
export const WALLET = `0x${"f1".repeat(32)}` as Hex;

/** Synthetic platform models: two standard models on the primary endpoint, one premium. */
export const MODELS: ModelInfo[] = [
  { id: "model-a", label: "Model A", provider: "primary", tier: "standard", inputPricePer1M: 0.25, outputPricePer1M: 2, enabled: true },
  { id: "model-b", label: "Model B", provider: "primary", tier: "standard", inputPricePer1M: 0.1, outputPricePer1M: 0.2, enabled: true },
  { id: "model-premium", label: "Premium", provider: "primary", tier: "premium", inputPricePer1M: 3, outputPricePer1M: 15, enabled: true },
];

const mkt = (
  p: Partial<ExchangeSpotMarket> & Pick<ExchangeSpotMarket, "marketId" | "pair" | "szDecimals" | "priceDecimals" | "lastPrice" | "dayQuoteVolume">,
): ExchangeSpotMarket => ({
  base: p.pair.split("/")[0] ?? p.pair,
  quote: p.pair.split("/")[1] ?? "",
  minBaseAmount: 0,
  minQuoteAmount: 1,
  status: "active",
  isFrozen: false,
  startTimestamp: 0,
  endTimestamp: 0,
  dayPriceChangePct: 0,
  ...p,
});

export const SPOT_MARKETS: ExchangeSpotMarket[] = [
  mkt({ marketId: 2107, pair: "NVDA/USDC", szDecimals: 2, priceDecimals: 3, lastPrice: 40, dayQuoteVolume: 1_000_000 }),
  mkt({ marketId: 2140, pair: "SPY/USDC", szDecimals: 5, priceDecimals: 0, lastPrice: 100000, dayQuoteVolume: 500_000 }),
  mkt({ marketId: 9, pair: "NVDA/USDT", szDecimals: 2, priceDecimals: 4, lastPrice: 41, dayQuoteVolume: 99_999_999 }), // another quote: ignored
];

/** A paper exchange: balances by wallet, a deep book around the mid, every order filled at its limit unless told otherwise. */
export class FakeExchange implements ExchangeClient {
  readonly quote = "USDC";
  markets: ExchangeSpotMarket[] = SPOT_MARKETS.map((m) => ({ ...m }));
  mids: Record<string, number> = { "NVDA/USDC": 40, "SPY/USDC": 100000 };
  balances = new Map<string, SpotBalance[]>();
  orders: { pk: string; key: AgentKeyRef; order: OrderRequest }[] = [];
  candleCloses: number[] = Array.from({ length: 200 }, (_, i) => 30 + i * 0.05);
  orderResult?: (o: OrderRequest) => OrderResult;
  /** Book override by coin; by default a deep book +/-5 bps around the mid. */
  books = new Map<string, OrderBook>();
  /** SOL for fees of every wallet, lamports; null = this exchange reports no gas. */
  gas: number | null = null;

  async spotMarkets() {
    return this.markets.map((m) => ({ ...m, lastPrice: this.mids[m.pair] ?? m.lastPrice }));
  }
  async allMids() {
    return { ...this.mids };
  }
  async candles(_coin: string, _i: CandleInterval, start: number): Promise<Candle[]> {
    return this.candleCloses.map((c, i) => ({ t: start + i * 60_000, o: c, h: c, l: c, c, v: 1 }));
  }
  async l2Book(coin: string): Promise<OrderBook> {
    const custom = this.books.get(coin);
    if (custom) return custom;
    const mid = this.mids[coin] ?? 0;
    if (!(mid > 0)) return { bids: [], asks: [] };
    const lv = (sign: number) => Array.from({ length: 20 }, (_, i) => ({ px: mid * (1 + sign * 0.0005 * (i + 1)), sz: 1e9 / mid }));
    return { bids: lv(-1), asks: lv(1) };
  }
  async spotBalances(wallet: Hex) {
    return this.balances.get(wallet.toLowerCase()) ?? [];
  }
  async gasLamports(): Promise<number> {
    if (this.gas === null) throw new Error("this paper exchange reports no gas");
    return this.gas;
  }
  async placeOrder(key: AgentKeyRef, order: OrderRequest): Promise<OrderResult> {
    this.orders.push({ pk: key.privateKey, key, order });
    if (this.orderResult) return this.orderResult(order);
    return {
      status: "filled",
      oid: 1000 + this.orders.length,
      orderIndex: String(5e17 + this.orders.length),
      txHash: `sig${this.orders.length}`,
      filledSz: Number(order.size),
      avgPx: Number(order.price),
    };
  }
}

/** Registry reads: an agent's status and wallet. */
export class FakeRegistry implements AgentRegistry {
  agents = new Map<number, { status: number; wallet: Hex }>();
  async getAgent(id: number) {
    const a = this.agents.get(id);
    return a ? { ...a } : null;
  }
}

/** LLM provider with a queue of answers: a string is the response text, an Error is thrown. */
export class FakeProvider implements LlmProvider {
  calls: LlmCompletionRequest[] = [];
  constructor(
    readonly name: string,
    public queue: (string | Error)[] = [],
    public isAvailable = true,
    readonly defaultModel?: string,
  ) {}
  available() {
    return this.isAvailable;
  }
  async complete(req: LlmCompletionRequest): Promise<LlmCompletion> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new LlmError(`${this.name}: no answer queued`, this.name);
    if (next instanceof Error) throw next;
    return { provider: this.name, model: req.model, text: next, usage: { inputTokens: 1000, outputTokens: 200 } };
  }
}

export interface WorldOptions {
  primary?: FakeProvider;
  fallback?: FakeProvider;
  exchange?: FakeExchange;
  registry?: FakeRegistry;
  now?: () => number;
  deps?: Partial<RunnerDeps>;
}

/** A complete runner world on MemoryStore with fakes. Markets are synced from FakeExchange. */
export async function makeWorld(o: WorldOptions = {}) {
  const store = new MemoryStore({ models: MODELS, presets: PRESETS });
  const exchange = o.exchange ?? new FakeExchange();
  const registry = o.registry ?? new FakeRegistry();
  const primary = o.primary ?? new FakeProvider("primary", [], false);
  const fallback = o.fallback ?? new FakeProvider("fallback", [], false, "fallback-model");
  const llm = new LlmRouter({ providers: [primary, fallback], models: () => store.listModels(), usage: store, now: o.now });
  const keys = new EncryptedKeyVault(MASTER_KEY);
  const runner = new Runner({ store, exchange, registry, llm, keys, config: runnerConfig(), now: o.now, ...o.deps });
  await runner.refreshMarkets();
  return { store, exchange, registry, primary, fallback, llm, keys, runner };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

/** An obviously fake 64-byte wallet secret, derived from the wallet so agents sharing a wallet share its key. */
export const fakeSecret = (wallet: Hex) => `${wallet.slice(2)}${wallet.slice(2)}`;

/** Registers an activated agent: in the registry, in the store, and its wallet key in the vault. */
export function addAgent(
  w: World,
  o: {
    id: number;
    spec: StrategySpec;
    owner?: Hex;
    wallet?: Hex;
    chainStatus?: number;
    createdAt?: number;
    allocationUsd?: number | null;
    registered?: boolean;
  },
) {
  const preset = PRESETS.find((p) => p.key === o.spec.preset);
  if (!preset) throw new Error(`unknown preset ${o.spec.preset}`);
  const wallet = lc(o.wallet ?? WALLET);
  const privateKey = fakeSecret(wallet);
  const status = o.chainStatus ?? 0;
  if (o.registered !== false) w.registry.agents.set(o.id, { status, wallet });
  w.store.upsertAgent({
    id: o.id,
    owner: o.owner ?? OWNER,
    presetId: preset.id,
    chainStatus: status,
    intervalSec: o.spec.intervalSec,
    createdAt: o.createdAt ?? 1,
    specHash: "0x01",
    modelId: "0x02",
    wallet,
    risk: o.spec.risk,
  });
  w.store.activateAgent(o.id, o.spec);
  w.keys.put(wallet, privateKey);
  if (o.allocationUsd !== undefined) w.store.setCapital(o.id, o.allocationUsd);
  return { privateKey, wallet };
}

export const decisionJson = (actions: object[], note = "test") => JSON.stringify({ actions, note });
