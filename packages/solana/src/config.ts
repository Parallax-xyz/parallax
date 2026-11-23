// Network endpoints and trading defaults of the Solana venue. Everything can be overridden from the environment.

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface SolanaConfig {
  /** Solana JSON-RPC (Helius, Alchemy, QuickNode…; the public endpoint is rate-limited). */
  rpcUrl: string;
  /** Jupiter API base (https://api.jup.ag) and its key (free at developers.jup.ag/portal). */
  jupiterUrl: string;
  jupiterKey?: string;
  /** Pause between Jupiter calls, ms (free key ≈ 1 request/s; a paid key can go lower). */
  jupiterGapMs: number;
  /** Jito block engine (low-latency send). */
  jitoUrl: string;
  jitoAuth?: string;
  /** Tip to the Jito validators per swap, lamports (Jito's minimum is 1000; busy times need more). */
  tipLamports: number;
  /** Upper bound of the tip when the tip floor is used (lamports). */
  maxTipLamports: number;
  /** Price data for candles (GeckoTerminal public API). */
  geckoUrl: string;
  /** Default slippage cap of a swap, bps (the order's worst price may tighten it). */
  slippageBps: number;
  /** SOL kept in every agent wallet for fees, tips and token accounts; never traded. */
  gasReserveSol: number;
  /** Confirmation timeout of a swap, ms. */
  confirmTimeoutMs: number;
}

export const DEFAULT_SOLANA: SolanaConfig = {
  rpcUrl: "https://api.mainnet-beta.solana.com",
  jupiterUrl: "https://api.jup.ag",
  jupiterGapMs: 1100,
  jitoUrl: "https://mainnet.block-engine.jito.wtf",
  tipLamports: 10_000,
  maxTipLamports: 200_000,
  geckoUrl: "https://api.geckoterminal.com/api/v2",
  slippageBps: 100,
  gasReserveSol: 0.02,
  confirmTimeoutMs: 60_000,
};

export function solanaConfigFromEnv(env: Record<string, string | undefined> = process.env): SolanaConfig {
  const num = (k: string, d: number) => {
    const v = Number(env[k]);
    return env[k] !== undefined && env[k] !== "" && Number.isFinite(v) ? v : d;
  };
  const str = (k: string, d: string) => env[k]?.trim() || d;
  return {
    rpcUrl: str("SOLANA_RPC_URL", DEFAULT_SOLANA.rpcUrl),
    jupiterUrl: str("JUPITER_API_URL", DEFAULT_SOLANA.jupiterUrl).replace(/\/+$/, ""),
    jupiterKey: env.JUPITER_API_KEY?.trim() || undefined,
    jupiterGapMs: num("JUPITER_GAP_MS", DEFAULT_SOLANA.jupiterGapMs),
    jitoUrl: str("JITO_URL", DEFAULT_SOLANA.jitoUrl).replace(/\/+$/, ""),
    jitoAuth: env.JITO_AUTH?.trim() || undefined,
    tipLamports: num("JITO_TIP_LAMPORTS", DEFAULT_SOLANA.tipLamports),
    maxTipLamports: num("JITO_MAX_TIP_LAMPORTS", DEFAULT_SOLANA.maxTipLamports),
    geckoUrl: str("GECKO_API_URL", DEFAULT_SOLANA.geckoUrl).replace(/\/+$/, ""),
    slippageBps: num("SOLANA_SLIPPAGE_BPS", DEFAULT_SOLANA.slippageBps),
    gasReserveSol: num("SOLANA_GAS_RESERVE_SOL", DEFAULT_SOLANA.gasReserveSol),
    confirmTimeoutMs: num("SOLANA_CONFIRM_TIMEOUT_MS", DEFAULT_SOLANA.confirmTimeoutMs),
  };
}
