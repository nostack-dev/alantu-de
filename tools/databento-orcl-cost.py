#!/usr/bin/env python3
import json, os
try:
    import databento as db
except Exception as e:
    raise SystemExit("Install databento: python -m pip install databento") from e

key=os.environ.get("DATABENTO_API_KEY","")
if not key:
    raise SystemExit("DATABENTO_API_KEY missing")
dataset=os.environ.get("L2_DATASET","MEMX.MEMOIR")
symbol=os.environ.get("L2_SYMBOL","ORCL")
start=os.environ.get("L2_START","")
end=os.environ.get("L2_END","")
if not start or not end:
    raise SystemExit("L2_START and L2_END required")
client=db.Historical(key)
cost=float(client.metadata.get_cost(
    dataset=dataset,
    symbols=[symbol],
    schema="mbp-10",
    start=start,
    end=end,
))
unit=client.metadata.list_unit_prices(dataset=dataset)
out={
    "provider":"databento","dataset":dataset,"symbol":symbol,"schema":"mbp-10",
    "start":start,"end":end,"estimated_cost_usd":cost,
    "unit_prices":unit,
}
print(json.dumps(out))
path=os.environ.get("L2_COST_OUT")
if path:
    open(path,"w").write(json.dumps(out,indent=2)+"\n")
max_cost=os.environ.get("L2_MAX_COST_USD","")
if max_cost:
    cap=float(max_cost)
    if cost>cap:
        raise SystemExit("estimated historical cost $%.2f exceeds cap $%.2f" % (cost,cap))
