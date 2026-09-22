# QUICK START

## Inspect the trained benchmark model

```bash
jq . models/fi2010-microstructure-model.json
jq . results/fi2010-microstructure-proof.json
```

## Re-run the public FI-2010 proof

```bash
cd research-fi2010
bash reproduce.sh
```

## Verify live/research feature parity

```bash
python -m pip install numpy
node src/live/dump-l2-feature-fixture.mjs > /tmp/l2-js.json
PYTHONPATH=src/research python src/research/test_l2_feature_parity.py /tmp/l2-js.json
```

## Train ORCL hdr-dt-v1

You need real ORCL XNAS.ITCH MBP-10 history.

```bash
export DATABENTO_API_KEY="YOUR_KEY"
export L2_START="YYYY-MM-DD"
export L2_END="YYYY-MM-DD"
export L2_OUT_DIR="./orcl-l2-days"

python -m pip install databento pandas numpy
python src/research/databento-orcl-mbp10-backfill.py
python src/research/train-orcl-l2-100.py ./orcl-l2-days ./models/orcl-l2-model.json ./results/orcl-l2-proof.json
node src/live/finalize-l2-model.mjs ./models/orcl-l2-model.json
```

If the model returns `unproven`, stop. Do not turn it into a directional live signal.

## Run live stack

```bash
export DATABENTO_API_KEY="YOUR_KEY"
export L2_INGEST_TOKEN="$(openssl rand -hex 32)"
docker compose -f deploy/market-stack.compose.yml up -d
```

Configure the public HTTPS relay endpoint before enabling the browser live config.

See `00_README_FIRST.md` for the full contract and reasoning.
