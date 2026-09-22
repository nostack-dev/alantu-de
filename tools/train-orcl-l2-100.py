#!/usr/bin/env python3
import json, math, sys, hashlib
from pathlib import Path
import numpy as np

ROOT=Path(sys.argv[1] if len(sys.argv)>1 else "orcl-l2-days")
OUT=Path(sys.argv[2] if len(sys.argv)>2 else "orcl-l2-model.json")
REPORT=Path(sys.argv[3] if len(sys.argv)>3 else "orcl-l2-proof.json")
H=100
DEADBAND_BPS=.5
SLIPPAGE_BPS=.35
FEATURE_NAMES=["imbalance_l1","imbalance_l3","imbalance_l5","imbalance_l10","microprice_bias","near_far_imbalance","depth_ratio_l5"]

def day_files():
    return sorted(p for p in ROOT.glob("*.npz") if p.stem[:4].isdigit())

def load(p):
    z=np.load(p)
    X=np.asarray(z["features"],dtype=np.float64);mid=np.asarray(z["mid"],dtype=np.float64);sp=np.asarray(z["spread_bps"],dtype=np.float64)
    if X.ndim!=2 or X.shape[1]!=7 or len(mid)!=len(X) or len(sp)!=len(X):raise ValueError(p)
    good=np.isfinite(X).all(1)&np.isfinite(mid)&np.isfinite(sp)&(mid>0)&(sp>=0)
    return X[good],mid[good],sp[good]

def targets(mid):
    y=np.zeros(max(0,len(mid)-H),dtype=np.int8)
    if len(y)==0:return y,np.array([],dtype=np.float64)
    ret=(mid[H:]/mid[:-H]-1)*10000
    y=np.where(ret>DEADBAND_BPS,1,np.where(ret<-DEADBAND_BPS,-1,0)).astype(np.int8)
    return y,ret

def moments(files):
    n=0;s=np.zeros(7);ss=np.zeros(7)
    for p in files:
        X,_,_=load(p);n+=len(X);s+=X.sum(0);ss+=(X*X).sum(0)
    mu=s/max(1,n);var=np.maximum(1e-18,ss/max(1,n)-mu*mu);return mu,np.sqrt(var),n

def fit_ridge(files,mu,sd,lmb=8.0):
    A=np.zeros((8,8));b=np.zeros(8)
    for p in files:
        X,mid,_=load(p);y,_=targets(mid);X=X[:len(y)]
        if not len(y):continue
        Z=(X-mu)/sd;D=np.column_stack([np.ones(len(Z)),Z])
        A+=D.T@D;b+=D.T@y.astype(np.float64)
    reg=np.eye(8)*lmb;reg[0,0]=0
    return np.linalg.solve(A+reg,b)

def scores(X,mu,sd,b):
    Z=(X-mu)/sd
    return b[0]+Z@b[1:]

def signal_events(p,mu,sd,b,thr):
    X,mid,sp=load(p);y,ret=targets(mid);n=len(y)
    if not n:return []
    sc=scores(X[:n],mu,sd,b);out=[];i=10
    while i<n:
        v=sc[i]
        if abs(v)>=thr:
            d=1 if v>0 else -1
            gross=d*ret[i]
            cost=float(sp[i])+SLIPPAGE_BPS
            mom=1 if mid[i]>mid[i-10] else -1 if mid[i]<mid[i-10] else 0
            out.append({"i":i,"dir":d,"score":float(v),"y":int(y[i]),"gross":float(gross),"cost":cost,"net":float(gross-cost),
                        "l1":float(X[i,0]),"momentum":mom})
            i+=H
        else:i+=1
    return out

def wilson(k,n):
    if not n:return [None,None]
    z=1.96;p=k/n;den=1+z*z/n;c=(p+z*z/(2*n))/den;m=z*math.sqrt((p*(1-p)+z*z/(4*n))/n)/den
    return [c-m,c+m]

def metrics(byday):
    ev=[e for d in byday for e in d["events"]];n=len(ev)
    if not n:return {"n":0,"days":0,"hit":None,"mean_net_bps":None,"median_net_bps":None,"mean_net_bps95":[None,None]}
    hit=sum(1 for e in ev if e["net"]>0);nets=np.array([e["net"] for e in ev],dtype=float)
    return {"n":n,"days":sum(1 for d in byday if d["events"]),"hit":hit/n,"hit95":wilson(hit,n),
            "mean_net_bps":float(nets.mean()),"median_net_bps":float(np.median(nets)),"mean_net_bps95":bootstrap(byday)}

def bootstrap(byday,iters=2000):
    ds=[d["events"] for d in byday if d["events"]]
    if len(ds)<2:return [None,None]
    rng=np.random.default_rng(20260922);vals=[]
    for _ in range(iters):
        ix=rng.integers(0,len(ds),size=len(ds));x=[e["net"] for j in ix for e in ds[int(j)]]
        vals.append(float(np.mean(x)))
    return [float(np.quantile(vals,.025)),float(np.quantile(vals,.975))]

def daily_vol(p):
    _,mid,_=load(p)
    if len(mid)<2:return 0
    return float(np.median(np.abs(np.diff(np.log(mid)))))

files=day_files()
if len(files)<252:
    status={"status":"unproven","reason":"usable_days_lt_252","usable_days":len(files),"horizon_events":H}
    OUT.write_text(json.dumps(status,indent=2));REPORT.write_text(json.dumps(status,indent=2));print(json.dumps(status));raise SystemExit(0)

a=int(len(files)*.55);b=int(len(files)*.75)
train,val,hold=files[:a],files[a:b],files[b:]
if len(hold)<60:raise SystemExit("holdout_days_lt_60")

mu,sd,nfit=moments(train);beta=fit_ridge(train,mu,sd)

# Candidate thresholds selected on validation only.
abs_scores=[]
for p in val:
    X,mid,_=load(p);y,_=targets(mid)
    if len(y):abs_scores.append(np.abs(scores(X[:len(y)],mu,sd,beta)))
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
    status={"status":"unproven","reason":"no_validation_threshold","usable_days":len(files),"horizon_events":H}
    OUT.write_text(json.dumps(status,indent=2));REPORT.write_text(json.dumps(status,indent=2));print(json.dumps(status));raise SystemExit(0)
_,thr,valm=best

hold_by=[{"day":p.stem,"events":signal_events(p,mu,sd,beta,thr),"vol":daily_vol(p)} for p in hold]
held=metrics(hold_by)
mid=len(hold_by)//2
halves=[metrics(hold_by[:mid]),metrics(hold_by[mid:])]
vol_med=float(np.median([d["vol"] for d in hold_by]))
regimes={"low_vol":metrics([d for d in hold_by if d["vol"]<=vol_med]),"high_vol":metrics([d for d in hold_by if d["vol"]>vol_med])}

# Baselines evaluated at the exact same model signal timestamps.
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
l1m=metrics(l1);momm=metrics(mom);baseline=max(x for x in [l1m.get("mean_net_bps"),momm.get("mean_net_bps")] if x is not None)

reasons=[]
if held["n"]<500:reasons.append("holdout_signals_lt_500")
if held["days"]<60:reasons.append("holdout_days_lt_60")
if (held["hit95"][0] or 0)<=.5:reasons.append("net_hit_ci_not_above_50")
if not (held["mean_net_bps"] is not None and held["mean_net_bps"]>.5):reasons.append("mean_net_edge_le_0_5bps")
if not (held["median_net_bps"] is not None and held["median_net_bps"]>0):reasons.append("median_net_not_positive")
if not (held["mean_net_bps95"][0] is not None and held["mean_net_bps95"][0]>0):reasons.append("bootstrap_ci_not_positive")
for i,h in enumerate(halves,1):
    if h["n"]<150 or h["days"]<20 or not(h["mean_net_bps"] and h["mean_net_bps"]>0 and h["median_net_bps"] and h["median_net_bps"]>0):reasons.append(f"unstable_half_{i}")
for k,r in regimes.items():
    if r["n"]<100 or r["days"]<15 or not(r["mean_net_bps"] and r["mean_net_bps"]>0 and r["median_net_bps"] and r["median_net_bps"]>0):reasons.append("unstable_"+k)
if not (held["mean_net_bps"] is not None and held["mean_net_bps"]>baseline+.25):reasons.append("does_not_beat_baselines")

status="validated" if not reasons else "unproven"
model={
 "status":status,"symbol":"ORCL","dataset":"XNAS.ITCH","schema":"mbp-10","horizon_events":H,
 "feature_names":FEATURE_NAMES,"deadband_bps":DEADBAND_BPS,"slippage_bps":SLIPPAGE_BPS,
 "standardization":{"mean":[float(x) for x in mu],"std":[float(x) for x in sd]},
 "coefficients":[float(x) for x in beta],"threshold":float(thr),"model_id":None,
 "evidence":{"usable_days":len(files),"train_days":len(train),"validation_days":len(val),"holdout_days":held["days"],
             "holdout_signals":held["n"],"holdout":held,"halves":halves,"regimes":regimes,
             "baselines":{"l1":l1m,"momentum":momm},"reasons":reasons}
}
report={"model":model,"validation":valm,"split":{"train":[p.stem for p in train],"validation":[p.stem for p in val],"holdout":[p.stem for p in hold]},
        "protocol":{"horizon_events":100,"independent_signals":"skip next 100 events after each signal","costs":"entry spread + 0.35 bps slippage",
                    "minimum_days":252,"minimum_holdout_signals":500,"minimum_holdout_days":60}}
OUT.write_text(json.dumps(model,indent=2));REPORT.write_text(json.dumps(report,indent=2))
print("ORCL_L2_MODEL "+json.dumps({"status":status,"threshold":thr,"evidence":model["evidence"]}))
