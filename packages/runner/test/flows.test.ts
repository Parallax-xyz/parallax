// Deposits and withdrawals are not profit or loss (flows.ts): the runner takes wallet changes its own trades do not
// explain out of the time-weighted index, the owner's dollar result and the daily loss limit.
import { PRESETS, type StrategySpec } from "@parallax/strategy";
import { describe, expect, it } from "vitest";
import { chainIndex, externalFlow, FEE_ALLOWANCE_PER_TRADE, returnBetween } from "../src/flows.js";
import { lc } from "../src/types.js";
import { addAgent, decisionJson, FakeProvider, makeWorld, WALLET } from "./helpers.js";

const dca = PRESETS.find((p) => p.key === "dca")!;
const spec: StrategySpec = {
  version: 1,
  preset: "dca",
  name: "DCA NVDA",
  goal: "accumulate",
  markets: ["NVDA"],
  venue: "solana",
  quote: "USDC",
  model: "model-a",
  intervalSec: 300,
  profile: "balanced",
  risk: dca.defaults.balanced.risk, // maxDailyLossBps 800
  params: dca.defaults.balanced.params,
};

type Bal = { coin: string; total: number; hold: number; entryNtl: number };
const usdc = (n: number): Bal => ({ coin: "USDC", total: n, hold: 0, entryNtl: 0 });
const nvda = (n: number): Bal => ({ coin: "NVDA", total: n, hold: 0, entryNtl: 0 });

const NOON = 1_800_000_000 - (1_800_000_000 % 86400) + 12 * 3600; // midday UTC: the ticks below stay in one day

async function setup(balances: Bal[], o: { offset?: () => number } = {}) {
  let now = NOON;
  const primary = new FakeProvider("primary");
  const w = await makeWorld({ primary, now: () => now, ...(o.offset ? { deps: { equityOffset: () => o.offset!() } } : {}) });
  addAgent(w, { id: 1, spec });
  const setBalances = (b: Bal[]) => w.exchange.balances.set(lc(WALLET), b);
  setBalances(balances);
  const hold = () => primary.queue.push(decisionJson([], "hold"));
  return {
    ...w,
    primary,
    setBalances,
    hold,
    agent: () => w.store.getAgent(1)!,
    /** next runner pass, past the decision interval */
    tick: async (advance = 301) => {
      now += advance;
      return w.runner.tickAgent(w.store.getAgent(1)!);
    },
    flows: () => w.store.listFlows(1),
  };
}

describe("external flows (pure)", () => {
  const prev = { usdc: 100, tokens: { NVDA: 1 }, tradeId: 0 };
  it("a deposit or a withdrawal is a flow; the index does not move without trading", () => {
    const dep = externalFlow(prev, { usdc: 600, tokens: { NVDA: 1 } }, { NVDA: 50 }, []);
    expect(dep.usd).toBeCloseTo(500, 9);
    expect(chainIndex(1, 150, 650, dep.usd)).toBeCloseTo(1, 12);
    const wd = externalFlow(prev, { usdc: 0, tokens: { NVDA: 1 } }, { NVDA: 50 }, []);
    expect(wd.usd).toBeCloseTo(-100, 9);
    expect(chainIndex(1, 150, 50, wd.usd)).toBeCloseTo(1, 12);
  });

  it("$1 agent + $100 deposit and no trades: 0%, not +10,000%", () => {
    const f = externalFlow({ usdc: 1, tokens: {}, tradeId: 0 }, { usdc: 101, tokens: {} }, {}, []);
    const idx = chainIndex(1, 1, 101, f.usd);
    expect(returnBetween({ ts: 0, equityUsd: 1, perfIndex: 1 }, { ts: 1, equityUsd: 101, perfIndex: idx })).toBe(0);
  });

  it("own trades are not flows; the SOL an own swap burns on fees stays a cost; a gas top-up is a flow", () => {
    const trades = [{ id: 1, side: "buy" as const, market: "JUP", sizeUsd: 40, sizeBase: 50 }];
    const p = { usdc: 100, tokens: { SOL: 0.1 }, tradeId: 0 };
    const mids = { JUP: 0.8, SOL: 150 };
    // bought 50 JUP for 40 USDC and paid 0.003 SOL in fee, tip and rent
    const f = externalFlow(p, { usdc: 60, tokens: { SOL: 0.097, JUP: 50 } }, mids, trades, "SOL");
    expect(f.usd).toBeCloseTo(0, 9);
    expect(f.ownTrades).toBe(1);
    // more than the allowance per trade: the rest left the wallet (a transfer)
    const out = externalFlow(p, { usdc: 60, tokens: { SOL: 0.05, JUP: 50 } }, mids, trades, "SOL");
    expect(out.usd).toBeCloseTo(-(0.05 - FEE_ALLOWANCE_PER_TRADE) * 150, 9);
    // already counted trades (id <= tradeId) do not explain anything any more
    const top = externalFlow({ ...p, tradeId: 1 }, { usdc: 100, tokens: { SOL: 0.2 } }, mids, trades, "SOL");
    expect(top.usd).toBeCloseTo(15, 9);
    expect(Object.keys(top.qty)).toEqual(["SOL"]);
  });

  it("TWR: a gain before and after a deposit is chained, not diluted or inflated", () => {
    // $400 in NVDA +10%, then $600 USDC deposited, then NVDA +10% again
    let idx = chainIndex(1, 400, 440, 0);
    idx = chainIndex(idx, 440, 1040, 600);
    idx = chainIndex(idx, 1040, 1084, 0);
    expect((idx - 1) * 100).toBeCloseTo((1.1 * (1084 / 1040) - 1) * 100, 9); // +14.65%, not +171%
  });
});

describe("the runner: deposits and withdrawals are not results", () => {
  it("a deposit mid-period: index unchanged, a deposit row, result $0, day baseline moved", async () => {
    const t = await setup([usdc(100)]);
    t.hold();
    await t.tick();
    expect(t.agent().state.perf?.index).toBe(1);
    t.setBalances([usdc(200)]);
    t.hold();
    await t.tick();
    const st = t.agent().state;
    expect(st.perf?.index).toBeCloseTo(1, 12);
    expect(st.lastEquity).toBeCloseTo(200, 9);
    expect(st.initialEquity).toBeCloseTo(100, 9);
    expect(st.netFlowUsd).toBeCloseTo(100, 9);
    expect(st.dayStart?.equity).toBeCloseTo(200, 9);
    expect(t.flows()).toMatchObject([{ agentId: 1, amountUsd: 100, kind: "deposit" }]);
  });

  it("a withdrawal: 0%, a withdraw row, and no false daily loss (a buy still goes through)", async () => {
    const t = await setup([usdc(1000)]);
    t.hold();
    await t.tick();
    t.setBalances([usdc(500)]);
    t.primary.queue.push(decisionJson([{ type: "buy", market: "NVDA", sizeBps: 300, limitPriceUsd: null, reason: "schedule" }]));
    const out = await t.tick();
    expect(out.kind).toBe("decided");
    if (out.kind !== "decided") return;
    expect(out.rejections.map((r) => r.code)).not.toContain("daily_loss_limit");
    expect(out.orders).toHaveLength(1);
    const st = t.agent().state;
    expect(st.perf?.index).toBeCloseTo(1, 12);
    expect(st.netFlowUsd).toBeCloseTo(-500, 9);
    expect(t.flows()).toMatchObject([{ amountUsd: -500, kind: "withdraw" }]);
  });

  it("a deposit does not hide a daily loss", async () => {
    const t = await setup([usdc(600), nvda(10)]); // $1000 with NVDA at 40
    t.hold();
    await t.tick();
    t.exchange.mids["NVDA/USDC"] = 20; // NVDA halves: $800, -20% today
    t.runner.cache.clear();
    t.setBalances([usdc(10600), nvda(10)]); // and $10,000 arrive
    t.primary.queue.push(decisionJson([{ type: "buy", market: "NVDA", sizeBps: 300, limitPriceUsd: null, reason: "dip" }]));
    const out = await t.tick();
    expect(out.kind).toBe("decided");
    if (out.kind !== "decided") return;
    expect(out.rejections.map((r) => r.code)).toEqual(["daily_loss_limit"]);
    const st = t.agent().state;
    expect(st.perf?.index).toBeCloseTo(0.8, 2); // the book mid sits a hair off 20
    expect(st.netFlowUsd).toBeCloseTo(10000, 6);
  });

  it("own trades are not flows: a filled buy reflected in the wallet moves no money in or out", async () => {
    const t = await setup([usdc(1000)]);
    t.primary.queue.push(decisionJson([{ type: "buy", market: "NVDA", sizeBps: 300, limitPriceUsd: null, reason: "schedule" }]));
    await t.tick();
    const trade = t.store.allTradesAsc(1)[0]!;
    expect(trade).toBeDefined();
    t.setBalances([usdc(1000 - trade.sizeUsd), nvda(trade.sizeBase)]);
    t.hold();
    await t.tick();
    const st = t.agent().state;
    expect(st.netFlowUsd ?? 0).toBe(0);
    expect(t.flows()).toEqual([]);
    // the index moved only by what the trade cost against the mid
    expect(st.perf?.index).toBeCloseTo(st.lastEquity! / 1000, 9);
  });

  it("Private mode sweep: profit leaves the wallet but stays in the result; no flow, index unchanged", async () => {
    let swept = 0;
    const t = await setup([usdc(1000)], { offset: () => swept });
    t.hold();
    await t.tick();
    // the wallet shows the sweep a pass before the sweep is booked, then the booking catches up
    t.setBalances([usdc(950)]);
    t.hold();
    await t.tick();
    expect(t.agent().state.perf?.index).toBeCloseTo(1, 12);
    swept = 50;
    t.hold();
    await t.tick();
    const st = t.agent().state;
    expect(st.perf?.index).toBeCloseTo(1, 12);
    expect(st.lastEquity).toBeCloseTo(1000, 9);
    expect(st.netFlowUsd ?? 0).toBeCloseTo(0, 9);
  });

  it("an agent with snapshots but no index yet continues its series; snapshots carry the index", async () => {
    const t = await setup([usdc(120)]);
    t.store.insertEpoch(1, 100, 0, NOON - 7200);
    t.store.insertEpoch(1, 110, 0, NOON - 3600);
    expect(t.store.lastEpoch(1)?.perfIndex).toBeCloseTo(1.1, 12);
    t.store.setAgentState(1, { initialEquity: 100, lastEquity: 110 });
    t.hold();
    await t.tick();
    expect(t.agent().state.perf?.index).toBeCloseTo(1.2, 12);
    t.setBalances([usdc(1120)]); // +$1000 deposit
    t.hold();
    await t.tick();
    t.runner.recordEpochs();
    const last = t.store.lastEpoch(1)!;
    expect(last.equityUsd).toBeCloseTo(1120, 9);
    expect(last.perfIndex).toBeCloseTo(1.2, 12);
    expect(last.pnlBps).toBe(2000);
  });
});

describe("the flow table", () => {
  it("a retry of the same interval is ignored", () => {
    return makeWorld().then((w) => {
      w.store.insertFlow({ agentId: 8, fromTs: 1, ts: 2, amountUsd: 5, kind: "deposit", qty: { USDC: 5 } });
      w.store.insertFlow({ agentId: 8, fromTs: 1, ts: 3, amountUsd: 5, kind: "deposit", qty: { USDC: 5 } });
      expect(w.store.listFlows(8)).toEqual([{ agentId: 8, fromTs: 1, ts: 2, amountUsd: 5, kind: "deposit", qty: { USDC: 5 } }]);
    });
  });
});
