// Solana addresses inside Parallax. Stores and records key accounts by a lower-case hex string. A Solana public key is
// 32 bytes, so inside the code it travels as "0x" + 64 hex characters: lower-casing it is safe (base58 is
// case-sensitive, hex is not). Users and explorers see the usual base58 form; the conversion happens only at the edges
// (API input/output, user interfaces, RPC calls).
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export type Hex = `0x${string}`;

/** "0x" + 64 hex = a Solana public key in Parallax's internal form. */
export function isSolanaHex(v: unknown): v is Hex {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
}

/** A valid base58 Solana address (32 bytes once decoded). Program-derived addresses count. */
export function isBase58Address(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return false;
  try {
    return bs58.decode(v).length === 32;
  } catch {
    return false;
  }
}

/** A base58 transaction signature (64 bytes once decoded). */
export function isBase58Signature(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 64 || v.length > 90) return false;
  try {
    return bs58.decode(v).length === 64;
  } catch {
    return false;
  }
}

/** base58 → internal hex form. Throws on anything that is not a 32-byte base58 key. */
export function toHexAddress(base58: string): Hex {
  if (!isBase58Address(base58)) throw new Error(`not a Solana address: ${base58}`);
  return `0x${Buffer.from(bs58.decode(base58)).toString("hex")}` as Hex;
}

/** internal hex form → base58. */
export function toBase58(hex: string): string {
  if (!isSolanaHex(hex)) throw new Error(`not a Solana key in hex form: ${hex}`);
  return bs58.encode(Buffer.from(hex.slice(2), "hex"));
}

/** Either form → internal hex form (lower case). */
export function normSolanaAddress(v: string): Hex {
  if (isSolanaHex(v)) return v.toLowerCase() as Hex;
  return toHexAddress(v);
}

export function pubkeyOf(addr: string): PublicKey {
  return new PublicKey(isSolanaHex(addr) ? Buffer.from(addr.slice(2), "hex") : addr);
}

export const shortSol = (base58: string) => `${base58.slice(0, 4)}…${base58.slice(-4)}`;
