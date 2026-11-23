// Venues: where an agent trades. Each agent runs on exactly one venue; its capital, wallet and markets belong to that
// venue. This open-source core ships one venue: Solana spot. Jupiter routes every swap over the Solana DEXs and the
// transaction is sent through Jito and RPC (see @parallax/solana). The network details live in that adapter; this
// module holds what the strategy layer, the risk engine and the runner need.

/** Venue key. "solana" = Solana spot: Jupiter routes over every Solana DEX, transactions go out through Jito. */
export type VenueKey = "solana";

export type QuoteAsset = "USDC";

export interface VenueInfo {
  key: VenueKey;
  label: string;
  /** Exchange family: picks the adapter. */
  exchange: "solana";
  /** Quote asset of every pair on this venue. */
  quote: QuoteAsset;
  /** What the venue offers to agents. */
  markets: { spot: boolean; perps: boolean };
  /** Usual minimum order in quote units (the runner's minOrderUsd wins). */
  minOrderQuote: number;
}

export const VENUES: Readonly<Record<VenueKey, VenueInfo>> = {
  solana: {
    key: "solana",
    label: "Solana (Jupiter + Jito)",
    exchange: "solana",
    quote: "USDC",
    markets: { spot: true, perps: false },
    minOrderQuote: 1,
  },
};

export const VENUE_KEYS = Object.keys(VENUES) as VenueKey[];

/** Venue of a spec that does not name one. Validation always writes it out (one spec, one specHash). */
export const DEFAULT_VENUE: VenueKey = "solana";

export function isVenueKey(v: unknown): v is VenueKey {
  return typeof v === "string" && Object.hasOwn(VENUES, v);
}

/** The venue a spec runs on: its `venue` field, or the default. */
export function venueOfSpec(spec: { venue?: VenueKey }): VenueInfo {
  return VENUES[spec.venue ?? DEFAULT_VENUE];
}
