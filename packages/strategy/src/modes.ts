// Agent modes: what a person picks first when creating an agent. A mode = an asset class (tokenized stocks or crypto)
// traded spot on Solana; it decides the presets on offer and the markets the agent may trade. The mode follows from the
// spec: `assets` ("stocks"; absent = crypto), see modeOfSpec. marketsForMode keeps the mode's class.
import type { GenericParams, PresetInfo, RiskBox, RiskProfile } from "./types.js";
import { type QuoteAsset, VENUES, type VenueKey } from "./venues.js";

export type AssetClass = "stocks" | "crypto";
export type TradeKind = "spot";
export type AgentModeKey = "stocks-spot" | "crypto-spot";

export interface AgentMode {
  key: AgentModeKey;
  assetClass: AssetClass;
  kind: TradeKind;
  venue: VenueKey;
  quote: QuoteAsset;
  title: string;
  description: string;
}

const mode = (key: AgentModeKey, assetClass: AssetClass, title: string, description: string): AgentMode => ({
  key,
  assetClass,
  kind: "spot",
  venue: "solana",
  quote: VENUES.solana.quote,
  title,
  description,
});

export const AGENT_MODES: Readonly<Record<AgentModeKey, AgentMode>> = {
  "stocks-spot": mode(
    "stocks-spot",
    "stocks",
    "Stocks · Spot",
    "Buys and sells tokenized US stocks and ETFs (xStocks and others) on Solana through Jupiter, quoted in USDC. No leverage.",
  ),
  "crypto-spot": mode(
    "crypto-spot",
    "crypto",
    "Crypto · Spot",
    "Buys and sells Solana tokens, from SOL and JUP to the trending verified coins, through Jupiter with Jito, quoted in USDC. No leverage.",
  ),
};

export const AGENT_MODE_KEYS = Object.keys(AGENT_MODES) as AgentModeKey[];

export function isAgentModeKey(v: unknown): v is AgentModeKey {
  return typeof v === "string" && Object.hasOwn(AGENT_MODES, v);
}

/** The mode of a spec: its asset class (`assets`; a spec without it is crypto). */
export function modeOfSpec(spec: { assets?: AssetClass }): AgentModeKey {
  return `${spec.assets ?? "crypto"}-spot` as AgentModeKey;
}

/** Spec fields a mode fixes: the venue (written out), the stocks class (crypto is implicit) and the quote. */
export function modeSpecFields(key: AgentModeKey): { venue: VenueKey; assets?: "stocks"; quote: QuoteAsset } {
  const m = AGENT_MODES[key];
  return { venue: m.venue, ...(m.assetClass === "stocks" ? { assets: "stocks" as const } : {}), quote: m.quote };
}

// ---------- asset class of a market ----------

/**
 * Tokenized US stocks and ETFs on Solana, by the symbols Jupiter lists them under (xStocks end in "x"). The Solana
 * adapter resolves each to its verified mint; everything else on Solana is crypto.
 */
export const SOLANA_STOCK_SYMBOLS: readonly string[] = [
  "SPYx",
  "QQQx",
  "NVDAx",
  "TSLAx",
  "AAPLx",
  "MSFTx",
  "GOOGLx",
  "AMZNx",
  "METAx",
  "COINx",
  "MSTRx",
  "HOODx",
  "CRCLx",
  "PLTRx",
  "AMDx",
  "NFLXx",
  "GLDx",
];
const SOLANA_STOCKS_UPPER: ReadonlySet<string> = new Set(SOLANA_STOCK_SYMBOLS.map((s) => s.toUpperCase()));

/** Asset class of a market: the tokenized stocks above are "stocks", every other Solana token is "crypto". */
export function assetClassOf(symbol: string, _venue: VenueKey = "solana"): AssetClass {
  return SOLANA_STOCKS_UPPER.has(symbol.toUpperCase()) ? "stocks" : "crypto";
}

/** The markets an agent of this mode may trade: the mode's asset class. */
export function marketsForMode<T extends { symbol: string; assetClass?: AssetClass | null }>(markets: readonly T[], key: AgentModeKey): T[] {
  const m = AGENT_MODES[key];
  return markets.filter((x) => (x.assetClass !== undefined ? x.assetClass : assetClassOf(x.symbol, m.venue)) === m.assetClass);
}

// ---------- presets of a mode ----------

/** Whether a preset is offered in a mode (its asset classes). */
export function presetFitsMode(p: Pick<PresetInfo, "kind" | "assetClasses">, key: AgentModeKey): boolean {
  const m = AGENT_MODES[key];
  return (p.kind ?? "spot") === m.kind && (!p.assetClasses || p.assetClasses.includes(m.assetClass));
}

export function presetsForMode(presets: readonly PresetInfo[], key: AgentModeKey): PresetInfo[] {
  return presets.filter((p) => p.enabled && presetFitsMode(p, key));
}

/** A preset's defaults for a profile in a mode: the profile's risk and params with the mode's overrides. */
export function presetDefaults(p: PresetInfo, profile: RiskProfile, key: AgentModeKey): { risk: RiskBox; params: GenericParams } {
  const d = p.defaults[profile];
  const over = p.modeParams?.[AGENT_MODES[key].assetClass]?.[profile];
  return { risk: { ...d.risk }, params: { ...d.params, ...over } };
}
