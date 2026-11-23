import { ComputeBudgetProgram, Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  budgetInstructions,
  cleanSymbol,
  DEFAULT_SOLANA,
  isBase58Address,
  isSafeTrending,
  isSolanaHex,
  type JupiterClient,
  type JupToken,
  loadUniverse,
  MAX_CU_PRICE,
  marketIdOf,
  normSolanaAddress,
  priceDecimalsFor,
  routeHonoursLimit,
  SampledCandles,
  SolanaExchange,
  slippageForLimit,
  syntheticBook,
  toBase58,
  toHexAddress,
  USDC_MINT,
  WSOL_MINT,
} from "../src/index.js";

describe("addresses", () => {
  it("round-trips base58 and the internal hex form", () => {
    const a = Keypair.generate().publicKey.toBase58();
    const hex = toHexAddress(a);
    expect(isSolanaHex(hex)).toBe(true);
    expect(hex).toBe(hex.toLowerCase());
    expect(toBase58(hex)).toBe(a);
    expect(normSolanaAddress(a)).toBe(hex);
    expect(normSolanaAddress(hex.toUpperCase().replace("0X", "0x"))).toBe(hex);
    expect(isBase58Address(USDC_MINT)).toBe(true);
    expect(isBase58Address("0x1580C7ae368Ad47e8A7Cad663253ED4187c6C9e7")).toBe(false);
    expect(() => toHexAddress("nope")).toThrow();
  });
});

describe("swap safety", () => {
  it("caps Jupiter's compute unit price and drops its unit limit", () => {
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 999 });
    const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 });
    const asJup = (i: typeof limit) => ({ programId: i.programId.toBase58(), accounts: [], data: Buffer.from(i.data).toString("base64") });
    const out = budgetInstructions([asJup(limit), asJup(price)]);
    expect(out).toHaveLength(1);
    expect(Buffer.from(out[0]!.data).readBigUInt64LE(1)).toBe(BigInt(MAX_CU_PRICE));
  });

  it("keeps the route's worst case at or better than the limit", () => {
    expect(routeHonoursLimit({ outAmount: "1000", otherAmountThreshold: "990" }, 990n)).toBe(true);
    expect(routeHonoursLimit({ outAmount: "1000", otherAmountThreshold: "989" }, 990n)).toBe(false);
    expect(slippageForLimit(1000n, 990n, 100)).toBe(100);
    expect(slippageForLimit(1000n, 995n, 100)).toBe(50);
    expect(slippageForLimit(1000n, 1000n, 100)).toBe(0);
  });
});

describe("markets", () => {
  const tok = (p: Partial<JupToken>): JupToken => ({
    id: Keypair.generate().publicKey.toBase58(),
    name: "X",
    symbol: "X",
    decimals: 6,
    isVerified: true,
    organicScoreLabel: "high",
    liquidity: 2_000_000,
    usdPrice: 1,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
    ...p,
  });

  it("offers only verified, organic, non-mintable, deep coins", () => {
    expect(isSafeTrending(tok({}), 500_000)).toBe(true);
    expect(isSafeTrending(tok({ isVerified: false }), 500_000)).toBe(false);
    expect(isSafeTrending(tok({ organicScoreLabel: "medium" }), 500_000)).toBe(false);
    expect(isSafeTrending(tok({ audit: { mintAuthorityDisabled: false } }), 500_000)).toBe(false);
    expect(isSafeTrending(tok({ audit: { isSus: true } }), 500_000)).toBe(false);
    expect(isSafeTrending(tok({ liquidity: 100 }), 500_000)).toBe(false);
    expect(isSafeTrending(tok({ id: USDC_MINT }), 500_000)).toBe(false);
    expect(isSafeTrending(tok({ symbol: "TSLAx", name: "Tesla xStock" }), 500_000)).toBe(false);
    expect(isSafeTrending(tok({ symbol: "TTWO", name: "Take-Two Interactive Tokenized Stock (Ondo)" }), 500_000)).toBe(false);
    expect(isSafeTrending(tok({ symbol: "SPCX", name: "SpaceX", tags: ["pre-ipo"] }), 500_000)).toBe(false);
  });

  it("cleans tickers and gives stable ids", () => {
    expect(cleanSymbol("$WIF")).toBe("WIF");
    expect(cleanSymbol("🚀")).toBeNull();
    expect(marketIdOf(USDC_MINT)).toBe(marketIdOf(USDC_MINT));
    expect(marketIdOf(USDC_MINT)).toBeLessThan(2 ** 31);
  });

  it("builds the universe: majors first, verified stocks, safe trending, no symbol twice", async () => {
    const tsla = tok({ symbol: "TSLAx", liquidity: 3_000_000 });
    const fakeTsla = tok({ symbol: "TSLAx", isVerified: false, liquidity: 9_000_000 });
    const fakeJup = tok({ symbol: "JUP" });
    const meme = tok({ symbol: "$PENGU", liquidity: 5_000_000 });
    const rug = tok({ symbol: "RUG", audit: { freezeAuthorityDisabled: false } });
    const jup = {
      tokens: async (mints: string[]) => mints.map((m) => tok({ id: m, symbol: "?", decimals: m === WSOL_MINT ? 9 : 6 })),
      search: async (q: string) => (q === "TSLAx" ? [fakeTsla, tsla] : []),
      category: async () => [fakeJup, meme, rug],
    } as unknown as JupiterClient;
    const u = await loadUniverse(jup, { maxTrending: 5, minTrendingLiquidityUsd: 500_000, minStockLiquidityUsd: 100_000 });
    const syms = u.map((m) => m.symbol);
    expect(syms.slice(0, 7)).toEqual(["SOL", "JUP", "BONK", "WIF", "JTO", "PYTH", "RAY"]);
    expect(u.find((m) => m.symbol === "TSLAx")?.mint).toBe(tsla.id);
    expect(syms).toContain("PENGU");
    expect(syms).not.toContain("RUG");
    expect(u.filter((m) => m.symbol === "JUP")).toHaveLength(1);
    expect(u.find((m) => m.symbol === "JUP")?.mint).toBe("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
  });
});

describe("market data helpers", () => {
  it("synthetic book: asks above, bids below, deeper liquidity = less impact", () => {
    const thin = syntheticBook(100, 50_000);
    const deep = syntheticBook(100, 5_000_000);
    expect(thin.asks[0]!.px).toBeGreaterThan(100);
    expect(thin.bids[0]!.px).toBeLessThan(100);
    expect(thin.asks.at(-1)!.px).toBeGreaterThan(thin.asks[0]!.px);
    const depth = (b: typeof thin) => b.asks.reduce((s, l) => s + l.px * l.sz, 0);
    expect(depth(deep)).toBeGreaterThan(depth(thin) * 10);
  });

  it("price decimals keep ~6 significant digits", () => {
    expect(priceDecimalsFor(150)).toBe(3);
    expect(priceDecimalsFor(0.00002)).toBe(10);
  });

  it("sampled candles roll 5-minute samples up", () => {
    const s = new SampledCandles();
    const t0 = Date.UTC(2026, 10, 22, 12, 0, 0);
    s.record("SOL", 100, t0);
    s.record("SOL", 110, t0 + 60_000);
    s.record("SOL", 90, t0 + 6 * 60_000);
    const c5 = s.candles("SOL", "5m", t0);
    expect(c5).toHaveLength(2);
    expect(c5[0]).toMatchObject({ o: 100, h: 110, c: 110 });
    const c1h = s.candles("SOL", "1h", t0);
    expect(c1h).toHaveLength(1);
    expect(c1h[0]).toMatchObject({ o: 100, h: 110, l: 90, c: 90 });
  });
});

describe("orders as swaps", () => {
  const kp = Keypair.generate();
  const key = { privateKey: Buffer.from(kp.secretKey).toString("hex") };
  const jup = {
    tokens: async (mints: string[]) => mints.map((m) => ({ id: m, symbol: "?", name: "?", decimals: m === WSOL_MINT ? 9 : 6, liquidity: 1e7, usdPrice: 150 })),
    search: async () => [],
    category: async () => [],
  } as unknown as JupiterClient;

  it("buy spends size x limit USDC and needs size tokens back at worst", async () => {
    let seen: { amountIn: bigint; minOut: bigint; inputMint: string } | null = null;
    const ex = new SolanaExchange({
      config: DEFAULT_SOLANA,
      jupiter: jup,
      swap: async (_d, _s, req) => {
        seen = req;
        return { status: "filled", signature: "sig", inAmount: req.amountIn, outAmount: 2_000_000_000n };
      },
    });
    const r = await ex.placeOrder(key, { marketId: 1, coin: "SOL/USDC", isBuy: true, price: "151", size: "2", szDecimals: 9, priceDecimals: 3, tif: "Ioc" });
    expect(seen!.inputMint).toBe(USDC_MINT);
    expect(seen!.amountIn).toBe(302_000_000n);
    expect(Number(seen!.minOut)).toBeGreaterThanOrEqual(1_999_990_000);
    expect(r).toMatchObject({ status: "filled", filledSz: 2, txHash: "sig" });
    expect(r.avgPx).toBeCloseTo(151);
  });

  it("sell needs size x limit USDC back; errors are reported, not thrown", async () => {
    let seen: { amountIn: bigint; minOut: bigint; outputMint: string } | null = null;
    const ex = new SolanaExchange({
      config: DEFAULT_SOLANA,
      jupiter: jup,
      swap: async (_d, _s, req) => {
        seen = req;
        return { status: "error", error: "price moved past the limit" };
      },
    });
    const r = await ex.placeOrder(key, { marketId: 1, coin: "SOL/USDC", isBuy: false, price: "149", size: "1.5", szDecimals: 9, priceDecimals: 3, tif: "Ioc" });
    expect(seen!.outputMint).toBe(USDC_MINT);
    expect(seen!.amountIn).toBe(1_500_000_000n);
    expect(Number(seen!.minOut)).toBeGreaterThanOrEqual(223_499_000);
    expect(r).toMatchObject({ status: "error" });
    const bad = await ex.placeOrder(key, { marketId: 1, coin: "NOPE/USDC", isBuy: true, price: "1", size: "1", szDecimals: 6, priceDecimals: 3, tif: "Ioc" });
    expect(bad.status).toBe("error");
  });
});

describe("well-known program addresses", () => {
  it("match @solana/spl-token's constants (a mistyped program id breaks every token transfer)", async () => {
    const { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } = await import("../src/wallets.js");
    expect(ASSOCIATED_TOKEN_PROGRAM.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(TOKEN_PROGRAM.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(TOKEN_2022_PROGRAM.toBase58()).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  });
});
