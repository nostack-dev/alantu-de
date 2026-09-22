import crypto from 'node:crypto';

const FEATURE_NAMES=[
  'imbalance_l1','imbalance_l3','imbalance_l5','imbalance_l10',
  'microprice_bias','near_far_imbalance','depth_ratio_l5'
];

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

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
  let b5=0,a5=0;for(let i=0;i<5;i++){b5+=bidSz[i];a5+=askSz[i];}
  const depthRatio=Math.log((b5+1e-12)/(a5+1e-12));
  const values=[i1,i3,i5,i10,(micro-mid)/spread,i1-i10,depthRatio];
  if(!values.every(Number.isFinite))return null;
  return {
    names:FEATURE_NAMES.slice(),values,mid,spread_bps:mid>0?spread/mid*10000:null,
    at:event.at??event.ts_event??null,sequence:event.sequence??null
  };
}

export function estimateEventClock(events,horizonEvents=100){
  const xs=(events||[]).map(e=>Date.parse(e?.at??e?.ts_event??'')).filter(Number.isFinite);
  if(xs.length<8)return {events_per_second:null,eta_seconds:null,sample_events:xs.length};
  const recent=xs.slice(-Math.min(500,xs.length));
  const dt=(recent.at(-1)-recent[0])/1000;
  if(!(dt>0))return {events_per_second:null,eta_seconds:null,sample_events:recent.length};
  const rate=(recent.length-1)/dt;
  return {events_per_second:rate,eta_seconds:rate>0?horizonEvents/rate:null,sample_events:recent.length};
}

function modelKey(model){
  return crypto.createHash('sha256').update(JSON.stringify({
    symbol:model.symbol,dataset:model.dataset,schema:model.schema,
    horizon_events:model.horizon_events,feature_names:model.feature_names,
    mean:model.standardization?.mean,std:model.standardization?.std,
    coefficients:model.coefficients,threshold:model.threshold
  })).digest('hex').slice(0,16);
}

export function validateL2ModelContract(model){
  const reasons=[];
  if(!model||model.status!=='validated')reasons.push('model_not_validated');
  if(model?.symbol!=='ORCL')reasons.push('wrong_symbol');
  if(model?.schema!=='mbp-10')reasons.push('wrong_schema');
  if(Number(model?.horizon_events)!==100)reasons.push('wrong_horizon');
  if(JSON.stringify(model?.feature_names)!==JSON.stringify(FEATURE_NAMES))reasons.push('wrong_features');
  if(!Array.isArray(model?.standardization?.mean)||model.standardization.mean.length!==7)reasons.push('bad_mean');
  if(!Array.isArray(model?.standardization?.std)||model.standardization.std.length!==7)reasons.push('bad_std');
  if(!Array.isArray(model?.coefficients)||model.coefficients.length!==8)reasons.push('bad_coefficients');
  if(!(Number(model?.threshold)>0))reasons.push('bad_threshold');
  if(Number(model?.evidence?.usable_days||0)<252)reasons.push('insufficient_days');
  if(Number(model?.evidence?.holdout_signals||0)<500)reasons.push('insufficient_holdout_signals');
  if(Number(model?.evidence?.holdout_days||0)<60)reasons.push('insufficient_holdout_days');
  const expected=modelKey(model);
  if(model?.model_id!==expected)reasons.push('model_id_mismatch');
  return {ok:reasons.length===0,reasons,expected_model_id:expected};
}

export function forecastL2Event(event,eventHistory,model){
  const contract=validateL2ModelContract(model);
  if(!contract.ok)return {status:'no_signal',reason:'model_contract',reasons:contract.reasons};
  const f=l2FeatureVector(event);if(!f)return {status:'no_signal',reason:'bad_l2_event'};
  const mu=model.standardization.mean.map(Number),sd=model.standardization.std.map(Number);
  const z=f.values.map((v,i)=>(v-mu[i])/Math.max(1e-12,sd[i]));
  const b=model.coefficients.map(Number);
  let score=b[0];for(let i=0;i<7;i++)score+=b[i+1]*z[i];
  const threshold=Number(model.threshold);
  const dir=score>=threshold?1:score<=-threshold?-1:0;
  const clock=estimateEventClock(eventHistory,100);
  if(!dir)return {
    status:'no_signal',reason:'below_threshold',score,threshold,
    horizon_events:100,eta_seconds:clock.eta_seconds,event_rate:clock.events_per_second,
    asof:f.at,model_id:model.model_id
  };
  return {
    status:'forecast',direction:dir>0?'up':'down',dir,
    score,threshold,signal_strength:clamp(Math.abs(score)/threshold,1,5),
    horizon_events:100,eta_seconds:clock.eta_seconds,event_rate:clock.events_per_second,
    asof:f.at,mid:f.mid,spread_bps:f.spread_bps,
    model_id:model.model_id
  };
}

export {FEATURE_NAMES};
