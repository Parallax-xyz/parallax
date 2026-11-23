// The spot runner on the Solana venue, end to end on fakes of the chain: markets synced from the Solana adapter, the
// agent's own wallet as its account (USDC + SOL above the gas reserve), and an order executed as a swap signed by the
// agent wallet's key from the vault, recorded as a trade.
import { DEFAULT_SOLANA, type JupiterClient, newAgentWallet, SolanaExchange, USDC_MINT, WSOL_MINT } from "@parallax/solana";
import { PRESETS, type StrategySpec } from "@parallax/strategy";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { runnerConfig } from "../src/config.js";
import { EncryptedKeyVault } from "../src/keys.js";
import { LlmRouter } from "../src/llm/router.js";
import { Runner } from "../src/runner.js";
import { MemoryStore } from "../src/store.js";
import { FakeProvider, FakeRegistry, MASTER_KEY, MODELS } from "./helpers.js";

const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const dca = PRESETS.find((p) => p.key === "dca")!;

function fakeJupiter(): JupiterClient {
  const info = (id: string) => ({
    id,
    symbol: "?",
    name: "?",
    decimals: id === WSOL_MINT ? 9 : 6,
    liquidity: 50_000_000,
    usdPrice: id === WSOL_MINT ? 150 : 1,
    stats24h: { buyVolume: 1e7, sellVolume: 1e7 },
  });
  return {
    tokens: async (mints: string[]) => mints.map(info),
    search: async () => [],
    category: async () => [],
    prices: async (mints: string[]) => Object.fromEntries(mints.map((m) => [m, { usdPrice: m === WSOL_MINT ? 150 : 0.8 }])),
  } as unknown as JupiterClient;
}

function fakeConnection(owner: string, usdc: bigint, lamports: number) {
  const parsed = (mint: string, amount: bigint, decimals: number) => ({
    pubkey: Keypair.generate().publicKey,
    account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals } } } } },
  });
  return {
    getBalance: async () => lamports,
    getParsedTokenAccountsByOwner: async (_pk: unknown, f: { programId: { toBase58(): string } }) => ({
      value: f.programId.toBase58().startsWith("Tokenkeg") ? [parsed(USDC_MINT, usdc, 6)] : [],
    }),
    owner,
  };
}

describe("the spot runner on Solana", () => {
  it("syncs Solana markets, sees the wallet and executes a swap with the agent key", async () => {
    const w = newAgentWallet();
    const swaps: { signer: string; req: { inputMint: string; outputMint: string; amountIn: bigint } }[] = [];
    const exchange = new SolanaExchange({
      config: DEFAULT_SOLANA,
      jupiter: fakeJupiter(),
      connection: fakeConnection(w.address, 200_000_000n, 0.5e9) as never,
      swap: async (_d, signer, req) => {
        swaps.push({ signer: signer.publicKey.toBase58(), req });
        return { status: "filled", signature: "sig1", inAmount: req.amountIn, outAmount: 133_000_000n };
      },
    });
    const store = new MemoryStore({ models: MODELS, presets: PRESETS });
    const keys = new EncryptedKeyVault(MASTER_KEY);
    const registry = new FakeRegistry();
    const primary = new FakeProvider("primary", [], false);
    const runner = new Runner({
      store,
      exchange,
      registry,
      llm: new LlmRouter({ providers: [primary], models: () => store.listModels(), usage: store }),
      keys,
      config: { ...runnerConfig(), runner: { ...runnerConfig().runner, dryRun: false } },
    });
    expect(await runner.refreshMarkets()).toBe(true);
    expect(store.listMarkets().map((m) => m.pair)).toEqual(expect.arrayContaining(["SOL/USDC", "JUP/USDC"]));

    const spec: StrategySpec = {
      version: 1,
      preset: "dca",
      name: "sol dca",
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

    const agent = store.getAgent(1)!;
    const snap = await runner.snapshot(agent, spec);
    expect(snap.balances.usdc).toBeCloseTo(200);
    // 0.5 SOL in the wallet, 0.02 kept for fees: 0.48 SOL is a position worth 72 USDC
    expect(snap.balances.tokens.SOL).toBeCloseTo(0.48);
    expect(snap.equity).toBeCloseTo(200 + 0.48 * 150, 1);

    const jup = store.listMarkets().find((m) => m.symbol === "JUP")!;
    const filled = await runner.execute(
      agent,
      [
        {
          index: 0,
          market: "JUP",
          coin: "JUP/USDC",
          marketId: jup.marketId,
          side: "buy",
          sizeBase: "100",
          limitPx: "0.82",
          szDecimals: 6,
          priceDecimals: 4,
          tif: "Ioc",
          notionalUsd: 82,
          reason: "test",
        } as never,
      ],
      "llm",
      { ...agent.state },
    );
    expect(filled).toBe(1);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]!.signer).toBe(w.address); // signed by the agent's own wallet
    expect(swaps[0]!.req).toMatchObject({ inputMint: USDC_MINT, outputMint: JUP_MINT, amountIn: 82_000_000n });
    const trade = store.allTradesAsc(1)[0]!;
    expect(trade).toMatchObject({ side: "buy", market: "JUP", sizeBase: 133, exchangeTxHash: "sig1" });
    expect(trade.price).toBeCloseTo(82 / 133, 6);
  });
});
