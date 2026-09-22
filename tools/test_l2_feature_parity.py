#!/usr/bin/env python3
import json, sys, math
import numpy as np
from l2_temporal_features import FEATURE_NAMES, derive_features

js=json.loads(open(sys.argv[1]).read())
N=1201
i=np.arange(N,dtype=np.float64)
bidp=np.column_stack([np.full(N,100-j*.01) for j in range(10)])
askp=np.column_stack([np.full(N,100.01+j*.01) for j in range(10)])
bids=np.column_stack([220-j*4+i*.001 for j in range(10)])
asks=np.column_stack([np.full(N,100+j*3,dtype=np.float64) for j in range(10)])
eps=1e-12
def imb(k):
    bv=bids[:,:k].sum(1);av=asks[:,:k].sum(1)
    return (bv-av)/(bv+av+eps)
i1,i3,i5,i10=imb(1),imb(3),imb(5),imb(10)
mid=(askp[:,0]+bidp[:,0])/2
spread=np.maximum(askp[:,0]-bidp[:,0],eps)
d0=bids[:,0]+asks[:,0]
micro=(askp[:,0]*bids[:,0]+bidp[:,0]*asks[:,0])/(d0+eps)
micro_bias=(micro-mid)/spread
depth_ratio=np.log((bids[:,:5].sum(1)+eps)/(asks[:,:5].sum(1)+eps))
base=np.column_stack([i1,i3,i5,i10,micro_bias,i1-i10,depth_ratio])
x=(i1+i3+i5+i10+2*micro_bias)/6
y=np.log1p((bids+asks).sum(1))
sp=spread/mid*10000
ts=np.array([1770000000000000000+k*1000000 for k in range(N)],dtype=np.int64)
F=derive_features(base,x,y,sp,ts)
py=F[-1]
assert js["feature_names"]==FEATURE_NAMES,(js["feature_names"],FEATURE_NAMES)
assert len(py)==len(js["values"])
for k,(a,b) in enumerate(zip(py,js["values"])):
    if not math.isclose(float(a),float(b),rel_tol=1e-9,abs_tol=1e-10):
        raise SystemExit(f"feature mismatch {k} {FEATURE_NAMES[k]}: python={a} js={b}")
print(json.dumps({"ok":True,"features":len(py),"max_abs_diff":float(np.max(np.abs(py-np.array(js["values"],dtype=float))))}))
