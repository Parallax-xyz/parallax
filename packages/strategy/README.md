# @parallax/strategy

The strategy layer of Parallax agents.

- `StrategySpec` and its zod schema (`StrategySpecSchema`, `validateSpec`): preset, markets, venue, model, decision
  interval, risk profile, hard limits (`RiskBox`) and preset parameters. Extra keys are rejected.
- `specHashOf` / `canonicalJson`: keccak256 of the canonical JSON, a stable fingerprint of the exact strategy.
- `PRESETS`: DCA, Protect, Trend, Rebalance and Momentum, as data (indicators, prompt template, code-enforced rules,
  protective stops, defaults per risk profile).
- Agent modes (`AGENT_MODES`, `modeSpecFields`, `marketsForMode`): tokenized stocks or crypto, spot on Solana.
- Units for people (`formatParamValue`, `riskWords`, `durationWords`).

```js
import { modeSpecFields, PRESETS, presetDefaults, validateSpec } from "@parallax/strategy";

const dca = PRESETS.find((p) => p.key === "dca");
const spec = {
  version: 1,
  preset: "dca",
  name: "SOL DCA",
  goal: "Accumulate SOL",
  markets: ["SOL"],
  ...modeSpecFields("crypto-spot"),
  model: "my-model",
  intervalSec: 300,
  profile: "balanced",
  ...presetDefaults(dca, "balanced", "crypto-spot"),
};
const { ok, errors, specHash } = validateSpec(spec, env);
```

Apache-2.0.
