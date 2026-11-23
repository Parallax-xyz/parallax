// The owner's private balance in the browser (Solana Privacy Rings by Helius, SDK @heliuslabs/spr, pinned alpha).
//
// One wallet signature of "Parallax private balance v1" gives two keys, both made and kept only in this tab:
//   - the private balance key: sha256(signature) → the shielded keypair, and the Solana signer that owns the balance;
//   - the deposit wallet: sha256("parallax-deposit-wallet-v1" || signature) → an ordinary Solana wallet. The owner tops
//     it up from their main wallet with a normal transfer (common wallets cannot sign the SDK's v1 transactions); it
//     signs the private deposits and pays the fees of private withdrawals.
// The SDK's HTTP calls can go straight to Helius or through a relay of your backend that adds the API key (relayFetch,
// relayEndpoints): the relay then sees encrypted prover requests and indexer queries, never a key or a signature.
//
// Assets: USDC and SOL (the SDK's SOL_MINT). Amounts in base units (USDC 6 decimals, SOL lamports).
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { depositSeedFromSignature, seedFromSignature } from "./private-balance.js";

export type PrivateNetwork = "mainnet" | "devnet";
export type PrivateAsset = "USDC" | "SOL";

const USDC: Record<PrivateNetwork, string> = {
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};
const SOL_MINT = "11111111111111111111111111111111";
export const usdcMintOf = (n: PrivateNetwork) => USDC[n];

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** The associated token account of an owner for a mint (classic token program). */
const ata = (owner: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/** Where the SDK talks to: Solana JSON-RPC, the SPR indexer and the SPR prover (direct, or a relay of your backend). */
export interface PrivateEndpoints {
  rpcUrl: string;
  indexerUrl: string;
  proverUrl: string;
  /** fetch for the SDK's HTTP calls (e.g. relayFetch). Default: the global fetch. */
  fetch?: typeof fetch;
}

/** Endpoints of a relay mounted at `relayBase` (e.g. https://api.example.com/v1/spr): /rpc, /indexer, /prover. */
export function relayEndpoints(relayBase: string, token: () => string | null): PrivateEndpoints {
  const base = relayBase.replace(/\/+$/, "");
  return { rpcUrl: `${base}/rpc`, indexerUrl: `${base}/indexer`, proverUrl: `${base}/prover`, fetch: relayFetch(base, token) };
}

/** Helius' CDN that serves the prover's signed TEE policy (no CORS there, so it is fetched through the relay). */
const TEE_POLICY_HOST = "d3gbdb0egjwcw9.cloudfront.net";

/**
 * fetch for the SDK behind a relay at `relayBase`: requests under it carry the session token; the prover's signed
 * policy (safe to relay: it is signed) is fetched through it too. Anything else goes out untouched.
 */
export function relayFetch(relayBase: string, token: () => string | null): typeof fetch {
  const base = new URL(relayBase.replace(/\/+$/, ""));
  const prefix = `${base.pathname.replace(/\/+$/, "")}/`;
  return (input, init) => {
    let url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const policy = url.hostname === TEE_POLICY_HOST && /^\/tee-policy\/(mainnet|devnet)\.json$/.test(url.pathname);
    if (policy) url = new URL(`${base.href.replace(/\/+$/, "")}/tee-policy/${url.pathname.split("/").pop()}`);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return globalThis.fetch(input, init);
    const headers = new Headers(init?.headers);
    const t = token();
    if (t) headers.set("authorization", `Bearer ${t}`);
    return globalThis.fetch(url, { ...init, headers }).then(async (res) => {
      // the SDK keeps only an error code; the relay's own answer says what happened (off, limit, session)
      if (!res.ok && res.status !== 400) {
        const body = (await res
          .clone()
          .json()
          .catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        lastFailure = { status: res.status, code: body?.error?.code ?? null, message: body?.error?.message ?? null, at: Date.now() };
      }
      return res;
    });
  };
}

let lastFailure: { status: number; code: string | null; message: string | null; at: number } | null = null;
/** The relay's last failed answer in the past 30 s (for plain-words errors), or null. */
export const lastRelayFailure = () => (lastFailure && Date.now() - lastFailure.at < 30_000 ? lastFailure : null);
export interface Balances {
  /** The private balance. */
  privateUsdc: bigint;
  privateSol: bigint;
  /** The deposit wallet (public). */
  depositUsdc: bigint;
  depositSol: bigint;
}

/** One unlocked private balance: lives in memory until lock() or the tab closes. */
export class PrivateBalance {
  private constructor(
    readonly network: PrivateNetwork,
    readonly shieldedHex: string,
    readonly depositAddress: string,
    private readonly sdk: typeof import("@heliuslabs/spr"),
    private readonly kit: typeof import("@solana/kit"),
    private readonly client: import("@heliuslabs/spr/client").SprClient,
    private readonly kp: import("@heliuslabs/spr").ShieldedKeypair,
    private readonly ownerSigner: import("@solana/kit").KeyPairSigner,
    private readonly depositSigner: import("@solana/kit").KeyPairSigner,
    private readonly depositKeypair: Keypair,
  ) {}

  static async open(signature: Uint8Array, network: PrivateNetwork, endpoints: PrivateEndpoints): Promise<PrivateBalance> {
    const seed = await seedFromSignature(signature);
    const dseed = await depositSeedFromSignature(signature);
    const sdk = await import("@heliuslabs/spr");
    const { SprClient, SignedTeePolicy } = await import("@heliuslabs/spr/client");
    const kit = await import("@solana/kit");
    await sdk.initializePoseidon();
    const kp = sdk.ShieldedKeypair.fromKeypair(sdk.SigningKey.fromEd25519Bytes(seed as never));
    const ownerSigner = await kit.createKeyPairSignerFromPrivateKeyBytes(seed);
    const depositSigner = await kit.createKeyPairSignerFromPrivateKeyBytes(dseed);
    const depositKeypair = Keypair.fromSeed(dseed);
    seed.fill(0);
    dseed.fill(0);
    const client = new SprClient({
      solanaRpcUrl: endpoints.rpcUrl,
      indexerUrl: endpoints.indexerUrl,
      proverUrl: endpoints.proverUrl,
      proverTee: SignedTeePolicy.forNetwork(network),
      priorityFeeLamports: 10_000n,
      ...(endpoints.fetch ? { fetch: endpoints.fetch } : {}),
    });
    const hex = Array.from(kp.shieldedAddress().toBytes(), (x) => x.toString(16).padStart(2, "0")).join("");
    return new PrivateBalance(network, hex, depositSigner.address, sdk, kit, client, kp, ownerSigner, depositSigner, depositKeypair);
  }

  private mint(asset: PrivateAsset) {
    return this.kit.address(asset === "USDC" ? USDC[this.network] : SOL_MINT);
  }

  private async wallet(slot?: bigint) {
    const w = new this.sdk.Wallet({ identity: this.kp.shieldedAddress() });
    const keys = this.sdk.LocalKeys.fromKeypair(this.kp, this.client.proofService);
    await this.sdk.syncWallet({ client: this.client, wallet: w, keys, ...(slot ? { config: { requireSlot: slot } } : {}) });
    return { w, keys };
  }

  /** The private balance (read through the indexer, decrypted here) and the deposit wallet's public balances. */
  async balances(): Promise<Balances> {
    const { w } = await this.wallet();
    const rpc = this.client.solanaRpc;
    const depositSol = (await rpc.getBalance(this.kit.address(this.depositAddress)).send()).value;
    const usdcAta = ata(new PublicKey(this.depositAddress), new PublicKey(USDC[this.network])).toBase58();
    const depositUsdc = await rpc
      .getTokenAccountBalance(this.kit.address(usdcAta))
      .send()
      .then((r) => BigInt(r.value.amount))
      .catch(() => 0n); // no USDC account yet
    return { privateUsdc: this.held(w, "USDC"), privateSol: this.held(w, "SOL"), depositUsdc, depositSol };
  }

  /**
   * What the private balance holds of one asset. The SDK learns a mint only from the wallet's own history, so a fresh
   * balance (nothing deposited yet) answers TRANSACTION_UNKNOWN_MINT: that is an empty balance, not an error.
   */
  private held(w: { balance(mint: never): { amount: bigint } }, asset: PrivateAsset): bigint {
    try {
      return w.balance(this.mint(asset) as never).amount;
    } catch (e) {
      if ((e as { code?: string })?.code === "TRANSACTION_UNKNOWN_MINT") return 0n;
      throw e;
    }
  }

  private async sendKit(tx: Parameters<typeof import("@solana/kit")["signTransactionWithSigners"]>[1], signers: import("@solana/kit").KeyPairSigner[]) {
    const signed = await this.kit.signTransactionWithSigners(signers, tx);
    const wire = this.kit.getBase64EncodedWireTransaction(signed as never);
    await this.client.solanaRpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
    const sig = this.kit.getSignatureFromTransaction(signed as never);
    await this.client.confirmTransaction(sig);
    return String(sig);
  }

  /** Deposit wallet → private balance (the deposit wallet signs and pays the fee). */
  async deposit(asset: PrivateAsset, amount: bigint): Promise<string> {
    if (amount <= 0n) throw new Error("Nothing to deposit.");
    const tx = await this.sdk.buildDepositTransaction({
      client: this.client,
      feePayer: this.depositSigner.address,
      recipient: this.kp.shieldedAddress(),
      asset: this.mint(asset),
      amount,
      ...(asset === "USDC" ? { splTokenAccount: this.kit.address(ata(new PublicKey(this.depositAddress), new PublicKey(USDC[this.network])).toBase58()) } : {}),
    });
    return this.sendKit(tx as never, [this.depositSigner]);
  }

  /** Private balance → any wallet (the owner's, or an agent wallet). The owner key signs; the deposit wallet pays the fee. */
  async withdraw(asset: PrivateAsset, amount: bigint, recipient: string): Promise<string> {
    if (amount <= 0n) throw new Error("Nothing to withdraw.");
    const { w, keys } = await this.wallet();
    const have = this.held(w, asset);
    if (have < amount) throw new Error(`The private balance holds less than that (${fmt(asset, have)}).`);
    const tx = await this.sdk.buildWithdrawalTransaction({
      client: this.client,
      wallet: w,
      keys,
      feePayer: this.depositSigner.address,
      recipient: this.kit.address(recipient),
      asset: this.mint(asset),
      amount,
    });
    return this.sendKit(tx as never, [this.depositSigner, this.ownerSigner]);
  }

  /** Everything left in the deposit wallet back to the owner's wallet (USDC, its account's rent, the SOL). */
  async sweepBack(owner: string): Promise<string | null> {
    const b = await this.balances();
    const rpc = this.client.solanaRpc;
    const from = this.depositKeypair.publicKey;
    const to = new PublicKey(owner);
    const mint = new PublicKey(USDC[this.network]);
    const src = ata(from, mint);
    const tx = new Transaction();
    const hasUsdcAccount = await rpc
      .getAccountInfo(this.kit.address(src.toBase58()), { encoding: "base64" })
      .send()
      .then((r) => !!r.value)
      .catch(() => false);
    if (b.depositUsdc > 0n) {
      const dst = ata(to, mint);
      tx.add(
        new TransactionInstruction({
          programId: ATA_PROGRAM,
          keys: [
            { pubkey: from, isSigner: true, isWritable: true },
            { pubkey: dst, isSigner: false, isWritable: true },
            { pubkey: to, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([1]), // CreateIdempotent
        }),
        new TransactionInstruction({
          programId: TOKEN_PROGRAM,
          keys: [
            { pubkey: src, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: dst, isSigner: false, isWritable: true },
            { pubkey: from, isSigner: true, isWritable: false },
          ],
          data: Buffer.concat([Buffer.from([12]), u64(b.depositUsdc), Buffer.from([6])]), // TransferChecked
        }),
      );
    }
    // close the emptied USDC account: its rent goes to the owner too
    if (hasUsdcAccount)
      tx.add(
        new TransactionInstruction({
          programId: TOKEN_PROGRAM,
          keys: [
            { pubkey: src, isSigner: false, isWritable: true },
            { pubkey: to, isSigner: false, isWritable: true },
            { pubkey: from, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([9]), // CloseAccount
        }),
      );
    // the SOL minus this transaction's fee (and the owner's USDC account rent, if it has to be made)
    const reserve = 5_000n + (b.depositUsdc > 0n ? 2_100_000n : 0n);
    if (b.depositSol > reserve) tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: b.depositSol - reserve }));
    if (tx.instructions.length === 0) return null;
    const bh = (await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = from;
    tx.sign(this.depositKeypair);
    const wire = Buffer.from(tx.serialize()).toString("base64");
    const sig = await rpc.sendTransaction(wire as never, { encoding: "base64", preflightCommitment: "confirmed" }).send();
    await this.client.confirmTransaction(sig);
    return String(sig);
  }
}

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
};

/** "12.5 USDC" / "0.03 SOL" from base units. */
export function fmt(asset: PrivateAsset, units: bigint): string {
  const d = asset === "USDC" ? 6 : 9;
  const n = Number(units) / 10 ** d;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: asset === "USDC" ? 2 : 4 })} ${asset}`;
}
export const toUnits = (asset: PrivateAsset, v: number) => BigInt(Math.round(v * 10 ** (asset === "USDC" ? 6 : 9)));

// ---------- timing: a deposit and a withdrawal of the same amount moments apart can be matched by anyone ----------

const LAST_DEPOSIT = "px_priv_last_deposit";
export const MATCH_WINDOW_SEC = 6 * 3600;
export function rememberDeposit(asset: PrivateAsset, amount: bigint) {
  try {
    localStorage.setItem(LAST_DEPOSIT, JSON.stringify({ asset, amount: amount.toString(), at: Math.floor(Date.now() / 1000) }));
  } catch {}
}
/**
 * Why withdrawing this now could be linked to a recent deposit (null: no reason): within MATCH_WINDOW_SEC of a deposit,
 * or the same amount within 2%.
 */
export function timingRisk(asset: PrivateAsset, amount: bigint, now = Math.floor(Date.now() / 1000)): string | null {
  let last: { asset: PrivateAsset; amount: string; at: number } | null = null;
  try {
    last = JSON.parse(localStorage.getItem(LAST_DEPOSIT) ?? "null");
  } catch {}
  if (!last || last.asset !== asset) return null;
  const ago = now - last.at;
  if (ago > MATCH_WINDOW_SEC) return null;
  const prev = BigInt(last.amount);
  const close = prev > 0n && amount * 100n >= prev * 98n && amount * 100n <= prev * 102n;
  const mins = Math.max(1, Math.round(ago / 60));
  return close
    ? `You deposited this same amount ${mins} min ago: anyone can match the deposit and this withdrawal by amount and time.`
    : `You deposited ${fmt(asset, prev)} ${mins} min ago: withdrawing soon after makes the two easier to match by time.`;
}
/** A suggested amount: a round figure (multiples of 5 USDC / 0.01 SOL) below what the balance holds. */
export function roundSuggestion(asset: PrivateAsset, have: bigint): bigint {
  const step = asset === "USDC" ? 5_000_000n : 10_000_000n;
  return (have / step) * step;
}

// ---------- the unlocked balance of this tab ----------

let current: PrivateBalance | null = null;
let currentKey = "";
/** The tab's unlocked private balance, or opens it with one wallet signature (`sign`). */
export async function unlockPrivateBalance(
  account: string,
  network: PrivateNetwork,
  sign: () => Promise<Uint8Array>,
  endpoints: PrivateEndpoints,
): Promise<PrivateBalance> {
  const key = `${account}:${network}`;
  if (current && currentKey === key) return current;
  const sig = await sign();
  try {
    current = await PrivateBalance.open(sig, network, endpoints);
    currentKey = key;
    return current;
  } finally {
    sig.fill(0);
  }
}
export const unlockedPrivateBalance = () => current;
export function lockPrivateBalance() {
  current = null;
  currentKey = "";
}
