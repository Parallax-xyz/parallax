// Feed an AI decision through the deterministic risk engine and the order-book liquidity guard.
// Run after `npm run build`:  node examples/risk-engine.mjs
import { checkLiquidity, evaluateDecision } from "@parallax/risk";
import { PRESETS } from "@parallax/strategy";

const trend = PRESETS.find((p) => p.key === "trend");

// What the model proposed (untrusted input).
const decision = {
  note: "SOL trend confirmed, SPYx overextended",
  actions: [
    { type: "buy", market: "SOL", sizeBps: 2000, reason: "fast EMA above slow EMA, RSI 58" },
    { type: "buy", market: "SPYx", sizeBps: 6000, reason: "chasing the breakout" }, // too large
    { type: "buy", market: "DOGE", sizeBps: 500, reason: "not one of the agent's markets" },
  ],
};

const result = evaluateDecision({
  spec: { markets: ["SOL", "SPYx"], risk: trend.defaults.balanced.risk },
  preset: trend,
  params: trend.defaults.balanced.params,
  indicators: { SOL: [181.2, 176.4, 58], SPYx: [612, 598, 74] }, // ema20, ema50, rsi14 per preset.indicators
  markets: [
    { symbol: "SOL", coin: "SOL/USDC", marketId: 1, szDecimals: 6, priceDecimals: 3 },
    { symbol: "SPYx", coin: "SPYx/USDC", marketId: 2, szDecimals: 6, priceDecimals: 2 },
  ],
  balances: { usdc: 1000, tokens: {} },
  mids: { SOL: 180, SPYx: 610 },
  tradesToday: 0,
  dailyPnlBps: 0,
  decision,
});

console.log("approved orders:");
for (const o of result.orders) console.log(`  ${o.side} ${o.sizeBase} ${o.market} at worst ${o.limitPx} (market ${o.marketId}, ~$${o.notionalUsd.toFixed(2)})`);
console.log("rejected:");
for (const r of result.rejections) console.log(`  #${r.index} ${r.action.type} ${r.action.market}: ${r.code} (${r.message})`);

// Every approved order is then checked against the book at execution time.
const book = {
  bids: Array.from({ length: 10 }, (_, i) => ({ px: 180 * (1 - 0.0005 * (i + 1)), sz: 50 })),
  asks: Array.from({ length: 10 }, (_, i) => ({ px: 180 * (1 + 0.0005 * (i + 1)), sz: 50 })),
};
const first = result.orders[0];
const liq = checkLiquidity(
  { side: first.side, sizeBase: Number(first.sizeBase), limitPx: Number(first.limitPx), szDecimals: first.szDecimals, priceDecimals: first.priceDecimals },
  book,
  2_000_000,
  {
    maxSpreadBps: 150,
    maxSlippageBps: 100,
    maxOrderPctOfDayVolume: 2,
    minMarketDayVolumeUsd: 5000,
    minOrderUsd: 1,
  },
);
console.log("liquidity guard:", liq.ok ? `ok, limit tightened to ${liq.limitPx}, spread ${liq.spreadBps.toFixed(1)} bps` : liq);
