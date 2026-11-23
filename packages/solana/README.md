# @parallax/solana

The Solana venue of Parallax agents.

- `SolanaExchange` implements `ExchangeClient` (`@parallax/exchange`): pairs are `SYMBOL/USDC`, an order is one
  exact-input swap from the agent's own wallet.
- `executeSwap` (`swap.ts`): Jupiter `/build` gives the best route over the Solana DEXs; the route's worst case after
  slippage must be at or better than the order's limit price before anything is signed; the transaction gets a capped
  priority fee and a Jito tip, is sent through Jito and RPC at the same time, and the real amounts are read back from
  the confirmed transaction.
- `loadUniverse` (`markets.ts`): majors (SOL, JUP, BONK, WIF, JTO, PYTH, RAY), tokenized stocks resolved to their
  verified mints, and trending tokens kept only when verified, with a high organic score, no mint or freeze authority
  and deep liquidity. A held token that leaves the trending list stays sellable.
- `GeckoCandles`, `SampledCandles`: candles from GeckoTerminal, with the adapter's own price samples as a fallback.
- Wallets (`wallets.ts`): `newAgentWallet`, `walletBalances` (classic and Token-2022 accounts) and
  `withdrawAllToOwner`, the only transfer the module can build: everything back to the agent's owner.
- `PrivacyClient` (`privacy.ts`): deposits USDC from an agent wallet into an owner's private balance (Solana Privacy
  Rings by Helius, `@heliuslabs/spr`, pinned alpha).
- `solanaConfigFromEnv`: RPC, Jupiter, Jito, GeckoTerminal, slippage, gas reserve and confirmation settings.

Apache-2.0.
