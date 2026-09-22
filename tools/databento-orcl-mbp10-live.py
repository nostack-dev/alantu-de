#!/usr/bin/env python3
import os, json, queue, threading, time, urllib.request
from datetime import datetime, timezone

try:
    import databento as db
except Exception as e:
    raise SystemExit("Install databento: python -m pip install databento") from e

KEY=os.environ.get("DATABENTO_API_KEY","")
TOKEN=os.environ.get("L2_INGEST_TOKEN","")
URL=os.environ.get("L2_RELAY_INGEST_URL","http://127.0.0.1:8080/internal/l2-events")
SYMBOL=os.environ.get("L2_SYMBOL","ORCL").upper()
DATASET=os.environ.get("L2_DATASET","XNAS.ITCH")
if not KEY or not TOKEN:
    raise SystemExit("DATABENTO_API_KEY and L2_INGEST_TOKEN required; no fake fallback")

q=queue.Queue(maxsize=20000)
stop=False

def px(v):
    x=float(v)
    return x/1e9 if abs(x)>1e6 else x

def ts_iso(ns):
    return datetime.fromtimestamp(int(ns)/1e9,tz=timezone.utc).isoformat().replace("+00:00","Z")

def normalize(r):
    levels=[]
    raw=getattr(r,"levels",None)
    if raw is None or len(raw)<10:return None
    for i in range(10):
        L=raw[i]
        bp=px(getattr(L,"bid_px"));ap=px(getattr(L,"ask_px"))
        bs=int(getattr(L,"bid_sz"));a=int(getattr(L,"ask_sz"))
        if not(bp>0 and ap>=bp and bs>=0 and a>=0):return None
        levels.append({"bid_px":bp,"ask_px":ap,"bid_sz":bs,"ask_sz":a})
    return {
      "provider":"databento","dataset":DATASET,"schema":"mbp-10","symbol":SYMBOL,
      "at":ts_iso(getattr(r,"ts_event")),"sequence":int(getattr(r,"sequence",0)),
      "levels":levels
    }

def post_batch(batch):
    body=json.dumps(batch,separators=(",",":")).encode()
    req=urllib.request.Request(URL,data=body,method="POST",headers={
      "content-type":"application/json","x-alantu-ingest-token":TOKEN
    })
    with urllib.request.urlopen(req,timeout=3) as resp:
        if resp.status//100!=2:raise RuntimeError(resp.status)

def worker():
    pending=[];last=time.monotonic()
    while not stop:
        timeout=max(0.01,.10-(time.monotonic()-last))
        try:
            pending.append(q.get(timeout=timeout))
        except queue.Empty:
            pass
        if pending and (len(pending)>=50 or time.monotonic()-last>=.10):
            try:
                post_batch(pending)
                pending.clear();last=time.monotonic()
            except Exception as e:
                print("L2 relay post failed",repr(e),flush=True)
                time.sleep(.5)

threading.Thread(target=worker,daemon=True).start()

def on_record(r):
    x=normalize(r)
    if not x:return
    try:q.put_nowait(x)
    except queue.Full:
        # Data loss is fail-closed: dropping events makes the live model invalid.
        print("L2 ingest queue overflow; terminating",flush=True)
        raise SystemExit(2)

client=db.Live(key=KEY)
client.subscribe(dataset=DATASET,schema="mbp-10",symbols=SYMBOL,snapshot=True)
client.add_callback(on_record)
print(json.dumps({"service":"databento-orcl-mbp10-live","dataset":DATASET,"schema":"mbp-10","symbol":SYMBOL}),flush=True)
client.start()
client.block_for_close()
stop=True
