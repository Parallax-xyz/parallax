// Private mode: an agent's realized profit goes from its wallet into its owner's private balance (Solana Privacy
// Rings by Helius), in USDC, without a swap.
//
// What is swept: realized profit from the agent's own trades since Private mode was turned on, minus what was already
// swept (losing trades lower it, so nothing is swept until they are made up), capped by the USDC in the wallet. A sweep
// happens once that reaches the minimum (PRIVATE_MIN_SWEEP_USDC). A failed deposit leaves the money in the agent wallet
// and is retried on the next pass; trading never waits for it. The swept total is added back to the agent's
// performance equity (RunnerDeps.equityOffset = PrivateModeStore.sweptUsd), so a sweep does not look like a loss to the
// daily loss limit or in the agent's returns.
//
// Storage is behind PrivateModeStore (MemoryPrivateModeStore here; a backend keeps it in its database). The chain side
// is behind two functions (walletUsdc, deposit); solanaSweepChain wires them to @parallax/solana.
import { type AgentRecord, type Hex, type KeyVault, type Logger, lc, ledgerFromTrades, noopLogger, type RunnerStore } from "@parallax/runner";
import { keypairFromSecret, type PrivacyClient, toBase58, toHexAddress, walletBalances } from "@parallax/solana";
import type { Connection } from "@solana/web3.js";

export interface PrivateModeRow {
  agentId: number;
  enabled: boolean;
  /** The owner's shielded address (hex), derived in the owner's browser (private-balance.ts). */
  ownerShielded: string;
  enabledAt: number;
  /** Realized PnL of the agent (USD) at the moment Private mode was turned on: profit before that stays in the wallet. */
  realizedAtEnable: number;
  sweptUsd: number;
  lastError: string | null;
  lastTryAt: number | null;
}

export interface SweepRow {
  id: number;
  agentId: number;
  ts: number;
  amountUsd: number;
  signature: string;
}

export interface PrivateModeStore {
  get(agentId: number): PrivateModeRow | undefined;
  listEnabled(): PrivateModeRow[];
  /** Turning it on again keeps the swept total and the original baseline; a new shielded address replaces the old one. */
  enable(agentId: number, ownerShielded: string, now: number, realizedNow: number): void;
  disable(agentId: number): void;
  recordTry(agentId: number, now: number, error: string | null): void;
  recordSweep(agentId: number, now: number, amountUsd: number, signature: string): void;
  /** Newest first. */
  sweeps(agentId: number, limit?: number): SweepRow[];
  /** Swept USD of an agent, for the runner's performance equity. */
  sweptUsd(agentId: number): number;
}

export class MemoryPrivateModeStore implements PrivateModeStore {
  private rows = new Map<number, PrivateModeRow>();
  private log: SweepRow[] = [];

  get(agentId: number): PrivateModeRow | undefined {
    const r = this.rows.get(agentId);
    return r ? { ...r } : undefined;
  }
  listEnabled(): PrivateModeRow[] {
    return [...this.rows.values()].filter((r) => r.enabled).map((r) => ({ ...r }));
  }
  enable(agentId: number, ownerShielded: string, now: number, realizedNow: number): void {
    const prev = this.rows.get(agentId);
    if (prev) Object.assign(prev, { enabled: true, ownerShielded, lastError: null });
    else
      this.rows.set(agentId, {
        agentId,
        enabled: true,
        ownerShielded,
        enabledAt: now,
        realizedAtEnable: realizedNow,
        sweptUsd: 0,
        lastError: null,
        lastTryAt: null,
      });
  }
  disable(agentId: number): void {
    const r = this.rows.get(agentId);
    if (r) r.enabled = false;
  }
  recordTry(agentId: number, now: number, error: string | null): void {
    const r = this.rows.get(agentId);
    if (r) Object.assign(r, { lastTryAt: now, lastError: error });
  }
  recordSweep(agentId: number, now: number, amountUsd: number, signature: string): void {
    this.log.push({ id: this.log.length + 1, agentId, ts: now, amountUsd, signature });
    const r = this.rows.get(agentId);
    if (r) Object.assign(r, { sweptUsd: r.sweptUsd + amountUsd, lastError: null, lastTryAt: now });
  }
  sweeps(agentId: number, limit = 50): SweepRow[] {
    return this.log
      .filter((s) => s.agentId === agentId)
      .reverse()
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }
  sweptUsd(agentId: number): number {
    return this.rows.get(agentId)?.sweptUsd ?? 0;
  }
}

/** Realized PnL (USD) from all of the agent's own trades (average cost, see @parallax/runner capital/ledger.ts). */
export function realizedPnl(store: Pick<RunnerStore, "allTradesAsc">, agentId: number): number {
  const trades = store.allTradesAsc(agentId);
  return ledgerFromTrades(
    0,
    trades.map((t) => ({ side: t.side, market: t.market, sizeUsd: t.sizeUsd, sizeBase: t.sizeBase })),
  ).realizedPnlUsd;
}

/** How much to sweep now (USD); 0 when it is below the minimum or the wallet lacks the USDC. Pure. */
export function sweepAmount(input: { realized: number; realizedAtEnable: number; sweptUsd: number; walletUsdc: number; minSweep: number }): number {
  const owed = input.realized - input.realizedAtEnable - input.sweptUsd;
  if (!(owed >= input.minSweep)) return 0;
  const amount = Math.min(owed, input.walletUsdc);
  if (!(amount >= input.minSweep)) return 0;
  return Math.floor(amount * 1e6) / 1e6; // whole USDC base units
}

/** The chain side of a sweep. */
export interface SweepChain {
  /** USDC (whole units) in an agent wallet. */
  walletUsdc(wallet: Hex): Promise<number>;
  /**
   * Deposits `amountUsdc` from the agent wallet into the shielded address and returns the transaction signature. The
   * agent wallet signs and pays the fee; `secretHex` is its key, decrypted for this call only.
   */
  deposit(agent: Pick<AgentRecord, "id" | "wallet">, secretHex: string, ownerShielded: string, amountUsdc: number): Promise<string>;
}

export interface SweepDeps {
  store: Pick<RunnerStore, "getAgent" | "allTradesAsc" | "setOffchainStatus">;
  privacy: PrivateModeStore;
  keys: KeyVault;
  chain: SweepChain;
  /** Profit is swept once at least this much USDC has built up. */
  minSweepUsdc: number;
  now?: () => number;
  log?: Logger;
}

const nowSec = (d: SweepDeps) => d.now?.() ?? Math.floor(Date.now() / 1000);

/** The owner's view of Private mode for one agent. */
export function privateView(d: Pick<SweepDeps, "store" | "privacy" | "minSweepUsdc">, agentId: number) {
  const row = d.privacy.get(agentId);
  const realized = row ? realizedPnl(d.store, agentId) : 0;
  return {
    minSweepUsd: d.minSweepUsdc,
    enabled: !!row?.enabled,
    sweptUsd: row?.sweptUsd ?? 0,
    pendingUsd: row ? Math.max(0, realized - row.realizedAtEnable - row.sweptUsd) : 0,
    lastError: row?.lastError ?? null,
    lastTryAt: row?.lastTryAt ?? null,
    sweeps: row ? d.privacy.sweeps(agentId) : [],
  };
}

/** Turns Private mode on (profit from now on is swept to `ownerShielded`) or off. */
export function setPrivateMode(d: SweepDeps, agentId: number, on: { enabled: true; ownerShielded: string } | { enabled: false }) {
  if (on.enabled) d.privacy.enable(agentId, on.ownerShielded, nowSec(d), realizedPnl(d.store, agentId));
  else d.privacy.disable(agentId);
  return privateView(d, agentId);
}

/** One sweep pass over every agent with Private mode on. Errors are kept per agent and retried next pass. Returns the sweeps made. */
export async function sweepPass(d: SweepDeps): Promise<number> {
  const log = d.log ?? noopLogger;
  let made = 0;
  for (const row of d.privacy.listEnabled()) {
    const agent = d.store.getAgent(row.agentId);
    if (!agent) continue;
    try {
      const realized = realizedPnl(d.store, agent.id);
      if (realized - row.realizedAtEnable - row.sweptUsd < d.minSweepUsdc) continue; // nothing due: no RPC call
      const walletUsdc = await d.chain.walletUsdc(agent.wallet);
      const amount = sweepAmount({ realized, realizedAtEnable: row.realizedAtEnable, sweptUsd: row.sweptUsd, walletUsdc, minSweep: d.minSweepUsdc });
      if (amount <= 0) continue;
      const ref = await d.keys.agentKey(agent);
      const signature = await d.chain.deposit(agent, ref.privateKey, row.ownerShielded, amount);
      d.privacy.recordSweep(agent.id, nowSec(d), amount, signature);
      made++;
      log.info({ agentId: agent.id, amountUsd: amount, signature }, "private mode: profit swept to the owner's private balance");
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      d.privacy.recordTry(agent.id, nowSec(d), msg);
      log.warn({ agentId: agent.id, err: msg }, "private mode: sweep failed, will retry");
    }
  }
  return made;
}

/**
 * "Withdraw all → to my private balance": the agent stops, and all USDC in its wallet goes into the owner's private
 * balance (the same deposit a sweep makes). SOL and other tokens stay in the agent wallet: sending them to the owner's
 * public wallet would link the two again.
 */
export async function withdrawAllToPrivate(
  d: SweepDeps,
  agent: Pick<AgentRecord, "id" | "wallet" | "offchainStatus">,
  ownerShielded: string,
  settleMs = 1500,
): Promise<{ signature: string; amountUsd: number }> {
  if (agent.offchainStatus !== "stopped") d.store.setOffchainStatus(agent.id, "stopped", "owner_withdraw");
  await new Promise((r) => setTimeout(r, settleMs)); // a swap in flight lands first
  const usdc = await d.chain.walletUsdc(agent.wallet);
  if (!(usdc > 0)) throw new Error("the agent wallet holds no USDC to move");
  const ref = await d.keys.agentKey(agent);
  const amount = Math.floor(usdc * 1e6) / 1e6;
  const signature = await d.chain.deposit(agent, ref.privateKey, ownerShielded, amount);
  return { signature, amountUsd: amount };
}

/** Runs sweepPass every `everySec` (at least 30 s; passes never overlap). Returns a stop function. */
export function startSweeper(d: SweepDeps, everySec = 120): () => void {
  const log = d.log ?? noopLogger;
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    sweepPass(d)
      .catch((e) => log.warn({ err: (e as Error).message }, "private mode: sweep pass failed"))
      .finally(() => {
        busy = false;
      });
  }, Math.max(30, everySec) * 1000);
  return () => clearInterval(t);
}

/** The chain side on Solana: USDC read from the wallet, deposits through @parallax/solana's PrivacyClient. */
export function solanaSweepChain(connection: Connection, client: PrivacyClient, usdcMint: string): SweepChain {
  return {
    async walletUsdc(wallet) {
      const bal = await walletBalances(connection, toBase58(wallet));
      const t = bal.tokens.find((x) => x.mint === usdcMint);
      return t ? Number(t.amount) / 10 ** t.decimals : 0;
    },
    async deposit(agent, secretHex, ownerShielded, amountUsdc) {
      const kp = keypairFromSecret(secretHex);
      if (toHexAddress(kp.publicKey.toBase58()) !== lc(agent.wallet)) throw new Error("the stored key does not match the agent wallet");
      return client.depositUsdc(kp, ownerShielded, amountUsdc);
    },
  };
}
