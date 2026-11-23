import type { DecisionRow, TradeRow } from "@parallax/runner";
import { describe, expect, it } from "vitest";
import { ANONYMOUS, performanceLine, publicDecision, publicRankingRow, publicTrade, scrubAmounts, viewer } from "../src/public-view.js";

describe("scrubAmounts: no amounts in public texts", () => {
  it("removes dollar figures", () => {
    expect(scrubAmounts("bought $12.34 of SOL, equity $ 1,200 ($5k goal)")).toBe("bought $… of SOL, equity $… ($… goal)");
  });

  it("removes amounts followed by a currency or SOL", () => {
    expect(scrubAmounts("needs 12.34 USDC, available 5.00")).toBe("needs … USDC, available …");
    expect(scrubAmounts("spend 50 USDC now, keep 0.03 SOL for fees, 2k USDT, 1,000.5 USD")).toBe("spend … USDC now, keep … SOL for fees, … USDT, … USD");
    expect(scrubAmounts("order 123.45 USD > 2% of 24h volume (5000.00 USD)")).toBe("order … USD > 2% of 24h volume (… USD)");
  });

  it("removes estimates and base sizes from the risk engine's messages", () => {
    expect(scrubAmounts("order is below the 1 USD minimum (≈ 9.88)")).toBe("order is below the … USD minimum (≈ …)");
    expect(scrubAmounts("order is below the 10 USD minimum after rounding to the lot size (BONK lot ≈ 0.70): 0.01 BONK ≈ 0.70")).toBe(
      "order is below the … USD minimum after rounding to the lot size (BONK lot ≈ …): … BONK ≈ …",
    );
    expect(scrubAmounts("book depth 3.5 < order size 4.25")).toBe("book depth … < order size …");
    expect(scrubAmounts("filling 4.25 needs price impact beyond 50 bps (only 1.5e-7 available within the band)")).toBe(
      "filling … needs price impact beyond 50 bps (only … available within the band)",
    );
    expect(scrubAmounts("fillable size 0.42 USD is below the 1 USD minimum")).toBe("fillable size … USD is below the … USD minimum");
  });

  it("keeps percentages, bps, counts and prices without a unit", () => {
    const keep = "RSI 28, up 4.5% today, share 1200 bps > maxPositionBps 1000, already holding 3 tokens, price ≈ 5% above EMA 20";
    expect(scrubAmounts(keep)).toBe(keep);
  });
});

describe("public records", () => {
  const owner = "0x00000000000000000000000000000000000000000000000000000000000000e1" as const;
  const trade: TradeRow = {
    id: 7,
    agentId: 1,
    owner,
    side: "buy",
    market: "SOL",
    sizeUsd: 123.45,
    sizeBase: 0.9,
    price: 137.2,
    reason: "dip buy for $123.45",
    orderId: 42,
    timestamp: 1_800_000_000,
    source: "llm",
    exchangeOrderId: null,
    exchangeTxHash: "5ig",
  };

  it("a public trade has no owner, size, order id or signature", () => {
    const p = publicTrade(trade);
    expect(p).toEqual({ id: 7, agentId: 1, side: "buy", market: "SOL", price: 137.2, reason: "dip buy for $…", timestamp: 1_800_000_000, source: "llm" });
    expect(JSON.stringify(p)).not.toMatch(/123\.45|0\.9|5ig|e1/);
  });

  it("a public decision keeps shares and reasons, scrubs amounts", () => {
    const d: DecisionRow = {
      id: 1,
      agentId: 1,
      ts: 1,
      provider: "p",
      model: "m",
      decision: { note: "cash $50", actions: [{ type: "buy", market: "SOL", sizeBps: 500, reason: "about 12 USDC" }] },
      rejections: [
        { index: 0, action: { type: "buy", market: "SOL", sizeBps: 500, reason: "" }, code: "insufficient_usdc", message: "needs 12 USDC, available 3" },
      ],
    };
    const p = publicDecision(d);
    expect(p.decision.note).toBe("cash $…");
    expect(p.decision.actions[0]).toMatchObject({ sizeBps: 500, reason: "about … USDC" });
    expect(p.rejections[0]).toEqual({ index: 0, code: "insufficient_usdc", message: "needs … USDC, available …" });
  });

  it("performance is a % line from the first funded snapshot, by the performance index", () => {
    const line = performanceLine([
      { ts: 1, equityUsd: 0, perfIndex: 1 },
      { ts: 2, equityUsd: 100, perfIndex: 1 },
      { ts: 3, equityUsd: 1100, perfIndex: 1.05 }, // a $1000 deposit does not count as a return
    ]);
    expect(line).toEqual([
      { ts: 2, returnPct: 0 },
      { ts: 3, returnPct: 5 },
    ]);
  });

  it("ranking rows lose owner and dollar equity; only the owner sees their own agents in full", () => {
    expect(publicRankingRow({ agentId: 1, owner, startEquityUsd: 10, equityUsd: 12, returnPct: 20 })).toEqual({ agentId: 1, returnPct: 20 });
    const me = viewer(owner.toUpperCase().replace("0X", "0x"));
    expect(me.sees(owner)).toBe(true);
    expect(viewer(null).sees(owner)).toBe(false);
    expect(ANONYMOUS.owns(owner)).toBe(false);
  });
});
