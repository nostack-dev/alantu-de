# ORCL microstructure proof verdict

**Status: NOT PROVEN — NO-GO for predictive trading claims.**

This is the answer to the original question: does the approach *actually hold* and produce useful ORCL predictions?

## What is proven

Order-book microstructure contains measurable information about future price direction. This is supported both by the independent FI-2010 replication in this repository and by published ORCL-specific LOBSTER research.

## What is not proven

A reliable, actionable ORCL trading edge is **not** proven.

The strongest ORCL-specific external test we found uses tick-by-tick 10-level LOBSTER data over 2017–2019 and evaluates DeepLOB not only with classification metrics but with the paper's transaction-level practicability metric, **pT**.

For ORCL:

| Horizon | Potential transactions | pT @ .3 | pT @ .5 | pT @ .7 | pT @ .9 |
| --- | ---: | ---: | ---: | ---: | ---: |
| H10 | 62,514 | 12% | 11% | 4% | 0% |
| H50 | 41,516 | 16% | 15% | 8% | 0% |
| H100 | 31,524 | 17% | 16% | 11% | 0% |

The important result is the divergence between conventional model metrics and practical transaction correctness. Example: at H50 / threshold .9, ORCL reaches **MCC .65 / F1 .71 while pT is 0**. A model can therefore look statistically strong while being useless for correctly timing a complete transaction.

Source: Briola, Bartolucci & Aste, *Deep limit order book forecasting: a microstructural guide*, Quantitative Finance 25(7), 2025, DOI 10.1080/14697688.2025.2522911. Open code: FinancialComputingUCL/LOBFrame.

## ALANTU evidence

Our own tests reached the same qualitative conclusion:

- OHLCV/sentiment `Vorimpuls`: no stable held-out edge.
- Regime-relative price/volume + QQQ/IGV: failed held-out test.
- Structural breakout: small gross effect, not robust enough after costs.
- Overextension reversal: looked promising on one 60-day split, then failed on 2-year hourly validation.
- Cross-stock ignition: failed held-out generalization.
- FI-2010 LOB replication: real directional information exists, but strict actionable gate remained `not_proven`.

## Production decision

ALANTU must **not** display a predictive directional edge unless a current ORCL-specific dataset passes the long-form promotion protocol below.

### Required promotion evidence

A model is eligible only if all are true:

1. Current ORCL trades + contemporaneous NBBO/L2 data.
2. At least **252 usable trading days** spanning multiple regimes.
3. Strict chronological walk-forward folds; no random split.
4. No feature, normalization, threshold or model selection may see its test fold.
5. At least **500 independent holdout signals** across **60+ holdout days**.
6. Net returns after observed spread plus conservative slippage are positive in aggregate.
7. Mean **and median** net edge are positive.
8. 95% bootstrap CI for mean net edge is above zero.
9. Positive net edge in both halves of every accepted holdout and in high-/low-volatility regimes.
10. Must beat simple baselines: price momentum, L1 imbalance, and no-model direction at matched coverage.
11. At least one fully untouched final test block remains after model selection.
12. Shadow-live must reproduce the offline feature/model path before any UI promotion.

Until all 12 pass, the production status is **NO EDGE / NOT PROVEN**.

## Sources

- https://pmc.ncbi.nlm.nih.gov/articles/PMC12315853/
- https://doi.org/10.1080/14697688.2025.2522911
- https://github.com/FinancialComputingUCL/LOBFrame
