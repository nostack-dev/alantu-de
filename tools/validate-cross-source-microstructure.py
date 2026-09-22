#!/usr/bin/env python3
import csv, io, json, math, sys, zipfile
from pathlib import Path
import numpy as np

ROOT=Path(sys.argv[1]); CBOE=Path(sys.argv[2]); OUT=Path(sys.argv[3] if len(sys.argv)>3 else "cross-source-microstructure-proof.json")
SYMS=["AAPL","MSFT","AMZN","GOOG","INTC"]
BIN=5.0; START=34200.0; END=57600.0

def rollsum(x,n):
    c=np.concatenate([[0.0],np.cumsum(x,dtype=float)])
    out=np.zeros_like(x,dtype=float)
    idx=np.arange(len(x)); lo=np.maximum(0,idx-n+1)
    out=c[idx+1]-c[lo]
    return out

def features_from_bins(bid,ask,vol,signed,count):
    mid=(bid+ask)/2
    spread=np.where(mid>0,(ask-bid)/mid*1e4,np.nan)
    v30=rollsum(vol,6); s30=rollsum(signed,6); c30=rollsum(count,6)
    v300=rollsum(vol,60); s300=rollsum(signed,60); c300=rollsum(count,60)
    flow30=np.divide(s30,v30,out=np.zeros_like(s30),where=v30>0)
    flow300=np.divide(s300,v300,out=np.zeros_like(s300),where=v300>0)
    accel=flow30-flow300
    intensity=np.divide(c30/6,c300/60,out=np.ones_like(c30),where=c300>0)
    logm=np.log(np.maximum(mid,1e-12))
    mom30=np.zeros_like(mid);mom300=np.zeros_like(mid)
    mom30[6:]=(logm[6:]-logm[:-6])*1e4
    mom300[60:]=(logm[60:]-logm[:-60])*1e4
    ret=np.zeros_like(mid);ret[1:]=np.diff(logm)*1e4
    absret=rollsum(np.abs(ret),60)/60
    F=np.column_stack([flow30,flow300,accel,np.log(np.maximum(intensity,1e-6)),spread,mom30,mom300,absret])
    return np.nan_to_num(F,nan=0,posinf=0,neginf=0),mid,spread

def lobster_symbol(zip_path,sym):
    with zipfile.ZipFile(zip_path) as z:
        names=z.namelist()
        mf=[n for n in names if "_message_10.csv" in n][0]
        bf=[n for n in names if "_orderbook_10.csv" in n][0]
        msg=np.loadtxt(io.BytesIO(z.read(mf)),delimiter=",")
        book=np.loadtxt(io.BytesIO(z.read(bf)),delimiter=",",usecols=(0,1,2,3))
    t=msg[:,0];typ=msg[:,1].astype(int);size=msg[:,3];direction=msg[:,5]
    askp=book[:,0]/10000.;bidp=book[:,2]/10000.
    nbin=int((END-START)/BIN);grid=START+(np.arange(nbin)+1)*BIN
    idx=np.searchsorted(t,grid,side="right")-1
    good=idx>=0
    bid=np.full(nbin,np.nan);ask=np.full(nbin,np.nan)
    bid[good]=bidp[idx[good]];ask[good]=askp[idx[good]]
    # forward fill any rare initial gaps
    for a in (bid,ask):
        last=np.nan
        for i in range(len(a)):
            if np.isfinite(a[i]):last=a[i]
            elif np.isfinite(last):a[i]=last
    ex=(typ==4)|(typ==5)
    bi=np.floor((t[ex]-START)/BIN).astype(int)
    ok=(bi>=0)&(bi<nbin)
    bi=bi[ok];sz=size[ex][ok];dr=direction[ex][ok]
    vol=np.bincount(bi,weights=sz,minlength=nbin).astype(float)
    signed=np.bincount(bi,weights=(-dr*sz),minlength=nbin).astype(float)
    cnt=np.bincount(bi,minlength=nbin).astype(float)
    F,mid,spread=features_from_bins(bid,ask,vol,signed,cnt)
    return {"symbol":sym,"bid":bid,"ask":ask,"F":F,"mid":mid,"spread":spread}

def cboe_iwm(path):
    nbin=int((END-START)/BIN); bid=np.full(nbin,np.nan);ask=np.full(nbin,np.nan)
    vol=np.zeros(nbin);signed=np.zeros(nbin);cnt=np.zeros(nbin)
    with path.open(newline="") as f:
        r=csv.DictReader(f)
        for row in r:
            if row["underlying_symbol"]!="IWM":continue
            ts=row["quote_datetime"].split()[1]
            hh,mm,ss=ts.split(":"); sec=float(ss); t=int(hh)*3600+int(mm)*60+sec
            if not (START<=t<END):continue
            try:p=float(row["trade_price"]);sz=float(row["trade_size"]);b=float(row["bid"]);a=float(row["ask"])
            except:continue
            if not (p>0 and sz>0 and b>0 and a>=b):continue
            bi=int((t-START)//BIN)
            bid[bi]=b;ask[bi]=a
            side=1 if p>=a else -1 if p<=b else 1 if p>(a+b)/2 else -1 if p<(a+b)/2 else 0
            vol[bi]+=sz;signed[bi]+=side*sz;cnt[bi]+=1
    for a in (bid,ask):
        last=np.nan
        for i in range(len(a)):
            if np.isfinite(a[i]):last=a[i]
            elif np.isfinite(last):a[i]=last
    valid=np.isfinite(bid)&np.isfinite(ask)
    first=np.argmax(valid)
    bid[:first]=bid[first];ask[:first]=ask[first]
    F,mid,spread=features_from_bins(bid,ask,vol,signed,cnt)
    return {"symbol":"IWM","bid":bid,"ask":ask,"F":F,"mid":mid,"spread":spread}

def future_mid_return(d,hbins):
    m=d["mid"]; y=np.full(len(m),np.nan)
    y[:-hbins]=(np.log(m[hbins:]/m[:-hbins])*1e4)
    return y

def exec_pnl(d,score,thr,hbins):
    pred=np.where(score>=thr,1,np.where(score<=-thr,-1,0))
    rows=[]
    for i,di in enumerate(pred[:-hbins]):
        if di==0:continue
        if di>0:
            entry=d["ask"][i];exitp=d["bid"][i+hbins]
            if entry>0 and exitp>0:p=(exitp/entry-1)*1e4
            else:continue
        else:
            entry=d["bid"][i];cover=d["ask"][i+hbins]
            if entry>0 and cover>0:p=(entry/cover-1)*1e4
            else:continue
        rows.append(p)
    return np.array(rows,float),pred

def wilson(k,n):
    if not n:return [None,None]
    z=1.96;p=k/n;den=1+z*z/n;c=(p+z*z/(2*n))/den;m=z*math.sqrt((p*(1-p)+z*z/(4*n))/n)/den
    return [c-m,c+m]

def metrics(p):
    n=len(p)
    if not n:return {"n":0,"hit":None,"hit95":[None,None],"mean_net_bps":None,"median_net_bps":None}
    k=int((p>0).sum())
    return {"n":n,"hit":k/n,"hit95":wilson(k,n),"mean_net_bps":float(p.mean()),"median_net_bps":float(np.median(p)),"p10_bps":float(np.quantile(p,.1)),"p90_bps":float(np.quantile(p,.9))}

def fit_ridge(X,y,lmb=20):
    X1=np.column_stack([np.ones(len(X)),X]);reg=np.eye(X1.shape[1])*lmb;reg[0,0]=0
    return np.linalg.solve(X1.T@X1+reg,X1.T@y)
def pred(X,b):return b[0]+X@b[1:]

data=[]
for s in SYMS:
    data.append(lobster_symbol(ROOT/f"LOBSTER_SampleFile_{s}_2012-06-21_10.zip",s))
iwm=cboe_iwm(CBOE)

result={"train_source":"LOBSTER NASDAQ TotalView samples 2012-06-21","independent_test_source":"Cboe Equity & ETF Trades sample IWM 2016-06-01","bin_seconds":5,"horizons":{}}
for secs in (60,300):
    hb=int(secs/BIN)
    # Strict time split on training source: first 65% fit, next 20% validation. Last 15% unused.
    fitX=[];fity=[]; val_parts=[]
    for d in data:
        n=len(d["F"]); a=int(n*.65);b=int(n*.85)
        y=future_mid_return(d,hb)
        mask=np.arange(n)<a; mask &= np.isfinite(y)
        fitX.append(d["F"][mask]);fity.append(y[mask])
    X=np.vstack(fitX);y=np.concatenate(fity)
    mu=X.mean(0);sd=X.std(0);sd[sd<1e-9]=1
    Xz=(X-mu)/sd;bcoef=fit_ridge(Xz,y)
    # Validation threshold selected on LOBSTER only and must be positive across >=4/5 names.
    val_scores=[];val_ds=[]
    for d in data:
        n=len(d["F"]);a=int(n*.65);b=int(n*.85)
        sc=pred((d["F"]-mu)/sd,bcoef); val_scores.append(sc[a:b]);val_ds.append((d,a,b,sc))
    absall=np.abs(np.concatenate(val_scores))
    candidates=np.unique(np.quantile(absall,[.50,.60,.70,.75,.80,.85,.90,.92,.94,.96,.97,.98]))
    best=None
    for th in candidates:
        per=[];allp=[]
        for d,a,b,sc in val_ds:
            sub={k:(v[a:b] if isinstance(v,np.ndarray) and len(v)==len(d["F"]) else v) for k,v in d.items()}
            pnl,_=exec_pnl(sub,sc[a:b],float(th),hb)
            per.append(metrics(pnl));allp.append(pnl)
        pp=np.concatenate([x for x in allp if len(x)]) if any(len(x) for x in allp) else np.array([])
        m=metrics(pp);positive=sum(1 for x in per if x["n"]>=30 and (x["mean_net_bps"] or -1)>0)
        if m["n"]<250 or positive<4:continue
        objective=(m["hit95"][0] or 0)+.02*min(5,max(-5,m["mean_net_bps"] or -5))+.01*positive
        if best is None or objective>best[0]:best=(objective,float(th),m,per)
    if best is None:
        # Keep best evidence candidate without pretending it passed.
        th=float(np.quantile(absall,.9));best=(None,th,None,None)
    th=best[1]
    # Independent 2016 IWM test: entire RTH, no fitting or threshold changes.
    si=pred((iwm["F"]-mu)/sd,bcoef)
    ipnl,_=exec_pnl(iwm,si,th,hb); im=metrics(ipnl)
    lob_hold=[]
    for d in data:
        n=len(d["F"]);a=int(n*.85)
        sub={k:(v[a:] if isinstance(v,np.ndarray) and len(v)==n else v) for k,v in d.items()}
        sc=pred((d["F"][a:]-mu)/sd,bcoef);p,_=exec_pnl(sub,sc,th,hb)
        lob_hold.append({"symbol":d["symbol"],**metrics(p)})
    qualified=bool(im["n"]>=100 and (im["hit95"][0] or 0)>.5 and (im["mean_net_bps"] or -999)>.5 and (im["median_net_bps"] or -999)>0)
    result["horizons"][str(secs)]={
      "threshold":th,"lobster_validation":best[2],"lobster_validation_by_symbol":best[3],
      "lobster_late_holdout":lob_hold,"cboe_iwm_2016_holdout":im,"qualified_cross_source":qualified,
      "coefficients":{"intercept":float(bcoef[0]),"features":["flow30","flow300","flow_accel","log_intensity","spread_bps","mom30_bps","mom300_bps","absret300_bps"],"beta":[float(x) for x in bcoef[1:]]}
    }

result["verdict"]="cross_source_tradeable_edge" if any(x["qualified_cross_source"] for x in result["horizons"].values()) else "not_proven_cross_source"
OUT.write_text(json.dumps(result,indent=2))
print("CROSS_SOURCE_PROOF_JSON "+json.dumps(result))
