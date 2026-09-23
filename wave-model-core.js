export const FEATURE_VERSION='wave-hdr-dt-v1';
export const BAR_MINUTES=5;
export const HORIZONS=[5,15,30];
export const FEATURE_NAMES=[
  'ret_bps','log_dt_min','velocity_bps_min','accel_bps_min2',
  'price_slope_15','price_slope_60','price_slope_180','hdr_price_local','hdr_price_global',
  'price_eff_15','price_persist_60',
  'volume_pressure_15','volume_pressure_60','volume_pressure_180','hdr_volume_local','hdr_volume_global',
  'volume_ratio_log','volume_rate_log','rv_15','rv_180','hdr_volatility','vwap_gap_bps','body_bps','range_bps'
];

const NY=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function nyParts(v){const o={};for(const p of NY.formatToParts(new Date(v)))if(p.type!=='literal')o[p.type]=p.value;return o;}
export function sessionKey(v){const p=nyParts(v);return `${p.year}-${p.month}-${p.day}`;}
export function regular(v){const p=nyParts(v),m=+p.hour*60+(+p.minute);return m>=570&&m<960;}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function hdr(a,b){a=Number(a);b=Number(b);if(!Number.isFinite(a)||!Number.isFinite(b))return 0;return clamp((a-b)/(Math.abs(a)+Math.abs(b)+1e-12),-1,1);}
function median(a){const x=a.filter(Number.isFinite).sort((p,q)=>p-q);if(!x.length)return 0;const m=x.length>>1;return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function signedLog(v){return Math.sign(v)*Math.log1p(Math.abs(v));}

export function barsFromYahoo(payload){
  const a=payload?.chart?.result?.[0],ts=a?.timestamp||[],q=a?.indicators?.quote?.[0]||{};
  const out=[];
  for(let i=0;i<ts.length;i++){
    const at=Number(ts[i])*1000,o=Number(q.open?.[i]),h=Number(q.high?.[i]),l=Number(q.low?.[i]),c=Number(q.close?.[i]),v=Number(q.volume?.[i]);
    if(!Number.isFinite(at)||!regular(at)||!(o>0&&h>0&&l>0&&c>0)||!Number.isFinite(v)||v<0)continue;
    out.push({at:new Date(at).toISOString(),open:o,high:h,low:l,close:c,volume:v});
  }
  return out.sort((x,y)=>Date.parse(x.at)-Date.parse(y.at));
}

export function aggregateBars(rows,minutes=BAR_MINUTES){
  const by=new Map();
  for(const r of rows||[]){
    const t=Date.parse(r.at);if(!Number.isFinite(t)||!regular(t)||!(Number(r.close)>0))continue;
    const p=nyParts(t),tod=+p.hour*60+(+p.minute),slot=Math.floor((tod-570)/minutes);if(slot<0)continue;
    const key=sessionKey(t)+':'+slot;
    const cur=by.get(key),o=Number(r.open||r.close),h=Number(r.high||r.close),l=Number(r.low||r.close),c=Number(r.close),v=Math.max(0,Number(r.volume)||0);
    if(!cur)by.set(key,{at:new Date(t).toISOString(),open:o,high:h,low:l,close:c,volume:v,_t:t});
    else{cur.at=new Date(Math.max(cur._t,t)).toISOString();cur._t=Math.max(cur._t,t);cur.high=Math.max(cur.high,h);cur.low=Math.min(cur.low,l);cur.close=c;cur.volume+=v;}
  }
  return [...by.values()].sort((a,b)=>a._t-b._t).map(({_t,...x})=>x);
}

export function groupSessions(rows){
  const m=new Map();for(const r of rows||[]){const k=sessionKey(r.at);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return [...m.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([day,bars])=>({day,bars:bars.sort((x,y)=>Date.parse(x.at)-Date.parse(y.at))}));
}

function windowRows(bars,i,mins){const end=Date.parse(bars[i].at),out=[];for(let j=i;j>=0;j--){const t=Date.parse(bars[j].at);if(end-t>mins*60000)break;out.push(bars[j]);}return out.reverse();}
function trendFit(bars,i,mins){
  const a=windowRows(bars,i,mins);if(a.length<3)return null;const t0=Date.parse(a[0].at);let sx=0,sy=0,sxx=0,sxy=0,path=0,prev=null,up=0,down=0;
  for(const r of a){const x=(Date.parse(r.at)-t0)/60000,y=Math.log(Number(r.close));sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;if(prev!=null){const d=y-prev;path+=Math.abs(d);if(d>0)up++;else if(d<0)down++;}prev=y;}
  const n=a.length,den=n*sxx-sx*sx,slope=den?(n*sxy-sx*sy)/den:0,net=Math.log(a.at(-1).close/a[0].close),dir=Math.sign(slope),steps=up+down;
  return {slope:slope*10000,net_bps:net*10000,dir,persist:steps?(dir>0?up:down)/steps:0,eff:path?Math.abs(net)/path:0};
}
function volumeFlow(bars,i,mins){
  const a=windowRows(bars,i,mins);if(a.length<3)return null;let signed=0,total=0,agree=0,dir=0;
  for(let k=1;k<a.length;k++){const v=Math.max(0,Number(a[k].volume)||0),d=Math.sign(Number(a[k].close)-Number(a[k-1].close));signed+=v*d;total+=v;}
  const pressure=total?signed/total:0;dir=Math.abs(pressure)>=.04?Math.sign(pressure):0;
  if(dir)for(let k=1;k<a.length;k++)if(Math.sign(Number(a[k].close)-Number(a[k-1].close))===dir)agree++;
  return {pressure,dir,persist:(a.length>1)?agree/(a.length-1):0};
}
function realizedVol(bars,i,mins){const a=windowRows(bars,i,mins);if(a.length<3)return 0;let s=0,n=0;for(let k=1;k<a.length;k++){const r=Math.log(a[k].close/a[k-1].close)*10000;if(Number.isFinite(r)){s+=r*r;n++;}}return n?Math.sqrt(s/n):0;}
function vwap(bars,i,mins){const a=windowRows(bars,i,mins);let pv=0,v=0;for(const r of a){const x=Math.max(0,Number(r.volume)||0);pv+=Number(r.close)*x;v+=x;}return v?pv/v:Number(bars[i].close);}

export function featureAt(bars,i){
  if(!bars||i<36||i>=bars.length)return null;
  const cur=bars[i],prev=bars[i-1],prev2=bars[i-2];
  if(sessionKey(cur.at)!==sessionKey(bars[i-36].at))return null;
  const dt=Math.max(1/60,(Date.parse(cur.at)-Date.parse(prev.at))/60000),pdt=Math.max(1/60,(Date.parse(prev.at)-Date.parse(prev2.at))/60000);
  const ret=Math.log(cur.close/prev.close)*10000,pret=Math.log(prev.close/prev2.close)*10000,vel=ret/dt,pvel=pret/pdt,accel=(vel-pvel)/Math.max(1/60,(dt+pdt)/2);
  const p15=trendFit(bars,i,15),p60=trendFit(bars,i,60),p180=trendFit(bars,i,180),v15=volumeFlow(bars,i,15),v60=volumeFlow(bars,i,60),v180=volumeFlow(bars,i,180);
  if(!p15||!p60||!p180||!v15||!v60||!v180)return null;
  const prior=windowRows(bars,i-1,180).map(r=>Number(r.volume)||0),med=median(prior),ratio=(Number(cur.volume)+1)/(med+1),rv15=realizedVol(bars,i,15),rv180=realizedVol(bars,i,180),vw=vwap(bars,i,180);
  const x=[
    ret,Math.log1p(dt),signedLog(vel),signedLog(accel),
    p15.slope,p60.slope,p180.slope,hdr(p15.slope,p60.slope),hdr(p60.slope,p180.slope),
    p15.eff,p60.persist,
    v15.pressure,v60.pressure,v180.pressure,hdr(v15.pressure,v60.pressure),hdr(v60.pressure,v180.pressure),
    Math.log(ratio),Math.log1p(Math.max(0,Number(cur.volume))/dt),rv15,rv180,hdr(rv15,rv180),
    (cur.close/vw-1)*10000,Math.log(cur.close/cur.open)*10000,Math.log(cur.high/cur.low)*10000
  ];
  return x.every(Number.isFinite)?{at:cur.at,x,diagnostics:{dt_min:dt,price:{short:p15,local:p60,global:p180},volume:{short:v15,local:v60,global:v180},rv:{short:rv15,global:rv180},vwap_gap_bps:x[21]}}:null;
}

export function futureReturnBps(bars,i,horizonMinutes){
  const t=Date.parse(bars[i].at),day=sessionKey(bars[i].at),target=t+horizonMinutes*60000;
  for(let j=i+1;j<bars.length;j++){
    if(sessionKey(bars[j].at)!==day)break;const tj=Date.parse(bars[j].at);
    if(tj>=target){if(tj-target>BAR_MINUTES*60000+15000)return null;return Math.log(bars[j].close/bars[i].close)*10000;}
  }return null;
}

export function latestFeatures(rows){const bars=aggregateBars(rows,BAR_MINUTES),sessions=groupSessions(bars);if(!sessions.length)return null;const s=sessions.at(-1),f=featureAt(s.bars,s.bars.length-1);return f?{...f,bars:s.bars,day:s.day}:null;}
function zscore(x,m){const mu=m.standardization.mean,sd=m.standardization.std;return x.map((v,i)=>(v-mu[i])/Math.max(1e-12,sd[i]));}
export function scoreHorizon(features,h){const z=zscore(features.x,h),b=h.coefficients;let s=b[0];for(let i=0;i<z.length;i++)s+=z[i]*b[i+1];return s;}
export function forecastLatest(rows,model){
  if(!model||model.feature_version!==FEATURE_VERSION||model.bar_minutes!==BAR_MINUTES)return {status:'blocked',reason:'model_contract'};
  const f=latestFeatures(rows);if(!f)return {status:'blocked',reason:'insufficient_live_history'};
  const age=Date.now()-Date.parse(f.at);if(!Number.isFinite(age)||age>5*60000)return {status:'blocked',reason:'stale_live_bar',asof:f.at};
  const forecasts=[];
  for(const h of model.horizons||[]){
    if(!h||h.status!=='validated')continue;const score=scoreHorizon(f,h),thr=Number(h.threshold)||Infinity,dir=Math.abs(score)>=thr?Math.sign(score):0;
    forecasts.push({horizon_minutes:h.horizon_minutes,dir,score_bps:score,threshold_bps:thr,margin:Math.abs(score)/Math.max(1e-9,thr),holdout:h.holdout,model_id:model.model_id});
  }
  return {status:'ok',asof:f.at,diagnostics:f.diagnostics,forecasts};
}
