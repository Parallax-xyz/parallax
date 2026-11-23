// Jupiter: prices (Price API v3), token info (Tokens API v2) and swap instructions (Swap API v2 /build).
// /build returns the instructions of the best route over every Solana DEX; we assemble, sign and send the transaction
// ourselves (through Jito, see jito.ts), so the agent's key never leaves the process that runs the agent.
import { fetchJson, type JsonClientOptions } from "./http.js";

export interface JupInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

export interface JupBuild {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct?: string | number;
  routePlan?: { bps?: number; percent?: number; swapInfo?: { label?: string } }[];
  computeBudgetInstructions?: JupInstruction[];
  setupInstructions?: JupInstruction[];
  swapInstruction: JupInstruction;
  cleanupInstruction?: JupInstruction | null;
  otherInstructions?: JupInstruction[];
  tipInstruction?: JupInstruction | null;
  addressesByLookupTableAddress?: Record<string, string[]>;
  blockhashWithMetadata?: { blockhash: number[] | string; lastValidBlockHeight: number };
  computeUnitPrice?: number | string;
}

export interface JupToken {
  id: string; // mint
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  usdPrice?: number;
  liquidity?: number;
  mcap?: number;
  isVerified?: boolean | null;
  tags?: string[] | null;
  organicScore?: number;
  organicScoreLabel?: "high" | "medium" | "low";
  tokenProgram?: string;
  stats24h?: { priceChange?: number; buyVolume?: number; sellVolume?: number; volumeChange?: number };
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; isSus?: boolean };
}

export interface JupPrice {
  usdPrice: number;
  decimals?: number;
  priceChange24h?: number;
  blockId?: number;
}

/**
 * Jupiter's free key allows about one request per second: calls are queued and spaced (`minGapMs`), and a 429 is
 * retried with a growing pause. Without spacing, half of the market list was silently lost (seen in practice).
 */
export class JupiterClient {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly base: string,
    private readonly key?: string,
    private readonly o: JsonClientOptions & { minGapMs?: number } = {},
  ) {}

  private get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    const qs = q.toString();
    const gap = this.o.minGapMs ?? 1100;
    const run = async (): Promise<T> => {
      const wait = this.last + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fetchJson<T>(`${this.base}${path}${qs ? `?${qs}` : ""}`, {
        retries: 4,
        ...this.o,
        headers: { ...(this.key ? { "x-api-key": this.key } : {}), ...this.o.headers },
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Swap instructions for an exact input amount (base units). `taker` pays and signs. */
  build(p: { inputMint: string; outputMint: string; amount: bigint | string; taker: string; slippageBps: number; maxAccounts?: number }): Promise<JupBuild> {
    return this.get<JupBuild>("/swap/v2/build", {
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: String(p.amount),
      taker: p.taker,
      slippageBps: Math.max(1, Math.round(p.slippageBps)),
      maxAccounts: p.maxAccounts ?? 48,
      forJitoBundle: true,
    });
  }

  /** USD prices by mint (up to 50 per call). Mints without a price are left out. */
  async prices(mints: string[]): Promise<Record<string, JupPrice>> {
    const out: Record<string, JupPrice> = {};
    for (let i = 0; i < mints.length; i += 50) {
      const part = mints.slice(i, i + 50);
      const r = await this.get<Record<string, JupPrice | null>>("/price/v3", { ids: part.join(",") });
      for (const [m, p] of Object.entries(r ?? {})) if (p && Number(p.usdPrice) > 0) out[m] = { ...p, usdPrice: Number(p.usdPrice) };
    }
    return out;
  }

  search(query: string): Promise<JupToken[]> {
    return this.get<JupToken[]>("/tokens/v2/search", { query });
  }

  /** Token info by mints (search accepts a comma-separated list of mints, up to 100). */
  async tokens(mints: string[]): Promise<JupToken[]> {
    const out: JupToken[] = [];
    for (let i = 0; i < mints.length; i += 100) out.push(...(await this.search(mints.slice(i, i + 100).join(","))));
    return out;
  }

  /** "toptraded" | "toptrending" | "toporganicscore" over "5m" | "1h" | "6h" | "24h". */
  category(category: string, interval: string, limit = 100): Promise<JupToken[]> {
    return this.get<JupToken[]>(`/tokens/v2/${category}/${interval}`, { limit });
  }
}
