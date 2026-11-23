# @parallax/indicators

Pure technical indicators for Parallax agents, computed from candles (ascending close prices):

- `ema`, `rsi`, `change`, `volatility`;
- `resolveIndicatorSpecs` applies an agent's parameters (timeframe, EMA periods) to a preset's indicator list;
- `computeIndicators` fetches the candles each timeframe needs once and returns values by label (`ema20_1h`, `rsi14_1h`);
  `indicatorLabel`, `candlesNeeded`, `TIMEFRAME_MS` are the helpers behind it.

No network and no state: the caller passes a candle fetcher.

Apache-2.0.
