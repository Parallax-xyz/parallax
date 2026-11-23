// The owner's private balance (Solana Privacy Rings by Helius) belongs to a key the browser derives from ONE wallet
// signature:
//
//   seed = sha256(signMessage("Parallax private balance v1"))   (ed25519 signatures are deterministic: same wallet,
//   key  = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed))       same message → same key, any time)
//
// Only the PUBLIC shielded address (signing || nullifier || viewing public keys, hex) leaves the browser: the runner
// deposits the agent's profit to it. The signature, the seed and the key stay in the tab's memory for the moment of the
// derivation and are wiped right after; nothing is stored, logged or sent.
//
// The SDK (@heliuslabs/spr, alpha, pinned) is loaded only here, on demand. Browser-safe: Web Crypto only.

/** The exact message the wallet signs. Changing it would change every owner's private balance key. */
export const PRIVATE_BALANCE_MESSAGE = "Parallax private balance v1";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The 32-byte seed of the private balance key from the wallet's signature of PRIVATE_BALANCE_MESSAGE. */
export async function seedFromSignature(signature: Uint8Array): Promise<Uint8Array> {
  if (signature.length !== 64) throw new Error("expected a 64-byte ed25519 signature");
  return new Uint8Array(await crypto.subtle.digest("SHA-256", signature as Uint8Array<ArrayBuffer>));
}

/**
 * The deposit wallet: a plain Solana wallet the browser derives from the SAME signature, domain-separated:
 * seed = sha256("parallax-deposit-wallet-v1" || signature). Common wallets cannot sign the SDK's v1 transactions, so
 * the owner sends USDC and a little SOL to this wallet with an ordinary transfer, and the browser signs the private
 * deposits (and pays the fees of private withdrawals) with it. Never sent anywhere.
 */
export const DEPOSIT_WALLET_DOMAIN = "parallax-deposit-wallet-v1";
export async function depositSeedFromSignature(signature: Uint8Array): Promise<Uint8Array> {
  if (signature.length !== 64) throw new Error("expected a 64-byte ed25519 signature");
  const domain = new TextEncoder().encode(DEPOSIT_WALLET_DOMAIN);
  const input = new Uint8Array(domain.length + signature.length);
  input.set(domain, 0);
  input.set(signature, domain.length);
  const out = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  input.fill(0);
  return out;
}

/**
 * The owner's shielded address (lowercase hex, as parseShieldedAddress in @parallax/solana takes it) from the wallet's
 * signature. The seed and the signing key are wiped before returning.
 */
export async function shieldedAddressFromSignature(signature: Uint8Array): Promise<string> {
  const seed = await seedFromSignature(signature);
  const { initializePoseidon, ShieldedKeypair, SigningKey } = await import("@heliuslabs/spr/keypair");
  await initializePoseidon();
  const signing = SigningKey.fromEd25519Bytes(seed as Parameters<typeof SigningKey.fromEd25519Bytes>[0]);
  try {
    return hex(ShieldedKeypair.fromKeypair(signing).shieldedAddress().toBytes());
  } finally {
    signing.destroy();
    seed.fill(0);
  }
}
