// Runner: the agent decision loop. Every config.runner.tickSec (15 s) for every runnable agent:
//  1) skip unless the agent is activated, Active in its registry (when one is wired) and not paused off-chain; an
//     agent out of SOL for fees pauses itself and may only run protective sells until it is topped up (gas.ts);
//  2) protective stops and preset exit rules (code, not AI) are checked EVERY tick and executed immediately;
//  3) when a decision is due (intervalSec) and a cheap trigger fires: context -> AI -> risk engine -> liquidity guard
//     -> orders signed by the agent's own wallet key (on Solana: one Jupiter swap each, see @parallax/solana);
//  4) accounting: deposits and withdrawals are told apart from trading results (flows.ts) and equity snapshots are
//     taken hourly with a time-weighted performance index.
// No preset-specific logic: rights come from allowsBuy/allowsSell, stops from preset.protection,
// indicators from preset.indicators, the prompt from preset.promptTemplate, rules from preset.rules.
import {
  type AgentKeyRef,
  type Candle,
  type ExchangeClient,
  marketOpenState,
  type OrderBook,
  parseSpotMarkets,
  quoteOf,
  type ResolvedMarket,
  type SpotBalance,
} from "@parallax/exchange";
import { computeIndicators, resolveIndicatorSpecs, TIMEFRAME_MS } from "@parallax/indicators";
import {
  type ApprovedOrder,
  avgEntryFromTrades,
  checkLiquidity,
  checkProtection,
  computeEquity,
  describeConditions,
  evalConditions,
  evaluateDecision,
  indicatorLabels,
  indicatorValues,
  nearProtection,
  numParam,
  type Position,
  type Rejection,
  type RiskInput,
  rebalancePlan,
  updatePeaks,
  weightsParam,
} from "@parallax/risk";
import {
  AGENT_MODES,
  type AgentAction,
  type AgentDecision,
  assetClassOf,
  DEFAULT_VENUE,
  isAllMarkets,
  MIN_ORDER_MARGIN,
  type ModelInfo,
  modeOfSpec,
  type PresetInfo,
  type StrategySpec,
  VENUES,
} from "@parallax/strategy";
import { TtlCache } from "./cache.js";
import type { CapitalResult } from "./capital/ledger.js";
import { computeAgentCapital } from "./capital/service.js";
import type { RunnerConfig } from "./config.js";
import { EquityRecorder } from "./equity.js";
import { chainIndex, epochIndexFromEquity, externalFlow, FLOW_ROW_MIN_USD, type WalletView, walletEquity } from "./flows.js";
import { BUY_WORST_LAMPORTS, canSwap, GAS_ASSET, gasLevel, LOW_GAS_LAMPORTS, LOW_GAS_REASON, SELL_WORST_LAMPORTS } from "./gas.js";
import type { KeyVault } from "./keys.js";
import type { DecisionContext, MarketContext } from "./llm/prompt.js";
import { aiUnavailableNote, type LlmRouter } from "./llm/router.js";
import { type Logger, noopLogger } from "./log.js";
import { type MarketSyncTarget, midsBySymbol, type RunnerStore } from "./store.js";
import { type AgentRecord, type AgentState, type Hex, lc } from "./types.js";
import { affordableBuy, agentUniverse, heldSymbols, minSellShareBps, POSITION_DUST_USD, type UniverseMarket } from "./universe.js";

export type TickOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "protect"; orders: ApprovedOrder[]; filled: number; rejections: Rejection[] }
  | { kind: "not_due" }
  | { kind: "no_trigger" }
  | { kind: "decided"; ok: boolean; decision: AgentDecision; orders: ApprovedOrder[]; filled: number; rejections: Rejection[]; provider: string };

export interface Snapshot {
  /** The agent's markets this tick: its pairs (or the "*" shortlist) plus held positions. buyable = may buy. */
  markets: UniverseMarket[];
  mids: Record<string, number>;
  balances: { usdc: number; tokens: Record<string, number> };
  positions: Position[];
  equity: number;
  /** The agent's capital view of its wallet. ok=false: the agent needs a capital allocation. */
  capital?: CapitalResult;
  /** Enabled markets left out of the agent's set because of capital/lot size ("*" mode). */
  unbuyable?: Record<string, "min_order">;
}

/** Where agents are registered (for example an on-chain registry). The runner only reads an agent's status and wallet. */
export interface AgentRegistry {
  /** status: 0 Active, 1 Paused, 2 Stopped. null = not registered. */
  getAgent(id: number): Promise<{ status: number; wallet: Hex } | null>;
}

export interface RunnerDeps {
  store: RunnerStore;
  /** The venue's exchange client (spot). */
  exchange: ExchangeClient;
  /** Registry reads (agent status and wallet). Without it the store's status is the source of truth. */
  registry?: AgentRegistry;
  llm: LlmRouter;
  keys: KeyVault;
  config: RunnerConfig;
  log?: Logger;
  /** Current time, unix seconds. */
  now?: () => number;
  /** Premium status of an owner (shorter decision intervals, premium models). Default: false. */
  isPremium?: (owner: Hex) => Promise<boolean>;
  /** Platform minimum decision interval for non-premium owners. Default 300 s. */
  minIntervalSec?: number;
  /** Equity series sink (at most one point per minute per agent, and right after a trade), e.g. for an equity chart. */
  onEquity?: (agentId: number, ts: number, equityUsd: number) => void;
  /** USD the agent sent out of its wallet as profit (Private mode), added back to its performance equity. */
  equityOffset?: (agentId: number) => number;
}

/** A runner wired to an exchange that quotes in another asset would value the agent wrong: refuse to start. */
export function assertVenueQuote(exchange: { quote?: string }): void {
  const want = VENUES[DEFAULT_VENUE].quote;
  const got = quoteOf(exchange);
  if (got !== want) throw new Error(`the venue quotes in ${want}, but the exchange client quotes in ${got}`);
}

const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const dayStartSec = (sec: number) => Math.floor(sec / 86400) * 86400;
const INT32 = 2 ** 31;

export class Runner {
  readonly cache = new TtlCache();
  private readonly candleCache = new Map<string, { at: number; candles: Candle[] }>();
  private readonly equity: EquityRecorder;
  private readonly log: Logger;
  private readonly now: () => number;
  private timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(private readonly d: RunnerDeps) {
    this.log = d.log ?? noopLogger;
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.equity = new EquityRecorder(d.onEquity);
    assertVenueQuote(d.exchange);
  }

  private get cfg(): RunnerConfig {
    return this.d.config;
  }

  // ---------- data ----------

  /** Mid prices by symbol for known markets (cached 5 s). */
  async midsBySymbol(): Promise<Record<string, number>> {
    const all = await this.cache.get("exchange:mids", 5_000, () => this.d.exchange.allMids());
    return midsBySymbol(all, this.d.store.listMarkets());
  }

  /**
   * Syncs every spot pair of the venue (quoted in its quote asset) into the store, when the store supports it, with
   * liquidity stats and market status. Enabling is automatic: 24h volume >= minMarketDayVolumeUsd enables a pair, below
   * disables it. Exchange errors are not fatal: the runner keeps the known markets.
   */
  async refreshMarkets(): Promise<boolean> {
    const store = this.d.store as RunnerStore & Partial<MarketSyncTarget>;
    if (!store.upsertMarkets) return false;
    try {
      const quote = quoteOf(this.d.exchange);
      const rows = parseSpotMarkets(await this.d.exchange.spotMarkets(), quote);
      if (rows.length === 0) throw new Error(`the exchange lists no ${quote} spot pairs`);
      store.upsertMarkets(rows, this.now(), this.cfg.liquidity.minMarketDayVolumeUsd);
      return true;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "markets unavailable, using known markets");
      return false;
    }
  }

  private async isPremium(owner: Hex): Promise<boolean> {
    if (!this.d.isPremium) return false;
    try {
      return await this.cache.get(`premium:${lc(owner)}`, 60_000, () => this.d.isPremium!(owner));
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "isPremium: read failed, assuming false");
      return false;
    }
  }

  /** The registry's view of the agent (cached 60 s): it must be Active and point at the same wallet. */
  private async registryActive(agent: AgentRecord): Promise<string | null> {
    const { registry } = this.d;
    if (!registry) return null;
    let a: { status: number; wallet: Hex } | null;
    try {
      a = await this.cache.get(`registry:agent:${agent.id}`, 60_000, () => registry.getAgent(agent.id));
    } catch {
      return "registry_unavailable";
    }
    if (!a) return "not_registered";
    if (a.status !== agent.chainStatus) this.d.store.setAgentChainStatus(agent.id, a.status);
    if (a.status !== 0) return a.status === 1 ? "paused_in_registry" : "stopped_in_registry";
    if (lc(a.wallet) !== lc(agent.wallet)) return "wallet_mismatch";
    return null;
  }

  private async fetchCandles(coin: string, tf: keyof typeof TIMEFRAME_MS, start: number): Promise<Candle[]> {
    const key = `${coin}:${tf}:${Math.floor(start / TIMEFRAME_MS[tf])}`;
    const ttl = Math.min(TIMEFRAME_MS[tf] / 4, 5 * 60_000);
    const hit = this.candleCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.candles;
    const candles = await this.d.exchange.candles(coin, tf, start);
    if (this.candleCache.size > 500) this.candleCache.clear();
    this.candleCache.set(key, { at: Date.now(), candles });
    return candles;
  }

  /** Premium model rules: a premium model without premium status falls back to the first enabled standard model. */
  effectiveModel(modelId: string, premium: boolean): ModelInfo | undefined {
    const all = this.d.store.listModels();
    const m = all.find((x) => x.id === modelId);
    if (m?.enabled && (m.tier === "standard" || premium)) return m;
    return all.find((x) => x.enabled && x.tier === "standard") ?? m;
  }

  async snapshot(agent: AgentRecord, spec: StrategySpec): Promise<Snapshot> {
    const { store, exchange } = this.d;
    const [allMids, raw] = await Promise.all([this.midsBySymbol(), exchange.spotBalances(agent.wallet)]);
    const mids: Record<string, number> = { ...allMids }; // copy: held positions get the book mid below
    const bal = new Map<string, SpotBalance>(raw.map((b) => [b.coin, b]));
    const quote = quoteOf(exchange);
    const usdcB = bal.get(quote); // the venue quote: the ledger keeps it in its `usdc` field
    const realFree: Record<string, number> = {};
    for (const b of raw) if (b.coin !== quote) realFree[b.coin] = Math.max(0, b.total - b.hold);
    // The agent's capital: the whole wallet, or its own cash (allocation +/- own trades) and own tokens reconciled with the
    // real balance (capital/ledger.ts); Protect (manageExistingHoldings) also gets tokens no running agent owns.
    const capital = computeAgentCapital(store, agent, { usdc: usdcB ? Math.max(0, usdcB.total - usdcB.hold) : 0, tokens: realFree });
    const balances = { usdc: capital.ok ? capital.usdc : 0, tokens: {} as Record<string, number> };
    // The agent's free tokens are its held positions; the market set is its pairs (or the "*" shortlist) plus positions.
    // Disabled or illiquid markets stay in the set while a position exists: sells and protective stops always work.
    const free: Record<string, number> = capital.ok ? { ...capital.tokens } : {};
    // Max spend per buy: min(free cash, equity * min(maxTradeBps, preset budget)). Pairs where that amount, rounded down
    // to the lot step, is below the minimum order are not offered to the AI for buying.
    const roughEquity = balances.usdc + Object.entries(free).reduce((s, [sym, q]) => s + q * (mids[sym] ?? 0), 0);
    const preset = store.getPresetById(agent.presetId);
    const budgetBps = preset?.rules?.maxBuyBpsParam ? Number(spec.params?.[preset.rules.maxBuyBpsParam]) : Number.NaN;
    const capBps = Math.min(spec.risk.maxTradeBps, budgetBps > 0 ? budgetBps : Number.POSITIVE_INFINITY);
    const maxBuyUsd = Math.min(balances.usdc, (roughEquity * capBps) / 10000);
    const minOrderUsd = this.cfg.limits.minOrderUsd;
    const canBuy = (m: { symbol: string; szDecimals: number }) => affordableBuy(m.szDecimals, mids[m.symbol], maxBuyUsd, minOrderUsd);
    const known = store.listMarkets();
    const nowMs = this.now() * 1000;
    const isOpen = (m: ResolvedMarket) => marketOpenState(m, nowMs).open;
    // "*" = the liquid pairs of the agent's asset class (crypto, or tokenized stocks)
    const cls = AGENT_MODES[modeOfSpec(spec)].assetClass;
    const inMode = (m: ResolvedMarket) => assetClassOf(m.symbol) === cls;
    const trades = store.allTradesAsc(agent.id);
    // markets the owner removed from the strategy while the agent still holds what it bought there: sell-only, never stranded
    const bought = [...new Set(trades.filter((t) => t.side === "buy" && !spec.markets.includes(t.market)).map((t) => t.market))];
    const markets = agentUniverse(spec.markets, known, heldSymbols(free, mids), this.cfg.runner.allModeShortlist, canBuy, isOpen, inMode, bought);
    const positions: Position[] = [];
    // Held positions are priced at the order book mid, not the last price: on thin pairs the last trade can be far from
    // the book (a false trailing peak would trigger a premature sell).
    for (const m of markets) {
      const q = Math.max(0, free[m.symbol] ?? 0);
      if (!(q > 0) || !((mids[m.symbol] ?? 0) * q >= POSITION_DUST_USD)) continue;
      const book = await this.cache.get<OrderBook>(`runner:book:${m.coin}`, 10_000, () => exchange.l2Book(m.coin)).catch(() => null);
      const bid = book?.bids[0]?.px;
      const ask = book?.asks[0]?.px;
      if (bid && ask && ask >= bid) mids[m.symbol] = (bid + ask) / 2;
    }
    for (const m of markets) {
      const b = bal.get(m.symbol);
      const qty = Math.max(0, free[m.symbol] ?? 0);
      balances.tokens[m.symbol] = qty;
      const tracked = avgEntryFromTrades(trades, m.symbol);
      const exEntry = b && b.total > 0 && b.entryNtl > 0 ? b.entryNtl / b.total : null;
      positions.push({ market: m.symbol, qty, entryPx: tracked.avgPx ?? exEntry });
    }
    const equity = computeEquity(balances, mids);
    const unbuyable: Record<string, "min_order"> = {};
    if (isAllMarkets(spec.markets)) {
      const inSet = new Set(markets.map((m) => m.symbol));
      for (const m of known) if (m.enabled && m.resolved && !inSet.has(m.symbol) && !canBuy(m)) unbuyable[m.symbol] = "min_order";
    }
    return { markets, mids, balances, positions, equity, capital, unbuyable };
  }

  // ---------- one agent tick ----------

  /** SOL for fees of the agent wallet, lamports; null when the venue has no gas or the read fails. */
  private async gasOf(agent: AgentRecord): Promise<number | null> {
    const ex = this.d.exchange;
    if (typeof ex.gasLamports !== "function") return null;
    try {
      return await ex.gasLamports(agent.wallet);
    } catch {
      return null; // unknown: the swap itself still fails safely if fees are short
    }
  }

  async tickAgent(agent: AgentRecord): Promise<TickOutcome> {
    const { store } = this.d;
    const log = this.log;
    const now = this.now();
    const spec = agent.spec;
    if (!agent.activated || !spec) return { kind: "skipped", reason: "not_activated" };
    // SOL for fees (gas.ts). Out of it the agent pauses itself ("low_gas") and only protective sells may still go out;
    // topped up, it resumes by itself — only a gas pause, never one its owner made.
    let gasHold = false;
    const gasPaused = agent.offchainStatus === "paused" && agent.pauseReason === LOW_GAS_REASON;
    const gas = agent.offchainStatus === "ok" || gasPaused ? await this.gasOf(agent) : null;
    if (gas !== null) {
      if (gasPaused) {
        if (gas >= LOW_GAS_LAMPORTS) {
          store.setOffchainStatus(agent.id, "ok", null);
          log.info({ agentId: agent.id, lamports: gas }, "gas topped up: agent resumed by itself");
          agent = { ...agent, offchainStatus: "ok", pauseReason: null };
        } else gasHold = true;
      } else if (gasLevel(gas) === "empty") {
        store.setOffchainStatus(agent.id, "paused", LOW_GAS_REASON);
        log.warn({ agentId: agent.id, lamports: gas }, "out of SOL for fees: agent paused (protective sells only)");
        gasHold = true;
      }
    }
    if (agent.offchainStatus !== "ok" && !gasHold) return { kind: "skipped", reason: `offchain_${agent.offchainStatus}` };
    const registryProblem = await this.registryActive(agent);
    if (registryProblem) return { kind: "skipped", reason: registryProblem };
    const preset = store.getPresetById(agent.presetId);
    if (!preset) return { kind: "skipped", reason: "preset_missing" };

    const snap = await this.snapshot(agent, spec);
    if (snap.capital && !snap.capital.ok) {
      // several agents share this wallet and this one has no allocation: it must not trade the whole wallet
      store.setOffchainStatus(agent.id, "paused", `allocation_required: ${snap.capital.message}`.slice(0, 300));
      log.warn({ agentId: agent.id, reason: snap.capital.message }, "agent paused: capital allocation required");
      return { kind: "skipped", reason: "allocation_required" };
    }
    if (snap.capital?.ok) {
      if (snap.capital.scaledDown.length)
        log.info({ agentId: agent.id, symbols: snap.capital.scaledDown }, "capital: ledger scaled down to the real wallet balance");
      const adopted = snap.capital.adopted;
      const prevAdopted = store.getCapital(agent.id)?.adopted ?? {};
      const keys = Object.keys({ ...adopted, ...prevAdopted });
      if (keys.some((k) => Math.abs((adopted[k] ?? 0) - (prevAdopted[k] ?? 0)) > 1e-9)) {
        store.setAdopted(agent.id, adopted, now);
        if (Object.keys(adopted).length) log.info({ agentId: agent.id, adopted }, "capital: adopted holdings not owned by running agents");
      }
    }
    const state: AgentState = { ...agent.state };
    // Performance equity: the agent's whole wallet (or sub-account) at the tick's prices, plus profit already sent out
    // of it on purpose (Private mode sweeps), so a sweep is not a loss for the daily limit or the equity chart.
    const wallet: WalletView = snap.capital?.ok ? { usdc: snap.capital.usdc, tokens: snap.capital.tokens } : snap.balances;
    const offset = Math.max(0, this.d.equityOffset?.(agent.id) ?? 0);
    const perfEquity = walletEquity(wallet, snap.mids) + offset;
    // The equity baselines (day start / initial) must be in the same capital accounting mode as the current equity,
    // otherwise switching from "whole account" to "agent sub-account" shows a false daily loss.
    const capitalMode = snap.capital?.ok ? snap.capital.mode : "whole_account";
    // A baseline set on THIS tick from perfEquity already includes what came in and must not be shifted.
    let baselineFresh = !state.dayStart || state.dayStart.day !== utcDay(now) || state.initialEquity === undefined;
    const modeChanged = state.capitalMode !== capitalMode && perfEquity > 0;
    // Deposits and withdrawals (flows.ts): wallet changes the agent's own trades do not explain are not profit or loss
    const trades = store.allTradesAsc(agent.id);
    const prevPerf = state.perf;
    let index: number;
    let flowUsd = 0;
    let pendingUsd = prevPerf?.pendingUsd ?? 0;
    if (prevPerf && !modeChanged) {
      const f = externalFlow(prevPerf, wallet, snap.mids, trades, GAS_ASSET);
      // a sweep leaves the wallet but adds to the offset: no flow at the performance level
      flowUsd = f.usd + (offset - prevPerf.offset);
      index = chainIndex(prevPerf.index, prevPerf.equity, perfEquity, flowUsd);
      pendingUsd += flowUsd;
      // a row per deposit / withdrawal, written on a tick without own trades (a swap the balance shows a tick late
      // nets out first)
      if (f.ownTrades === 0 && Math.abs(pendingUsd) >= FLOW_ROW_MIN_USD) {
        const onlyGas = Object.keys(f.qty).length > 0 && Object.keys(f.qty).every((k) => k === GAS_ASSET);
        store.insertFlow({
          agentId: agent.id,
          fromTs: prevPerf.at,
          ts: now,
          amountUsd: pendingUsd,
          kind: onlyGas ? "gas" : pendingUsd > 0 ? "deposit" : "withdraw",
          qty: f.qty,
        });
        log.info({ agentId: agent.id, usd: Number(pendingUsd.toFixed(6)) }, "external flow: not counted as profit or loss");
        pendingUsd = 0;
      }
    } else if (prevPerf) {
      index = prevPerf.index; // the accounting view changed: nothing to compare with
    } else {
      // first tick with this accounting: continue the agent's snapshot series, assuming nothing came in or out since
      // its last snapshot
      const last = store.lastEpoch(agent.id);
      index = last ? epochIndexFromEquity(last, perfEquity) : 1;
    }
    if (modeChanged) {
      baselineFresh = true;
      if (state.capitalMode !== undefined || state.dayStart)
        log.info({ agentId: agent.id, from: state.capitalMode ?? "none", to: capitalMode }, "capital mode changed: equity baselines reset");
      state.capitalMode = capitalMode;
      state.dayStart = { day: utcDay(now), equity: perfEquity, index };
      state.initialEquity = perfEquity;
      state.netFlowUsd = 0;
    }
    // the dollar baselines move by the flow: the owner's result is equity − start − net deposits
    if (Math.abs(flowUsd) > 1e-9 && !baselineFresh) {
      if (state.dayStart) state.dayStart = { ...state.dayStart, equity: Math.max(0, state.dayStart.equity + flowUsd) };
      if (state.initialEquity !== undefined) state.netFlowUsd = (state.netFlowUsd ?? 0) + flowUsd;
    }
    if (state.initialEquity === undefined && perfEquity > 0) {
      state.initialEquity = perfEquity; // the first money in is the start, not a deposit
      state.netFlowUsd = 0;
    }
    if (!state.dayStart || state.dayStart.day !== utcDay(now)) state.dayStart = { day: utcDay(now), equity: perfEquity, index };
    state.perf = {
      index,
      equity: perfEquity,
      usdc: wallet.usdc,
      tokens: Object.fromEntries(Object.entries(wallet.tokens).filter(([, q]) => q > 0)),
      offset,
      tradeId: trades.reduce((m, t) => Math.max(m, t.id), prevPerf?.tradeId ?? 0),
      at: now,
      ...(Math.abs(pendingUsd) > 1e-9 ? { pendingUsd } : {}),
    };
    state.lastEquity = perfEquity;
    state.lastEquityAt = now;
    if (gas !== null) {
      state.gasLamports = gas;
      state.gasAt = now;
    }
    this.equity.record(agent.id, now, perfEquity); // equity series (<= 1 point per minute, right after a trade)
    state.peaks = updatePeaks(state.peaks ?? {}, snap.positions, snap.mids);
    // daily result on the performance index (flows.ts): a deposit cannot hide a loss, a withdrawal is not one; a day
    // baseline without an index uses the dollar equity
    const day = state.dayStart;
    const dailyPnlBps =
      day.index !== undefined && day.index > 0 ? (index / day.index - 1) * 10000 : day.equity > 0 ? ((perfEquity - day.equity) / day.equity) * 10000 : 0;
    const tradesToday = store.countTradesSince(agent.id, dayStartSec(now));
    const riskBase: Omit<RiskInput, "decision"> = {
      spec,
      preset,
      params: spec.params,
      markets: snap.markets,
      balances: snap.balances,
      mids: snap.mids,
      tradesToday,
      dailyPnlBps,
      protectOnly: agent.protectOnly,
      startedAt: agent.activatedAt ?? agent.createdAt,
      nowSec: now,
      limits: this.cfg.limits,
      unbuyable: snap.unbuyable,
    };

    // 2) protective stops and preset exit rules (rules.exitWhen): no AI
    // dust (below the minimum order) cannot be sold: do not fire stops on it every tick
    const minOrderUsd = this.cfg.limits.minOrderUsd;
    const sellable = snap.positions.filter((p) => p.qty * (snap.mids[p.market] ?? 0) >= minOrderUsd);
    const triggers: { market: string; reason: string; kind?: string }[] = checkProtection(preset, spec.params, sellable, snap.mids, state.peaks);
    const exitRule = preset.rules?.exitWhen;
    if (exitRule?.length) {
      const labels = indicatorLabels(preset.indicators, spec.params);
      const indSpecs = resolveIndicatorSpecs(preset.indicators, spec.params);
      for (const p of snap.positions) {
        if (!(p.qty > 0) || triggers.some((t) => t.market === p.market)) continue;
        const mid = snap.mids[p.market] ?? 0;
        if (!(p.qty * mid >= minOrderUsd)) continue;
        const m = snap.markets.find((x) => x.symbol === p.market);
        if (!m) continue;
        let byLabel: Record<string, number | null> = {};
        try {
          byLabel = await computeIndicators(indSpecs, m.coin, (coin, tf, start) => this.fetchCandles(coin, tf, start), now * 1000);
        } catch {
          continue; // no candles: the exit rule does not fire (stops still work)
        }
        if (evalConditions(exitRule, indicatorValues(labels, byLabel), mid, spec.params) === true)
          triggers.push({ market: p.market, kind: "exit_rule", reason: `Exit rule: ${describeConditions(exitRule, labels, spec.params)}` });
      }
    }
    if (triggers.length > 0) {
      const decision: AgentDecision = {
        actions: triggers.map((t) => ({ type: "sell", market: t.market, sizeBps: 10000, reason: t.reason })),
        note: "protective stops (executed by code)",
      };
      const pre = evaluateDecision({ ...riskBase, decision }, { protective: true });
      const liq = await this.liquidityPass(agent.id, pre.orders, decision, snap.markets, "clip");
      const risk = { ...pre, orders: liq.orders, rejections: [...pre.rejections, ...liq.rejections] };
      const filled = await this.execute(agent, risk.orders, "protect", state);
      store.insertDecision({ agentId: agent.id, ts: now, provider: "code", model: "protection", decision, rejections: risk.rejections });
      store.setAgentState(agent.id, state);
      log.info({ agentId: agent.id, triggers: triggers.map((t) => t.kind), filled }, "protective stops");
      return { kind: "protect", orders: risk.orders, filled, rejections: risk.rejections };
    }
    if (gasHold) {
      // paused for gas: no decisions and no buys until the wallet is topped up
      store.setAgentState(agent.id, state);
      return { kind: "skipped", reason: LOW_GAS_REASON };
    }

    // 3) is a decision due?
    const premium = await this.isPremium(agent.owner);
    const min = this.d.minIntervalSec ?? 300;
    // the interval comes from the current spec (the owner can edit it), not the registered column
    const baseInterval = spec.intervalSec || agent.intervalSec;
    const interval = premium ? baseInterval : Math.max(baseInterval, min);
    if (state.lastDecisionAt && now - state.lastDecisionAt < interval) {
      store.setAgentState(agent.id, state);
      return { kind: "not_due" };
    }
    // rebalancing (rules.rebalance): the code computes the plan; the AI is called only when the drift exceeds the band
    const codePlan = this.rebalanceActions(preset, spec, snap, state, now);
    const trigger = preset.rules?.rebalance ? codePlan.length > 0 : this.cheapTrigger(preset, spec, snap, state, now);
    if (!trigger) {
      store.setAgentState(agent.id, state);
      return { kind: "no_trigger" };
    }

    // context -> AI
    // protectOnly only ever comes from a failed AI call, and that call already held its own tick: the next decision
    // is asked with normal permissions
    const ctx = await this.buildContext(preset, spec, snap, state, dailyPnlBps, tradesToday, false, now);
    if (codePlan.length) ctx.codePlan = codePlan;
    const model = this.effectiveModel(spec.model, premium);
    const res = await this.d.llm.decide(agent.id, model, ctx);
    const protectOnly = !res.ok;
    if (protectOnly !== agent.protectOnly) store.setProtectOnly(agent.id, protectOnly);
    state.lastLlmError = res.ok ? undefined : res.errors.join(" | ").slice(0, 500);

    const labels = indicatorLabels(preset.indicators, spec.params);
    const indicators = Object.fromEntries(ctx.markets.map((m) => [m.symbol, indicatorValues(labels, m.indicators)]));
    const lastBuy = store
      .allTradesAsc(agent.id)
      .filter((t) => t.side === "buy")
      .pop();
    const pre = evaluateDecision({ ...riskBase, protectOnly, decision: res.value, indicators, secondsSinceLastBuy: lastBuy ? now - lastBuy.timestamp : null });
    const liq = await this.liquidityPass(agent.id, pre.orders, res.value, snap.markets, "strict");
    const risk = { ...pre, orders: liq.orders, rejections: [...pre.rejections, ...liq.rejections] };
    for (const r of risk.rejections)
      log.info({ agentId: agent.id, code: r.code, market: r.action?.market, type: r.action?.type }, `risk engine: rejected: ${r.message}`);
    const filled = await this.execute(agent, risk.orders, "llm", state);
    // a failed AI call says why in the feed ("AI unavailable: timeout"); a backup model says which model it replaced
    const stored = !res.ok ? { ...res.value, note: aiUnavailableNote(res.errors) } : res.fallback ? { ...res.value, fallback: res.fallback } : res.value;
    store.insertDecision({ agentId: agent.id, ts: now, provider: res.provider, model: res.model, decision: stored, rejections: risk.rejections });
    state.lastDecisionAt = now;
    state.lastDecisionMids = Object.fromEntries(snap.markets.filter((m) => (snap.mids[m.symbol] ?? 0) > 0).map((m) => [m.symbol, snap.mids[m.symbol]!]));
    store.setAgentState(agent.id, state);
    return { kind: "decided", ok: res.ok, decision: res.value, orders: risk.orders, filled, rejections: risk.rejections, provider: res.provider };
  }

  /** Rebalance plan (rules.rebalance) as actions for the AI; empty when there is no drift or it is too early (minIntervalParam). */
  rebalanceActions(preset: PresetInfo, spec: StrategySpec, snap: Snapshot, state: AgentState, now: number): AgentAction[] {
    const rb = preset.rules?.rebalance;
    if (!rb) return [];
    const minGap = numParam(spec.params, rb.minIntervalParam) ?? 0;
    if (minGap > 0 && state.lastTradeAt && now - state.lastTradeAt < minGap) return [];
    const known = new Map(snap.markets.map((m) => [m.symbol, m]));
    return rebalancePlan({
      targets: weightsParam(spec.params, rb.targetsParam) ?? {},
      bandBps: numParam(spec.params, rb.bandParam) ?? 300,
      equity: snap.equity,
      balances: snap.balances,
      mids: snap.mids,
      buyable: (s) => !!known.get(s) && known.get(s)?.buyable !== false,
    }).map((p) => ({
      type: p.type,
      market: p.market,
      sizeBps: p.sizeBps,
      reason: `Rebalance: ${p.market} is ${p.currentBps} bps of equity vs target ${p.targetBps} bps`,
    }));
  }

  /**
   * Cheap trigger without AI: first decision; a price move >= triggerMovePct since the last decision; a position near a
   * stop/take level; a scheduled time (any numeric preset param named *EverySec, e.g. buyEverySec); or the heartbeat.
   */
  cheapTrigger(preset: PresetInfo, spec: StrategySpec, snap: Snapshot, state: AgentState, now: number): boolean {
    const cfg = this.cfg.runner;
    if (!state.lastDecisionAt || !state.lastDecisionMids) return true;
    if (now - state.lastDecisionAt >= cfg.heartbeatSec) return true;
    for (const { symbol: m } of snap.markets) {
      const prev = state.lastDecisionMids[m] ?? 0;
      const cur = snap.mids[m] ?? 0;
      if (prev > 0 && cur > 0 && (Math.abs(cur - prev) / prev) * 100 >= cfg.triggerMovePct) return true;
    }
    if (nearProtection(preset, spec.params, snap.positions, snap.mids, state.peaks ?? {})) return true;
    for (const [k, v] of Object.entries(spec.params)) {
      if (k.endsWith("EverySec") && typeof v === "number" && v > 0 && now - (state.lastTradeAt ?? 0) >= v) return true;
    }
    return false;
  }

  async buildContext(
    preset: PresetInfo,
    spec: StrategySpec,
    snap: Snapshot,
    state: AgentState,
    dailyPnlBps: number,
    tradesToday: number,
    protectOnly: boolean,
    now: number,
  ): Promise<DecisionContext> {
    const indSpecs = resolveIndicatorSpecs(preset.indicators, spec.params);
    const minOrderUsd = this.cfg.limits.minOrderUsd;
    const markets: MarketContext[] = [];
    for (const m of snap.markets) {
      const open = marketOpenState(m, now * 1000);
      const mid = snap.mids[m.symbol] ?? 0;
      let indicators: Record<string, number | null> = {};
      try {
        indicators = await computeIndicators(indSpecs, m.coin, (coin, tf, start) => this.fetchCandles(coin, tf, start), now * 1000);
      } catch (e) {
        this.log.warn({ market: m.symbol, err: (e as Error).message }, "candles unavailable");
      }
      const pos = snap.positions.find((p) => p.market === m.symbol);
      const prev = state.lastDecisionMids?.[m.symbol];
      // Minimum sell as a share of the position (no absolute amounts in the prompt), accounting for the lot step and a
      // fill below mid: otherwise the AI can pick exactly the minimum share and the rounded order lands just below it.
      const posUsd = pos && pos.qty > 0 ? pos.qty * mid : 0;
      const minSell = posUsd > 0 && pos ? minSellShareBps(pos.qty, mid, m.szDecimals, minOrderUsd) : null;
      markets.push({
        symbol: m.symbol,
        midUsd: mid,
        changeSinceLastDecisionPct: prev && prev > 0 && mid > 0 ? ((mid - prev) / prev) * 100 : null,
        indicators,
        positionBps: snap.equity > 0 && pos ? ((pos.qty * mid) / snap.equity) * 10000 : 0,
        unrealizedPnlPct: pos && pos.qty > 0 && pos.entryPx ? ((mid - pos.entryPx) / pos.entryPx) * 100 : null,
        buyable: m.buyable,
        minSellShareBps: minSell !== null && minSell <= 10000 ? minSell : null,
        ...(open.open ? {} : { closed: true, closedReason: open.reason }),
        ...(m.unbuyableReason === "removed" ? { removed: true } : {}),
      });
    }
    // MIN_ORDER_MARGIN headroom for lot rounding and the fill price (for buys the lot step is already handled by `buyable`)
    const minOrderBps = snap.equity > 0 ? Math.ceil(((minOrderUsd * MIN_ORDER_MARGIN) / snap.equity) * 10000) : null;
    const venue = VENUES[spec.venue ?? DEFAULT_VENUE];
    return {
      minOrderShareBps: minOrderBps,
      preset,
      goal: spec.goal,
      risk: spec.risk,
      params: spec.params,
      markets,
      usdcBps: snap.equity > 0 ? (snap.balances.usdc / snap.equity) * 10000 : 0,
      venue: { label: venue.label, quote: venue.quote },
      dailyPnlBps,
      tradesToday,
      protectOnly,
      secondsSinceLastTrade: state.lastTradeAt ? now - state.lastTradeAt : null,
      nowIso: new Date(now * 1000).toISOString(),
    };
  }

  /**
   * Liquidity guard for EVERY order: the l2Book at execution time -> checkLiquidity.
   * strict (AI orders): reject on spread / volume / depth / impact. clip (protective stops): the size is clipped to what
   * fills within the slippage band; an exit is never blocked by spread or volume.
   */
  async liquidityPass(
    agentId: number,
    orders: ApprovedOrder[],
    decision: AgentDecision,
    markets: ResolvedMarket[],
    mode: "strict" | "clip",
  ): Promise<{ orders: ApprovedOrder[]; rejections: Rejection[] }> {
    const { exchange } = this.d;
    const cfg = this.cfg;
    const out: ApprovedOrder[] = [];
    const rejections: Rejection[] = [];
    const books = new Map<string, OrderBook | null>();
    const limits = {
      maxSpreadBps: cfg.liquidity.maxSpreadBps,
      maxSlippageBps: cfg.limits.maxSlippageBps,
      maxOrderPctOfDayVolume: cfg.liquidity.maxOrderPctOfDayVolume,
      minMarketDayVolumeUsd: cfg.liquidity.minMarketDayVolumeUsd,
      minOrderUsd: cfg.limits.minOrderUsd,
      bookBufferBps: cfg.liquidity.bookBufferBps,
    };
    for (const o of orders) {
      const action = decision.actions?.[o.index] ?? { type: o.side, market: o.market, sizeBps: 0, reason: o.reason };
      if (!books.has(o.coin)) books.set(o.coin, await exchange.l2Book(o.coin).catch(() => null));
      const book = books.get(o.coin);
      if (!book) {
        rejections.push({ index: o.index, action, code: "no_book", message: `order book for ${o.market} is unavailable` });
        continue;
      }
      const mkt = markets.find((m) => m.symbol === o.market);
      const szDecimals = mkt?.szDecimals ?? 0;
      // a sell is an exit: always the soft mode (never blocked by spread/volume, clipped to what fills)
      const orderMode = o.side === "sell" ? "clip" : mode;
      const r = checkLiquidity(
        { side: o.side, sizeBase: Number(o.sizeBase), limitPx: Number(o.limitPx), szDecimals, priceDecimals: o.priceDecimals },
        book,
        mkt?.dayVolumeUsd ?? 0,
        limits,
        orderMode,
      );
      if (!r.ok) {
        rejections.push({ index: o.index, action, code: r.code, message: r.message });
        this.log.info(
          { agentId, market: o.market, side: o.side, code: r.code, spreadBps: r.spreadBps, impactBps: r.impactBps },
          `liquidity guard: rejected: ${r.message}`,
        );
        continue;
      }
      if (r.clipped)
        this.log.warn({ agentId, market: o.market, from: o.sizeBase, to: r.sizeBase }, "liquidity guard: protective order clipped to fillable size");
      out.push({ ...o, sizeBase: r.sizeBase, limitPx: r.limitPx, notionalUsd: r.notionalUsd });
    }
    return { orders: out, rejections };
  }

  /**
   * Executes approved orders signed by the agent's wallet key. Fees charged in the received asset are handled by
   * recording the net amount of a buy. Returns the number of filled orders.
   */
  async execute(agent: AgentRecord, orders: ApprovedOrder[], source: "llm" | "protect", state: AgentState): Promise<number> {
    if (orders.length === 0) return 0;
    const { store, exchange } = this.d;
    const log = this.log;
    if (this.cfg.runner.dryRun) {
      for (const o of orders) log.info({ agentId: agent.id, ...o }, "DRY_RUN: order not sent");
      return 0;
    }
    let key: AgentKeyRef;
    try {
      key = await this.d.keys.agentKey(agent);
    } catch (e) {
      log.error({ agentId: agent.id, err: (e as Error).message }, "agent key unavailable: cannot execute orders");
      return 0;
    }
    let filled = 0;
    // a swap is not attempted without the SOL to pay for it at worst (gas.ts); sells need less than buys, so a
    // protective sell still goes out when a buy would not
    let gasBudget = await this.gasOf(agent);
    for (const o of orders) {
      if (gasBudget !== null) {
        if (!canSwap(o.side, gasBudget)) {
          log.warn({ agentId: agent.id, market: o.market, side: o.side, lamports: gasBudget }, "not enough SOL for fees: swap not attempted");
          continue;
        }
        gasBudget -= o.side === "buy" ? BUY_WORST_LAMPORTS : SELL_WORST_LAMPORTS;
      }
      const res = await exchange.placeOrder(key, {
        marketId: o.marketId,
        coin: o.coin,
        isBuy: o.side === "buy",
        price: o.limitPx,
        size: o.sizeBase,
        szDecimals: o.szDecimals,
        priceDecimals: o.priceDecimals,
        tif: o.tif,
      });
      const filledSz = res.filledSz ?? 0;
      if (res.status !== "filled" || !(filledSz > 0)) {
        log.warn({ agentId: agent.id, market: o.market, side: o.side, status: res.status, error: res.error }, "order not filled");
        continue;
      }
      const px = res.avgPx ?? Number(o.limitPx);
      const sizeUsd = filledSz * px;
      // buy: a fee taken in the bought token means the ledger records the net amount; otherwise the agent's
      // sub-account would "see" tokens that are not there
      let sizeBase = filledSz;
      if (o.side === "buy" && res.netBaseReceived !== undefined && res.netBaseReceived > 0 && res.netBaseReceived <= sizeBase) sizeBase = res.netBaseReceived;
      store.insertTrade({
        agentId: agent.id,
        owner: agent.owner,
        side: o.side,
        market: o.market,
        sizeUsd,
        sizeBase,
        price: px,
        reason: o.reason,
        orderId: res.oid ?? 0,
        timestamp: this.now(),
        source,
        exchangeOrderId: res.orderIndex ?? null,
        exchangeTxHash: res.txHash ?? null,
      });
      state.lastTradeAt = this.now();
      this.equity.markDirty(agent.id);
      filled++;
      log.info({ agentId: agent.id, market: o.market, side: o.side, sz: filledSz, px, source }, "trade filled");
    }
    return filled;
  }

  // ---------- equity snapshots ----------

  /**
   * Snapshots an epoch (equity and PnL since the start) for agents due after epochSec. The PnL is the performance index
   * (deposits and withdrawals excluded, flows.ts) when known. Returns the number of snapshots taken.
   */
  recordEpochs(): number {
    const { store } = this.d;
    const now = this.now();
    let n = 0;
    for (const a of store.listRunnableAgents()) {
      const s = a.state;
      if (s.lastEquity === undefined || !s.initialEquity) continue;
      if (s.lastEpochAt && now - s.lastEpochAt < this.cfg.runner.epochSec) continue;
      const raw = s.perf ? (s.perf.index - 1) * 10000 : ((s.lastEquity - s.initialEquity) / s.initialEquity) * 10000;
      const pnlBps = Math.max(-INT32, Math.min(INT32 - 1, Math.round(raw)));
      store.insertEpoch(a.id, s.lastEquity, pnlBps, now, s.perf?.index);
      store.setAgentState(a.id, { ...s, lastEpochAt: now });
      n++;
    }
    return n;
  }

  async tickAll(): Promise<void> {
    if (this.busy) return; // the previous tick is still running
    this.busy = true;
    try {
      for (const agent of this.d.store.listRunnableAgents()) {
        try {
          const out = await this.tickAgent(agent);
          if (out.kind === "skipped") this.log.debug({ agentId: agent.id, reason: out.reason }, "agent skipped");
        } catch (e) {
          this.log.error({ agentId: agent.id, err: (e as Error).message }, "agent tick failed");
        }
      }
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    const { runner, liquidity } = this.cfg;
    void this.refreshMarkets();
    this.timers.push(setInterval(() => void this.tickAll(), runner.tickSec * 1000));
    this.timers.push(setInterval(() => this.recordEpochs(), Math.min(runner.epochSec, 600) * 1000));
    this.timers.push(setInterval(() => void this.refreshMarkets(), liquidity.marketsSyncSec * 1000));
    void this.tickAll();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
