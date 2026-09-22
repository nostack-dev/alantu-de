#!/usr/bin/env python3
import json, math, sys
from pathlib import Path
import numpy as np

ROOT=Path(sys.argv[1] if len(sys.argv)>1 else "/tmp/fi2010")
OUT=Path(sys.argv[2] if len(sys.argv)>2 else "fi2010-microstructure-proof.json")

def find(name):
    hits=list(ROOT.rglob(name))
    if not hits: raise FileNotFoundError(name)
    return hits[0]

def load(name):
    p=find(name)
    a=np.loadtxt(p, dtype=np.float64)
    if a.ndim!=2 or a.shape[0] < 45: raise ValueError(f"unexpected shape {name}: {a.shape}")
    return a

def features(a):
    x=a[:40,:].T
    # FI-2010 convention: [askP, askV, bidP, bidV] repeated for 10 levels.
    askp=x[:,0::4]; askv=x[:,1::4]; bidp=x[:,2::4]; bidv=x[:,3::4]
    eps=1e-12
    def imb(k):
        bv=bidv[:,:k].sum(1); av=askv[:,:k].sum(1)
        return (bv-av)/(bv+av+eps)
    i1=imb(1); i3=imb(3); i5=imb(5); i10=imb(10)
    ap=askp[:,0]; bp=bidp[:,0]; av=askv[:,0]; bv=bidv[:,0]
    mid=(ap+bp)/2
    spread=np.maximum(ap-bp,eps)
    micro=(ap*bv+bp*av)/(bv+av+eps)
    micro_bias=(micro-mid)/spread
    near_far=i1-i10
    depth_ratio=np.log((bidv[:,:5].sum(1)+eps)/(askv[:,:5].sum(1)+eps))
    # Cross-stock scale free only: no absolute prices or volumes.
    F=np.column_stack([i1,i3,i5,i10,micro_bias,near_far,depth_ratio])
    return np.nan_to_num(F,nan=0.0,posinf=0.0,neginf=0.0)

def labels(a):
    y=a[-5:,:].T.astype(np.int8)
    # FI-2010: 1=up, 2=stationary, 3=down.
    return np.where(y==1,1,np.where(y==3,-1,0)).astype(np.int8)

def standardize_fit(X):
    mu=X.mean(0); sd=X.std(0); sd[sd<1e-9]=1
    return mu,sd

def z(X,mu,sd): return (X-mu)/sd

def ridge_fit(X,y,lmb=8.0):
    X1=np.column_stack([np.ones(len(X)),X])
    reg=np.eye(X1.shape[1])*lmb; reg[0,0]=0
    return np.linalg.solve(X1.T@X1+reg,X1.T@y)

def score(X,b):
    return b[0]+X@b[1:]

def wilson(k,n):
    if not n:return [None,None]
    z0=1.96;p=k/n;d=1+z0*z0/n
    c=(p+z0*z0/(2*n))/d
    m=z0*math.sqrt((p*(1-p)+z0*z0/(4*n))/n)/d
    return [c-m,c+m]

def evaluate(sc,y,thr):
    pred=np.where(sc>=thr,1,np.where(sc<=-thr,-1,0))
    fire=pred!=0;n=int(fire.sum())
    if not n:return dict(n=0,coverage=0,hit=None,hit95=[None,None],directional_hit=None,flat_share=None,mean_label_edge=None)
    yp=y[fire]; pp=pred[fire]
    hits=int((pp==yp).sum())
    directional=yp!=0; dn=int(directional.sum())
    dh=int((pp[directional]==yp[directional]).sum()) if dn else 0
    return dict(
      n=n,coverage=float(n/len(y)),hit=float(hits/n),hit95=wilson(hits,n),
      directional_n=dn,directional_hit=float(dh/dn) if dn else None,
      flat_share=float((yp==0).mean()),mean_label_edge=float(np.mean(pp*yp))
    )

def choose_thr(sc,y):
    vals=np.quantile(np.abs(sc),[.50,.60,.70,.75,.80,.85,.90,.92,.94,.96,.97,.98])
    best=None
    for t in sorted(set(map(float,vals))):
        m=evaluate(sc,y,t)
        if m["n"]<3000 or m["coverage"]<.03: continue
        lo=m["hit95"][0] or 0
        # Reward evidence first, not tiny cherry-picked coverage.
        objective=lo + .10*min(.30,m["coverage"]) + .05*(m["mean_label_edge"] or 0)
        row=(objective,t,m)
        if best is None or row[0]>best[0]:best=row
    if best is None: raise RuntimeError("no validation threshold")
    return best[1],best[2]

train=load("Train_Dst_NoAuction_DecPre_CF_7.txt")
tests=[load(f"Test_Dst_NoAuction_DecPre_CF_{i}.txt") for i in (7,8,9)]
X=features(train);Y=labels(train)
cut=int(len(X)*.80)
mu,sd=standardize_fit(X[:cut])
Xfit=z(X[:cut],mu,sd); Xval=z(X[cut:],mu,sd)

result={"dataset":"FI-2010 NoAuction DecPre","train_samples":int(cut),"validation_samples":int(len(X)-cut),"test_days":[],"horizons":{}}
for h in range(5):
    yfit=Y[:cut,h].astype(float); yval=Y[cut:,h]
    b=ridge_fit(Xfit,yfit)
    sval=score(Xval,b)
    thr,valm=choose_thr(sval,yval)
    day_metrics=[];all_sc=[];all_y=[]
    for di,a in enumerate(tests,8):
        Xt=z(features(a),mu,sd); yt=labels(a)[:,h]; st=score(Xt,b)
        m=evaluate(st,yt,thr);m["day"]=di;m["samples"]=int(len(yt))
        day_metrics.append(m);all_sc.append(st);all_y.append(yt)
    sall=np.concatenate(all_sc); yall=np.concatenate(all_y)
    held=evaluate(sall,yall,thr)
    # Baseline: same coverage, L1 imbalance sign with threshold selected only on validation.
    raw_val=X[cut:,0]
    q=np.quantile(np.abs(raw_val),max(0,min(1,1-valm["coverage"])))
    base_val=np.where(raw_val>=q,1,np.where(raw_val<=-q,-1,0))
    base_test=np.concatenate([features(a)[:,0] for a in tests])
    base_pred=np.where(base_test>=q,1,np.where(base_test<=-q,-1,0)
    )
    fire=base_pred!=0; by=np.concatenate([labels(a)[:,h] for a in tests])
    bn=int(fire.sum()); bh=int((base_pred[fire]==by[fire]).sum()) if bn else 0
    baseline={"n":bn,"coverage":float(bn/len(by)) if len(by) else 0,"hit":float(bh/bn) if bn else None,"hit95":wilson(bh,bn)}
    stable=sum(1 for m in day_metrics if m["hit"] is not None and m["hit"]>.5)
    result["horizons"][str([10,20,30,50,100][h])]={
      "threshold":thr,"validation":valm,"holdout":held,"holdout_days":day_metrics,
      "stable_days_above_50":stable,"l1_imbalance_baseline":baseline,
      "coefficients":{"intercept":float(b[0]),"imb1":float(b[1]),"imb3":float(b[2]),"imb5":float(b[3]),"imb10":float(b[4]),"micro_bias":float(b[5]),"near_far":float(b[6]),"depth_ratio":float(b[7])}
    }

# Fail-closed verdict: not "alpha"; only proof that LOB state carries OOS directional information.
qualified=[]
for h,r in result["horizons"].items():
    m=r["holdout"]
    if m["n"]>=5000 and (m["hit95"][0] or 0)>.5 and r["stable_days_above_50"]==3 and m["hit"]>r["l1_imbalance_baseline"]["hit"]:
        qualified.append(h)
result["verdict"]="microstructure_predictive_oos" if qualified else "not_proven"
result["qualified_horizons"]=qualified
OUT.write_text(json.dumps(result,indent=2))
print("FI2010_PROOF_JSON "+json.dumps(result))
