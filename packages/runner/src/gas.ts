// Gas (SOL for network fees) of a Solana agent wallet: how much one swap can cost at worst, and what the runner does
// when the wallet runs low. Pure: numbers in lamports (1 SOL = 1e9).
//
// Worst cost of one swap, from packages/solana/src/swap.ts:
//   network fee      5 000          (one signature)
//   priority fee     ≤ 960 000      (compute unit price capped at MAX_CU_PRICE 2 000 000 µlamports × ≤ 480 000 units)
//   Jito tip         ≤ 200 000      (JITO_MAX_TIP_LAMPORTS default)
//   token account    2 039 280      (rent of a new token account: the first buy of a token; sells go to the USDC
//                                    account the wallet already has)
// The wallet itself must keep the rent-exempt minimum of a system account (890 880), or every transaction fails.
//
// Levels: "ok"; "low" below 0.01 SOL (a warning: the owner tops up); "empty" when one more buy could fail (below the
// worst buy plus the account minimum): the agent pauses itself ("low_gas"), no new swaps are attempted, protective
// sells still go out while one worst-case sell fits. It resumes by itself once the wallet is back to 0.01 SOL —
// only when it was paused for gas, never when its owner paused it.

const LAMPORTS_PER_SOL = 1_000_000_000;
/** The asset that pays the fees of an agent's swaps (flows.ts treats its small drops around own trades as costs). */
export const GAS_ASSET = "SOL";
export const ACCOUNT_RENT_MIN = 890_880;
export const SWAP_NETWORK_FEE = 5_000;
export const MAX_PRIORITY_FEE = 960_000;
export const MAX_JITO_TIP = 200_000;
export const TOKEN_ACCOUNT_RENT = 2_039_280;
/** Worst case of a sell (into the USDC account the wallet has). */
export const SELL_WORST_LAMPORTS = SWAP_NETWORK_FEE + MAX_PRIORITY_FEE + MAX_JITO_TIP;
/** Worst case of a buy (a new token account included). */
export const BUY_WORST_LAMPORTS = SELL_WORST_LAMPORTS + TOKEN_ACCOUNT_RENT;
/** A usual swap (fee, a modest priority fee, a floor tip): for "about N trades left" only. */
export const TYPICAL_SWAP_LAMPORTS = 100_000;
/** Below this the owner is warned; at or above it an agent paused for gas resumes. */
export const LOW_GAS_LAMPORTS = 10_000_000;
/** The pause reason of an agent that paused itself for gas. */
export const LOW_GAS_REASON = "low_gas";

export type GasLevel = "ok" | "low" | "empty";

/** Lamports a wallet can spend on fees (its balance above the account's rent-exempt minimum). */
export const spendable = (lamports: number) => Math.max(0, lamports - ACCOUNT_RENT_MIN);

export function gasLevel(lamports: number): GasLevel {
  if (spendable(lamports) < BUY_WORST_LAMPORTS) return "empty";
  if (lamports < LOW_GAS_LAMPORTS) return "low";
  return "ok";
}

/** About how many usual swaps the wallet can still pay for. */
export const tradesLeft = (lamports: number) => Math.floor(spendable(lamports) / TYPICAL_SWAP_LAMPORTS);

/** Whether a swap of this side may be attempted with this much gas (worst case). */
export const canSwap = (side: "buy" | "sell", lamports: number) => spendable(lamports) >= (side === "buy" ? BUY_WORST_LAMPORTS : SELL_WORST_LAMPORTS);

/** What the owner sees: level, SOL, about how many trades. */
export function gasView(lamports: number) {
  return { level: gasLevel(lamports), lamports, sol: lamports / LAMPORTS_PER_SOL, tradesLeft: tradesLeft(lamports) };
}
