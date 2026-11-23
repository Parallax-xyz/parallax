# @parallax/risk

The deterministic rules that outrank the AI. Pure functions, no network.

- `evaluateDecision`: checks every proposed action against the agent's markets, the preset's rights (buy/sell), the
  hard limits (trade size, position size, trades per day, daily loss, run time), protect-only mode, preset rules and
  the minimum order, and turns the rest into orders with a worst acceptable price.
- `checkLiquidity`: the order-book guard applied to every order at execution time (24h volume, spread, share of daily
  volume, depth, price impact). Protective sells are clipped to what fills, never blocked.
- `checkProtection`, `nearProtection`, `updatePeaks`: stop-loss, take-profit and trailing stops executed by code.
- `evalConditions`, `rebalancePlan`: indicator conditions of presets and the rebalancing plan to target weights.

```js
import { evaluateDecision } from "@parallax/risk";

const { orders, rejections } = evaluateDecision({ spec, preset, params, markets, balances, mids, tradesToday, dailyPnlBps, decision });
```

Apache-2.0.
