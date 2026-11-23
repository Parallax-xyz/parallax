// One swap from an agent wallet: Jupiter /build → our v0 transaction (compute limit from a simulation, Jupiter's
// priority fee capped, a Jito tip) → signed by the agent key → sent through Jito and the RPC at once → confirmed →
// the real amounts read back from the transaction's balance changes.
//
// The worst price of the order is enforced before anything is signed: the route's minimum output
// (otherAmountThreshold, i.e. after slippage) must still be at or better than the order's limit price.
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { JitoClient } from "./jito.js";
import type { JupBuild, JupInstruction, JupiterClient } from "./jupiter.js";

const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
/** Highest compute unit price we accept from Jupiter's estimate, micro-lamports (≈0.001 SOL at 500k CU). */
export const MAX_CU_PRICE = 2_000_000;
const MAX_CU = 1_400_000;

export interface SwapRequest {
  inputMint: string;
  outputMint: string;
  /** Exact input in base units. */
  amountIn: bigint;
  /** Smallest acceptable output in base units (the order's worst price). 0 = only the slippage cap applies. */
  minOut: bigint;
  slippageBps: number;
}

export interface SwapResult {
  status: "filled" | "error" | "unknown";
  signature?: string;
  /** Actual amounts moved, base units (read from the confirmed transaction). */
  inAmount?: bigint;
  outAmount?: bigint;
  /** Network fee + tip, lamports. */
  costLamports?: number;
  error?: string;
}

export interface SwapDeps {
  connection: Connection;
  jupiter: JupiterClient;
  jito: JitoClient;
  tip: { min: number; max: number };
  confirmTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const toIx = (i: JupInstruction) =>
  new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(i.data, "base64"),
  });

/** Jupiter's compute budget instructions without the unit limit (we set our own), with the unit price capped. */
export function budgetInstructions(list: JupInstruction[] = []): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  for (const i of list) {
    if (i.programId !== COMPUTE_BUDGET) continue;
    const data = Buffer.from(i.data, "base64");
    if (data[0] === 2) continue; // SetComputeUnitLimit
    if (data[0] === 3 && data.length >= 9) {
      const price = data.readBigUInt64LE(1);
      out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price > BigInt(MAX_CU_PRICE) ? MAX_CU_PRICE : Number(price) }));
      continue;
    }
    out.push(toIx(i));
  }
  return out;
}

export function lookupTables(map: Record<string, string[]> = {}): AddressLookupTableAccount[] {
  return Object.entries(map).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt("18446744073709551615"),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: addresses.map((a) => new PublicKey(a)),
        },
      }),
  );
}

function blockhashOf(b: JupBuild): { blockhash: string; lastValidBlockHeight: number } | null {
  const m = b.blockhashWithMetadata;
  if (!m) return null;
  const blockhash = Array.isArray(m.blockhash) ? bs58.encode(Uint8Array.from(m.blockhash)) : String(m.blockhash);
  return blockhash ? { blockhash, lastValidBlockHeight: Number(m.lastValidBlockHeight) } : null;
}

/** Whether the route's worst case (minimum output after slippage) still honours the order's minimum output. */
export function routeHonoursLimit(build: Pick<JupBuild, "otherAmountThreshold" | "outAmount">, minOut: bigint): boolean {
  if (minOut <= 0n) return true;
  return BigInt(build.otherAmountThreshold || build.outAmount) >= minOut;
}

/** Slippage that keeps the worst case at the limit: (quoted out − min out) / quoted out, capped by `cap`. */
export function slippageForLimit(quotedOut: bigint, minOut: bigint, cap: number): number {
  if (minOut <= 0n) return cap;
  if (quotedOut <= minOut) return 0;
  const bps = Number(((quotedOut - minOut) * 10_000n) / quotedOut);
  return Math.max(0, Math.min(cap, bps));
}

export async function executeSwap(d: SwapDeps, signer: Keypair, req: SwapRequest): Promise<SwapResult> {
  const taker = signer.publicKey.toBase58();
  let build = await d.jupiter.build({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amountIn, taker, slippageBps: req.slippageBps });
  if (BigInt(build.outAmount) < req.minOut) return { status: "error", error: `price moved past the limit: quote ${build.outAmount} < minimum ${req.minOut}` };
  if (!routeHonoursLimit(build, req.minOut)) {
    const slip = slippageForLimit(BigInt(build.outAmount), req.minOut, req.slippageBps);
    if (slip < 1) return { status: "error", error: "no room for slippage at the limit price" };
    build = await d.jupiter.build({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amountIn, taker, slippageBps: slip });
    if (!routeHonoursLimit(build, req.minOut)) return { status: "error", error: "the route's worst case is past the limit price" };
  }

  const tipAccount = new PublicKey(await d.jito.randomTipAccount());
  const tip = await d.jito.tipLamports(d.tip.min, d.tip.max);
  const body: TransactionInstruction[] = [
    ...(build.setupInstructions ?? []).map(toIx),
    toIx(build.swapInstruction),
    ...(build.cleanupInstruction ? [toIx(build.cleanupInstruction)] : []),
    ...(build.otherInstructions ?? []).filter((i) => i.programId !== COMPUTE_BUDGET).map(toIx),
    SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: tipAccount, lamports: tip }),
  ];
  const budget = budgetInstructions([...(build.computeBudgetInstructions ?? []), ...(build.otherInstructions ?? [])]);
  const alts = lookupTables(build.addressesByLookupTableAddress);
  let bh = blockhashOf(build);
  if (!bh) bh = await d.connection.getLatestBlockhash("confirmed");

  const compile = (units: number) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...budget, ...body],
      }).compileToV0Message(alts),
    );

  // compute units: simulate with the maximum, then 1.2x of what it used
  let units = MAX_CU;
  const sim = await d.connection.simulateTransaction(compile(MAX_CU), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  if (sim.value.err)
    return { status: "error", error: `simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`.slice(0, 500) };
  if (sim.value.unitsConsumed) units = Math.min(MAX_CU, Math.ceil(sim.value.unitsConsumed * 1.2) + 1000);

  const tx = compile(units);
  tx.sign([signer]);
  const raw = Buffer.from(tx.serialize());
  const signature = bs58.encode(tx.signatures[0]!);
  const b64 = raw.toString("base64");
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const broadcast = async () => {
    await Promise.allSettled([d.jito.sendTransaction(b64), d.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })]);
  };
  await broadcast();
  const deadline = Date.now() + d.confirmTimeoutMs;
  let landed: { err: unknown } | null = null;
  let lastSend = Date.now();
  while (Date.now() < deadline) {
    await sleep(1500);
    const st = (await d.connection.getSignatureStatuses([signature])).value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      landed = { err: st.err };
      break;
    }
    const height = await d.connection.getBlockHeight("confirmed").catch(() => 0);
    if (height > bh.lastValidBlockHeight) break; // expired: it can no longer land
    if (Date.now() - lastSend > 3000) {
      lastSend = Date.now();
      await broadcast();
    }
  }
  if (!landed) {
    // one last look: a late confirmation must not be reported as "not filled"
    const st = (await d.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (st?.confirmationStatus) landed = { err: st.err };
  }
  if (!landed) return { status: "unknown", signature, error: "not confirmed before the blockhash expired" };
  if (landed.err) return { status: "error", signature, error: `transaction failed: ${JSON.stringify(landed.err)}` };
  const amounts = await readAmounts(d.connection, signature, taker, req.inputMint, req.outputMint, tip);
  return { status: "filled", signature, ...amounts };
}

const WSOL = "So11111111111111111111111111111111111111112";

/** Amounts the owner actually sent and received in a confirmed swap, from the transaction's balance changes. */
export async function readAmounts(
  connection: Connection,
  signature: string,
  owner: string,
  inputMint: string,
  outputMint: string,
  tipLamports = 0,
): Promise<{ inAmount?: bigint; outAmount?: bigint; costLamports?: number }> {
  let tx = null;
  for (let i = 0; i < 5 && !tx; i++) {
    tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if (!tx) await new Promise((r) => setTimeout(r, 800));
  }
  if (!tx?.meta) return {};
  const meta = tx.meta;
  const delta = (mint: string): bigint => {
    const sum = (list: typeof meta.preTokenBalances) =>
      (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    return sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
  };
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses });
  const idx = keys.staticAccountKeys.findIndex((k) => k.toBase58() === owner);
  const lamportDelta = idx >= 0 ? BigInt(meta.postBalances[idx]! - meta.preBalances[idx]!) : 0n;
  const fee = BigInt(meta.fee);
  // the native SOL leg excludes the costs of the swap itself (network fee and Jito tip, reported separately)
  const nativeDelta = lamportDelta + fee + BigInt(tipLamports);
  const legOf = (mint: string) => (mint === WSOL ? nativeDelta + delta(WSOL) : delta(mint));
  const inLeg = legOf(inputMint);
  const outLeg = legOf(outputMint);
  return {
    inAmount: inLeg < 0n ? -inLeg : 0n,
    outAmount: outLeg > 0n ? outLeg : 0n,
    costLamports: Number(fee) + tipLamports,
  };
}
