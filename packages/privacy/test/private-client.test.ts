// The browser's private balance client: the deposit wallet's key is a second, domain-separated key from the same
// signature; behind a relay, the SDK's HTTP calls carry the session (and the prover policy goes through it); the timing
// warning for deposits and withdrawals that could be matched.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  DEPOSIT_WALLET_DOMAIN,
  depositSeedFromSignature,
  PRIVATE_BALANCE_MESSAGE,
  seedFromSignature,
  shieldedAddressFromSignature,
} from "../src/private-balance.js";
import { PrivateBalance, relayEndpoints, relayFetch, rememberDeposit, roundSuggestion, timingRisk } from "../src/private-client.js";

const API_URL = "https://api.example.com";

const { privateKey } = generateKeyPairSync("ed25519");
const sig = () => new Uint8Array(sign(null, Buffer.from(PRIVATE_BALANCE_MESSAGE, "utf8"), privateKey));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
});

describe("the deposit wallet", () => {
  it("is sha256(domain || signature): deterministic, and a different key from the private balance's", async () => {
    const s = sig();
    const d = await depositSeedFromSignature(s);
    expect(Buffer.from(d).toString("hex")).toBe(
      createHash("sha256")
        .update(Buffer.concat([Buffer.from(DEPOSIT_WALLET_DOMAIN), s]))
        .digest("hex"),
    );
    expect(Buffer.from(await depositSeedFromSignature(sig())).equals(Buffer.from(d))).toBe(true);
    expect(Buffer.from(await seedFromSignature(s)).equals(Buffer.from(d))).toBe(false);
  });

  it("opens without any network call: the deposit wallet address and the shielded address come from the signature", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: unknown) => {
      calls.push(String(u));
      throw new Error("no network in this test");
    });
    const s = sig();
    const expectedDeposit = Keypair.fromSeed(await depositSeedFromSignature(s)).publicKey.toBase58();
    const pb = await PrivateBalance.open(
      s,
      "mainnet",
      relayEndpoints(`${API_URL}/v1/spr`, () => "tok"),
    );
    expect(pb.depositAddress).toBe(expectedDeposit);
    expect(pb.shieldedHex).toBe(await shieldedAddressFromSignature(sig()));
    expect(calls).toEqual([]);
  });
});

describe("the relay fetch", () => {
  it("adds the session only to the relay's routes, and sends the prover policy through the relay", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (u: unknown, init?: RequestInit) => {
      seen.push({ url: String(u), auth: new Headers(init?.headers).get("authorization") });
      return new Response("{}");
    });
    const f = relayFetch(`${API_URL}/v1/spr`, () => "tok");
    await f(`${API_URL}/v1/spr/indexer/getUserRecords?x=1`, { method: "POST", headers: { "content-type": "application/json" } });
    await f("https://d3gbdb0egjwcw9.cloudfront.net/tee-policy/mainnet.json");
    await f("https://example.com/other");
    expect(seen[0]).toEqual({ url: `${API_URL}/v1/spr/indexer/getUserRecords?x=1`, auth: "Bearer tok" });
    expect(seen[1]).toEqual({ url: `${API_URL}/v1/spr/tee-policy/mainnet.json`, auth: "Bearer tok" });
    expect(seen[2]!.auth).toBeNull();
  });
});

describe("timing", () => {
  it("warns about a withdrawal soon after a deposit, louder for the same amount; suggests round amounts", () => {
    const now = Math.floor(Date.now() / 1000);
    rememberDeposit("USDC", 25_000_000n);
    expect(timingRisk("USDC", 25_100_000n, now + 60)).toMatch(/same amount/);
    expect(timingRisk("USDC", 10_000_000n, now + 60)).toMatch(/easier to match/);
    expect(timingRisk("USDC", 25_000_000n, now + 7 * 3600)).toBeNull();
    expect(timingRisk("SOL", 25_000_000n, now + 60)).toBeNull();
    expect(roundSuggestion("USDC", 23_456_789n)).toBe(20_000_000n);
    expect(roundSuggestion("SOL", 34_000_000n)).toBe(30_000_000n);
  });
});
