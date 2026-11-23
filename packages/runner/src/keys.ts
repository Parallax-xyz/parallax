// Agent keys at rest. Every agent has its own wallet; its secret key is stored encrypted with AES-256-GCM and the
// ciphertext is bound to the wallet address (AAD), so a blob cannot be moved to another agent. The master key comes
// from the runner's environment (MASTER_KEY, 32 bytes of hex). A key is decrypted only for the duration of a call.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentKeyRef } from "@parallax/exchange";
import { type AgentRecord, type Hex, lc } from "./types.js";

const VERSION = "v1";

function keyBytes(masterKeyHex: string): Buffer {
  const hex = masterKeyHex.startsWith("0x") ? masterKeyHex.slice(2) : masterKeyHex;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("MASTER_KEY must be 32 bytes of hex");
  return Buffer.from(hex, "hex");
}

/** Format: v1:<iv b64>:<tag b64>:<ciphertext b64>. `aad` binds the ciphertext to a context (the wallet). */
export function encryptSecret(plain: string, masterKeyHex: string, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(masterKeyHex), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(blob: string, masterKeyHex: string, aad?: string): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("unknown ciphertext format");
  const [, ivB, tagB, ctB] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(masterKeyHex), Buffer.from(ivB, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Source of the agent's key used to sign its orders. The key is decrypted only for the duration of a call. */
export interface KeyVault {
  agentKey(agent: Pick<AgentRecord, "id" | "wallet">): Promise<AgentKeyRef>;
}

/**
 * KeyVault over encrypted blobs keyed by the lowercase wallet. The blob map is injectable so it can be backed by any
 * storage; only ciphertext is ever stored.
 */
export class EncryptedKeyVault implements KeyVault {
  constructor(
    private readonly masterKeyHex: string,
    private readonly blobs: Pick<Map<string, string>, "get" | "set"> = new Map(),
  ) {
    keyBytes(masterKeyHex); // validate early
  }

  /** Encrypt and store the secret key of the agent wallet. Returns the ciphertext. */
  put(wallet: Hex, privateKey: string): string {
    const blob = encryptSecret(privateKey, this.masterKeyHex, lc(wallet));
    this.blobs.set(lc(wallet), blob);
    return blob;
  }

  async agentKey(agent: Pick<AgentRecord, "id" | "wallet">): Promise<AgentKeyRef> {
    const blob = this.blobs.get(lc(agent.wallet));
    if (!blob) throw new Error(`no key stored for agent #${agent.id}`);
    return { privateKey: decryptSecret(blob, this.masterKeyHex, lc(agent.wallet)) };
  }
}
