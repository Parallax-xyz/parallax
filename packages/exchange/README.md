# @parallax/exchange

The venue-neutral interface the Parallax runner trades through, and the helpers every venue shares.

- `ExchangeClient`: spot markets, mid prices, candles, the L2 book, wallet balances, one immediate-or-cancel order
  signed with the agent key, and (optionally) the native coin left for fees.
- `parseSpotMarkets`, `marketOpenState`, `marketTier`, `withTier`: markets as the runner keeps them, open or closed.
- `formatSpotPrice`, `formatSpotSize`, `slippageLimitPrice`: directional rounding, so a buy limit never rounds above
  and a sell limit never below the slippage cap, and sizes always round down.

`@parallax/solana` implements `ExchangeClient` for Solana; tests and examples use a paper exchange.

Apache-2.0.
