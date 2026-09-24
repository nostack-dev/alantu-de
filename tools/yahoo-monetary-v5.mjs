export const V5_VERSION='yahoo-monetary-dt-v5';
export const V5_HORIZONS=[1,5,15,30];
export const V5_WINDOWS_SEC=[5,15,30,60,180,300];
export const V5_LOCAL=['MSFT','AMZN','GOOGL','NVDA','IGV'];
export const V5_GLOBAL=['QQQ','SPY'];
export const V5_COST_BPS=3.0;
export const V5_MIN_TRAIN_LABELS=120;
export const V5_MIN_CONFIDENCE=.20;
export const V5_SAMPLE_GAP_MS=60000;
export const V5_FEATURE_NAMES=[
  'self5','self15','self60','self300','local5','local15','local60','local300','global5','global15','global60','global300',
  'residual5','residual15','residual60','residual300','residual_accel_5_15','residual_accel_fast','residual_accel_slow',
  'coupling5','coupling15','coupling60','coupling300','coupling_delta_5_15','coupling_delta_fast','coupling_delta_slow',
  'peer_lead5','peer_lead15','peer_lead60','flow5','flow15','flow60','flow_delta_5_15','flow_delta',
  'event_rate_ratio','vol60','vol300','latency','coverage'
];

const NY_PARTS=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const NY_DAY=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function mean(a){const x=a.filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:null;}
function median(a){const x=a.filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!x.length)return null;const m=x.length>>1;return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function sigmoid(z){if(z>=0){const e=Math.exp(-Math.min(40,z));return 1/(1+e);}const e=Math.exp(Math.max(-40,z));return e/(1+e);}
function squash(x,scale=1){return Math.tanh((Number(x)||0)/Math.max(1e-9,scale));}
function hdr(a,b){a=Number(a);b=Number(b);if(!Number.isFinite(a)||!Number.isFinite(b))return 0;return clamp((a-b)/(Math.abs(a)+Math.abs(b)+1e-9),-1,1);}
function eventTime(e){const r=Number(e?.recv_at),t=Number(e?.t);return Number.isFinite(r)&&r>0?r:t;}
export function nyDayKeyV5(ms){try{return NY_DAY.format(new Date(ms));}catch{return '';}}
function nyParts(ms){const o={};for(const p of NY_PARTS.formatToParts(new Date(ms)))if(p.type!=='literal')o[p.type]=p.value;return o;}
export function v5SessionEligible(nowMs,horizonMinutes){
  const p=nyParts(nowMs),wd=p.weekday,minute=Number(p.hour)*60+Number(p.minute),h=Number(horizonMinutes)||0;
  if(wd==='Sat'||wd==='Sun')return false;
  return minute>=575&&minute<960&&minute+h<=960;
}
function windowStats(rows,nowMs,windowSec){
  if(!Array.isArray(rows)||rows.length<2)return null;
  const win=windowSec*1000,start=nowMs-win,anchorTol=clamp(win*.35,2000,15000),endTol=clamp(win*.25,2000,10000);
  let before=null,recent=[];
  for(const e of rows){
    const t=eventTime(e);if(!Number.isFinite(t)||t>nowMs)continue;
    if(t<=start)before=e;else recent.push(e);
  }
  const end=recent.length?recent.at(-1):before;if(!end)return null;
  const endMs=eventTime(end);if(nowMs-endMs>endTol)return null;
  let first=null;
  if(before&&start-eventTime(before)<=anchorTol)first=before;
  else if(recent.length&&eventTime(recent[0])-start<=anchorTol)first=recent[0];
  if(!first)return null;
  const firstMs=eventTime(first);if(!(endMs>firstMs)||!(Number(first.p)>0&&Number(end.p)>0))return null;
  const pts=rows.filter(e=>{const t=eventTime(e);return t>=firstMs&&t<=endMs&&Number(e.p)>0;});
  if(pts.length<2)return null;
  let signedVol=0,totalVol=0,up=0,down=0,sumSq=0,minP=Infinity,maxP=-Infinity;
  let prev=Number(pts[0].p);minP=Math.min(minP,prev);maxP=Math.max(maxP,prev);
  for(let i=1;i<pts.length;i++){
    const p=Number(pts[i].p),lr=Math.log(p/prev),d=p-prev,dv=Math.max(0,Number(pts[i].dv)||0),sgn=d>0?1:d<0?-1:0;
    sumSq+=lr*lr;signedVol+=sgn*dv;totalVol+=dv;if(sgn>0)up++;else if(sgn<0)down++;
    minP=Math.min(minP,p);maxP=Math.max(maxP,p);prev=p;
  }
  const elapsed=Math.max(1,endMs-firstMs),mins=elapsed/60000,ret=Math.log(Number(end.p)/Number(first.p))*10000,steps=up+down,dir=Math.sign(ret);
  const range=Math.log(maxP/minP)*10000;
  const delays=pts.map(e=>Number(e.recv_at)-Number(e.t)).filter(x=>Number.isFinite(x)&&x>=0&&x<60000);
  return {
    window_seconds:windowSec,count:pts.length,coverage:clamp(elapsed/win,0,1.5),elapsed_ms:elapsed,return_bps:ret,
    velocity_bps_min:ret/Math.max(mins,1/120),flow_ratio:totalVol?signedVol/totalVol:(steps?(up-down)/steps:0),
    event_rate_hz:pts.length/(elapsed/1000),persistence:steps?(dir>0?up:down)/steps:0,
    realized_bps:Math.sqrt(sumSq)*10000,range_bps:range,median_delivery_lag_ms:median(delays)
  };
}
function groupStats(series,symbols,nowMs,windowSec){
  const rows=symbols.map(s=>windowStats(series[s]||[],nowMs,windowSec)).filter(Boolean);
  if(!rows.length)return null;
  return {
    members:rows.length,return_bps:median(rows.map(x=>x.return_bps)),velocity_bps_min:median(rows.map(x=>x.velocity_bps_min)),
    flow_ratio:median(rows.map(x=>x.flow_ratio)),event_rate_hz:mean(rows.map(x=>x.event_rate_hz)),
    persistence:median(rows.map(x=>x.persistence)),realized_bps:median(rows.map(x=>x.realized_bps)),coverage:median(rows.map(x=>x.coverage))
  };
}
function peerBlend(local,global){
  if(local&&global)return .65*local.return_bps+.35*global.return_bps;
  if(local)return local.return_bps;if(global)return global.return_bps;return null;
}
function featureValue(x){return Number.isFinite(Number(x))?Number(x):0;}
export function extractV5Features(series,nowMs=Date.now()){
  const self={},local={},global={};
  for(const w of V5_WINDOWS_SEC){
    self[w]=windowStats(series.ORCL||[],nowMs,w);
    local[w]=groupStats(series,V5_LOCAL,nowMs,w);
    global[w]=groupStats(series,V5_GLOBAL,nowMs,w);
  }
  if(!self[15]||!self[60]||!self[300]||!local[15]||!local[60]||!global[15]||!global[60]||local[60].members<2||global[60].members<1){
    return {status:'blocked',reason:'insufficient_true_dt_coverage',windows_seconds:V5_WINDOWS_SEC,self,local,global};
  }
  const blend=w=>peerBlend(local[w],global[w]);
  const residual=w=>self[w]&&Number.isFinite(blend(w))?self[w].return_bps-blend(w):0;
  const coupling=w=>self[w]&&Number.isFinite(blend(w))?hdr(self[w].return_bps,blend(w)):0;
  const peerLead=w=>self[w]&&Number.isFinite(blend(w))?blend(w)-self[w].return_bps:0;
  const r5=residual(5),r15=residual(15),r60=residual(60),r300=residual(300),c5=coupling(5),c15=coupling(15),c60=coupling(60),c300=coupling(300);
  const rateRatio=Math.log((self[60].event_rate_hz+.01)/((local[60]?.event_rate_hz||0)+.01));
  const latency=median([self[15]?.median_delivery_lag_ms,self[60]?.median_delivery_lag_ms,self[300]?.median_delivery_lag_ms].filter(Number.isFinite));
  const minCoverage=Math.min(self[15].coverage,self[60].coverage,self[300].coverage,local[60].coverage||0,global[60].coverage||0);
  const f={
    self5:squash(self[5]?.return_bps,4),self15:squash(self[15].return_bps,8),self60:squash(self[60].return_bps,18),self300:squash(self[300].return_bps,45),
    local5:squash(local[5]?.return_bps,4),local15:squash(local[15]?.return_bps,7),local60:squash(local[60]?.return_bps,16),local300:squash(local[300]?.return_bps,40),
    global5:squash(global[5]?.return_bps,3.5),global15:squash(global[15]?.return_bps,6),global60:squash(global[60]?.return_bps,14),global300:squash(global[300]?.return_bps,35),
    residual5:squash(r5,4),residual15:squash(r15,7),residual60:squash(r60,14),residual300:squash(r300,30),
    residual_accel_5_15:squash(r5-r15/3,4),residual_accel_fast:squash(r15-r60*.25,7),residual_accel_slow:squash(r60-r300*.2,14),
    coupling5:c5,coupling15:c15,coupling60:c60,coupling300:c300,coupling_delta_5_15:clamp(c5-c15,-1,1),coupling_delta_fast:clamp(c15-c60,-1,1),coupling_delta_slow:clamp(c60-c300,-1,1),
    peer_lead5:squash(peerLead(5),4),peer_lead15:squash(peerLead(15),7),peer_lead60:squash(peerLead(60),14),
    flow5:squash(self[5]?.flow_ratio,.5),flow15:squash(self[15].flow_ratio,.5),flow60:squash(self[60].flow_ratio,.5),
    flow_delta_5_15:squash((self[5]?.flow_ratio||0)-self[15].flow_ratio,.4),flow_delta:squash(self[15].flow_ratio-self[60].flow_ratio,.4),
    event_rate_ratio:squash(rateRatio,1.5),vol60:squash(self[60].realized_bps,20),vol300:squash(self[300].realized_bps,45),
    latency:squash(latency||0,2500),coverage:clamp((minCoverage-.55)/.45,-1,1)
  };
  const vector=V5_FEATURE_NAMES.map(k=>featureValue(f[k]));
  return {
    status:'ok',version:V5_VERSION,asof:new Date(nowMs).toISOString(),clock:'receiver_time_actionable',
    windows_seconds:V5_WINDOWS_SEC,feature_names:V5_FEATURE_NAMES,features:f,vector,
    diagnostics:{self,local,global,residual_bps:{'15':r15,'60':r60,'300':r300},coupling:{'15':c15,'60':c60,'300':c300},
      peer_blend_bps:{'5':blend(5),'15':blend(15),'60':blend(60),'300':blend(300)},min_coverage:minCoverage,median_delivery_lag_ms:latency}
  };
}
export function structuralV5Score(features,h){
  const f=features||{};
  if(h===1)return .16*f.self5+.14*f.self15+.10*f.local5+.08*f.global5+.16*f.residual_accel_5_15+.12*f.coupling_delta_5_15+.12*f.flow5+.12*f.peer_lead5;
  if(h===5)return .16*f.self60+.15*f.local60+.10*f.global60+.18*f.residual_accel_fast+.16*f.coupling_delta_fast+.10*f.flow60+.08*f.peer_lead60-.07*f.residual60;
  if(h===15)return .12*f.self60+.17*f.local60+.13*f.global60+.14*f.residual_accel_slow+.17*f.coupling_delta_slow+.09*f.flow60+.10*f.peer_lead60-.08*f.residual300;
  return .12*f.self300+.18*f.local300+.16*f.global300+.13*f.residual_accel_slow+.16*f.coupling_delta_slow+.08*f.flow60+.09*f.peer_lead60-.08*f.residual300;
}
export function v5BarrierBps(featureState,h){
  const rv=Number(featureState?.diagnostics?.self?.[300]?.realized_bps);
  const fallback={1:5,5:9,15:15,30:22}[h]||10;
  const scaled=Number.isFinite(rv)?rv*Math.sqrt((h*60)/300)*.85:fallback;
  return Number(clamp(Math.max(fallback*.75,scaled),4,45).toFixed(3));
}
export function fitV5Logistic(outcomes,h){
  const rows=(outcomes||[]).filter(x=>x?.version===V5_VERSION&&Number(x.horizon_minutes)===Number(h)&&x.status==='evaluated'&&
    (Number(x.barrier_label)===1||Number(x.barrier_label)===-1)&&Array.isArray(x.feature_vector)&&x.feature_vector.length===V5_FEATURE_NAMES.length);
  if(rows.length<V5_MIN_TRAIN_LABELS)return {ready:false,n:rows.length,min_n:V5_MIN_TRAIN_LABELS,feature_names:V5_FEATURE_NAMES};
  const n=rows.length,d=V5_FEATURE_NAMES.length,w=new Array(d).fill(0),rate=0.12,l2=.035;
  const pos=rows.filter(r=>Number(r.barrier_label)===1).length,b0=Math.log((pos+.5)/(n-pos+.5));let b=clamp(b0,-2,2);
  for(let epoch=0;epoch<90;epoch++){
    const gw=new Array(d).fill(0);let gb=0;
    for(const r of rows){
      const x=r.feature_vector.map(featureValue),y=Number(r.barrier_label)===1?1:0;
      let z=b;for(let j=0;j<d;j++)z+=w[j]*x[j];
      const e=sigmoid(z)-y;gb+=e;for(let j=0;j<d;j++)gw[j]+=e*x[j];
    }
    const eta=rate/(1+epoch*.018);b-=eta*gb/n;
    for(let j=0;j<d;j++)w[j]-=eta*(gw[j]/n+l2*w[j]);
  }
  return {ready:true,n,min_n:V5_MIN_TRAIN_LABELS,weights:w,bias:b,feature_names:V5_FEATURE_NAMES,positive_rate:pos/n,algorithm:'causal_logistic_sgd_l2_v1'};
}
export function predictV5Logistic(model,vector){
  if(!model?.ready||!Array.isArray(vector)||vector.length!==model.weights.length)return {ready:false,dir:0,p_up:null,confidence:0};
  let z=Number(model.bias)||0;for(let i=0;i<vector.length;i++)z+=(Number(model.weights[i])||0)*(Number(vector[i])||0);
  const p=sigmoid(z),confidence=Math.abs(p-.5)*2,dir=confidence>=V5_MIN_CONFIDENCE?(p>.5?1:-1):0;
  return {ready:true,dir,p_up:p,confidence,model_n:model.n};
}
export function evaluateV5Path(prediction,events,nowMs=Date.now()){
  const start=Date.parse(prediction?.at||''),target=Date.parse(prediction?.target_at||''),entry=Number(prediction?.entry_price),barrier=Number(prediction?.barrier_bps);
  if(!Number.isFinite(start)||!Number.isFinite(target)||!(entry>0)||!(barrier>0))return {status:'invalid',reason:'bad_prediction_contract'};
  if(nowMs<target)return {status:'pending'};
  const late=Math.min(120000,Math.max(30000,Number(prediction.horizon_minutes||1)*6000));
  const a=(events||[]).filter(e=>Number(e?.p)>0&&Number.isFinite(eventTime(e))).slice().sort((x,y)=>eventTime(x)-eventTime(y));
  const endpoint=a.find(e=>eventTime(e)>=target&&eventTime(e)<=target+late);
  if(!endpoint)return nowMs<=target+late?{status:'pending'}:{status:'invalid',reason:'target_price_unavailable'};
  let upperHit=null,lowerHit=null,maxRet=-Infinity,minRet=Infinity,lastBefore=null;
  for(const e of a){
    const t=eventTime(e);if(t<start)continue;if(t>target)break;
    const ret=Math.log(Number(e.p)/entry)*10000;maxRet=Math.max(maxRet,ret);minRet=Math.min(minRet,ret);lastBefore=e;
    if(upperHit==null&&ret>=barrier)upperHit=t;
    if(lowerHit==null&&ret<=-barrier)lowerHit=t;
  }
  let barrierLabel=0,barrierAt=null;
  if(upperHit!=null&&(lowerHit==null||upperHit<lowerHit)){barrierLabel=1;barrierAt=upperHit;}
  else if(lowerHit!=null&&(upperHit==null||lowerHit<upperHit)){barrierLabel=-1;barrierAt=lowerHit;}
  const endpointRet=Math.log(Number(endpoint.p)/entry)*10000,cost=Number(prediction.assumed_roundtrip_cost_bps||V5_COST_BPS);
  const trade=(dir)=>{
    dir=Number(dir);if(dir!==1&&dir!==-1)return {gross_bps:null,net_bps:null,profitable:null};
    const gross=barrierLabel?dir*barrierLabel*barrier:dir*endpointRet,net=gross-cost;
    return {gross_bps:gross,net_bps:net,profitable:net>0};
  };
  return {
    status:'evaluated',endpoint_price:Number(endpoint.p),endpoint_at:new Date(eventTime(endpoint)).toISOString(),endpoint_market_at:new Date(Number(endpoint.t)).toISOString(),
    endpoint_return_bps:endpointRet,timing_error_ms:eventTime(endpoint)-target,barrier_label:barrierLabel,barrier_hit:barrierLabel!==0,
    barrier_at:barrierAt?new Date(barrierAt).toISOString():null,mfe_bps:Number.isFinite(maxRet)?maxRet:null,mae_bps:Number.isFinite(minRet)?minRet:null,
    structural:trade(prediction.structural_dir),learned:trade(prediction.learned_dir),last_before_target_at:lastBefore?new Date(eventTime(lastBefore)).toISOString():null
  };
}
function maxDrawdown(a){let c=0,p=0,d=0;for(const x of a){c+=x;p=Math.max(p,c);d=Math.max(d,p-c);}return d;}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,den=1+z*z/n,c=(p+z*z/(2*n))/den,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/den;return [Math.max(0,c-m),Math.min(1,c+m)];}
function tradeStats(rows,prefix,gateOnly=false){
  const dirKey=prefix+'_dir',netKey=prefix+'_net_bps',a=(rows||[]).filter(x=>x?.status==='evaluated'&&(!gateOnly||x.gate_sample===true)&&
    (Number(x[dirKey])===1||Number(x[dirKey])===-1)&&Number.isFinite(Number(x[netKey]))).sort((x,y)=>Date.parse(x.at)-Date.parse(y.at));
  const nets=a.map(x=>Number(x[netKey])),wins=nets.filter(x=>x>0),loss=nets.filter(x=>x<=0),n=a.length,days=new Set(a.map(x=>nyDayKeyV5(Date.parse(x.at))).filter(Boolean)).size;
  const pf=loss.length?wins.reduce((s,v)=>s+v,0)/Math.abs(loss.reduce((s,v)=>s+v,0)):(wins.length?Infinity:null),mid=Math.floor(n/2);
  const basic=(z)=>{const ns=z.map(x=>Number(x[netKey])),ws=ns.filter(x=>x>0),ls=ns.filter(x=>x<=0);return {n:z.length,mean_net_bps:mean(ns),median_net_bps:median(ns),profit_factor:ls.length?ws.reduce((s,v)=>s+v,0)/Math.abs(ls.reduce((s,v)=>s+v,0)):(ws.length?Infinity:null)};};
  return {n,days,profitable_rate:n?wins.length/n:null,profitable95:wilson(wins.length,n),mean_net_bps:mean(nets),median_net_bps:median(nets),profit_factor:pf,
    total_net_bps:nets.reduce((s,v)=>s+v,0),max_drawdown_bps:maxDrawdown(nets),barrier_hit_rate:n?a.filter(x=>x.barrier_hit).length/n:null,
    halves:[basic(a.slice(0,mid)),basic(a.slice(mid))]};
}
export function summarizeV5State(state){
  const outcomes=(state?.outcomes||[]).filter(x=>x.version===V5_VERSION),proof={};
  for(const h of V5_HORIZONS){
    const model=fitV5Logistic(outcomes,h),learned=tradeStats(outcomes.filter(x=>Number(x.horizon_minutes)===h),'learned',true),structural=tradeStats(outcomes.filter(x=>Number(x.horizon_minutes)===h),'structural',true);
    const paired=outcomes.filter(x=>Number(x.horizon_minutes)===h&&x.gate_sample===true&&Number.isFinite(Number(x.learned_net_bps))&&Number.isFinite(Number(x.structural_net_bps)));
    const delta=paired.map(x=>Number(x.learned_net_bps)-Number(x.structural_net_bps)),reasons=[];
    if(!model.ready)reasons.push('training_labels_lt_'+V5_MIN_TRAIN_LABELS);
    if(learned.n<180)reasons.push('gate_trades_lt_180');
    if(learned.days<10)reasons.push('trading_days_lt_10');
    if(!(learned.profitable_rate>=.52))reasons.push('profitable_rate_lt_52pct');
    if(!learned.profitable95||!(learned.profitable95[0]>.50))reasons.push('profit_rate_ci_not_above_50');
    if(!(learned.mean_net_bps>=1.0))reasons.push('mean_net_lt_1bp');
    if(!(learned.median_net_bps>0))reasons.push('median_net_not_positive');
    if(!(learned.profit_factor>=1.25))reasons.push('profit_factor_lt_1_25');
    for(let i=0;i<2;i++){const z=learned.halves[i]||{};if((z.n||0)<50||!(z.mean_net_bps>0)||!(z.profit_factor>=1.05))reasons.push('unstable_half_'+(i+1));}
    if(!delta.length||!(mean(delta)>=.5))reasons.push('does_not_beat_structural_by_0_5bps');
    proof[String(h)]={model,learned,structural,learned_vs_structural:{n:delta.length,mean_delta_bps:mean(delta),median_delta_bps:median(delta)},gate:{status:reasons.length?'collecting':'validated',reasons}};
    if(reasons.length&&model.ready&&learned.n>=60&&learned.days>=3&&learned.mean_net_bps>.75&&learned.profit_factor>1.15&&mean(delta)>.25)proof[String(h)].gate.status='promising';
  }
  const valid=[5,15,1,30].filter(h=>proof[String(h)].gate.status==='validated');
  return {version:V5_VERSION,contract:'true_dt_residual_barrier_causal_online_v1',clock:'receiver_time_actionable',objective:'first_profit_or_loss_barrier_then_horizon_close',
    assumed_roundtrip_cost_bps:V5_COST_BPS,windows_seconds:V5_WINDOWS_SEC,feature_names:V5_FEATURE_NAMES,proof,
    production:{enabled:valid.length>0,validated_horizons:valid,selected_horizon:valid[0]||null},started_at:state?.started_at||null,updated_at:state?.updated_at||null};
}
