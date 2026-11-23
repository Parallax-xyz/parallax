# @parallax/privacy

Private mode of Parallax agents.

- Profit sweep (`sweep.ts`): realized profit of an agent since Private mode was turned on, minus what was already
  swept and capped by the USDC in its wallet, is deposited into the owner's private balance (Solana Privacy Rings) once
  it reaches a minimum. Failed deposits are retried. `sweepPass`, `startSweeper`, `withdrawAllToPrivate`,
  `MemoryPrivateModeStore`, and `solanaSweepChain` to wire it to `@parallax/solana`. Pass `privacy.sweptUsd` to the
  runner as `equityOffset` so a sweep is not counted as a loss.
- Browser client (`@parallax/privacy/browser`): the owner's private balance key is derived from one wallet signature
  (`sha256(signMessage("Parallax private balance v1"))`) and never leaves the tab; only the public shielded address is
  shared. A second, domain-separated key is a deposit wallet for private deposits and withdrawal fees.
  `PrivateBalance` reads balances, deposits and withdraws; `relayFetch` and `relayEndpoints` route the SDK through
  your own relay so the Helius API key stays on your server; `timingRisk` warns when a withdrawal could be matched to a
  recent deposit.
- Public views (`public-view.ts`): `scrubAmounts`, `publicTrade`, `publicDecision`, `performanceLine` and
  `publicRankingRow` show what anyone may see: returns in %, decisions and reasons, never owners, wallets or amounts.

Apache-2.0.
