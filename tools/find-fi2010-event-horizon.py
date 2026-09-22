#!/usr/bin/env python3
import json, math, sys
from pathlib import Path
import numpy as np

ROOT=Path(sys.argv[1] if len(sys.argv)>1 else "/tmp/fi2010")
OUT=Path(sys.argv[2] if len(sys.argv)>2 else "fi2010-horizon-sweep.json")
# Dense near the plausible information half-life, logarithmic farther out.
HORIZONS=sorted(set(
    list(range(1,51)) +
    list(range(55,201,5)) +
    list(range(225,501,25)) +
    list(range(550,1001,50)) +
    [1250,1500,1750,2000,2500,3000,4000,5000,7500,10000]
))

def find(name):
    hits=list(ROOT.rglob(name))
    if not hits: raise FileNotFoundError(name)
    return hits[0]

def load(name):
    a=np.loadtxt(find(name),dtype=np.float64)
    if a.ndim!=2 or a.shape[0]<40: raise ValueError((name,a.shape))
    return a

def book(a):
    x=a[:40,:].T
    askp=x[:,0::4]; askv=x[:,1::4]; bidp=x[:,2::4]; bidv=x[:,3::4]
    eps=1e-12
    mid=(askp[:,0]+bidp[:,0])/2
    def imb(k):
        bv=bidv[:,:k].sum(1); av=askv[:,:k].sum(1)
        return (bv-av)/(bv+av+eps)
    i1,i3,i5,i10=imb(1),imb(3),imb(5),imb(10)
    spread=np.maximum(askp[:,0]-bidp[:,0],eps)
    micro=(askp[:,0]*bidv[:,0]+bidp[:,0]*askv[:,0])/(bidv[:,0]+askv[:,0]+eps)
    micro_bias=(micro-mid)/spread
    near_far=i1-i10
    depth_ratio=np.log((bidv[:,:5].sum(1)+eps)/(askv[:,:5].sum(1)+eps))
    F=np.column_stack([i1,i3,i5,i10,micro_bias,near_far,depth_ratio])
    return np.nan_to_num(F,nan=0.0,posinf=0.0,neginf=0.0),mid

def segments(mid):
    good=(mid[:-1]>0)&(mid[1:]>0)
    r=np.zeros(len(mid)-1)
    r[good]=np.abs(np.log(mid[1:][good]/mid[:-1][good]))
    pos=r[r>0]
    if not len(pos): return [(0,len(mid))]
    med=np.median(pos); mad=np.median(np.abs(pos-med))
    cut=max(0.02,med+100*max(mad,1e-12))
    idx=np.where(r>cut)[0]+1
    starts=np.r_[0,idx]; ends=np.r_[idx,len(mid)]
    return [(int(s),int(e)) for s,e in zip(starts,ends) if e-s>=100]

def label_h(mid,segs,h,deadband_bps=.5):
    y=np.full(len(mid),99,dtype=np.int8); db=deadband_bps/10000
    for s,e in segs:
        if e-s<=h: continue
        ret=mid[s+h:e]/mid[s:e-h]-1
        y[s:e-h]=np.where(ret>db,1,np.where(ret<-db,-1,0)).astype(np.int8)
    return y

def standardize_fit(X):
    mu=X.mean(0); sd=X.std(0); sd[sd<1e-9]=1
    return mu,sd
def z(X,mu,sd): return (X-mu)/sd
def ridge_fit(X,y,lmb=8.0):
    X1=np.column_stack([np.ones(len(X)),X]); reg=np.eye(X1.shape[1])*lmb;reg[0,0]=0
    return np.linalg.solve(X1.T@X1+reg,X1.T@y)
def score(X,b): return b[0]+X@b[1:]
def wilson(k,n):
    if not n:return [None,None]
    z0=1.96;p=k/n;d=1+z0*z0/n;c=(p+z0*z0/(2*n))/d
    m=z0*math.sqrt((p*(1-p)+z0*z0/(4*n))/n)/d
    return [c-m,c+m]
def metrics(pred,y):
    fire=pred!=0;n=int(fire.sum())
    if not n:return dict(n=0,coverage=0,hit=None,directional_hit=None,edge=None)
    yp=y[fire];pp=pred[fire];directional=yp!=0;dn=int(directional.sum())
    hit=int((pp==yp).sum()); dh=int((pp[directional]==yp[directional]).sum()) if dn else 0
    return dict(n=n,coverage=float(n/len(y)),hit=float(hit/n),hit95=wilson(hit,n),
                directional_n=dn,directional_hit=float(dh/dn) if dn else None,
                flat_share=float((yp==0).mean()),edge=float(np.mean(pp*yp)))
def choose_threshold(sc,y):
    best=None
    for t in np.quantile(np.abs(sc),[.35,.4,.45,.5,.55,.6,.65,.7,.75,.8,.85,.9,.92,.94,.96]):
        p=np.where(sc>=t,1,np.where(sc<=-t,-1,0));m=metrics(p,y)
        if m["n"]<1500 or m["coverage"]<.05: continue
        obj=(m["directional_hit"] or 0)+.06*min(.4,m["coverage"])+.03*(m["edge"] or 0)
        if best is None or obj>best[0]:best=(obj,float(t),m)
    return best

train=load("Train_Dst_NoAuction_DecPre_CF_7.txt")
X,mid=book(train); seg=segments(mid)

# Chronological development only: 55% fit, 15% threshold-validation, 30% horizon-selection.
n=len(X); fit_end=int(n*.55); thr_end=int(n*.70)
mu,sd=standardize_fit(X[:fit_end]); Xz=z(X,mu,sd)
rows=[]

for h in HORIZONS:
    y=label_h(mid,seg,h)
    fit=np.where((np.arange(n)<fit_end)&(y!=99))[0]
    thv=np.where((np.arange(n)>=fit_end)&(np.arange(n)<thr_end)&(y!=99))[0]
    sel=np.where((np.arange(n)>=thr_end)&(y!=99))[0]
    if len(fit)<10000 or len(thv)<2500 or len(sel)<5000:
        rows.append({"horizon":h,"status":"insufficient"}); continue
    b=ridge_fit(Xz[fit],y[fit].astype(float))
    pick=choose_threshold(score(Xz[thv],b),y[thv])
    if not pick:
        rows.append({"horizon":h,"status":"no_threshold"}); continue
    _,thr,threshold_validation=pick
    ss=score(Xz[sel],b); pred=np.where(ss>=thr,1,np.where(ss<=-thr,-1,0)); m=metrics(pred,y[sel])

    # Matched-coverage L1 baseline threshold chosen on threshold-validation only.
    q=np.quantile(np.abs(X[thv,0]),max(0,min(1,1-threshold_validation["coverage"])))
    bp=np.where(X[sel,0]>=q,1,np.where(X[sel,0]<=-q,-1,0)); base=metrics(bp,y[sel])

    # Stability across 4 chronological blocks of the selection period.
    blocks=[]
    chunks=np.array_split(sel,4)
    for ch in chunks:
        if len(ch)<500: continue
        scb=score(Xz[ch],b);pb=np.where(scb>=thr,1,np.where(scb<=-thr,-1,0))
        blocks.append(metrics(pb,y[ch]))
    good_blocks=sum(1 for x in blocks if x["directional_hit"] is not None and x["directional_hit"]>.5 and x["edge"] is not None and x["edge"]>0)
    directional_adv=(m["directional_hit"] or 0)-(base["directional_hit"] or 0)
    score_obj=(m["directional_hit"] or 0) + 0.8*directional_adv + .04*min(.4,m["coverage"]) + .015*good_blocks
    rows.append({"horizon":h,"status":"tested","threshold":thr,"selection":m,"baseline":base,
                 "directional_advantage":directional_adv,"stable_blocks":good_blocks,"blocks":blocks,
                 "objective":score_obj})

eligible=[r for r in rows if r.get("status")=="tested" and r["selection"]["directional_n"]>=3000
          and r["selection"]["coverage"]>=.05 and r["stable_blocks"]>=3
          and r["directional_advantage"]>0]
eligible.sort(key=lambda r:r["objective"],reverse=True)
best=eligible[0] if eligible else None

out={"dataset":"FI-2010 NoAuction DecPre","selection_protocol":{
        "fit_fraction":.55,"threshold_validation_fraction":.15,"horizon_selection_fraction":.30,
        "holdout_days_8_10_used_for_selection":False,"deadband_bps":.5,
        "minimum_directional_selection_samples":3000,"minimum_coverage":.05,"minimum_stable_blocks":3},
     "tested_horizons":HORIZONS,"best_development_horizon":best,"top10":eligible[:10],"curve":rows}
OUT.write_text(json.dumps(out,indent=2))
print("HORIZON_SWEEP_JSON "+json.dumps(out))
