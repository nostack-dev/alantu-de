# ALANTU Microstructure Research — FI-2010 proof package

## Purpose

This folder is the reproducible research record for the question:

> Does limit-order-book state contain out-of-sample directional information that could justify adding microstructure data to ALANTU?

This package does **not** claim a tradable edge. The current strict verdict is `not_proven`.

## Dataset

Dataset: **FI-2010 NoAuction DecPre**, the public benchmark used by the DeepLOB reference implementation.

Pinned upstream repository:
- repository: `zcakhaa/DeepLOB-Deep-Convolutional-Neural-Networks-for-Limit-Order-Books`
- commit: `ff14d7c2fd38bdfc143389786993d0f0236d4eb8`
- file: `data/data.zip`
- Git blob SHA: `2d8d7749caf622dd07e0df954413dc698129c766`
- size: `56,278,154 bytes`

The raw dataset is not required to live in this repository. `reproduce.sh` downloads the exact pinned byte stream and verifies it before training. The local chat bundle additionally contains the original ZIP itself.

## Label semantics

FI-2010 labels are:

- `1 = down`
- `2 = stationary`
- `3 = up`

The first exploratory run accidentally inverted up/down. That run is superseded. The committed validator and result files use the corrected mapping above.

## Split — no holdout fitting

The benchmark's first 7 days are the development period.

- Days 1–7: training source
- First 80% of that training matrix: coefficient fit
- Last 20%: threshold selection / validation
- Days 8–10: untouched holdout

Nothing from days 8–10 is used to fit standardization, coefficients, or thresholds.

## Features

Only scale-free order-book geometry is used:

1. L1 bid/ask depth imbalance
2. L3 bid/ask depth imbalance
3. L5 bid/ask depth imbalance
4. L10 bid/ask depth imbalance
5. Microprice displacement relative to spread
6. Near-vs-far depth imbalance
7. Log depth ratio over the nearest 5 levels

Absolute price and absolute volume are deliberately excluded so the model can be evaluated across the benchmark's five instruments.

## Model

For each FI-2010 prediction horizon (10, 20, 30, 50, 100 order-book events):

1. Standardize features with mean/std from fit data only.
2. Fit ridge regression with lambda = 8.
3. Score each event as:
   `score = intercept + Σ beta_i * z(feature_i)`
4. Choose a symmetric absolute score threshold on validation only.
5. Prediction:
   - score >= threshold → up
   - score <= -threshold → down
   - otherwise → no signal
6. Freeze everything.
7. Evaluate on days 8–10.

The exact means, standard deviations, coefficients and thresholds are in `fi2010-microstructure-model.json`.

## Evaluation

The result file reports:

- fired sample count
- coverage
- overall 3-state hit rate
- 95% Wilson interval
- directional-only hit rate
- stationary share
- mean signed label edge
- each holdout day separately
- an L1 imbalance baseline

The current strict gate returns:

`verdict = not_proven`

Reason: although the model contains directional information conditional on non-stationary outcomes, it does not yet establish a robust, transaction-cost-aware tradable edge. FI-2010 also is not ORCL and therefore cannot prove an ORCL-specific strategy.

## Reproduce

From this directory:

```bash
bash reproduce.sh
```

That command downloads the pinned dataset, verifies the Git blob SHA, installs NumPy into the active Python environment if needed, runs the exact validator, and regenerates the model + proof JSON.

## Production relationship

The FI-2010 proof is intentionally independent of ALANTU production.

Production microstructure code lives in:

- `../../tools/microstructure-core.mjs`
- `../../tools/microstructure-signal.mjs`
- `../../tools/alpaca-microstructure-backfill.mjs`
- `../../tools/validate-sip-edge.mjs`
- `../../tools/apply-micro-edge.mjs`
- `../../market-relay/server.mjs`

Production remains fail-closed: SIP cannot create a live directional signal unless the real ORCL walk-forward validator marks the model `validated`.
