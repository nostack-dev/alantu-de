# ALANTU 100E HDR-Δt — COMPLETE MODEL PACKAGE

## 0. What this package is

This archive contains the complete research, model, validation and live-integration state for the ALANTU short-horizon order-book forecasting work.

There are **two different model states** in this package and they must not be confused:

### A. Trained benchmark model — FI-2010

This model **is trained** and its exact parameters are included.

It proves that the selected order-book geometry contains out-of-sample directional information on a public benchmark. It does **not** prove a profitable ORCL strategy.

Files:
- `models/fi2010-microstructure-model.json`
- `results/fi2010-microstructure-proof.json`
- `data/FI-2010-data.zip`
- `src/research/validate-fi2010-microstructure.py`

### B. ORCL production model — hdr-dt-v1

The complete production architecture, feature contract, trainer, validator, live collector and relay are included.

The current model file is intentionally:

`status = unavailable`

because a real ORCL MBP-10 history of at least 252 usable trading days has not yet been supplied to the trainer.

**No ORCL coefficients are fabricated.**

Files:
- `models/orcl-l2-model.json`
- `src/research/train-orcl-l2-100.py`
- `src/research/l2_temporal_features.py`
- `src/live/l2-event-signal.mjs`
- `src/live/databento-orcl-mbp10-live.py`
- `src/live/market-relay-server.mjs`

---

# 1. Goal

The target is not "predict the next candle".

The production target is:

> Given the complete current ORCL top-10 limit-order-book state and its exact event-time trajectory, estimate whether the L1 midprice will be higher or lower **100 order-book events in the future**.

The model simultaneously reports the estimated wall-clock duration of those 100 future events from the current event pace:

`100E ↑ · ≈ 1.8 s`

or

`100E ↓ · ≈ 2.6 s`

If the evidence or timing quality is insufficient:

`NO SIGNAL`

This separation is intentional. Event count defines the structural horizon. Δt converts it into current real time.

---

# 2. Why Δt is part of the model

100 order-book changes in 150 ms and the same 100 changes over 20 seconds are not the same market state.

For every event:

`Δt_i = ts_event_i - ts_event_(i-1)`

The production feature vector therefore includes both state and motion:

- state Z(t)
- velocity dZ/dt
- acceleration d²Z/dt²
- event pace
- short/long pace ratio
- self/local/global relative position

This is the HDR-inspired part of the model.

---

# 3. Exact timestamps

The live collector preserves four clocks separately:

1. `ts_event` — exchange/venue event time; used for market Δt.
2. `ts_recv` — provider receive time.
3. `ts_out` — provider egress time.
4. `ts_local_recv` — timestamp when our collector receives the event.

The market dynamics use **ts_event**.

The other timestamps measure whether the forecast arrives in time to still be useful.

The relay decomposes latency into:

- venue → provider capture
- provider processing/gateway
- network/provider → our collector
- complete event → collector latency

A direction signal is suppressed when latency consumes too much of the current estimated 100-event horizon.

---

# 4. XY trajectory

The model maps every order-book event into a compact trajectory:

### X — directional book pressure

A coupled combination of:

- L1 imbalance
- L3 imbalance
- L5 imbalance
- L10 imbalance
- microprice displacement

Positive X = bid-side/upward pressure.
Negative X = ask-side/downward pressure.

### Y — displayed liquidity mass

`Y = log(1 + total displayed bid+ask size across top 10 levels)`

The state evolves as:

`P(t) = (X(t), Y(t))`

Velocity:

`V(t) = (P(t)-P(t-1)) / Δt`

Acceleration:

`A(t) = (V(t)-V(t-1)) / Δt_accel`

Signed logarithms are used for V/A features so extreme bursts do not numerically dominate the model while direction is preserved.

---

# 5. HDR self / local / global coupling

For each X and Y dimension the current state is compared against three references.

### Self

Current state relative to the same trajectory 100 events ago.

`R_self = (current - state[t-100]) / (|current| + |reference| + epsilon)`

### Local

Current state relative to the mean of the **previous 10 events**.

This measures immediate neighborhood departure.

### Global

Current state relative to the mean of the **previous 1000 events**.

This measures where the current move sits inside the broader local market regime.

All references are strictly backward-looking. No future data enters the feature vector.

---

# 6. Complete hdr-dt-v1 feature vector

The production contract contains **24 features**.

## Static book geometry

1. imbalance_l1
2. imbalance_l3
3. imbalance_l5
4. imbalance_l10
5. microprice_bias
6. near_far_imbalance
7. depth_ratio_l5

## XY state and time

8. xy_pressure
9. xy_liquidity_log
10. spread_bps
11. log_dt_us

## Motion

12. vx_log
13. vy_log
14. ax_log
15. ay_log

## HDR relations

16. hdr_self_x
17. hdr_self_y
18. hdr_local_x
19. hdr_local_y
20. hdr_global_x
21. hdr_global_y

## Event pace

22. log_rate_10
23. log_rate_100
24. pace_ratio_log

The exact implementation exists twice:

- Python for historical training
- JavaScript for live inference

CI runs a **numerical parity test** against an identical event fixture. This prevents research/live drift.

---

# 7. Target

Fixed structural horizon:

`H = 100 order-book events`

At event t:

`return_100 = mid[t+100] / mid[t] - 1`

Classification deadband:

- > +0.5 bps → UP
- < -0.5 bps → DOWN
- otherwise → STATIONARY

The model emits a directional live signal only when the continuous model score exceeds a validation-selected threshold.

---

# 8. Model family

The current production candidate is deliberately simple:

**Ridge regression, lambda = 8**

Why simple:

- deterministic
- inspectable
- very fast live
- low inference latency
- difficult to hide leakage inside
- exact same calculation can be reproduced in Python and JavaScript
- lets the data prove whether HDR/Δt adds information before moving to a larger neural model

The model uses standardized features:

`z_i = (x_i - mean_i) / std_i`

and:

`score = intercept + Σ beta_i × z_i`

Decision:

- score >= threshold → UP
- score <= -threshold → DOWN
- otherwise → NO SIGNAL

---

# 9. Chronological training protocol

No random train/test split is allowed.

For a valid ORCL run:

- first 55% of usable trading days → coefficient training
- next 20% → threshold selection
- final 25% → untouched holdout

Minimum:

- 252 usable trading days total
- 60 holdout trading days
- 500 independent holdout signals

After one counted signal, the evaluator skips the next 100 events. This prevents multiple overlapping observations of effectively the same future interval from inflating n.

---

# 10. Trading-cost treatment

Every signal is evaluated after:

- observed spread at the signal event
- + 0.35 bps conservative extra slippage

The promotion gate uses **net**, not gross, outcome.

This is not a full broker/execution simulator. Commission, taxes, queue position, market impact and broker-specific routing can matter and should be added before capital deployment.

---

# 11. Promotion gate

The ORCL model may become `validated` only if all conditions hold:

- >=252 usable ORCL trading days
- >=500 independent final-holdout signals
- >=60 final-holdout days
- lower 95% Wilson bound of net-positive signal hit rate > 50%
- mean net edge > 0.5 bps
- median net edge > 0
- lower 95% day-block bootstrap bound for mean net edge > 0
- positive first half of holdout
- positive second half of holdout
- positive low-volatility regime
- positive high-volatility regime
- beats L1 imbalance baseline
- beats short-momentum baseline

Anything else remains `unproven`.

No UI forecast is allowed from an unproven model.

---

# 12. Latency gate

Even a validated model may not emit a live signal if the current feed is too late.

Default relay limits:

- provider capture: max 50 ms
- absolute end-to-end collector latency: max 250 ms
- dynamic latency budget: max 35% of the estimated 100-event horizon

Example:

If 100 events are currently expected in 300 ms, the dynamic latency budget is ~105 ms.

A 180 ms-old signal is therefore suppressed even though 180 ms would pass the global 250 ms ceiling.

This is critical: prediction quality without enough remaining time is not actionable information.

---

# 13. Live architecture

```
NASDAQ order book
      │
      ▼
Databento XNAS.ITCH / MBP-10
      │ exact top-10 events
      │ ts_event / ts_recv / ts_out
      ▼
databento-orcl-mbp10-live.py
      │ batches ≤ ~10 ms
      │ + local receive timestamp
      ▼
authenticated internal relay endpoint
      │
      ▼
market-relay/server.mjs
      │ 1000-event context
      │ hdr-dt-v1 feature vector
      │ latency gate
      │ validated model only
      ▼
SSE "l2" event
      │
      ▼
ALANTU UI
      │
      └── 100E FORECAST ↑/↓ · ≈ X s · Δt · E2E
```

The old Yahoo path remains independent and is not used to fabricate L2 information.

---

# 14. How to train the real ORCL model

Requirements:

- Python 3.12+
- Node 22+
- a Databento API key with access to the required XNAS.ITCH MBP-10 history
- at least 252 usable ORCL sessions

Environment:

```bash
export DATABENTO_API_KEY="..."
export L2_SYMBOL="ORCL"
export L2_DATASET="XNAS.ITCH"
export L2_START="YYYY-MM-DD"
export L2_END="YYYY-MM-DD"
export L2_OUT_DIR="./orcl-l2-days"
```

Install:

```bash
python -m pip install databento pandas numpy
```

Backfill:

```bash
python src/research/databento-orcl-mbp10-backfill.py
```

Train:

```bash
python src/research/train-orcl-l2-100.py \
  ./orcl-l2-days \
  ./models/orcl-l2-model.json \
  ./results/orcl-l2-proof.json
```

Finalize deterministic model ID:

```bash
node src/live/finalize-l2-model.mjs ./models/orcl-l2-model.json
```

Inspect:

```bash
jq .status ./models/orcl-l2-model.json
jq .evidence ./models/orcl-l2-model.json
```

Do **not** deploy a model unless status is `validated`.

---

# 15. How to run live

Required secrets:

```
DATABENTO_API_KEY
L2_INGEST_TOKEN
```

Generate a strong private relay token yourself. It is not included in this archive.

Start relay and collector using:

```bash
docker compose -f deploy/market-stack.compose.yml up -d
```

The relay loads the current validated model and accepts L2 events only through its private authenticated ingest endpoint.

The browser never receives provider credentials.

---

# 16. What the user sees

Only after a model has passed every gate:

`100E FORECAST ↑ · L2 · +100 Events · ≈ 1.84 s · Δt 1.17 ms · E2E 24.3 ms`

The three geometry axes become:

- Self
- Lokal
- Global

They visualize the current directional-pressure relation of the current state to the three HDR reference scales.

No validated model → no 100E direction.

---

# 17. Current evidence status

## FI-2010

A trained benchmark model is included.

It demonstrates that order-book geometry can contain out-of-sample directional information.

The broader strict verdict remains `not_proven` as a trading strategy.

## Published ORCL evidence

The package includes the ORCL-specific external evidence file covering the published LOBSTER/DeepLOB study over 2017–2019.

The important lesson is that strong classification metrics do not automatically become good transaction timing.

## Real current ORCL hdr-dt-v1

**Not trained yet.**

Reason:

The package does not contain 252+ current ORCL XNAS.ITCH MBP-10 sessions with exact event timestamps. Fabricating or substituting candle data would destroy the central Δt/L2 premise.

The entire training and live path is ready; coefficients must only be created from the real historical feed.

---

# 18. Reproducibility

This archive includes:

- exact FI-2010 source data
- source-data hashes
- exact benchmark model
- exact benchmark proof
- long-horizon results
- horizon-sweep results
- all research scripts
- Python/JS feature parity fixtures
- ORCL L2 backfill
- ORCL trainer
- live model engine
- latency decomposition
- Databento collector
- relay
- Dockerfiles
- compose file
- CI workflows
- current ALANTU UI source
- external evidence
- model-status files
- source revision manifest

No API keys, passwords, provider tokens or broker credentials are included.

---

# 19. Non-negotiable integrity rule

Never replace missing L2/timestamp data with synthetic values in a production proof.

If:

- exact top-10 levels are unavailable,
- event timestamps are missing,
- receive timestamps are missing for latency measurement,
- sequence continuity is broken,
- model contract differs,
- model ID differs,
- holdout gate fails,
- or latency budget fails,

the correct output is:

**NO SIGNAL**

That is part of the model, not an error condition.
