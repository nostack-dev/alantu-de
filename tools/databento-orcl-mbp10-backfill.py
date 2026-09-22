#!/usr/bin/env python3
import os, sys, json
from pathlib import Path
from datetime import date, datetime, timedelta
import numpy as np
import pandas as pd

try:
    import databento as db
except Exception as e:
    raise SystemExit("Install databento: python -m pip install databento pandas numpy") from e

KEY=os.environ.get("DATABENTO_API_KEY","")
if not KEY:
    raise SystemExit("DATABENTO_API_KEY missing; no fake fallback")

START=os.environ.get("L2_START", sys.argv[1] if len(sys.argv)>1 else "")
END=os.environ.get("L2_END", sys.argv[2] if len(sys.argv)>2 else "")
OUT=Path(os.environ.get("L2_OUT_DIR", sys.argv[3] if len(sys.argv)>3 else "orcl-l2-days"))
SYMBOL=os.environ.get("L2_SYMBOL","ORCL").upper()
DATASET=os.environ.get("L2_DATASET","XNAS.ITCH")
SCHEMA="mbp-10"
if not START or not END:
    raise SystemExit("L2_START/L2_END required (YYYY-MM-DD)")
OUT.mkdir(parents=True,exist_ok=True)

def daterange(a,b):
    d=date.fromisoformat(a); z=date.fromisoformat(b)
    while d<=z:
        if d.weekday()<5: yield d
        d+=timedelta(days=1)

def price_array(s):
    a=pd.to_numeric(s,errors="coerce").to_numpy(dtype=np.float64)
    finite=a[np.isfinite(a)]
    if finite.size and np.nanmedian(np.abs(finite))>1e6:
        a=a/1e9
    return a

def event_time(df):
    if "ts_event" in df.columns:
        return pd.to_datetime(df["ts_event"],utc=True,errors="coerce")
    idx=pd.to_datetime(df.index,utc=True,errors="coerce")
    return pd.Series(idx,index=df.index)

def receive_time(df):
    if "ts_recv" in df.columns:
        return pd.to_datetime(df["ts_recv"],utc=True,errors="coerce")
    # Databento indexes schemas that contain ts_recv by the receive timestamp.
    if "ts_event" in df.columns:
        idx=pd.to_datetime(df.index,utc=True,errors="coerce")
        return pd.Series(idx,index=df.index)
    return pd.Series(pd.NaT,index=df.index,dtype="datetime64[ns, UTC]")

def extract(df,day):
    if df is None or len(df)==0:return None
    ts=event_time(df)
    tr=receive_time(df)
    local=ts.dt.tz_convert("America/New_York")
    mins=local.dt.hour*60+local.dt.minute
    mask=(local.dt.date==day)&(mins>=570)&(mins<960)
    df=df.loc[mask].copy(); ts=ts.loc[mask]; tr=tr.loc[mask]
    if len(df)<1000:return None

    bidp=[];askp=[];bids=[];asks=[]
    for i in range(10):
        suf=f"{i:02d}"
        cols=[f"bid_px_{suf}",f"ask_px_{suf}",f"bid_sz_{suf}",f"ask_sz_{suf}"]
        if any(c not in df.columns for c in cols):
            raise RuntimeError("Missing MBP-10 columns: "+",".join(c for c in cols if c not in df.columns))
        bidp.append(price_array(df[cols[0]]));askp.append(price_array(df[cols[1]]))
        bids.append(pd.to_numeric(df[cols[2]],errors="coerce").to_numpy(dtype=np.float64))
        asks.append(pd.to_numeric(df[cols[3]],errors="coerce").to_numpy(dtype=np.float64))
    bidp=np.column_stack(bidp);askp=np.column_stack(askp);bids=np.column_stack(bids);asks=np.column_stack(asks)

    good=np.isfinite(bidp).all(1)&np.isfinite(askp).all(1)&np.isfinite(bids).all(1)&np.isfinite(asks).all(1)
    good&=(bidp[:,0]>0)&(askp[:,0]>=bidp[:,0])&(bids>=0).all(1)&(asks>=0).all(1)
    if good.sum()<1000:return None
    bidp=bidp[good];askp=askp[good];bids=bids[good];asks=asks[good]
    t=pd.DatetimeIndex(ts[good]).asi8.astype(np.int64)
    tr_idx=pd.DatetimeIndex(tr[good])
    tr_ns=tr_idx.asi8.astype(np.int64)
    tr_ns[tr_idx.isna()]=-1

    eps=1e-12
    def imb(k):
        bv=bids[:,:k].sum(1);av=asks[:,:k].sum(1)
        return (bv-av)/(bv+av+eps)
    i1,i3,i5,i10=imb(1),imb(3),imb(5),imb(10)
    mid=(askp[:,0]+bidp[:,0])/2
    spread=np.maximum(askp[:,0]-bidp[:,0],eps)
    d0=bids[:,0]+asks[:,0]
    micro=np.where(d0>0,(askp[:,0]*bids[:,0]+bidp[:,0]*asks[:,0])/(d0+eps),mid)
    depth_ratio=np.log((bids[:,:5].sum(1)+eps)/(asks[:,:5].sum(1)+eps))
    micro_bias=(micro-mid)/spread
    X=np.column_stack([i1,i3,i5,i10,micro_bias,i1-i10,depth_ratio])
    x_pressure=(i1+i3+i5+i10+2*micro_bias)/6
    y_liquidity_log=np.log1p((bids+asks).sum(1))
    spread_bps=spread/mid*10000
    sequence=pd.to_numeric(df.loc[good,"sequence"],errors="coerce").fillna(0).to_numpy(dtype=np.int64) if "sequence" in df.columns else np.arange(len(mid),dtype=np.int64)
    return dict(
        ts_event_ns=t,
        ts_recv_ns=tr_ns,
        features=X.astype(np.float64),
        x_pressure=x_pressure.astype(np.float64),
        y_liquidity_log=y_liquidity_log.astype(np.float64),
        mid=mid.astype(np.float64),
        spread_bps=spread_bps.astype(np.float64),
        sequence=sequence
    )

client=db.Historical(KEY)
manifest=[]
for d in daterange(START,END):
    p=OUT/f"{d.isoformat()}.npz"
    if p.exists():
        try:
            z=np.load(p);manifest.append({"day":d.isoformat(),"events":int(len(z["mid"])),"status":"existing"});continue
        except Exception:
            p.unlink(missing_ok=True)
    try:
        data=client.timeseries.get_range(dataset=DATASET,schema=SCHEMA,symbols=SYMBOL,start=d.isoformat(),end=(d+timedelta(days=1)).isoformat())
        frame=data.to_df()
        out=extract(frame,d)
        if out is None:
            manifest.append({"day":d.isoformat(),"events":0,"status":"empty_or_thin"});continue
        np.savez_compressed(p,**out)
        manifest.append({
            "day":d.isoformat(),"events":int(len(out["mid"])),"status":"ok",
            "receive_timestamp_coverage":float(np.mean(out["ts_recv_ns"]>0))
        })
        print(json.dumps(manifest[-1]),flush=True)
    except Exception as e:
        manifest.append({"day":d.isoformat(),"events":0,"status":"error","error":str(e)[:500]})
        print(json.dumps(manifest[-1]),flush=True)

summary={
 "provider":"databento","dataset":DATASET,"schema":SCHEMA,"symbol":SYMBOL,
 "start":START,"end":END,"generated_at":datetime.utcnow().isoformat()+"Z",
 "days":manifest,"usable_days":sum(1 for x in manifest if x["status"] in ("ok","existing") and x["events"]>=1000)
}
(OUT/"manifest.json").write_text(json.dumps(summary,indent=2))
print("L2_BACKFILL "+json.dumps({k:summary[k] for k in ("provider","dataset","schema","symbol","usable_days")}))
