# ORCL 100-event forecast implementation

## Exact target

Predict the sign of the ORCL Nasdaq midprice **100 order-book events ahead**.

This is not "the next 100 trades". The event clock is the sequence of MBP-10 order-book updates. Live ALANTU converts 100 events into an estimated wall-clock horizon from the current event rate and displays that as `≈ X s`.

## Data contract

Live and historical data must expose the top 10 bid/ask price levels and sizes for every book event.

Canonical provider implementation:
- provider: Databento
- dataset: `XNAS.ITCH`
- schema: `mbp-10`
- symbol: `ORCL`

The provider exposes every top-10 market-depth update. The ALANTU model uses exactly the same seven scale-free features used in the independent FI-2010 experiment:

1. L1 depth imbalance
2. L3 depth imbalance
3. L5 depth imbalance
4. L10 depth imbalance
5. microprice displacement / spread
6. L1 minus L10 imbalance
7. log L5 bid/ask depth ratio

## Model

- fixed horizon: **100 events**
- target: future L1 midprice at event `t+100`
- deadband: ±0.5 bps => no-direction target
- model: ridge regression, lambda 8
- features standardized on training data only
- threshold selected on validation data only
- after a signal, the evaluator skips 100 events before counting another signal; holdout observations are therefore not overlapping copies of the same future interval

## Split

Chronological only:

- first 55% of usable trading days: coefficient fit
- next 20%: signal threshold selection
- final 25%: untouched holdout

Minimum total history: **252 usable trading days**.
Minimum final holdout: **60 days**.

## Costs

Each candidate signal is evaluated after:
- observed entry spread
- +0.35 bps slippage

No gross-only promotion is allowed.

## Promotion gate

`status=validated` is impossible unless all hold:

- ≥252 usable ORCL trading days
- ≥500 independent holdout signals
- ≥60 holdout days
- lower 95% Wilson bound for net-positive hit rate > 50%
- mean net edge > 0.5 bps
- median net edge > 0
- day-block-bootstrap 95% lower bound for mean net edge > 0
- positive low-volatility regime
- positive high-volatility regime
- stable first and second halves of holdout
- beats L1 imbalance and short momentum baselines at the same model signal timestamps

Until then `orcl-l2-model.json` stays `unavailable` or `unproven`.

## Live path

`databento-orcl-mbp10-live.py`
→ authenticated internal ingest
→ `market-relay/server.mjs`
→ `l2-event-signal.mjs`
→ latest 100-event forecast
→ SSE
→ ALANTU browser.

The browser accepts the forecast only when:
- static model says `validated`
- relay model says `validated`
- model IDs match
- data is <5 seconds old
- horizon is exactly 100 events.

UI text is:
`100E FORECAST ↑/↓ · L2 · nächste 100 Events · ≈ X s`

No model pass = no directional L2 signal.

## Files

- `tools/databento-orcl-mbp10-backfill.py`
- `tools/train-orcl-l2-100.py`
- `tools/l2-event-signal.mjs`
- `tools/finalize-l2-model.mjs`
- `tools/databento-orcl-mbp10-live.py`
- `market-relay/server.mjs`
- `orcl-l2-model.json`
- `.github/workflows/orcl-l2-proof.yml`
- `deploy/market-stack.compose.yml`
