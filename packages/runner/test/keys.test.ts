import { randomBytes } from "node:crypto";
import { PRESETS } from "@parallax/strategy";
import { describe, expect, it } from "vitest";
import { decryptSecret, EncryptedKeyVault, encryptSecret, safeEqualHex, sha256Hex } from "../src/keys.js";
import { addAgent, type Hex, makeWorld } from "./helpers.js";

const K = "11".repeat(32);
const K2 = "22".repeat(32);

describe("AES-256-GCM for agent wallet keys", () => {
  it("round trip; the key is not in the ciphertext", () => {
    const pk = randomBytes(64).toString("hex");
    const aad = `0x${"aa".repeat(32)}`;
    const blob = encryptSecret(pk, K, aad);
    expect(blob).not.toContain(pk);
    expect(blob.startsWith("v1:")).toBe(true);
    expect(decryptSecret(blob, K, aad)).toBe(pk);
  });
  it("random IV: two ciphertexts differ", () => {
    expect(encryptSecret("x", K)).not.toBe(encryptSecret("x", K));
  });
  it("wrong master key, wrong AAD or a tampered ciphertext -> error", () => {
    const blob = encryptSecret("secret", K, "0xabc");
    expect(() => decryptSecret(blob, K2, "0xabc")).toThrow();
    expect(() => decryptSecret(blob, K, "0xdef")).toThrow();
    const parts = blob.split(":");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString("base64");
    expect(() => decryptSecret(parts.join(":"), K, "0xabc")).toThrow();
  });
  it("the master key format is checked; a 0x prefix is accepted", () => {
    expect(() => encryptSecret("x", "short")).toThrow(/MASTER_KEY/);
    expect(decryptSecret(encryptSecret("x", `0x${K}`), K)).toBe("x");
  });
  it("sha256Hex and constant-time hex comparison", () => {
    const h = sha256Hex("parallax");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(safeEqualHex(h, sha256Hex("parallax"))).toBe(true);
    expect(safeEqualHex(h, sha256Hex("other"))).toBe(false);
    expect(safeEqualHex("ab", "abcd")).toBe(false);
  });
});

describe("EncryptedKeyVault", () => {
  it("stores only ciphertext bound to the wallet and returns the key of the agent's wallet", async () => {
    const w = await makeWorld();
    const spec = {
      ...PRESETS[0]!.defaults.balanced,
      version: 1 as const,
      preset: PRESETS[0]!.key,
      name: "n",
      goal: "",
      markets: ["NVDA"],
      venue: "solana" as const,
      quote: "USDC" as const,
      model: "model-a",
      intervalSec: 300,
      profile: "balanced" as const,
    };
    const k = addAgent(w, { id: 1, spec });
    expect(await w.keys.agentKey({ id: 1, wallet: k.wallet })).toEqual({ privateKey: k.privateKey });
  });

  it("an unknown wallet, a blob moved to another wallet and a bad master key fail loudly", async () => {
    const blobs = new Map<string, string>();
    const vault = new EncryptedKeyVault(K, blobs);
    const a = `0x${"0a".repeat(32)}` as Hex;
    const b = `0x${"0b".repeat(32)}` as Hex;
    const secret = randomBytes(64).toString("hex");
    vault.put(a, secret);
    expect([...blobs.values()][0]).not.toContain(secret);
    await expect(vault.agentKey({ id: 2, wallet: b })).rejects.toThrow(/no key stored/);
    blobs.set(b, blobs.get(a)!); // the ciphertext is bound to wallet a
    await expect(vault.agentKey({ id: 2, wallet: b })).rejects.toThrow();
    expect(() => new EncryptedKeyVault("short")).toThrow(/MASTER_KEY/);
  });
});
