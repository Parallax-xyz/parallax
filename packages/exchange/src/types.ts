// The exchange interface the runner trades through. Implementation: the Solana venue (@parallax/solana, Jupiter swaps
// sent through Jito); tests and examples substitute a paper exchange. Spot only.
//
// Identifiers (all documented here once):
//  • coin   — the spot pair symbol, e.g. "SOL/USDC". Market data is keyed by it.
//  • symbol — the base asset, e.g. "SOL" (spec.markets, balances, trades).
//  • wallet — the agent's own wallet. Addresses are carried as 0x-prefixed hex of the 32 public key bytes inside the
//             code (see @parallax/solana address.ts) and shown in base58.
//  • oid    — the order id the exchange adapter assigns to an order (a swap); kept on the trade row.

export type Hex = `0x${string}`;

export type CandleInterval = "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface BookLevel {
  px: number;
  sz: number;
}

/** bids by descending price, asks by ascending price. */
export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
  time?: number;
}

/** Spot balance by asset symbol (USDC, SOL, ...). total/hold in units of the asset. */
export interface SpotBalance {
  coin: string;
  total: number;
  hold: number;
  /** Entry notional by exchange data (0 when the venue does not report it). */
  entryNtl: number;
}

/** Market status. Only "active" is tradeable. */
export type ExchangeMarketStatus = "active" | "inactive" | string;

export interface ExchangeSpotMarket {
  marketId: number;
  pair: string; // "SOL/USDC"
  base: string; // "SOL"
  quote: string; // "USDC"
  szDecimals: number;
  priceDecimals: number;
  minBaseAmount: number;
  minQuoteAmount: number;
  status: ExchangeMarketStatus;
  isFrozen: boolean;
  startTimestamp: number; // ms, 0 = none
  endTimestamp: number; // ms, 0 = none
  lastPrice: number;
  dayQuoteVolume: number; // 24h volume in the quote asset
  dayPriceChangePct: number;
}

/** The agent's key: decrypted only for the duration of a call; never logged. On Solana: the wallet secret (hex). */
export interface AgentKeyRef {
  privateKey: string;
}

export interface OrderRequest {
  marketId: number;
  coin: string;
  isBuy: boolean;
  price: string; // decimal string, ≤ priceDecimals decimals (worst acceptable price)
  size: string; // decimal string, ≤ szDecimals decimals
  szDecimals: number;
  priceDecimals: number;
  /** Immediate-or-cancel: a swap either lands at the limit or better, or does nothing. */
  tif: "Ioc";
}

export interface OrderResult {
  status: "filled" | "resting" | "error" | "unknown";
  /** Order id assigned by the adapter. */
  oid?: number;
  orderIndex?: string;
  /** Transaction signature. */
  txHash?: string;
  filledSz?: number;
  avgPx?: number;
  /** Size actually credited for a buy after fees charged in the received asset. */
  netBaseReceived?: number;
  error?: string;
}

export interface ExchangeClient {
  /** Quote asset of the venue. Absent = "USDC". Use quoteOf(). */
  readonly quote?: string;
  spotMarkets(): Promise<ExchangeSpotMarket[]>;
  /** Mid (or last) prices by pair ("SOL/USDC"). */
  allMids(): Promise<Record<string, number>>;
  candles(coin: string, interval: CandleInterval, startTimeMs: number): Promise<Candle[]>;
  /** L2 book by pair: bids descending, asks ascending. Empty if the market is unknown. */
  l2Book(coin: string): Promise<OrderBook>;
  /** Spot balances of an agent wallet. */
  spotBalances(wallet: Hex): Promise<SpotBalance[]>;
  /** Signs with the agent key and confirms the result of one immediate-or-cancel order. */
  placeOrder(key: AgentKeyRef, order: OrderRequest): Promise<OrderResult>;
  /** Native coin for fees in an agent wallet (lamports on Solana). Absent on venues without gas. */
  gasLamports?(wallet: Hex): Promise<number>;
}

/** The quote asset of an exchange client (USDC when the client does not say). */
export function quoteOf(exchange: { quote?: string }): string {
  return exchange.quote ?? "USDC";
}
