import numpy as np

FEATURE_VERSION="hdr-dt-v1"
BASE_FEATURE_NAMES=[
    "imbalance_l1","imbalance_l3","imbalance_l5","imbalance_l10",
    "microprice_bias","near_far_imbalance","depth_ratio_l5"
]
FEATURE_NAMES=BASE_FEATURE_NAMES+[
    "xy_pressure","xy_liquidity_log","spread_bps","log_dt_us",
    "vx_log","vy_log","ax_log","ay_log",
    "hdr_self_x","hdr_self_y","hdr_local_x","hdr_local_y","hdr_global_x","hdr_global_y",
    "log_rate_10","log_rate_100","pace_ratio_log"
]
MIN_CONTEXT=1000

def signed_log(v):
    return np.sign(v)*np.log1p(np.abs(v))

def hdr_rel(cur,ref):
    return (cur-ref)/(np.abs(cur)+np.abs(ref)+1e-12)

def prev_mean(x,w):
    out=np.full(len(x),np.nan,dtype=np.float64)
    if len(x)<=w:return out
    cs=np.concatenate(([0.0],np.cumsum(x,dtype=np.float64)))
    out[w:]=(cs[w:len(x)]-cs[:len(x)-w])/w
    return out

def derive_features(base,x,y,sp,ts):
    n=len(base)
    F=np.full((n,len(FEATURE_NAMES)),np.nan,dtype=np.float64)
    F[:,:7]=base
    F[:,7]=x;F[:,8]=y;F[:,9]=sp

    d_ns=np.diff(ts.astype(np.int64))
    good_dt=d_ns>=0
    d_s=np.maximum(d_ns.astype(np.float64)/1e9,1e-9)
    logdt=np.full(n,np.nan);logdt[1:]=np.log1p(d_s*1e6)
    logdt[1:][~good_dt]=np.nan
    F[:,10]=logdt

    vx=np.full(n,np.nan);vy=np.full(n,np.nan)
    vx[1:]=(x[1:]-x[:-1])/d_s
    vy[1:]=(y[1:]-y[:-1])/d_s
    vx[1:][~good_dt]=np.nan;vy[1:][~good_dt]=np.nan

    ax=np.full(n,np.nan);ay=np.full(n,np.nan)
    if n>=3:
        adt=np.maximum((d_s[1:]+d_s[:-1])/2,1e-9)
        ax[2:]=(vx[2:]-vx[1:-1])/adt
        ay[2:]=(vy[2:]-vy[1:-1])/adt
    F[:,11]=signed_log(vx);F[:,12]=signed_log(vy)
    F[:,13]=signed_log(ax);F[:,14]=signed_log(ay)

    selfx=np.full(n,np.nan);selfy=np.full(n,np.nan)
    selfx[100:]=x[:-100];selfy[100:]=y[:-100]
    lx=prev_mean(x,10);ly=prev_mean(y,10)
    gx=prev_mean(x,1000);gy=prev_mean(y,1000)
    F[:,15]=hdr_rel(x,selfx);F[:,16]=hdr_rel(y,selfy)
    F[:,17]=hdr_rel(x,lx);F[:,18]=hdr_rel(y,ly)
    F[:,19]=hdr_rel(x,gx);F[:,20]=hdr_rel(y,gy)

    rate10=np.full(n,np.nan);rate100=np.full(n,np.nan)
    if n>10:
        dt10=(ts[10:]-ts[:-10]).astype(np.float64)/1e9
        ok=dt10>=0
        rate10[10:]=10/np.maximum(dt10,1e-9)
        rate10[10:][~ok]=np.nan
    if n>100:
        dt100=(ts[100:]-ts[:-100]).astype(np.float64)/1e9
        ok=dt100>=0
        rate100[100:]=100/np.maximum(dt100,1e-9)
        rate100[100:][~ok]=np.nan
    F[:,21]=np.log1p(rate10)
    F[:,22]=np.log1p(rate100)
    F[:,23]=np.log((rate10+1e-12)/(rate100+1e-12))
    return F
