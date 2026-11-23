// The browser derives the owner's private balance key from one wallet signature and shares only the public shielded
// address. It must be (1) deterministic, (2) the shielded keypair of the 32-byte seed sha256(signature), and (3) an
// address parseShieldedAddress accepts — and nothing secret in it.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { initializePoseidon, ShieldedKeypair, SigningKey } from "@heliuslabs/spr";
import { parseShieldedAddress } from "@parallax/solana";
import { describe, expect, it } from "vitest";
import { PRIVATE_BALANCE_MESSAGE, seedFromSignature, shieldedAddressFromSignature } from "../src/private-balance.js";

/** A wallet stand-in: ed25519 signMessage over the UTF-8 bytes of the message (deterministic, RFC 8032). */
const { privateKey } = generateKeyPairSync("ed25519");
const signMessage = (m: string) => new Uint8Array(sign(null, Buffer.from(m, "utf8"), privateKey));

describe("private balance key from a wallet signature", () => {
  it("the same wallet always gives the same shielded address; another message gives another one", async () => {
    const a = await shieldedAddressFromSignature(signMessage(PRIVATE_BALANCE_MESSAGE));
    const b = await shieldedAddressFromSignature(signMessage(PRIVATE_BALANCE_MESSAGE));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(await shieldedAddressFromSignature(signMessage("something else"))).not.toBe(a);
  });

  it("is sha256(signature) as the seed of the shielded keypair", async () => {
    const sig = signMessage(PRIVATE_BALANCE_MESSAGE);
    const seed = createHash("sha256").update(sig).digest();
    expect(Buffer.from(await seedFromSignature(sig)).equals(seed)).toBe(true);
    await initializePoseidon();
    const kp = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(Uint8Array.from(seed) as never));
    expect(await shieldedAddressFromSignature(sig)).toBe(Buffer.from(kp.shieldedAddress().toBytes()).toString("hex"));
  });

  it("parseShieldedAddress accepts the address, and it holds neither the signature nor the seed", async () => {
    const sig = signMessage(PRIVATE_BALANCE_MESSAGE);
    const addr = await shieldedAddressFromSignature(sig);
    expect(await parseShieldedAddress(addr)).toBe(addr);
    expect(addr).not.toContain(Buffer.from(sig).toString("hex").slice(0, 32));
    expect(addr).not.toContain(createHash("sha256").update(sig).digest("hex").slice(0, 32));
  });

  it("refuses anything but a 64-byte signature", async () => {
    await expect(shieldedAddressFromSignature(new Uint8Array(32))).rejects.toThrow(/64-byte/);
  });
});
