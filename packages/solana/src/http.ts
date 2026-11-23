// Small fetch wrapper: timeout, JSON, readable errors, one retry on 429/5xx. Injectable for tests.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface JsonClientOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Attempts in all (429 and 5xx are retried with a growing pause). Default 2. */
  retries?: number;
  headers?: Record<string, string>;
}

export async function fetchJson<T>(url: string, init: RequestInit & JsonClientOptions = {}): Promise<T> {
  const f = init.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = init.timeoutMs ?? 15_000;
  let last: unknown;
  const attempts = init.retries ?? 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(url, {
        ...init,
        headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new HttpError(res.status, `${new URL(url).host} answered ${res.status}: ${text.slice(0, 300)}`, text);
        if ((res.status === 429 || res.status >= 500) && attempt < attempts - 1) {
          last = err;
          await new Promise((r) => setTimeout(r, res.status === 429 ? 1500 * (attempt + 1) : 400));
          continue;
        }
        throw err;
      }
      return (text ? JSON.parse(text) : null) as T;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      last = e;
      if (attempt < attempts - 1) continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** JSON-RPC 2.0 call (Jito block engine). */
export async function jsonRpc<T>(url: string, method: string, params: unknown[], o: JsonClientOptions = {}): Promise<T> {
  const r = await fetchJson<{ result?: T; error?: { code: number; message: string } }>(url, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    ...o,
  });
  if (r?.error) throw new Error(`${method}: ${r.error.message} (${r.error.code})`);
  return r?.result as T;
}
