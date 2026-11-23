// Gas (SOL for fees) of Solana agent wallets: the thresholds, no swap attempted without the SOL to pay for it, a
// protective sell still going out when a buy would not, the self-pause "low_gas" and the self-resume once topped up —
// which never overrides a pause the owner made.
import { DEFAULT_SOLANA, type JupiterClient, newAgentWallet, SolanaExchange, USDC_MINT, WSOL_MINT } from "@parallax/solana";
import { PRESETS, type StrategySpec } from "@parallax/strategy";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { runnerConfig } from "../src/config.js";
import {
  ACCOUNT_RENT_MIN,
  BUY_WORST_LAMPORTS,
  canSwap,
  gasLevel,
  gasView,
  LOW_GAS_LAMPORTS,
  LOW_GAS_REASON,
  SELL_WORST_LAMPORTS,
  TOKEN_ACCOUNT_RENT,
} from "../src/gas.js";
import { EncryptedKeyVault } from "../src/keys.js";
import { LlmRouter } from "../src/llm/router.js";
import { Runner } from "../src/runner.js";
import { MemoryStore } from "../src/store.js";
import { FakeProvider, FakeRegistry, MASTER_KEY, MODELS } from "./helpers.js";

const dca = PRESETS.find((p) => p.key === "dca")!;

describe("gas thresholds", () => {
  it("empty below one worst-case buy (new token account included), low below 0.01 SOL", () => {
    expect(BUY_WORST_LAMPORTS - SELL_WORST_LAMPORTS).toBe(TOKEN_ACCOUNT_RENT);
    expect(gasLevel(0)).toBe("empty");
    expect(gasLevel(ACCOUNT_RENT_MIN + BUY_WORST_LAMPORTS - 1)).toBe("empty");
    expect(gasLevel(ACCOUNT_RENT_MIN + BUY_WORST_LAMPORTS)).toBe("low");
    expect(gasLevel(LOW_GAS_LAMPORTS - 1)).toBe("low");
    expect(gasLevel(LOW_GAS_LAMPORTS)).toBe("ok");
    expect(gasLevel(0.03e9)).toBe("ok");
    const sellOnly = ACCOUNT_RENT_MIN + SELL_WORST_LAMPORTS;
    expect(canSwap("sell", sellOnly)).toBe(true);
    expect(canSwap("buy", sellOnly)).toBe(false);
    expect(gasView(0.03e9)).toMatchObject({ level: "ok", sol: 0.03, tradesLeft: 291 });
  });
});

function setup() {
  const w = newAgentWallet();
  const gas = { lamports: 0.03e9 };
  const swaps: { inputMint: string }[] = [];
  const parsed = (mint: string, amount: bigint, decimals: number) => ({
    pubkey: Keypair.generate().publicKey,
    account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals } } } } },
  });
  const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  const connection = {
    getBalance: async () => gas.lamports,
    getParsedTokenAccountsByOwner: async (_pk: unknown, f: { programId: { toBase58(): string } }) => ({
      value: f.programId.toBase58().startsWith("Tokenkeg") ? [parsed(USDC_MINT, 200_000_000n, 6), parsed(JUP, 50_000_000n, 6)] : [],
    }),
  };
  const jupiter = {
    tokens: async (mints: string[]) =>
      mints.map((id) => ({
        id,
        symbol: "?",
        name: "?",
        decimals: id === WSOL_MINT ? 9 : 6,
        liquidity: 5e7,
        usdPrice: 1,
        stats24h: { buyVolume: 1e7, sellVolume: 1e7 },
      })),
    search: async () => [],
    category: async () => [],
    prices: async (mints: string[]) => Object.fromEntries(mints.map((m) => [m, { usdPrice: m === WSOL_MINT ? 150 : 0.8 }])),
  } as unknown as JupiterClient;
  const exchange = new SolanaExchange({
    config: DEFAULT_SOLANA,
    jupiter,
    connection: connection as never,
    swap: async (_d, _signer, req) => {
      swaps.push(req);
      return { status: "filled", signature: "sig", inAmount: req.amountIn, outAmount: 10_000_000n };
    },
  });
  const store = new MemoryStore({ models: MODELS, presets: PRESETS });
  const keys = new EncryptedKeyVault(MASTER_KEY);
  const registry = new FakeRegistry();
  const runner = new Runner({
    store,
    exchange,
    registry,
    llm: new LlmRouter({ providers: [new FakeProvider("primary", [], false)], models: () => store.listModels(), usage: store }),
    keys,
    config: { ...runnerConfig(), runner: { ...runnerConfig().runner, dryRun: false } },
  });
  const spec: StrategySpec = {
    version: 1,
    preset: "dca",
    name: "gas",
    goal: "",
    markets: ["SOL", "JUP"],
    venue: "solana",
    quote: "USDC",
    model: "model-a",
    intervalSec: 300,
    profile: "balanced",
    risk: dca.defaults.balanced.risk,
    params: dca.defaults.balanced.params,
  };
  const registered = {
    id: 1,
    owner: `0x${"11".repeat(32)}` as const,
    presetId: dca.id,
    chainStatus: 0,
    intervalSec: 300,
    createdAt: 1,
    specHash: "0x01" as const,
    modelId: "0x02" as const,
    wallet: w.addressHex,
    risk: spec.risk,
  };
  registry.agents.set(1, { status: 0, wallet: w.addressHex });
  store.upsertAgent(registered);
  store.activateAgent(1, spec);
  keys.put(w.addressHex, w.secretHex);
  // no decision due in these tests: only the gas rules act
  store.setAgentState(1, { lastDecisionAt: Math.floor(Date.now() / 1000) });
  return { gas, swaps, store, runner };
}

const order = (side: "buy" | "sell", marketId: number) =>
  ({
    index: 0,
    market: "JUP",
    coin: "JUP/USDC",
    marketId,
    side,
    sizeBase: "10",
    limitPx: side === "buy" ? "0.82" : "0.78",
    szDecimals: 6,
    priceDecimals: 4,
    tif: "Ioc",
    notionalUsd: 8,
    reason: "test",
  }) as never;

describe("the runner and gas", () => {
  it("no swap is attempted without the SOL to pay for it; a sell still goes out when a buy would not", async () => {
    const { gas, swaps, store, runner } = setup();
    expect(await runner.refreshMarkets()).toBe(true);
    const jup = store.listMarkets().find((m) => m.symbol === "JUP")!.marketId as number;
    const agent = store.getAgent(1)!;
    gas.lamports = ACCOUNT_RENT_MIN + SELL_WORST_LAMPORTS + 10; // enough for a sell, not for a buy
    expect(await runner.execute(agent, [order("buy", jup)], "llm", { ...agent.state })).toBe(0);
    expect(swaps).toHaveLength(0);
    expect(await runner.execute(agent, [order("sell", jup)], "protect", { ...agent.state })).toBe(1);
    expect(swaps).toHaveLength(1);
    gas.lamports = 1000; // nothing at all
    expect(await runner.execute(agent, [order("sell", jup)], "protect", { ...agent.state })).toBe(0);
    expect(swaps).toHaveLength(1);
    // two buys with gas for one: the second is not attempted
    gas.lamports = ACCOUNT_RENT_MIN + BUY_WORST_LAMPORTS + 10;
    expect(await runner.execute(agent, [order("buy", jup), order("buy", jup)], "llm", { ...agent.state })).toBe(1);
    expect(swaps).toHaveLength(2);
  });

  it("pauses itself when out of gas, resumes by itself once topped up; an owner's pause is never lifted", async () => {
    const { gas, store, runner } = setup();
    await runner.refreshMarkets();
    gas.lamports = 0.002e9;
    expect(await runner.tickAgent(store.getAgent(1)!)).toEqual({ kind: "skipped", reason: LOW_GAS_REASON });
    expect(store.getAgent(1)).toMatchObject({ offchainStatus: "paused", pauseReason: LOW_GAS_REASON });
    expect(store.getAgent(1)!.state.gasLamports).toBe(0.002e9);
    // a little more, still below the resume level: stays paused
    gas.lamports = 0.006e9;
    await runner.tickAgent(store.getAgent(1)!);
    expect(store.getAgent(1)!.offchainStatus).toBe("paused");
    // topped up: back to work by itself
    gas.lamports = 0.03e9;
    expect((await runner.tickAgent(store.getAgent(1)!)).kind).toBe("not_due");
    expect(store.getAgent(1)).toMatchObject({ offchainStatus: "ok", pauseReason: null });
    // the owner pauses it; gas does not matter then
    store.setOffchainStatus(1, "paused", "owner_pause");
    gas.lamports = 0.002e9;
    expect(await runner.tickAgent(store.getAgent(1)!)).toEqual({ kind: "skipped", reason: "offchain_paused" });
    gas.lamports = 0.5e9;
    await runner.tickAgent(store.getAgent(1)!);
    expect(store.getAgent(1)).toMatchObject({ offchainStatus: "paused", pauseReason: "owner_pause" });
  });

  it("low but not empty: a warning level only, the agent keeps working", async () => {
    const { gas, store, runner } = setup();
    await runner.refreshMarkets();
    gas.lamports = 0.008e9;
    expect(gasLevel(gas.lamports)).toBe("low");
    expect((await runner.tickAgent(store.getAgent(1)!)).kind).toBe("not_due");
    expect(store.getAgent(1)!.offchainStatus).toBe("ok");
  });
});
