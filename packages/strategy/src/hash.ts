// Fingerprints of a strategy: a short, stable hash of the spec and of the model id. A platform can publish them (for
// example in an agent registry) so anyone can check that an agent runs exactly the strategy it claims.
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { canonicalJson } from "./canonical.js";

const keccakHex = (s: string): `0x${string}` => `0x${bytesToHex(keccak_256(utf8ToBytes(s)))}`;

/** specHash: keccak256 of the canonical JSON of the spec. */
export function specHashOf(spec: unknown): `0x${string}` {
  return keccakHex(canonicalJson(spec));
}

/** modelId: keccak256 of the UTF-8 model id. */
export function modelIdOf(model: string): `0x${string}` {
  return keccakHex(model);
}
