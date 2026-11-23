// Agent modes (tokenized stocks or crypto, spot on Solana), presets per mode, asset class of markets.
import { describe, expect, it } from "vitest";
import {
  AGENT_MODE_KEYS,
  AGENT_MODES,
  assetClassOf,
  marketsForMode,
  modeOfSpec,
  modeSpecFields,
  PRESETS,
  presetDefaults,
  presetsForMode,
  type StrategySpec,
  validateSpec,
} from "../src/index.js";

const env = {
  presets: PRESETS,
  marketSymbols: ["SPYx", "QQQx", "NVDAx", "SOL", "JUP", "BONK"],
  models: [{ id: "m", label: "M", provider: "p", tier: "standard" as const, enabled: true }],
  intervals: { min: 300, premiumMin: 60 },
  isPremium: false,
};

describe("modes", () => {
  it("two spot modes, both on Solana in USDC", () => {
    expect(AGENT_MODE_KEYS).toEqual(["stocks-spot", "crypto-spot"]);
    expect(AGENT_MODES["stocks-spot"]).toMatchObject({ venue: "solana", quote: "USDC", kind: "spot", assetClass: "stocks" });
    expect(AGENT_MODES["crypto-spot"]).toMatchObject({ venue: "solana", quote: "USDC", kind: "spot", assetClass: "crypto" });
  });

  it("the mode follows from the spec: the asset class, crypto implicit", () => {
    expect(modeOfSpec({})).toBe("crypto-spot");
    expect(modeOfSpec({ assets: "stocks" })).toBe("stocks-spot");
    for (const k of AGENT_MODE_KEYS) expect(modeOfSpec(modeSpecFields(k))).toBe(k);
    expect(modeSpecFields("stocks-spot")).toEqual({ venue: "solana", assets: "stocks", quote: "USDC" });
    expect(modeSpecFields("crypto-spot")).toEqual({ venue: "solana", quote: "USDC" });
  });

  it("the asset class is part of the spec (and its hash); crypto stays implicit", () => {
    const base = {
      version: 1,
      preset: "dca",
      name: "x",
      goal: "",
      markets: ["*"],
      venue: "solana",
      quote: "USDC",
      model: "m",
      intervalSec: 300,
      profile: "balanced",
    } as const;
    const d = presetDefaults(PRESETS.find((p) => p.key === "dca")!, "balanced", "crypto-spot");
    const crypto = validateSpec({ ...base, risk: d.risk, params: d.params, assets: "crypto" }, env);
    const implicit = validateSpec({ ...base, risk: d.risk, params: d.params }, env);
    const stocks = validateSpec({ ...base, risk: d.risk, params: d.params, assets: "stocks" }, env);
    expect(crypto.spec!.assets).toBeUndefined();
    expect(crypto.specHash).toBe(implicit.specHash);
    expect(stocks.spec!.assets).toBe("stocks");
    expect(stocks.specHash).not.toBe(implicit.specHash);
  });

  it("each mode offers the five spot presets", () => {
    const keys = (m: (typeof AGENT_MODE_KEYS)[number]) => presetsForMode(PRESETS, m).map((p) => p.key);
    expect(keys("stocks-spot")).toEqual(["dca", "protect", "trend", "rebalance", "momentum"]);
    expect(keys("crypto-spot")).toEqual(["dca", "protect", "trend", "rebalance", "momentum"]);
  });

  it("preset ids are unique; preset texts name the venue only as Solana", () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    for (const p of PRESETS) {
      expect(p.promptTemplate, p.key).toContain("on Solana");
    }
  });

  it("every preset's defaults validate in every mode it is offered in", () => {
    for (const mode of AGENT_MODE_KEYS)
      for (const p of presetsForMode(PRESETS, mode))
        for (const profile of ["conservative", "balanced", "aggressive"] as const) {
          const d = presetDefaults(p, profile, mode);
          const crypto = AGENT_MODES[mode].assetClass === "crypto";
          const markets = p.rules?.rebalance ? Object.keys(d.params[p.rules.rebalance.targetsParam] as Record<string, number>) : [crypto ? "SOL" : "SPYx"];
          const spec: StrategySpec = {
            version: 1,
            preset: p.key,
            name: "x",
            goal: "",
            markets,
            model: "m",
            intervalSec: 300,
            profile,
            risk: d.risk,
            params: d.params,
            ...modeSpecFields(mode),
          };
          expect(validateSpec(spec, env), `${mode}/${p.key}/${profile}`).toMatchObject({ ok: true, errors: [] });
        }
  });

  it("Rebalance defaults to the tokenized S&P 500 ETF for stocks and SOL for crypto", () => {
    const rb = PRESETS.find((p) => p.key === "rebalance")!;
    expect(presetDefaults(rb, "balanced", "stocks-spot").params.targets).toEqual({ SPYx: 5000 });
    expect(presetDefaults(rb, "balanced", "crypto-spot").params.targets).toEqual({ SOL: 5000 });
  });
});

describe("asset class of markets", () => {
  it("tokenized stocks (xStocks) are stocks, every other Solana token is crypto", () => {
    expect(assetClassOf("SPYx")).toBe("stocks");
    expect(assetClassOf("nvdax")).toBe("stocks");
    expect(assetClassOf("SOL")).toBe("crypto");
    expect(assetClassOf("BONK")).toBe("crypto");
  });

  it("marketsForMode keeps the mode's class", () => {
    const list = [{ symbol: "SPYx" }, { symbol: "SOL" }, { symbol: "GLDx" }, { symbol: "JUP" }];
    expect(marketsForMode(list, "stocks-spot").map((m) => m.symbol)).toEqual(["SPYx", "GLDx"]);
    expect(marketsForMode(list, "crypto-spot").map((m) => m.symbol)).toEqual(["SOL", "JUP"]);
    const tagged = [
      { symbol: "TSLAx", assetClass: "stocks" as const },
      { symbol: "WIF", assetClass: "crypto" as const },
      { symbol: "ODD", assetClass: null },
    ];
    expect(marketsForMode(tagged, "stocks-spot").map((m) => m.symbol)).toEqual(["TSLAx"]);
    expect(marketsForMode(tagged, "crypto-spot").map((m) => m.symbol)).toEqual(["WIF"]);
  });
});
