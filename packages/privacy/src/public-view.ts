// What PUBLIC views of an agent show (no sign-in: rankings, the public agent page). Privacy is the product's focus:
// public views never reveal amounts, owners, or anything that leads to an agent's wallet. They keep agent names,
// modes, presets, markets, returns in %, trade counts, status, the decision log and each trade's side, market, price
// and time.
//
// Removed here: owners (not even shortened), equity in dollars (start/end/now), trade sizes (USD and base), order ids
// and transaction signatures of trades, wallets, and dollar figures inside decision texts. The owner's own views keep
// everything.
import { type DecisionRow, type PerfPoint, returnBetween, type TradeRow } from "@parallax/runner";

const NUM = String.raw`\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?`;
const AMOUNT_RULES: [RegExp, string][] = [
  // "$12.34", "$ 1,200", "$5k"
  [new RegExp(String.raw`\$\s?${NUM}(?:\s?[kKmM]\b)?`, "g"), "$…"],
  // "12.34 USDC", "0.03 SOL", "2k USD"
  [new RegExp(String.raw`${NUM}(?:\s?[kKmM])?\s?(USDC|USDT|USD|SOL)\b`, "g"), "… $1"],
  // "0.01 BONK ≈ …": a size in base units right before an estimate
  [new RegExp(String.raw`${NUM}(\s+[A-Za-z][\w.]*\s*≈)`, "g"), "…$1"],
  // "≈ 9.88" (not "≈ 5%")
  [new RegExp(String.raw`≈\s?${NUM}(?![\d.]|\s?%)`, "g"), "≈ …"],
  // the risk engine's own wording: "available 5.00", "order size 1.5", "book depth 3", "filling 2", "only 4 available"
  [new RegExp(String.raw`\b(available|order size|book depth|filling)\s+${NUM}(?![\d.]|\s?%)`, "g"), "$1 …"],
  [new RegExp(String.raw`\bonly\s+${NUM}(\s+available)`, "g"), "only …$1"],
];

/**
 * Amounts in a text would reveal the agent's size: "$12.34", "12.34 USDC", "≈ 9.88", base sizes in the risk engine's
 * messages → "…". Percentages, bps and prices without a unit stay.
 */
export const scrubAmounts = (text: string) => AMOUNT_RULES.reduce((s, [re, to]) => s.replace(re, to), text);

/**
 * Equity snapshots → a performance line in % from the first funded point (0%), never dollars. Time-weighted by the
 * snapshots' performance index (@parallax/runner flows.ts): deposits and withdrawals do not move it.
 */
export function performanceLine(eps: PerfPoint[]): { ts: number; returnPct: number }[] {
  const base = eps.find((e) => e.equityUsd > 0);
  if (!base) return [];
  return eps.filter((e) => e.equityUsd > 0).map((e) => ({ ts: e.ts, returnPct: returnBetween(base, e) ?? 0 }));
}

/** A trade as the public sees it: side, market, price, time, why. */
export function publicTrade(t: TradeRow) {
  return {
    id: t.id,
    agentId: t.agentId,
    side: t.side,
    market: t.market,
    price: t.price,
    reason: scrubAmounts(t.reason),
    timestamp: t.timestamp,
    source: t.source,
  };
}

/** A decision as the public sees it: the actions (share of capital in bps, not dollars), the reasons, the rejections. */
export function publicDecision(d: DecisionRow) {
  const dec = d.decision;
  return {
    id: d.id,
    agentId: d.agentId,
    ts: d.ts,
    provider: d.provider,
    model: d.model,
    decision: {
      note: scrubAmounts(dec.note ?? ""),
      actions: (dec.actions ?? []).map((a) => ({ ...a, ...(typeof a.reason === "string" ? { reason: scrubAmounts(a.reason) } : {}) })),
    },
    rejections: d.rejections.map((r) => ({ index: r.index, code: r.code, message: scrubAmounts(r.message) })),
  };
}

/** A ranking row without its owner and dollar equity. */
export function publicRankingRow<T extends { owner?: string; startEquityUsd?: number; equityUsd?: number }>(
  r: T,
): Omit<T, "owner" | "startEquityUsd" | "equityUsd"> {
  const { owner: _o, startEquityUsd: _s, equityUsd: _e, ...rest } = r;
  return rest;
}

/** Who looks at a page: an agent's owner sees everything about their own agents; everyone else gets the public view. */
export interface Viewer {
  /** The viewer owns an agent of this owner (internal address form). */
  owns(owner: string): boolean;
  /** The viewer may see the full data of an agent of this owner. */
  sees(owner: string): boolean;
}
export const ANONYMOUS: Viewer = { owns: () => false, sees: () => false };
export function viewer(address: string | null): Viewer {
  const me = address?.toLowerCase() ?? null;
  const owns = (owner: string) => me !== null && owner.toLowerCase() === me;
  return { owns, sees: owns };
}
