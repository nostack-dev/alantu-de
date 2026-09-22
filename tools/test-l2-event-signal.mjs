import assert from 'node:assert/strict';
import {FEATURE_NAMES,FEATURE_VERSION,l2FeatureVector,l2TemporalFeatureVector,estimateEventClock,forecastL2Event,l2ModelId,latencyMetrics} from './l2-event-signal.mjs';

const baseNs=1770000000000000000n;
function makeEvent(i){
  const ns=baseNs+BigInt(i)*1000000n; // exact 1 ms event delta
  return {
    provider:'databento',dataset:'XNAS.ITCH',schema:'mbp-10',symbol:'ORCL',
    at:new Date(Number(ns/1000000n)).toISOString(),
    ts_event_ns:String(ns),
    ts_recv_ns:String(ns+100000n),
    ts_out_ns:String(ns+150000n),
    ts_local_recv_ns:String(ns+300000n),
    sequence:i,
    levels:Array.from({length:10},(_,j)=>({
      bid_px:100-j*.01,ask_px:100.01+j*.01,
      bid_sz:220-j*4+i*.001,ask_sz:100+j*3
    }))
  };
}
const hist=Array.from({length:1201},(_,i)=>makeEvent(i));
const event=hist.at(-1);
const b=l2FeatureVector(event);
assert.equal(b.values.length,7);
assert(b.x_pressure>0);
const f=l2TemporalFeatureVector(hist);
assert.equal(f.values.length,FEATURE_NAMES.length);
assert(Math.abs(f.trajectory.dt_ms-1)<1e-9);
assert(Number.isFinite(f.trajectory.vx));
assert(Number.isFinite(f.trajectory.ax));
assert(Number.isFinite(f.trajectory.hdr.self.x));
assert(Number.isFinite(f.trajectory.hdr.local.x));
assert(Number.isFinite(f.trajectory.hdr.global.x));

const clock=estimateEventClock(hist,100);
assert(clock.events_per_second>999&&clock.events_per_second<1001);
assert(clock.eta_seconds>.099&&clock.eta_seconds<.101);
const lm=latencyMetrics(event);
assert(Math.abs(lm.provider_capture_latency_ms-.1)<1e-9);
assert(Math.abs(lm.provider_gateway_ms-.05)<1e-9);
assert(Math.abs(lm.network_to_collector_ms-.15)<1e-9);
assert(Math.abs(lm.collector_latency_ms-.3)<1e-9);

const model={
 status:'validated',symbol:'ORCL',dataset:'XNAS.ITCH',schema:'mbp-10',
 feature_version:FEATURE_VERSION,horizon_events:100,feature_names:FEATURE_NAMES,
 standardization:{mean:Array(FEATURE_NAMES.length).fill(0),std:Array(FEATURE_NAMES.length).fill(1)},
 coefficients:[0,10,...Array(FEATURE_NAMES.length-1).fill(0)],threshold:.2,
 evidence:{usable_days:300,holdout_signals:800,holdout_days:70}
};
model.model_id=l2ModelId(model);
const s=forecastL2Event(event,hist,model);
assert.equal(s.status,'forecast');
assert.equal(s.direction,'up');
assert.equal(s.horizon_events,100);
assert.equal(s.feature_version,FEATURE_VERSION);
assert(Math.abs(s.trajectory.dt_ms-1)<1e-9);
console.log(JSON.stringify({ok:true,feature_count:FEATURE_NAMES.length,clock,latency:lm,trajectory:s.trajectory,forecast:{direction:s.direction,eta_seconds:s.eta_seconds}}));
