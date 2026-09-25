import assert from 'node:assert/strict';
import {extractV5Features,structuralV5Score,v5BarrierBps,fitV5Logistic,predictV5Logistic,evaluateV5Path,summarizeV5State,V5_VERSION,V5_FEATURE_NAMES} from './yahoo-monetary-v5.mjs';

function seriesFor(base,drift,now){
  const a=[];let day=100000;
  for(let s=360;s>=0;s--){
    const recv=now-s*1000,price=base*Math.exp((drift*(360-s)/360)/10000);
    day+=100;a.push({t:recv-200,p:price,dv:100,day_volume:day,recv_at:recv});
  }
  return a;
}
const now=Date.parse('2026-09-24T14:00:00Z');
const series={
  ORCL:seriesFor(140,30,now),MSFT:seriesFor(500,12,now),AMZN:seriesFor(220,11,now),GOOGL:seriesFor(190,10,now),
  NVDA:seriesFor(180,13,now),IGV:seriesFor(110,9,now),QQQ:seriesFor(600,8,now),SPY:seriesFor(700,6,now)
};
const f=extractV5Features(series,now);
assert.equal(f.status,'ok');assert.equal(f.vector.length,V5_FEATURE_NAMES.length);assert.ok(f.diagnostics.residual_bps['300']>0);
assert.ok(V5_FEATURE_NAMES.includes('self5'));assert.ok(V5_FEATURE_NAMES.includes('residual_accel_5_15'));
assert.ok(Number.isFinite(structuralV5Score(f.features,15)));assert.ok(v5BarrierBps(f,15)>=4);

const pred={at:new Date(now).toISOString(),target_at:new Date(now+60000).toISOString(),entry_price:140,horizon_minutes:1,barrier_bps:5,
  structural_dir:1,learned_dir:1,assumed_roundtrip_cost_bps:3};
const path=[
  {recv_at:now,t:now-100,p:140},{recv_at:now+20000,t:now+19900,p:140.08},{recv_at:now+61000,t:now+60900,p:140.09}
];
const ev=evaluateV5Path(pred,path,now+62000);assert.equal(ev.status,'evaluated');assert.equal(ev.barrier_label,1);assert.ok(ev.learned.net_bps>0);

const training=[];
for(let i=0;i<160;i++){
  const x=new Array(V5_FEATURE_NAMES.length).fill(0);x[0]=i%2?0.8:-0.8;
  training.push({version:V5_VERSION,horizon_minutes:5,status:'evaluated',gate_sample:true,path_label:i%2?1:-1,barrier_label:i%2?1:-1,feature_vector:x});
}
const m=fitV5Logistic(training,5);assert.equal(m.ready,true);
const up=new Array(V5_FEATURE_NAMES.length).fill(0);up[0]=.9;
assert.equal(predictV5Logistic(m,up).dir,1);

const outcomes=[];
for(let d=0;d<12;d++)for(let i=0;i<16;i++){
  const at=new Date(Date.UTC(2026,8,1+d,14,i,0)).toISOString(),vec=new Array(V5_FEATURE_NAMES.length).fill(0);vec[0]=i%2?.8:-.8;
  const dir=i%2?1:-1;
  outcomes.push({version:V5_VERSION,horizon_minutes:5,status:'evaluated',at,gate_sample:true,path_label:dir,barrier_label:dir,barrier_hit:true,feature_vector:vec,
    learned_dir:dir,structural_dir:-dir,learned_net_bps:3,structural_net_bps:-7});
}
const summary=summarizeV5State({outcomes,started_at:'2026-09-01T00:00:00Z'});
assert.equal(summary.proof['5'].model.ready,true);
assert.equal(summary.proof['5'].gate.status,'validated');
assert.equal(summary.production.enabled,false);
assert.equal(summary.production.reason,'execution_prices_and_realized_costs_not_validated');
assert.equal(summary.research.validated_horizons.includes(5),true);
console.log('yahoo-monetary-v5 tests ok');
