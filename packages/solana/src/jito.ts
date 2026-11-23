// Jito: the block engine forwards our transactions straight to the next validator running Jito-Solana (most of the
// stake). That lands swaps faster and keeps them out of the public queue where bots sandwich them. Every transaction
// pays a small tip in SOL to one of Jito's tip accounts (minimum 1000 lamports).
import { fetchJson, type JsonClientOptions, jsonRpc } from "./http.js";

/** Jito's published tip accounts (getTipAccounts returns the same set; used when that call fails). */
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export const JITO_MIN_TIP = 1000;

export class JitoClient {
  private tipAccounts: string[] | null = null;
  private floor: { at: number; lamports: number } | null = null;

  constructor(
    private readonly base: string,
    private readonly auth?: string,
    private readonly o: JsonClientOptions = {},
  ) {}

  private get headers(): Record<string, string> {
    return this.auth ? { "x-jito-auth": this.auth } : {};
  }

  async randomTipAccount(): Promise<string> {
    if (!this.tipAccounts) {
      try {
        const r = await jsonRpc<string[]>(`${this.base}/api/v1/bundles`, "getTipAccounts", [], { ...this.o, headers: this.headers });
        this.tipAccounts = Array.isArray(r) && r.length ? r : JITO_TIP_ACCOUNTS;
      } catch {
        this.tipAccounts = JITO_TIP_ACCOUNTS;
      }
    }
    return this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)]!;
  }

  /**
   * Tip for one swap: the 50th percentile of recent landed tips (Jito's tip floor API, cached 1 min), clamped to
   * [max(min, JITO_MIN_TIP), max]. Falls back to `min` when the floor is unavailable.
   */
  async tipLamports(min: number, max: number): Promise<number> {
    const lo = Math.max(JITO_MIN_TIP, Math.round(min));
    const now = Date.now();
    if (!this.floor || now - this.floor.at > 60_000) {
      try {
        const r = await fetchJson<{ landed_tips_50th_percentile?: number }[]>("https://bundles.jito.wtf/api/v1/bundles/tip_floor", this.o);
        const sol = Number(r?.[0]?.landed_tips_50th_percentile);
        this.floor = { at: now, lamports: Number.isFinite(sol) && sol > 0 ? Math.round(sol * 1e9) : lo };
      } catch {
        this.floor = { at: now, lamports: lo };
      }
    }
    return Math.min(Math.max(lo, this.floor.lamports), Math.max(lo, max));
  }

  /** Sends one signed transaction (base64) through the block engine. Returns the signature. */
  sendTransaction(base64Tx: string): Promise<string> {
    return jsonRpc<string>(`${this.base}/api/v1/transactions`, "sendTransaction", [base64Tx, { encoding: "base64" }], {
      ...this.o,
      headers: this.headers,
    });
  }
}
