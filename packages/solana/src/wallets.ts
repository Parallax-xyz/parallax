// Agent wallets on Solana. Every agent gets its own wallet made by the backend; the owner funds it (USDC to trade,
// a little SOL for fees). The key is stored encrypted (the runner's EncryptedKeyVault, AES-256-GCM, bound to the
// wallet address) and decrypted only for the duration of a call.
//
// Safety rule of this module: the only transfers it can build go to the agent's OWNER (the wallet that created the
// agent). There is no function that sends an agent's funds anywhere else; swaps go through Jupiter in swap.ts.
import {
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
  type TransactionSignature,
} from "@solana/web3.js";
import { type Hex, pubkeyOf, toHexAddress } from "./address.js";
import { LAMPORTS_PER_SOL, WSOL_MINT } from "./config.js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export function newAgentWallet(): { address: string; addressHex: Hex; secretHex: string } {
  const kp = Keypair.generate();
  return { address: kp.publicKey.toBase58(), addressHex: toHexAddress(kp.publicKey.toBase58()), secretHex: Buffer.from(kp.secretKey).toString("hex") };
}

export function keypairFromSecret(secretHex: string): Keypair {
  const hex = secretHex.startsWith("0x") ? secretHex.slice(2) : secretHex;
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) throw new Error("agent wallet secret must be 64 bytes of hex");
  return Keypair.fromSecretKey(Buffer.from(hex, "hex"));
}

export interface TokenHolding {
  mint: string;
  /** Base units. */
  amount: bigint;
  decimals: number;
  tokenAccount: string;
  program: string;
}

export interface WalletBalances {
  lamports: number;
  tokens: TokenHolding[];
}

/** SOL and every SPL token (classic and Token-2022, which tokenized stocks use) of a wallet. */
export async function walletBalances(connection: Connection, owner: string): Promise<WalletBalances> {
  const pk = pubkeyOf(owner);
  const [lamports, classic, t22] = await Promise.all([
    connection.getBalance(pk, "confirmed"),
    connection.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM }, "confirmed"),
    connection.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_2022_PROGRAM }, "confirmed"),
  ]);
  const tokens: TokenHolding[] = [];
  for (const [list, program] of [
    [classic.value, TOKEN_PROGRAM],
    [t22.value, TOKEN_2022_PROGRAM],
  ] as const) {
    for (const a of list) {
      const info = (a.account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info;
      if (!info?.mint || !info.tokenAmount?.amount) continue;
      tokens.push({
        mint: info.mint,
        amount: BigInt(info.tokenAmount.amount),
        decimals: Number(info.tokenAmount.decimals ?? 0),
        tokenAccount: a.pubkey.toBase58(),
        program: program.toBase58(),
      });
    }
  }
  return { lamports, tokens };
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

/** CreateIdempotent of an associated token account (no-op when it exists). */
function createAtaIdempotent(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey, program: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** SPL TransferChecked (12): amount u64 LE, decimals u8. */
function transferChecked(src: PublicKey, mint: PublicKey, dst: PublicKey, authority: PublicKey, amount: bigint, decimals: number, program: PublicKey) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: src, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dst, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** CloseAccount (9): returns the token account's rent to the owner. */
function closeAccount(account: PublicKey, dest: PublicKey, owner: PublicKey, program: PublicKey) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

export interface WithdrawPlan {
  /** Token transfers to the owner, base units. */
  tokens: { mint: string; amount: bigint }[];
  /** SOL sent to the owner (everything that is left after the fee), lamports. */
  lamports: number;
}

/**
 * Sends EVERYTHING in the agent wallet back to its owner: every token (the owner's token accounts are created when
 * missing, paid by the agent wallet), closes the emptied token accounts (their rent comes back) and finally sweeps
 * the SOL. Only ever to `owner`. Several transactions when there are many tokens.
 */
export async function withdrawAllToOwner(
  connection: Connection,
  agent: Keypair,
  ownerAddr: string,
): Promise<{ signatures: TransactionSignature[]; plan: WithdrawPlan }> {
  const owner = pubkeyOf(ownerAddr);
  const bal = await walletBalances(connection, agent.publicKey.toBase58());
  const sigs: TransactionSignature[] = [];
  const plan: WithdrawPlan = { tokens: [], lamports: 0 };
  const holdings = bal.tokens;
  for (let i = 0; i < holdings.length; i += 4) {
    const tx = new Transaction();
    for (const h of holdings.slice(i, i + 4)) {
      const program = new PublicKey(h.program);
      const mint = new PublicKey(h.mint);
      const src = new PublicKey(h.tokenAccount);
      if (h.amount > 0n && h.mint !== WSOL_MINT) {
        const dst = associatedTokenAddress(owner, mint, program);
        tx.add(createAtaIdempotent(agent.publicKey, dst, owner, mint, program));
        tx.add(transferChecked(src, mint, dst, agent.publicKey, h.amount, h.decimals, program));
        plan.tokens.push({ mint: h.mint, amount: h.amount });
      }
      // wrapped SOL: closing the account unwraps it into the agent wallet (swept below with the rest)
      tx.add(closeAccount(src, agent.publicKey, agent.publicKey, program));
    }
    sigs.push(await sendAndConfirmTransaction(connection, tx, [agent], { commitment: "confirmed" }));
  }
  const lamports = await connection.getBalance(agent.publicKey, "confirmed");
  const fee = 5000;
  if (lamports > fee) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: owner, lamports: lamports - fee }));
    sigs.push(await sendAndConfirmTransaction(connection, tx, [agent], { commitment: "confirmed" }));
    plan.lamports = lamports - fee;
  }
  return { signatures: sigs, plan };
}

export const solOf = (lamports: number) => lamports / LAMPORTS_PER_SOL;
