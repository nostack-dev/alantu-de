#!/usr/bin/env python3
"""Minimal inference example for the trained FI-2010 proof model.

Input is ONE already-computed seven-feature vector in exactly this order:
[imbalance_l1, imbalance_l3, imbalance_l5, imbalance_l10,
 microprice_bias, near_far_imbalance, depth_ratio_l5]

This example demonstrates the stored trained model only.
It is NOT the ORCL hdr-dt-v1 production model.
"""
import json, sys
from pathlib import Path
import numpy as np

MODEL=Path(sys.argv[1] if len(sys.argv)>1 else "fi2010-microstructure-model.json")
HORIZON=str(sys.argv[2] if len(sys.argv)>2 else "100")

def predict(feature_vector, model, horizon="100"):
    x=np.asarray(feature_vector,dtype=float)
    names=model["feature_names"]
    if x.shape!=(len(names),):
        raise ValueError(f"expected {len(names)} features in order {names}")
    mu=np.asarray(model["standardization"]["mean"],dtype=float)
    sd=np.asarray(model["standardization"]["std"],dtype=float)
    z=(x-mu)/sd
    h=model["horizons"][str(horizon)]
    b=np.asarray(h["coefficients"],dtype=float)
    score=float(b[0]+np.dot(b[1:],z))
    thr=float(h["threshold"])
    direction="up" if score>=thr else "down" if score<=-thr else "no_signal"
    return {"direction":direction,"score":score,"threshold":thr,"horizon_events":int(horizon)}

if __name__=="__main__":
    model=json.loads(MODEL.read_text())
    # Neutral demonstration vector = training means -> z=0.
    demo=model["standardization"]["mean"]
    print(json.dumps(predict(demo,model,HORIZON),indent=2))
