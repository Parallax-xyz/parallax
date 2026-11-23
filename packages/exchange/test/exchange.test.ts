// Order formatting (directional rounding), market parsing, tiers and market status.
import { describe, expect, it } from "vitest";
import {
  type ExchangeSpotMarket,
  formatSpotPrice,
  formatSpotSize,
  marketOpenState,
  marketTier,
  parseSpotMarkets,
  quoteOf,
  slippageLimitPrice,
  toScaledInt,
  withTier,
} from "../src/index.js";

describe("prices and sizes with a market's decimals", () => {
  it("price: at most priceDecimals decimals, directional rounding", () => {
    expect(formatSpotPrice(176.0549, 2, "down")).toBe("176.05");
    expect(formatSpotPrice(176.0501, 2, "up")).toBe("176.06");
    expect(formatSpotPrice(176.005, 2, "nearest")).toBe("176.01");
    expect(formatSpotPrice(1.005, 3, "nearest")).toBe("1.005");
    expect(formatSpotPrice(0.012345, 5, "down")).toBe("0.01234");
    expect(formatSpotPrice(123456.7, 0, "down")).toBe("123456");
    expect(formatSpotPrice(9.999, 2, "up")).toBe("10");
    expect(() => formatSpotPrice(0.001, 2, "down")).toThrow();
  });
  it("size rounds down to szDecimals", () => {
    expect(formatSpotSize(1.23456789, 4)).toBe("1.2345");
    expect(formatSpotSize(0.1999999, 2)).toBe("0.19");
    expect(formatSpotSize(5, 0)).toBe("5");
    expect(formatSpotSize(0.004, 2)).toBe("0");
  });
  it("worst price: buy <= mid*(1+s), sell >= mid*(1-s)", () => {
    const b = Number(slippageLimitPrice(176.4321, "buy", 100, 2));
    const s = Number(slippageLimitPrice(176.4321, "sell", 100, 2));
    expect(b).toBeLessThanOrEqual(176.4321 * 1.01);
    expect(s).toBeGreaterThanOrEqual(176.4321 * 0.99);
    expect(b).toBe(178.19);
    expect(s).toBe(174.67);
  });
  it("decimal strings to integers: exact, no float", () => {
    expect(toScaledInt("0.05", 4)).toBe(500);
    expect(toScaledInt("176.05", 2)).toBe(17605);
    expect(toScaledInt("0.1", 1)).toBe(1);
    expect(() => toScaledInt("1.234", 2)).toThrow();
    expect(() => toScaledInt("-1", 2)).toThrow();
    expect(() => toScaledInt("1e3", 2)).toThrow();
  });
});

const row = (p: Partial<ExchangeSpotMarket> & Pick<ExchangeSpotMarket, "marketId" | "base" | "dayQuoteVolume">): ExchangeSpotMarket => ({
  pair: `${p.base}/USDC`,
  quote: "USDC",
  szDecimals: 6,
  priceDecimals: 4,
  minBaseAmount: 0,
  minQuoteAmount: 1,
  status: "active",
  isFrozen: false,
  startTimestamp: 0,
  endTimestamp: 0,
  lastPrice: 10,
  dayPriceChangePct: 0,
  ...p,
});

describe("parseSpotMarkets", () => {
  it("keeps pairs to the quote, sorted by 24h volume; coin = pair; previous-day price from the 24h change", () => {
    const rows = [
      row({ marketId: 1, base: "JUP", dayQuoteVolume: 5_000_000 }),
      row({ marketId: 2, base: "SOL", dayQuoteVolume: 90_000_000, lastPrice: 110, dayPriceChangePct: 10 }),
      row({ marketId: 3, base: "XYZ", dayQuoteVolume: 1e12, quote: "USDT", pair: "XYZ/USDT" }),
    ];
    const m = parseSpotMarkets(rows, "USDC");
    expect(m.map((x) => x.symbol)).toEqual(["SOL", "JUP"]);
    expect(m[0]).toMatchObject({ coin: "SOL/USDC", marketId: 2, resolved: true, midUsd: 110 });
    expect(m[0].prevDayPx).toBeCloseTo(100, 9);
  });

  it("one pair per symbol: an active pair wins over an inactive one with more volume", () => {
    const a = row({ marketId: 3000, base: "ABC", status: "active", dayQuoteVolume: 10 });
    const b = row({ marketId: 3001, base: "ABC", status: "inactive", dayQuoteVolume: 1e9 });
    const r = parseSpotMarkets([b, a], "USDC");
    expect(r).toHaveLength(1);
    expect(r[0].marketId).toBe(3000);
  });

  it("tier by thresholds; withTier adds the tier and the open state", () => {
    const t = { minMarketDayVolumeUsd: 5000, liquidDayVolumeUsd: 100000 };
    expect(marketTier(100000, t)).toBe("liquid");
    expect(marketTier(5000, t)).toBe("thin");
    expect(marketTier(4999, t)).toBe("illiquid");
    expect(marketTier(undefined, t)).toBe("illiquid");
    const m = { ...parseSpotMarkets([row({ marketId: 1, base: "SOL", dayQuoteVolume: 1e6 })], "USDC")[0], enabled: true };
    expect(withTier(m, t, 1_800_000_000_000)).toMatchObject({ tier: "liquid", open: true });
    expect(withTier({ ...m, isFrozen: true }, t)).toMatchObject({ open: false, closedReason: "frozen" });
  });

  it("quoteOf defaults to USDC", () => {
    expect(quoteOf({})).toBe("USDC");
    expect(quoteOf({ quote: "USDC" })).toBe("USDC");
  });
});

describe("market status", () => {
  const now = 1_800_000_000_000;
  it("active and not frozen: open; any other status: closed", () => {
    expect(marketOpenState({ status: "active", resolved: true }, now)).toEqual({ open: true });
    expect(marketOpenState({ status: "inactive", resolved: true }, now)).toEqual({ open: false, reason: "status:inactive" });
  });
  it("frozen, before the start, after the end, delisted", () => {
    expect(marketOpenState({ status: "active", isFrozen: true, resolved: true }, now).reason).toBe("frozen");
    expect(marketOpenState({ status: "active", startTs: now + 1, resolved: true }, now).reason).toBe("not_started");
    expect(marketOpenState({ status: "active", endTs: now, resolved: true }, now).reason).toBe("ended");
    expect(marketOpenState({ status: "active", resolved: false }, now).reason).toBe("delisted");
  });
});
