// One agent, end to end, on paper: a paper exchange (two Solana pairs, a deep book, fills at the worst acceptable
// price), a scripted model, a fresh throwaway agent wallet whose key is kept encrypted in the vault. Nothing touches a
// network and nothing real is signed. Run after `npm run build`:  node examples/paper-agent.mjs
//
//   read (prices, candles, wallet) -> decide (model, shares and percent only) -> check (risk engine, liquidity guard)
//   -> route + land (here: the paper exchange; live: a Jupiter swap sent through Jito) -> record (trade, equity)
import { randomBytes } from "node:crypto";
import { EncryptedKeyVault, LlmRouter, MemoryStore, Runner, runnerConfig } from "@parallax/runner";
import { newAgentWallet } from "@parallax/solana";
import { modeSpecFields, PRESETS, presetDefaults } from "@parallax/strategy";

const trend = PRESETS.find((p) => p.key === "trend");
const OWNER = `0x${"0e".repeat(32)}`; // the agent's owner (only used for bookkeeping here)
const wallet = newAgentWallet(); // a fresh random wallet: the agent's own account

// ---------- paper exchange: SOL/USDC and JUP/USDC, an uptrend, a deep book ----------
const mids = { "SOL/USDC": 180, "JUP/USDC": 0.8 };
const balances = { USDC: 1000, SOL: 0 };
const exchange = {
  quote: "USDC",
  orders: [],
  async spotMarkets() {
    const row = (marketId, base, lastPrice, szDecimals, priceDecimals) => ({
      marketId,
      pair: `${base}/USDC`,
      base,
      quote: "USDC",
      szDecimals,
      priceDecimals,
      minBaseAmount: 0,
      minQuoteAmount: 1,
      lastPrice,
      dayQuoteVolume: 50_000_000,
      dayPriceChangePct: 1.8,
      status: "active",
      isFrozen: false,
      startTimestamp: 0,
      endTimestamp: 0,
    });
    return [row(1, "SOL", mids["SOL/USDC"], 6, 3), row(2, "JUP", mids["JUP/USDC"], 6, 5)];
  },
  async allMids() {
    return { ...mids };
  },
  async candles(pair, _tf, start) {
    const base = pair === "SOL/USDC" ? 160 : 0.7;
    return Array.from({ length: 200 }, (_, i) => {
      const c = base * (1 + i * 0.0006);
      return { t: start + i * 60_000, o: c, h: c, l: c, c, v: 1 };
    });
  },
  async l2Book(pair) {
    const mid = mids[pair];
    const lv = (s) => Array.from({ length: 20 }, (_, i) => ({ px: mid * (1 + s * 0.0005 * (i + 1)), sz: 1e6 / mid }));
    return { bids: lv(-1), asks: lv(1) };
  },
  async spotBalances() {
    return Object.entries(balances).map(([coin, total]) => ({ coin, total, hold: 0, entryNtl: 0 }));
  },
  async gasLamports() {
    return 30_000_000; // 0.03 SOL for fees
  },
  async placeOrder(key, order) {
    if (!key.privateKey) throw new Error("unsigned");
    this.orders.push(order);
    const [base] = order.coin.split("/");
    const size = Number(order.size);
    const px = Number(order.price);
    balances.USDC += order.isBuy ? -size * px : size * px;
    balances[base] = (balances[base] ?? 0) + (order.isBuy ? size : -size);
    return { status: "filled", oid: this.orders.length, txHash: `paper-${this.orders.length}`, filledSz: size, avgPx: px };
  },
};

// ---------- model stand-in: one sensible buy, one oversized buy the risk engine must refuse ----------
const model = {
  name: "primary",
  available: () => true,
  async complete(req) {
    console.log(`[prompt, user part]\n${req.user.slice(0, 500)} ...\n`);
    const text = JSON.stringify({
      note: "Uptrend confirmed on 1h.",
      actions: [
        { type: "buy", market: "SOL", sizeBps: 2000, limitPriceUsd: null, reason: "Fast EMA above slow EMA." },
        { type: "buy", market: "JUP", sizeBps: 9000, limitPriceUsd: null, reason: "All in." },
      ],
    });
    return { provider: this.name, model: req.model, text, usage: { inputTokens: 900, outputTokens: 120 } };
  },
};

// ---------- wiring ----------
const models = [{ id: "example-model", label: "Example", provider: "primary", tier: "standard", enabled: true }];
const store = new MemoryStore({ models, presets: PRESETS });
const llm = new LlmRouter({ providers: [model], models: () => store.listModels() });
const keys = new EncryptedKeyVault(randomBytes(32).toString("hex")); // in production MASTER_KEY comes from your secret store
let now = Math.floor(Date.now() / 1000);
const runner = new Runner({ store, exchange, llm, keys, config: runnerConfig(), now: () => now });
await runner.refreshMarkets();

const { risk, params } = presetDefaults(trend, "balanced", "crypto-spot");
const spec = {
  version: 1,
  preset: "trend",
  name: "SOL + JUP trend",
  goal: "Ride confirmed uptrends, go back to USDC on reversals.",
  markets: ["SOL", "JUP"],
  ...modeSpecFields("crypto-spot"),
  model: "example-model",
  intervalSec: 300,
  profile: "balanced",
  risk,
  params,
};
store.upsertAgent({
  id: 1,
  owner: OWNER,
  presetId: trend.id,
  chainStatus: 0,
  intervalSec: spec.intervalSec,
  createdAt: now - 1000,
  specHash: "0x01",
  modelId: "0x02",
  wallet: wallet.addressHex,
  risk: spec.risk,
});
store.activateAgent(1, spec);
keys.put(wallet.addressHex, wallet.secretHex); // stored encrypted, bound to the wallet address

// ---------- tick 1: the AI decides, the risk engine filters, the paper exchange fills ----------
const out = await runner.tickAgent(store.getAgent(1));
console.log("[tick 1]", out.kind);
for (const o of out.orders ?? []) console.log(`  approved: ${o.side} ${o.sizeBase} ${o.market} at worst ${o.limitPx}`);
for (const r of out.rejections ?? []) console.log(`  rejected: ${r.action.type} ${r.action.sizeBps} bps ${r.action.market}: ${r.code}`);

// ---------- tick 2: SOL drops 10%: the 7% stop-loss sells by code, without asking the AI ----------
now += 60;
mids["SOL/USDC"] = 162;
runner.cache.clear();
const out2 = await runner.tickAgent(store.getAgent(1));
console.log("[tick 2]", out2.kind, out2.orders?.map((o) => `${o.side} ${o.sizeBase} ${o.market}`).join(", ") ?? "");

console.log("[trades]");
for (const t of store.allTradesAsc(1)) console.log(`  ${t.source} ${t.side} ${t.sizeBase} ${t.market} @ ${t.price} (${t.reason})`);
const st = store.getAgent(1).state;
console.log("[equity]", { start: st.initialEquity, now: Number(st.lastEquity.toFixed(2)), performanceIndex: Number(st.perf.index.toFixed(4)) });
