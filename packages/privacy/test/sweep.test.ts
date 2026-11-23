// Private mode sweeps: what is owed, when it is swept, retries, and "withdraw all to my private balance".
import { EncryptedKeyVault, type Hex, MemoryStore } from "@parallax/runner";
import { PRESETS } from "@parallax/strategy";
import { describe, expect, it } from "vitest";
import {
  MemoryPrivateModeStore,
  privateView,
  type SweepChain,
  type SweepDeps,
  setPrivateMode,
  sweepAmount,
  sweepPass,
  withdrawAllToPrivate,
} from "../src/sweep.js";

const MASTER_KEY = "cd".repeat(32);
const WALLET = `0x${"aa".repeat(32)}` as Hex;
const OWNER = `0x${"bb".repeat(32)}` as Hex;
const SHIELDED = "ab".repeat(96);

function world(walletUsdc = 1000) {
  const store = new MemoryStore({ presets: PRESETS });
  store.upsertAgent({
    id: 1,
    owner: OWNER,
    presetId: 2,
    chainStatus: 0,
    intervalSec: 300,
    createdAt: 1,
    specHash: "0x01",
    modelId: "0x02",
    wallet: WALLET,
    risk: PRESETS[2]!.defaults.balanced.risk,
  });
  const keys = new EncryptedKeyVault(MASTER_KEY);
  keys.put(WALLET, "11".repeat(64));
  const calls = { reads: 0, deposits: [] as { secret: string; to: string; amount: number }[], fail: false };
  const chain: SweepChain = {
    async walletUsdc() {
      calls.reads++;
      return walletUsdc;
    },
    async deposit(_agent, secret, to, amount) {
      if (calls.fail) throw new Error("rpc down");
      calls.deposits.push({ secret, to, amount });
      return `sig${calls.deposits.length}`;
    },
  };
  const privacy = new MemoryPrivateModeStore();
  let t = 1_800_000_000;
  const d: SweepDeps = { store, privacy, keys, chain, minSweepUsdc: 5, now: () => t++ };
  const trade = (side: "buy" | "sell", sizeBase: number, price: number) =>
    store.insertTrade({
      agentId: 1,
      owner: OWNER,
      side,
      market: "SOL",
      sizeUsd: sizeBase * price,
      sizeBase,
      price,
      reason: "",
      orderId: 0,
      timestamp: t++,
      source: "llm",
    });
  return { store, privacy, d, calls, trade };
}

describe("sweepAmount", () => {
  it("is realized profit since enabling, minus what was swept, capped by the wallet's USDC, in whole base units", () => {
    expect(sweepAmount({ realized: 20, realizedAtEnable: 0, sweptUsd: 0, walletUsdc: 100, minSweep: 5 })).toBe(20);
    expect(sweepAmount({ realized: 20, realizedAtEnable: 10, sweptUsd: 0, walletUsdc: 100, minSweep: 5 })).toBe(10);
    expect(sweepAmount({ realized: 20, realizedAtEnable: 0, sweptUsd: 16, walletUsdc: 100, minSweep: 5 })).toBe(0); // 4 < 5
    expect(sweepAmount({ realized: 20, realizedAtEnable: 0, sweptUsd: 0, walletUsdc: 7.1234567, minSweep: 5 })).toBe(7.123456);
    expect(sweepAmount({ realized: 20, realizedAtEnable: 0, sweptUsd: 0, walletUsdc: 3, minSweep: 5 })).toBe(0);
  });
});

describe("sweepPass", () => {
  it("sweeps realized profit once, then nothing until there is new profit (no RPC call when nothing is due)", async () => {
    const w = world();
    w.trade("buy", 10, 10);
    setPrivateMode(w.d, 1, { enabled: true, ownerShielded: SHIELDED });
    w.trade("sell", 10, 12); // +20 realized after enabling
    expect(await sweepPass(w.d)).toBe(1);
    expect(w.calls.deposits).toEqual([{ secret: "11".repeat(64), to: SHIELDED, amount: 20 }]);
    expect(w.privacy.sweptUsd(1)).toBe(20);
    const reads = w.calls.reads;
    expect(await sweepPass(w.d)).toBe(0);
    expect(w.calls.reads).toBe(reads);
    expect(privateView(w.d, 1)).toMatchObject({ enabled: true, sweptUsd: 20, pendingUsd: 0 });
  });

  it("profit made before Private mode was turned on stays in the wallet; losses are made up first", async () => {
    const w = world();
    w.trade("buy", 10, 10);
    w.trade("sell", 10, 12); // +20 before enabling
    setPrivateMode(w.d, 1, { enabled: true, ownerShielded: SHIELDED });
    w.trade("buy", 10, 10);
    w.trade("sell", 10, 9); // -10
    expect(await sweepPass(w.d)).toBe(0);
    w.trade("buy", 10, 10);
    w.trade("sell", 10, 11.6); // +16: 6 owed
    expect(await sweepPass(w.d)).toBe(1);
    expect(w.calls.deposits[0]?.amount).toBeCloseTo(6, 5); // floored to whole USDC base units
  });

  it("a failed deposit is kept as the agent's last error and retried next pass", async () => {
    const w = world();
    setPrivateMode(w.d, 1, { enabled: true, ownerShielded: SHIELDED });
    w.trade("buy", 10, 10);
    w.trade("sell", 10, 12);
    w.calls.fail = true;
    expect(await sweepPass(w.d)).toBe(0);
    expect(w.privacy.get(1)?.lastError).toBe("rpc down");
    w.calls.fail = false;
    expect(await sweepPass(w.d)).toBe(1);
    expect(w.privacy.get(1)?.lastError).toBeNull();
  });

  it("turned off, nothing is swept; turned on again, the baseline and the swept total are kept", async () => {
    const w = world();
    setPrivateMode(w.d, 1, { enabled: true, ownerShielded: SHIELDED });
    w.trade("buy", 10, 10);
    w.trade("sell", 10, 12);
    setPrivateMode(w.d, 1, { enabled: false });
    expect(await sweepPass(w.d)).toBe(0);
    setPrivateMode(w.d, 1, { enabled: true, ownerShielded: SHIELDED });
    expect(w.privacy.get(1)?.realizedAtEnable).toBe(0);
    expect(await sweepPass(w.d)).toBe(1);
  });
});

describe("withdrawAllToPrivate", () => {
  it("stops the agent and moves all its USDC into the private balance", async () => {
    const w = world(42.5);
    const r = await withdrawAllToPrivate(w.d, { id: 1, wallet: WALLET, offchainStatus: "ok" }, SHIELDED, 0);
    expect(r).toEqual({ signature: "sig1", amountUsd: 42.5 });
    expect(w.store.getAgent(1)?.offchainStatus).toBe("stopped");
  });

  it("refuses an empty wallet", async () => {
    const w = world(0);
    await expect(withdrawAllToPrivate(w.d, { id: 1, wallet: WALLET, offchainStatus: "ok" }, SHIELDED, 0)).rejects.toThrow(/no USDC/);
  });
});
