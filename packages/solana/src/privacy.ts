// Private mode (Solana Privacy Rings by Helius): the agent wallet deposits USDC straight into its owner's private
// balance. Only the owner's shielded address is needed here (public data); the owner's keys never reach the runner.
// The SDK (@heliuslabs/spr, alpha, pinned) builds Solana v1 transactions only; the agent wallet signs and pays them.
// Loaded lazily, so a process with Private mode off never imports the SDK.
import { type Keypair, PublicKey } from "@solana/web3.js";
import { USDC_MINT } from "./config.js";
import { associatedTokenAddress, TOKEN_PROGRAM } from "./wallets.js";

export type PrivacyNetwork = "devnet" | "mainnet";

export interface PrivacyConfig {
  /** Off unless PRIVATE_MODE=on: the whole feature hides behind this flag. */
  enabled: boolean;
  network: PrivacyNetwork;
  heliusApiKey: string | null;
  indexerUrl: string;
  proverUrl: string;
  /** Profit is swept once at least this much USDC has built up. */
  minSweepUsdc: number;
  /** The whole transaction's priority fee, in lamports. */
  priorityFeeLamports: number;
}

const DEFAULT_URLS: Record<PrivacyNetwork, { indexer: string; prover: string }> = {
  // devnet: the Helius indexer (/v1/spr) and the prover from the SDK's README; mainnet: Helius /v1/spr for both
  devnet: { indexer: "https://devnet.helius-rpc.com/v1/spr", prover: "https://dd73hh473h6ha.cloudfront.net" },
  mainnet: { indexer: "https://mainnet.helius-rpc.com/v1/spr", prover: "https://mainnet.helius-rpc.com/v1/spr" },
};

/** Reads PRIVATE_MODE, SPR_NETWORK, SPR_INDEXER_URL, SPR_PROVER_URL, PRIVATE_MIN_SWEEP_USDC; the key from HELIUS_API_KEY or the RPC URL. */
export function loadPrivacyConfig(env: NodeJS.ProcessEnv = process.env): PrivacyConfig {
  const network: PrivacyNetwork = env.SPR_NETWORK?.trim() === "mainnet" ? "mainnet" : "devnet";
  let key = env.HELIUS_API_KEY?.trim() || null;
  if (!key && env.SOLANA_RPC_URL) {
    try {
      key = new URL(env.SOLANA_RPC_URL).searchParams.get("api-key");
    } catch {}
  }
  const min = Number(env.PRIVATE_MIN_SWEEP_USDC ?? 5);
  return {
    enabled: env.PRIVATE_MODE?.trim() === "on",
    network,
    heliusApiKey: key,
    indexerUrl: env.SPR_INDEXER_URL?.trim() || DEFAULT_URLS[network].indexer,
    proverUrl: env.SPR_PROVER_URL?.trim() || DEFAULT_URLS[network].prover,
    minSweepUsdc: Number.isFinite(min) && min > 0 ? min : 5,
    priorityFeeLamports: Number(env.PRIVATE_PRIORITY_FEE_LAMPORTS ?? 5000) || 5000,
  };
}

/** The devnet USDC mint (Circle's) and the mainnet one. */
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const usdcMintFor = (n: PrivacyNetwork) => (n === "mainnet" ? USDC_MINT : USDC_MINT_DEVNET);

/** Checks the bytes of a shielded address (signing || nullifier || viewing) and returns them as lowercase hex. */
export async function parseShieldedAddress(hex: string): Promise<string> {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(clean) || clean.length < 64 || clean.length > 512) throw new Error("not a shielded address");
  const { ShieldedAddress, initializePoseidon } = await import("@heliuslabs/spr");
  await initializePoseidon();
  ShieldedAddress.fromBytes(Uint8Array.from(Buffer.from(clean, "hex"))); // throws on a malformed address
  return clean;
}

/** Adds ?api-key= to a URL that has none (the SDK's prover client takes its key only from the URL). */
export function withApiKey(url: string, key: string): string {
  const u = new URL(url);
  if (!u.searchParams.has("api-key")) u.searchParams.set("api-key", key);
  return u.toString();
}

export class PrivacyClient {
  private client: Promise<import("@heliuslabs/spr/client").SprClient> | null = null;
  constructor(
    readonly cfg: PrivacyConfig,
    private readonly solanaRpcUrl: string,
  ) {}

  private rpcUrl(): string {
    if (this.cfg.network === "mainnet") return this.solanaRpcUrl;
    return `https://devnet.helius-rpc.com/?api-key=${this.cfg.heliusApiKey ?? ""}`;
  }

  private sdk() {
    this.client ??= (async () => {
      if (!this.cfg.heliusApiKey) throw new Error("Private mode needs a Helius API key");
      await (await import("@heliuslabs/spr")).initializePoseidon(); // the hasher (wasm) loads once, before any address is used
      const { SprClient, SignedTeePolicy } = await import("@heliuslabs/spr/client");
      const rpc = this.rpcUrl();
      return new SprClient({
        solanaRpcUrl: rpc,
        solanaRpcSubscriptionsUrl: rpc.replace(/^http/, "ws"),
        indexerUrl: this.cfg.indexerUrl,
        proverUrl: withApiKey(this.cfg.proverUrl, this.cfg.heliusApiKey), // the prover reads its key only from its URL
        apiKey: this.cfg.heliusApiKey,
        proverTee: SignedTeePolicy.forNetwork(this.cfg.network),
        priorityFeeLamports: BigInt(this.cfg.priorityFeeLamports),
      });
    })();
    return this.client;
  }

  /**
   * Deposits `amountUsdc` from the agent wallet into the owner's private balance. The agent wallet pays the fee and
   * signs; returns the transaction signature once confirmed.
   */
  async depositUsdc(agent: Keypair, ownerShieldedHex: string, amountUsdc: number): Promise<string> {
    const client = await this.sdk();
    const spr = await import("@heliuslabs/spr");
    const kit = await import("@solana/kit");
    const signer = await kit.createKeyPairSignerFromPrivateKeyBytes(agent.secretKey.slice(0, 32));
    if (signer.address !== agent.publicKey.toBase58()) throw new Error("the agent key does not match its wallet");
    const mint = usdcMintFor(this.cfg.network);
    const recipient = spr.ShieldedAddress.fromBytes(Uint8Array.from(Buffer.from(ownerShieldedHex, "hex")));
    const amount = BigInt(Math.floor(amountUsdc * 1e6));
    if (amount <= 0n) throw new Error("nothing to deposit");
    const tx = await spr.buildDepositTransaction({
      client,
      feePayer: signer.address,
      recipient,
      asset: kit.address(mint),
      splTokenAccount: kit.address(associatedTokenAddress(agent.publicKey, new PublicKey(mint), TOKEN_PROGRAM).toBase58()),
      amount,
    });
    const signed = await kit.signTransactionWithSigners([signer], tx);
    const send = kit.sendAndConfirmTransactionFactory({ rpc: client.solanaRpc, rpcSubscriptions: client.solanaRpcSubscriptions });
    await send(signed as Parameters<typeof send>[0], { commitment: "confirmed" });
    return kit.getSignatureFromTransaction(signed);
  }
}
