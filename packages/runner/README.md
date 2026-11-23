# @parallax/runner

The agent loop of Parallax.

`Runner` ticks every running agent (15 s by default): it reads a snapshot (prices, candles, the agent wallet), runs
protective stops and exit rules by code, asks the AI when a decision is due and something changed, passes the answer
through the risk engine and the liquidity guard, executes the approved orders with the agent's own key, and records
trades, decisions and hourly equity snapshots.

Also in this package:

- `LlmRouter`, `buildDecisionPrompt`, `loadLlmFromEnv`: any OpenAI-compatible endpoint, a fallback chain, one retry on
  an invalid answer, protect-only mode when every provider fails. Prompts carry shares and percentages only.
- `flows.ts`: deposits and withdrawals told apart from results, a time-weighted performance index, the daily loss
  limit on that index.
- `gas.ts`: SOL for fees; a swap is never attempted without enough for its worst case, an empty wallet pauses buying.
- `capital/`: the agent's capital view of its wallet (the whole wallet, or a ledger when several agents share one).
- `EncryptedKeyVault`: agent keys encrypted at rest with AES-256-GCM, bound to the wallet address.
- `MemoryStore`: a complete in-memory `RunnerStore` for tests and experiments; implement `RunnerStore` on your database
  for production.
- `AgentRegistry` (optional): where agents are registered; the runner only reads their status and wallet.

```js
import { EncryptedKeyVault, LlmRouter, loadLlmFromEnv, loadRunnerConfig, MemoryStore, Runner } from "@parallax/runner";

const store = new MemoryStore({ models });
const runner = new Runner({
  store,
  exchange, // e.g. new SolanaExchange({ config: solanaConfigFromEnv() })
  llm: new LlmRouter({ providers: loadLlmFromEnv(), models: () => store.listModels(), usage: store }),
  keys: new EncryptedKeyVault(masterKeyHex),
  config: loadRunnerConfig(),
});
runner.start();
```

See `examples/paper-agent.mjs` at the repository root for a complete run on paper.

Apache-2.0.
