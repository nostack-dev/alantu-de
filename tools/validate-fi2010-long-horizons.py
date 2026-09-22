#!/usr/bin/env python3
import json, math, sys
from pathlib import Path
import numpy as np

ROOT=Path(sys.argv[1] if len(sys.argv)>1 else "/tmp/fi2010")
OUT=Path(sys.argv[2] if len(sys.argv)>2 else "fi2010-long-horizons.json")
HORIZONS=[200,500,1000,2000,5000,10000,20000,50000,100000,1000000]

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
    # FI-2010 concatenates instruments/days. Boundaries create jumps far larger
    # than one-event market moves. Robustly detect them from the empirical jump distribution.
    good=(mid[:-1]>0)&(mid[1:]>0)
    r=np.zeros(len(mid)-1)
    r[good]=np.abs(np.log(mid[1:][good]/mid[:-1][good]))
    pos=r[r>0]
    if not len(pos): return [(0,len(mid))]
    med=np.median(pos); mad=np.median(np.abs(pos-med))
    # Very conservative: either >2% single-event jump or >100 MAD above typical.
    cut=max(0.02, med+100*max(mad,1e-12))
    idx=np.where(r>cut)[0]+1
    starts=np.r_[0,idx]; ends=np.r_[idx,len(mid)]
    return [(int(s),int(e)) for s,e in zip(starts,ends) if e-s>=100]

def label_h(mid,segs,h,deadband_bps=0.5):
    y=np.full(len(mid),99,dtype=np.int8)
    db=deadband_bps/10000
    for s,e in segs:
        n=e-s
        if n<=h: continue
        now=mid[s:e-h]; fut=mid[s+h:e]
        ret=fut/now-1
        lab=np.where(ret>db,1,np.where(ret<-db,-1,0)).astype(np.int8)
        y[s:e-h]=lab
    return y

def standardize_fit(X):
    mu=X.mean(0); sd=X.std(0); sd[sd<1e-9]=1
    return mu,sd
def z(X,mu,sd): return (X-mu)/sd
def ridge_fit(X,y,lmb=8.0):
    X1=np.column_stack([np.ones(len(X)),X]); reg=np.eye(X1.shape[1])*lmb; reg[0,0]=0
    return np.linalg.solve(X1.T@X1+reg,X1.T@y)
def score(X,b): return b[0]+X@b[1:]
def wilson(k,n):
    if not n:return [None,None]
    z0=1.96;p=k/n;d=1+z0*z0/n;c=(p+z0*z0/(2*n))/d
    m=z0*math.sqrt((p*(1-p)+z0*z0/(4*n))/n)/d
    return [c-m,c+m]
def eval_score(sc,y,thr):
    pred=np.where(sc>=thr,1,np.where(sc<=-thr,-1,0)); fire=pred!=0
    n=int(fire.sum())
    if not n:return {"n":0,"coverage":0,"hit":None,"directional_hit":None}
    yp=y[fire]; pp=pred[fire]; directional=yp!=0; dn=int(directional.sum())
    hit=int((pp==yp).sum())
    return {"n":n,"coverage":float(n/len(y)),"hit":float(hit/n),"hit95":wilson(hit,n),
            "directional_n":dn,"directional_hit":float((pp[directional]==yp[directional]).sum()/dn) if dn else None,
            "flat_share":float((yp==0).mean()),"mean_label_edge":float(np.mean(pp*yp))}
def choose_thr(sc,y):
    best=None
    for t in np.quantile(np.abs(sc),[.5,.6,.7,.75,.8,.85,.9,.92,.94,.96,.98]):
        m=eval_score(sc,y,float(t))
        if m["n"]<1000 or m["coverage"]<.03: continue
        # use validation only
        obj=(m["directional_hit"] or 0)+.03*min(.3,m["coverage"])
        if best is None or obj>best[0]: best=(obj,float(t),m)
    return None if best is None else best[1:]

train=load("Train_Dst_NoAuction_DecPre_CF_7.txt")
tests=[load(f"Test_Dst_NoAuction_DecPre_CF_{i}.txt") for i in (7,8,9)]
X,mid=book(train); seg=segments(mid)
cut=int(len(X)*.8); mu,sd=standardize_fit(X[:cut]); Xz=z(X,mu,sd)
out={"dataset":"FI-2010 NoAuction DecPre","method":"future raw L1 midprice at exact event horizon, within detected sequence boundaries only",
     "deadband_bps":0.5,"train_samples":len(X),"train_segments":[e-s for s,e in seg],
     "test_segments":[],"horizons":{}}
test_books=[]
for a in tests:
    Ft,mt=book(a); st=segments(mt); test_books.append((Ft,mt,st)); out["test_segments"].append([e-s for s,e in st])

for h in HORIZONS:
    y=label_h(mid,seg,h)
    valid=np.where(y!=99)[0]
    fit=valid[valid<cut]; val=valid[valid>=cut]
    row={"horizon_events":h,"train_usable":int(len(fit)),"validation_usable":int(len(val))}
    # Impossible/too thin is a result, not silently skipped.
    if len(fit)<5000 or len(val)<1000:
        row["status"]="insufficient_sequence_length"
        out["horizons"][str(h)]=row
        continue
    b=ridge_fit(Xz[fit],y[fit].astype(float))
    sv=score(Xz[val],b); picked=choose_thr(sv,y[val])
    if not picked:
        row["status"]="no_validation_threshold";out["horizons"][str(h)]=row;continue
    thr,vm=picked
    all_y=[];all_sc=[];days=[]
    for di,(Ft,mt,st) in enumerate(test_books,8):
        yt=label_h(mt,st,h); mask=yt!=99
        if mask.sum()<100:
            days.append({"day":di,"usable":int(mask.sum()),"status":"insufficient"});continue
        sc=score(z(Ft[mask],mu,sd),b); yy=yt[mask]
        m=eval_score(sc,yy,thr);m["day"]=di;m["usable"]=int(mask.sum());days.append(m)
        all_y.append(yy);all_sc.append(sc)
    if not all_y:
        row["status"]="insufficient_holdout_sequence_length";out["horizons"][str(h)]=row;continue
    yy=np.concatenate(all_y);ss=np.concatenate(all_sc);held=eval_score(ss,yy,thr)
    # simple L1 imbalance baseline at matched validation coverage
    rawv=X[val,0]; q=np.quantile(np.abs(rawv),max(0,min(1,1-vm["coverage"])))
    basepred=[];basey=[]
    for Ft,mt,st in test_books:
        yt=label_h(mt,st,h); mask=yt!=99
        if not mask.any(): continue
        p=np.where(Ft[mask,0]>=q,1,np.where(Ft[mask,0]<=-q,-1,0))
        basepred.append(p);basey.append(yt[mask])
    bp=np.concatenate(basepred);by=np.concatenate(basey);fire=bp!=0
    base={"n":int(fire.sum()),"coverage":float(fire.mean()),"hit":float((bp[fire]==by[fire]).mean()) if fire.any() else None,
          "directional_hit":float((bp[fire][by[fire]!=0]==by[fire][by[fire]!=0]).mean()) if np.any(by[fire]!=0) else None}
    row.update({"status":"tested","threshold":thr,"validation":vm,"holdout":held,"holdout_days":days,"l1_baseline":base,
                "coefficients":[float(x) for x in b]})
    out["horizons"][str(h)]=row

OUT.write_text(json.dumps(out,indent=2))
print("LONG_HORIZON_JSON "+json.dumps(out))
