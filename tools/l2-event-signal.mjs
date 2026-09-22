import crypto from 'node:crypto';

const FEATURE_VERSION='hdr-dt-v1';
const BASE_FEATURE_NAMES=[
  'imbalance_l1','imbalance_l3','imbalance_l5','imbalance_l10',
  'microprice_bias','near_far_imbalance','depth_ratio_l5'
];
const FEATURE_NAMES=[
  ...BASE_FEATURE_NAMES,
  'xy_pressure','xy_liquidity_log','spread_bps','log_dt_us',
  'vx_log','vy_log','ax_log','ay_log',
  'hdr_self_x','hdr_self_y','hdr_local_x','hdr_local_y','hdr_global_x','hdr_global_y',
  'log_rate_10','log_rate_100','pace_ratio_log'
];

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function signedLog(v){v=Number(v);return Number.isFinite(v)?Math.sign(v)*Math.log1p(Math.abs(v)):null;}
function hdrRel(cur,ref){
  cur=Number(cur);ref=Number(ref);
  if(!Number.isFinite(cur)||!Number.isFinite(ref))return null;
  return (cur-ref)/(Math.abs(cur)+Math.abs(ref)+1e-12);
}
function mean(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;}

function eventNs(event,key='ts_event_ns'){
  const raw=event?.[key];
  if(raw!=null&&String(raw)!==''){
    try{return BigInt(String(raw));}catch{}
  }
  if(key==='ts_event_ns'){
    const ms=Date.parse(event?.at??event?.ts_event??'');
    if(Number.isFinite(ms))return BigInt(Math.round(ms))*1000000n;
  }
  return null;
}
function dtSeconds(newer,older){
  const a=eventNs(newer),b=eventNs(older);
  if(a==null||b==null||a<b)return null;
  const d=a-b;
  return Math.max(1e-9,Number(d)/1e9);
}
function windowRate(events,back){
  if(!Array.isArray(events)||events.length<=back)return null;
  const end=events.at(-1),start=events[events.length-1-back];
  const dt=dtSeconds(end,start);
  return dt&&dt>0?back/dt:null;
}

export function l2FeatureVector(event){
  const levels=event?.levels;
  if(!Array.isArray(levels)||levels.length<10)return null;
  const bidPx=[],askPx=[],bidSz=[],askSz=[];
  for(let i=0;i<10;i++){
    const L=levels[i]||{};
    const bp=n(L.bid_px??L.bidPx),ap=n(L.ask_px??L.askPx),bs=n(L.bid_sz??L.bidSize),as=n(L.ask_sz??L.askSize);
    if(!(bp>0&&ap>0&&ap>=bp&&bs>=0&&as>=0))return null;
    bidPx.push(bp);askPx.push(ap);bidSz.push(bs);askSz.push(as);
  }
  const imb=k=>{
    let b=0,a=0;for(let i=0;i<k;i++){b+=bidSz[i];a+=askSz[i];}
    const d=b+a;return d>0?(b-a)/d:0;
  };
  const i1=imb(1),i3=imb(3),i5=imb(5),i10=imb(10);
  const mid=(askPx[0]+bidPx[0])/2,spread=Math.max(1e-12,askPx[0]-bidPx[0]);
  const d0=bidSz[0]+askSz[0];
  const micro=d0>0?(askPx[0]*bidSz[0]+bidPx[0]*askSz[0])/d0:mid;
  let b5=0,a5=0,depth10=0;
  for(let i=0;i<10;i++){
    depth10+=bidSz[i]+askSz[i];
    if(i<5){b5+=bidSz[i];a5+=askSz[i];}
  }
  const depthRatio=Math.log((b5+1e-12)/(a5+1e-12));
  const microBias=(micro-mid)/spread;
  const values=[i1,i3,i5,i10,microBias,i1-i10,depthRatio];
  const xPressure=(i1+i3+i5+i10+2*microBias)/6;
  const yLiquidity=Math.log1p(depth10);
  if(!values.every(Number.isFinite)||!Number.isFinite(xPressure)||!Number.isFinite(yLiquidity))return null;
  return {
    names:BASE_FEATURE_NAMES.slice(),values,mid,
    spread_bps:mid>0?spread/mid*10000:null,
    x_pressure:xPressure,y_liquidity_log:yLiquidity,
    at:event.at??event.ts_event??null,
    ts_event_ns:event?.ts_event_ns??null,
    ts_recv_ns:event?.ts_recv_ns??null,
    ts_local_recv_ns:event?.ts_local_recv_ns??null,
    sequence:event.sequence??null
  };
}

export function l2TemporalFeatureVector(eventHistory){
  if(!Array.isArray(eventHistory)||eventHistory.length<1001)return null;
  const tail=eventHistory.slice(-1001);
  const states=tail.map(l2FeatureVector);
  if(states.some(x=>!x))return null;
  const i=states.length-1,cur=states[i],prev=states[i-1],prev2=states[i-2];
  const dt=dtSeconds(tail[i],tail[i-1]),dtPrev=dtSeconds(tail[i-1],tail[i-2]);
  if(!(dt>0&&dtPrev>0))return null;

  const vx=(cur.x_pressure-prev.x_pressure)/dt;
  const vy=(cur.y_liquidity_log-prev.y_liquidity_log)/dt;
  const pvx=(prev.x_pressure-prev2.x_pressure)/dtPrev;
  const pvy=(prev.y_liquidity_log-prev2.y_liquidity_log)/dtPrev;
  const accelDt=Math.max(1e-9,(dt+dtPrev)/2);
  const ax=(vx-pvx)/accelDt,ay=(vy-pvy)/accelDt;

  const self=states[i-100];
  const local=states.slice(i-10,i);
  const global=states.slice(0,i);
  const lx=mean(local.map(x=>x.x_pressure)),ly=mean(local.map(x=>x.y_liquidity_log));
  const gx=mean(global.map(x=>x.x_pressure)),gy=mean(global.map(x=>x.y_liquidity_log));

  const rate10=windowRate(tail,10),rate100=windowRate(tail,100);
  if(!(rate10>0&&rate100>0))return null;

  const extra=[
    cur.x_pressure,cur.y_liquidity_log,cur.spread_bps,Math.log1p(dt*1e6),
    signedLog(vx),signedLog(vy),signedLog(ax),signedLog(ay),
    hdrRel(cur.x_pressure,self.x_pressure),hdrRel(cur.y_liquidity_log,self.y_liquidity_log),
    hdrRel(cur.x_pressure,lx),hdrRel(cur.y_liquidity_log,ly),
    hdrRel(cur.x_pressure,gx),hdrRel(cur.y_liquidity_log,gy),
    Math.log1p(rate10),Math.log1p(rate100),Math.log((rate10+1e-12)/(rate100+1e-12))
  ];
  const values=cur.values.concat(extra);
  if(values.length!==FEATURE_NAMES.length||!values.every(Number.isFinite))return null;
  return {
    names:FEATURE_NAMES.slice(),values,
    mid:cur.mid,spread_bps:cur.spread_bps,at:cur.at,
    ts_event_ns:cur.ts_event_ns,sequence:cur.sequence,
    trajectory:{
      x:cur.x_pressure,y:cur.y_liquidity_log,
      dt_ms:dt*1000,
      vx,vy,ax,ay,
      hdr:{
        self:{x:extra[8],y:extra[9]},
        local:{x:extra[10],y:extra[11]},
        global:{x:extra[12],y:extra[13]}
      },
      event_rate_10:rate10,event_rate_100:rate100
    }
  };
}

export function latencyMetrics(event){
  const te=eventNs(event,'ts_event_ns');
  const tr=eventNs(event,'ts_recv_ns');
  const tl=eventNs(event,'ts_local_recv_ns');
  const diffMs=(a,b)=>a!=null&&b!=null&&a>=b?Number(a-b)/1e6:null;
  return {
    provider_latency_ms:diffMs(tr,te),
    collector_latency_ms:diffMs(tl,te),
    transport_after_provider_ms:diffMs(tl,tr)
  };
}

export function estimateEventClock(events,horizonEvents=100){
  if(!Array.isArray(events)||events.length<8)return {events_per_second:null,eta_seconds:null,sample_events:events?.length||0};
  const recent=events.slice(-Math.min(500,events.length));
  const dt=dtSeconds(recent.at(-1),recent[0]);
  if(!(dt>0))return {events_per_second:null,eta_seconds:null,sample_events:recent.length};
  const rate=(recent.length-1)/dt;
  return {events_per_second:rate,eta_seconds:rate>0?horizonEvents/rate:null,sample_events:recent.length};
}

export function l2ModelId(model){
  return crypto.createHash('sha256').update(JSON.stringify({
    symbol:model.symbol,dataset:model.dataset,schema:model.schema,
    feature_version:model.feature_version,horizon_events:model.horizon_events,feature_names:model.feature_names,
    mean:model.standardization?.mean,std:model.standardization?.std,
    coefficients:model.coefficients,threshold:model.threshold
  })).digest('hex').slice(0,16);
}

export function validateL2ModelContract(model){
  const reasons=[];
  if(!model||model.status!=='validated')reasons.push('model_not_validated');
  if(model?.symbol!=='ORCL')reasons.push('wrong_symbol');
  if(model?.schema!=='mbp-10')reasons.push('wrong_schema');
  if(model?.feature_version!==FEATURE_VERSION)reasons.push('wrong_feature_version');
  if(Number(model?.horizon_events)!==100)reasons.push('wrong_horizon');
  if(JSON.stringify(model?.feature_names)!==JSON.stringify(FEATURE_NAMES))reasons.push('wrong_features');
  if(!Array.isArray(model?.standardization?.mean)||model.standardization.mean.length!==FEATURE_NAMES.length)reasons.push('bad_mean');
  if(!Array.isArray(model?.standardization?.std)||model.standardization.std.length!==FEATURE_NAMES.length)reasons.push('bad_std');
  if(!Array.isArray(model?.coefficients)||model.coefficients.length!==FEATURE_NAMES.length+1)reasons.push('bad_coefficients');
  if(!(Number(model?.threshold)>0))reasons.push('bad_threshold');
  if(Number(model?.evidence?.usable_days||0)<252)reasons.push('insufficient_days');
  if(Number(model?.evidence?.holdout_signals||0)<500)reasons.push('insufficient_holdout_signals');
  if(Number(model?.evidence?.holdout_days||0)<60)reasons.push('insufficient_holdout_days');
  const expected=l2ModelId(model);
  if(model?.model_id!==expected)reasons.push('model_id_mismatch');
  return {ok:reasons.length===0,reasons,expected_model_id:expected};
}

export function forecastL2Event(event,eventHistory,model){
  const contract=validateL2ModelContract(model);
  if(!contract.ok)return {status:'no_signal',reason:'model_contract',reasons:contract.reasons};
  const f=l2TemporalFeatureVector(eventHistory);
  if(!f)return {status:'no_signal',reason:'insufficient_or_invalid_temporal_history'};
  const mu=model.standardization.mean.map(Number),sd=model.standardization.std.map(Number);
  const z=f.values.map((v,i)=>(v-mu[i])/Math.max(1e-12,sd[i]));
  const b=model.coefficients.map(Number);
  let score=b[0];for(let i=0;i<FEATURE_NAMES.length;i++)score+=b[i+1]*z[i];
  const threshold=Number(model.threshold);
  const dir=score>=threshold?1:score<=-threshold?-1:0;
  const clock=estimateEventClock(eventHistory,100);
  const latency=latencyMetrics(event);
  const common={
    score,threshold,horizon_events:100,eta_seconds:clock.eta_seconds,event_rate:clock.events_per_second,
    asof:f.at,mid:f.mid,spread_bps:f.spread_bps,trajectory:f.trajectory,latency,
    feature_version:FEATURE_VERSION,model_id:model.model_id
  };
  if(!dir)return {status:'no_signal',reason:'below_threshold',...common};
  return {
    status:'forecast',direction:dir>0?'up':'down',dir,
    signal_strength:clamp(Math.abs(score)/threshold,1,5),
    ...common
  };
}

export {BASE_FEATURE_NAMES,FEATURE_NAMES,FEATURE_VERSION};
