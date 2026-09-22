#!/usr/bin/env python3
import json, math, sys
from pathlib import Path
import numpy as np
from l2_temporal_features import FEATURE_VERSION, FEATURE_NAMES, MIN_CONTEXT, derive_features

ROOT=Path(sys.argv[1] if len(sys.argv)>1 else "orcl-l2-days")
OUT=Path(sys.argv[2] if len(sys.argv)>2 else "orcl-l2-model.json")
REPORT=Path(sys.argv[3] if len(sys.argv)>3 else "orcl-l2-proof.json")

H=100
DEADBAND_BPS=.5
SLIPPAGE_BPS=.35
ALLOWED_DATASETS={"MEMX.MEMOIR","XNAS.ITCH"}
manifest_path=ROOT/"manifest.json"
if not manifest_path.exists():
    raise SystemExit("manifest.json missing; training refuses unknown data provenance")
manifest=json.loads(manifest_path.read_text())
DATASET=str(manifest.get("dataset") or "")
if DATASET not in ALLOWED_DATASETS:
    raise SystemExit(f"unsupported dataset: {DATASET}")
if str(manifest.get("schema") or "")!="mbp-10" or str(manifest.get("symbol") or "")!="ORCL":
    raise SystemExit("manifest dataset contract mismatch")
def day_files():
    return sorted(p for p in ROOT.glob("*.npz") if p.stem[:4].isdigit())

def load(p):
    z=np.load(p)
    base=np.asarray(z["features"],dtype=np.float64)
    x=np.asarray(z["x_pressure"],dtype=np.float64)
    y=np.asarray(z["y_liquidity_log"],dtype=np.float64)
    mid=np.asarray(z["mid"],dtype=np.float64)
    sp=np.asarray(z["spread_bps"],dtype=np.float64)
    ts=np.asarray(z["ts_event_ns"],dtype=np.int64)
    tr=np.asarray(z["ts_recv_ns"],dtype=np.int64) if "ts_recv_ns" in z.files else np.full(len(mid),-1,dtype=np.int64)
    n=len(mid)
    if base.ndim!=2 or base.shape[1]!=7 or any(len(a)!=n for a in (x,y,sp,ts,tr)):
        raise ValueError(f"bad day shape {p}")
    F=derive_features(base,x,y,sp,ts)
    good=np.isfinite(F).all(1)&np.isfinite(mid)&np.isfinite(sp)&(mid>0)&(sp>=0)
    return F,mid,sp,ts,tr,good

def targets(mid):
    if len(mid)<=H:return np.array([],dtype=np.int8),np.array([],dtype=np.float64)
    ret=(mid[H:]/mid[:-H]-1)*10000
    y=np.where(ret>DEADBAND_BPS,1,np.where(ret<-DEADBAND_BPS,-1,0)).astype(np.int8)
    return y,ret

def usable_indices(F,mid,good):
    y,_=targets(mid);n=len(y)
    if not n:return np.array([],dtype=np.int64)
    mask=good[:n].copy()
    mask[:min(MIN_CONTEXT,n)]=False
    return np.where(mask)[0]

def moments(files):
    n=0;s=np.zeros(len(FEATURE_NAMES));ss=np.zeros(len(FEATURE_NAMES))
    for p in files:
        F,mid,_,_,_,good=load(p);idx=usable_indices(F,mid,good)
        if not len(idx):continue
        X=F[idx];n+=len(X);s+=X.sum(0);ss+=(X*X).sum(0)
    mu=s/max(1,n);var=np.maximum(1e-18,ss/max(1,n)-mu*mu)
    return mu,np.sqrt(var),n

def fit_ridge(files,mu,sd,lmb=8.0):
    k=len(FEATURE_NAMES)+1
    A=np.zeros((k,k));b=np.zeros(k)
    for p in files:
        F,mid,_,_,_,good=load(p);y,_=targets(mid);idx=usable_indices(F,mid,good)
        if not len(idx):continue
        Z=(F[idx]-mu)/sd;D=np.column_stack([np.ones(len(Z)),Z]);yy=y[idx].astype(np.float64)
        A+=D.T@D;b+=D.T@yy
    reg=np.eye(k)*lmb;reg[0,0]=0
    return np.linalg.solve(A+reg,b)

def scores(X,mu,sd,b):
    Z=(X-mu)/sd
    return b[0]+Z@b[1:]

def signal_events(p,mu,sd,b,thr):
    F,mid,sp,ts,tr,good=load(p);y,ret=targets(mid);n=len(y)
    if not n:return []
    sc=scores(F[:n],mu,sd,b);out=[];i=MIN_CONTEXT
    while i<n:
        if not good[i]:
            i+=1;continue
        v=sc[i]
        if abs(v)>=thr:
            d=1 if v>0 else -1
            gross=d*ret[i]
            cost=float(sp[i])+SLIPPAGE_BPS
            mom=1 if mid[i]>mid[i-10] else -1 if mid[i]<mid[i-10] else 0
            dt100=(int(ts[i])-int(ts[i-100]))/1e9 if i>=100 else None
            provider_latency_ms=((int(tr[i])-int(ts[i]))/1e6) if int(tr[i])>0 and int(tr[i])>=int(ts[i]) else None
            out.append({
                "i":i,"dir":d,"score":float(v),"y":int(y[i]),
                "gross":float(gross),"cost":cost,"net":float(gross-cost),
                "l1":float(F[i,0]),"momentum":mom,
                "forecast_window_seconds_observed":float(dt100) if dt100 is not None else None,
                "provider_latency_ms":float(provider_latency_ms) if provider_latency_ms is not None else None
            })
            i+=H
        else:i+=1
    return out

def wilson(k,n):
    if not n:return [None,None]
    z=1.96;p=k/n;den=1+z*z/n;c=(p+z*z/(2*n))/den
    m=z*math.sqrt((p*(1-p)+z*z/(4*n))/n)/den
    return [c-m,c+m]

def bootstrap(byday,iters=2000):
    ds=[d["events"] for d in byday if d["events"]]
    if len(ds)<2:return [None,None]
    rng=np.random.default_rng(20260922);vals=[]
    for _ in range(iters):
        ix=rng.integers(0,len(ds),size=len(ds))
        x=[e["net"] for j in ix for e in ds[int(j)]]
        vals.append(float(np.mean(x)))
    return [float(np.quantile(vals,.025)),float(np.quantile(vals,.975))]

def metrics(byday):
    ev=[e for d in byday for e in d["events"]];n=len(ev)
    if not n:return {"n":0,"days":0,"hit":None,"mean_net_bps":None,"median_net_bps":None,"mean_net_bps95":[None,None]}
    hit=sum(1 for e in ev if e["net"]>0);nets=np.array([e["net"] for e in ev],dtype=float)
    windows=np.array([e["forecast_window_seconds_observed"] for e in ev if e.get("forecast_window_seconds_observed") is not None],dtype=float)
    lat=np.array([e["provider_latency_ms"] for e in ev if e.get("provider_latency_ms") is not None],dtype=float)
    return {
        "n":n,"days":sum(1 for d in byday if d["events"]),
        "hit":hit/n,"hit95":wilson(hit,n),
        "mean_net_bps":float(nets.mean()),"median_net_bps":float(np.median(nets)),
        "mean_net_bps95":bootstrap(byday),
        "forecast_window_seconds_median":float(np.median(windows)) if len(windows) else None,
        "forecast_window_seconds_p90":float(np.quantile(windows,.9)) if len(windows) else None,
        "provider_latency_ms_median":float(np.median(lat)) if len(lat) else None,
        "provider_latency_coverage":float(len(lat)/n)
    }

def daily_vol(p):
    _,mid,_,_,_,_=load(p)
    if len(mid)<2:return 0
    return float(np.median(np.abs(np.diff(np.log(mid)))))

files=day_files()
if len(files)<252:
    status={"status":"unproven","reason":"usable_days_lt_252","usable_days":len(files),"dataset":DATASET,"schema":"mbp-10","symbol":"ORCL","horizon_events":H,"feature_version":FEATURE_VERSION}
    OUT.write_text(json.dumps(status,indent=2));REPORT.write_text(json.dumps(status,indent=2));print(json.dumps(status));raise SystemExit(0)

a=int(len(files)*.55);b=int(len(files)*.75)
train,val,hold=files[:a],files[a:b],files[b:]
if len(hold)<60:raise SystemExit("holdout_days_lt_60")

mu,sd,nfit=moments(train);beta=fit_ridge(train,mu,sd)

abs_scores=[]
for p in val:
    F,mid,_,_,_,good=load(p);idx=usable_indices(F,mid,good)
    if len(idx):abs_scores.append(np.abs(scores(F[idx],mu,sd,beta)))
if not abs_scores:raise SystemExit("no validation features")
all_abs=np.concatenate(abs_scores)
qs=[.50,.60,.70,.75,.80,.85,.90,.92,.94,.96,.97,.98,.99]
candidates=sorted(set(float(np.quantile(all_abs,q)) for q in qs))
best=None
for thr in candidates:
    by=[{"day":p.stem,"events":signal_events(p,mu,sd,beta,thr)} for p in val]
    m=metrics(by)
    if m["n"]<200 or m["days"]<30:continue
    obj=(m["hit95"][0] or 0)+.06*max(-2,min(4,m["mean_net_bps"] or 0))+.02*math.log1p(m["n"])
    if best is None or obj>best[0]:best=(obj,thr,m)
if best is None:
    status={"status":"unproven","reason":"no_validation_threshold","usable_days":len(files),"dataset":DATASET,"schema":"mbp-10","symbol":"ORCL","horizon_events":H,"feature_version":FEATURE_VERSION}
    OUT.write_text(json.dumps(status,indent=2));REPORT.write_text(json.dumps(status,indent=2));print(json.dumps(status));raise SystemExit(0)
_,thr,valm=best

hold_by=[{"day":p.stem,"events":signal_events(p,mu,sd,beta,thr),"vol":daily_vol(p)} for p in hold]
held=metrics(hold_by)
half=len(hold_by)//2
halves=[metrics(hold_by[:half]),metrics(hold_by[half:])]
vol_med=float(np.median([d["vol"] for d in hold_by]))
regimes={
    "low_vol":metrics([d for d in hold_by if d["vol"]<=vol_med]),
    "high_vol":metrics([d for d in hold_by if d["vol"]>vol_med])
}

l1=[];mom=[]
for d in hold_by:
    le=[];me=[]
    for e in d["events"]:
        ldir=1 if e["l1"]>0 else -1 if e["l1"]<0 else 0
        mdir=int(e["momentum"])
        if ldir:
            gross=e["gross"] if ldir==e["dir"] else -e["gross"]
            le.append({"net":gross-e["cost"]})
        if mdir:
            gross=e["gross"] if mdir==e["dir"] else -e["gross"]
            me.append({"net":gross-e["cost"]})
    l1.append({"day":d["day"],"events":le});mom.append({"day":d["day"],"events":me})
l1m=metrics(l1);momm=metrics(mom)
baseline=max(x for x in [l1m.get("mean_net_bps"),momm.get("mean_net_bps")] if x is not None)

reasons=[]
if held["n"]<500:reasons.append("holdout_signals_lt_500")
if held["days"]<60:reasons.append("holdout_days_lt_60")
if (held["hit95"][0] or 0)<=.5:reasons.append("net_hit_ci_not_above_50")
if not (held["mean_net_bps"] is not None and held["mean_net_bps"]>.5):reasons.append("mean_net_edge_le_0_5bps")
if not (held["median_net_bps"] is not None and held["median_net_bps"]>0):reasons.append("median_net_not_positive")
if not (held["mean_net_bps95"][0] is not None and held["mean_net_bps95"][0]>0):reasons.append("bootstrap_ci_not_positive")
for i,h in enumerate(halves,1):
    if h["n"]<150 or h["days"]<20 or not(h["mean_net_bps"] and h["mean_net_bps"]>0 and h["median_net_bps"] and h["median_net_bps"]>0):
        reasons.append(f"unstable_half_{i}")
for k,r in regimes.items():
    if r["n"]<100 or r["days"]<15 or not(r["mean_net_bps"] and r["mean_net_bps"]>0 and r["median_net_bps"] and r["median_net_bps"]>0):
        reasons.append("unstable_"+k)
if not (held["mean_net_bps"] is not None and held["mean_net_bps"]>baseline+.25):reasons.append("does_not_beat_baselines")

status="validated" if not reasons else "unproven"
model={
    "status":status,"symbol":"ORCL","dataset":DATASET,"schema":"mbp-10",
    "feature_version":FEATURE_VERSION,"horizon_events":H,
    "feature_names":FEATURE_NAMES,"deadband_bps":DEADBAND_BPS,"slippage_bps":SLIPPAGE_BPS,
    "standardization":{"mean":[float(x) for x in mu],"std":[float(x) for x in sd]},
    "coefficients":[float(x) for x in beta],"threshold":float(thr),"model_id":None,
    "evidence":{
        "usable_days":len(files),"train_days":len(train),"validation_days":len(val),"holdout_days":held["days"],
        "holdout_signals":held["n"],"holdout":held,"halves":halves,"regimes":regimes,
        "baselines":{"l1":l1m,"momentum":momm},"reasons":reasons
    }
}
report={
    "model":model,"validation":valm,
    "split":{"train":[p.stem for p in train],"validation":[p.stem for p in val],"holdout":[p.stem for p in hold]},
    "protocol":{
        "horizon_events":100,
        "dataset":DATASET,
        "feature_version":FEATURE_VERSION,
        "event_time":"ts_event nanoseconds",
        "delta_t":"exact exchange-event delta; zero intervals floored to 1 ns only for derivatives",
        "trajectory_xy":{"x":"coupled order-book pressure","y":"log top-10 displayed liquidity"},
        "hdr_coupling":{"self":"event t-100","local":"prior 10-event mean","global":"prior 1000-event mean"},
        "independent_signals":"skip next 100 events after each signal",
        "costs":"entry spread + 0.35 bps slippage",
        "minimum_days":252,"minimum_holdout_signals":500,"minimum_holdout_days":60
    }
}
OUT.write_text(json.dumps(model,indent=2));REPORT.write_text(json.dumps(report,indent=2))
print("ORCL_L2_MODEL "+json.dumps({"status":status,"threshold":thr,"feature_version":FEATURE_VERSION,"evidence":model["evidence"]}))
