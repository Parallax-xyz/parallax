// Strategy edits by the owner (MemoryStore.setAgentStrategy) as the runner sees them: the next pass trades the new spec;
// a market taken out of the strategy while the agent holds it stays sell-only (never stranded, still in equity); the
// first due decision after an edit asks the AI, and the interval counts from the last decision.
import { evaluateDecision } from "@parallax/risk";
import { PRESETS, type StrategySpec } from "@parallax/strategy";
import { describe, expect, it } from "vitest";
import { lc } from "../src/types.js";
import { agentUniverse } from "../src/universe.js";
import { addAgent, decisionJson, FakeProvider, makeWorld, WALLET } from "./helpers.js";

const trend = PRESETS.find((p) => p.key === "trend")!;
const spec: StrategySpec = {
  version: 1,
  preset: "trend",
  name: "Trend",
  goal: "ride the trend",
  markets: ["NVDA", "SPY"],
  venue: "solana",
  quote: "USDC",
  model: "model-a",
  intervalSec: 300,
  profile: "balanced",
  risk: trend.defaults.balanced.risk,
  params: trend.defaults.balanced.params,
};

async function setup() {
  let now = Math.floor(Date.now() / 1000);
  const primary = new FakeProvider("primary");
  const w = await makeWorld({ primary, now: () => now });
  addAgent(w, { id: 1, spec, createdAt: now - 1000 });
  w.exchange.balances.set(lc(WALLET), [{ coin: "USDC", total: 1000, hold: 0, entryNtl: 0 }]);
  return { ...w, agent: () => w.store.getAgent(1)!, tick: (n: number) => (now += n), at: () => now };
}

/** What a filled NVDA buy leaves on the account (the fake exchange does not move balances itself). */
function holdNvda(t: Awaited<ReturnType<typeof setup>>) {
  const filled = t.exchange.orders.at(-1)!.order;
  const q = Number(filled.size);
  t.exchange.balances.set(lc(WALLET), [
    { coin: "USDC", total: 1000 - q * Number(filled.price), hold: 0, entryNtl: 0 },
    { coin: "NVDA", total: q, hold: 0, entryNtl: q * Number(filled.price) },
  ]);
  return q;
}

const edit = (t: Awaited<ReturnType<typeof setup>>, patch: Partial<StrategySpec>) => {
  const s = { ...t.agent().spec!, ...patch };
  t.store.setAgentStrategy(1, { spec: s, specHash: "0x0b", modelId: "0x0c", presetId: trend.id, intervalSec: s.intervalSec }, (st) => {
    const { lastDecisionMids: _m, ...rest } = st;
    return rest;
  });
};

describe("strategy edits in the runner", () => {
  it("agentUniverse: a held market the agent bought, removed from its pairs, stays sell-only; one it never bought does not", () => {
    const m = (symbol: string) => ({ symbol, coin: `${symbol}/USDC`, resolved: true, enabled: true, szDecimals: 2 }) as never;
    const all = [m("NVDA"), m("SPY"), m("AAPL")];
    const u = agentUniverse(["SPY"], all, ["NVDA", "AAPL"], 5, undefined, undefined, undefined, ["NVDA"]);
    expect(u.map((x) => [x.symbol, x.buyable, x.unbuyableReason])).toEqual([
      ["SPY", true, undefined],
      ["NVDA", false, "removed"],
    ]);
    // not held any more: gone from the set
    expect(agentUniverse(["SPY"], all, [], 5, undefined, undefined, undefined, ["NVDA"]).map((x) => x.symbol)).toEqual(["SPY"]);
  });

  it("risk engine: a removed market can be sold but not bought, and counts in equity", () => {
    const base = {
      spec: { markets: ["SPY"], risk: spec.risk },
      preset: trend,
      params: spec.params,
      markets: [
        { symbol: "SPY", coin: "SPY/USDC", marketId: 1, szDecimals: 5, priceDecimals: 0, buyable: true },
        { symbol: "NVDA", coin: "NVDA/USDC", marketId: 2, szDecimals: 2, priceDecimals: 3, buyable: false, unbuyableReason: "removed" as const },
      ],
      balances: { usdc: 500, tokens: { NVDA: 10, SPY: 0 } },
      mids: { SPY: 100000, NVDA: 40 },
      tradesToday: 0,
      dailyPnlBps: 0,
      protectOnly: false,
      startedAt: 0,
      nowSec: 1000,
    };
    const r = evaluateDecision({
      ...base,
      decision: {
        actions: [
          { type: "buy", market: "NVDA", sizeBps: 500, reason: "x" },
          { type: "sell", market: "NVDA", sizeBps: 10000, reason: "wind down" },
        ],
        note: "",
      },
    } as never);
    expect(r.rejections.map((x) => x.code)).toEqual(["market_removed"]);
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ market: "NVDA", side: "sell" });
  });

  it("the next pass trades the new spec; the dropped NVDA position is wound down, never bought again, and stays in equity", async () => {
    const t = await setup();
    t.primary.queue.push(decisionJson([{ type: "buy", market: "NVDA", sizeBps: 2000, limitPriceUsd: null, reason: "trend" }]));
    expect((await t.runner.tickAgent(t.agent())).kind).toBe("decided");
    const q = holdNvda(t);
    t.runner.cache.clear();
    const before = await t.runner.snapshot(t.agent(), t.agent().spec!);

    // the owner drops NVDA and checks every 15 minutes instead of 5
    edit(t, { markets: ["SPY"], intervalSec: 900 });
    expect(t.agent().spec!.markets).toEqual(["SPY"]);
    expect(t.agent().intervalSec).toBe(900);
    expect(t.agent().state.lastDecisionAt).toBeDefined(); // results and timing continue
    const snap = await t.runner.snapshot(t.agent(), t.agent().spec!);
    expect(snap.markets.find((m) => m.symbol === "NVDA")).toMatchObject({ buyable: false, unbuyableReason: "removed" });
    expect(snap.balances.tokens.NVDA).toBeCloseTo(q);
    expect(snap.equity).toBeCloseTo(before.equity, 6); // no false loss in the agent's returns

    // the old interval passed, the new one not yet: no decision
    t.tick(400);
    expect((await t.runner.tickAgent(t.agent())).kind).toBe("not_due");
    // the new interval passed: the AI is asked even without a price move (first decision under the new strategy)
    t.tick(600);
    t.runner.cache.clear();
    t.primary.queue.push(
      decisionJson([
        { type: "buy", market: "NVDA", sizeBps: 1000, limitPriceUsd: null, reason: "more" },
        { type: "sell", market: "NVDA", sizeBps: 10000, limitPriceUsd: null, reason: "not in the strategy any more" },
      ]),
    );
    const out = await t.runner.tickAgent(t.agent());
    expect(out.kind).toBe("decided");
    const prompt = t.primary.calls.at(-1)!;
    expect(prompt.user).toContain('"removedFromStrategy":true');
    expect(prompt.system).toContain("removedFromStrategy=true");
    if (out.kind !== "decided") throw new Error("not decided");
    expect(out.rejections.map((r) => r.code)).toEqual(["market_removed"]);
    expect(t.exchange.orders.at(-1)!.order).toMatchObject({ coin: "NVDA/USDC", isBuy: false });
    expect(t.store.allTradesAsc(1).map((x) => [x.side, x.market])).toEqual([
      ["buy", "NVDA"],
      ["sell", "NVDA"],
    ]);
  });
});
