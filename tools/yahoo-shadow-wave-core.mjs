export const YAHOO_SHADOW_VERSION='yahoo-shadow-hdr-dt-v1';
export const YAHOO_HORIZONS=[1,5,15,30];
export const YAHOO_LOCAL=['MSFT','AMZN','GOOGL','NVDA','IGV'];
export const YAHOO_GLOBAL=['QQQ','SPY'];

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function median(a){const x=a.filter(Number.isFinite).sort((p,q)=>p-q);if(!x.length)return null;const m=x.length>>1;return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function mean(a){const x=a.filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:null;}
export function hdr(a,b){a=Number(a);b=Number(b);if(!Number.isFinite(a)||!Number.isFinite(b))return 0;return clamp((a-b)/(Math.abs(a)+Math.abs(b)+1e-12),-1,1);}
function squash(x,scale=1){return Math.tanh(Number(x||0)/Math.max(1e-9,scale));}

function windowRows(rows,endMs,windowMs){
  const start=endMs-windowMs;
  let i=rows.length-1;
  while(i>=0&&rows[i].t>=start)i--;
  return rows.slice(i+1);
}
function stats(rows,endMs,windowMs){
  const a=windowRows(rows,endMs,windowMs);
  if(a.length<2)return null;
  const first=a[0],last=a[a.length-1],mins=Math.max((last.t-first.t)/60000,1/60);
  if(!(first.p>0&&last.p>0))return null;
  let signed=0,total=0,up=0,down=0;
  for(let i=1;i<a.length;i++){
    const dv=Math.max(0,Number(a[i].dv)||0),d=a[i].p-a[i-1].p;
    const s=d>0?1:d<0?-1:0;
    signed+=s*dv;total+=dv;if(s>0)up++;else if(s<0)down++;
  }
  const ret=Math.log(last.p/first.p)*10000;
  const dir=ret>0?1:ret<0?-1:0,steps=up+down;
  return {
    count:a.length,
    return_bps:ret,
    velocity_bps_min:ret/mins,
    signed_volume_ratio:total?signed/total:0,
    event_rate:a.length/Math.max(.01,windowMs/1000),
    persistence:steps?(dir>0?up:down)/steps:0
  };
}
function groupStats(series,symbols,endMs,windowMs){
  const s=symbols.map(sym=>stats(series[sym]||[],endMs,windowMs)).filter(Boolean);
  if(!s.length)return null;
  return {
    members:s.length,
    return_bps:median(s.map(x=>x.return_bps)),
    velocity_bps_min:median(s.map(x=>x.velocity_bps_min)),
    signed_volume_ratio:median(s.map(x=>x.signed_volume_ratio)),
    event_rate:mean(s.map(x=>x.event_rate)),
    persistence:median(s.map(x=>x.persistence))
  };
}
function eventRate60(rows,endMs){
  return windowRows(rows,endMs,60000).length/60;
}
function dynamicWindows(rows,endMs){
  const rate=Math.max(.08,eventRate60(rows,endMs));
  let fast=clamp(16/rate,4,30);
  let mid=clamp(96/rate,20,180);
  let slow=clamp(600/rate,90,900);
  mid=Math.max(mid,fast*3);slow=Math.max(slow,mid*3);
  return {fast_s:fast,mid_s:Math.min(mid,180),slow_s:Math.min(slow,900),event_rate_60s:rate};
}
function quality(series,endMs){
  const target=series.ORCL||[];
  const last=target.at(-1),age=last?endMs-last.t:Infinity;
  const localFresh=YAHOO_LOCAL.filter(s=>{const x=(series[s]||[]).at(-1);return x&&endMs-x.t<=15000;}).length;
  const globalFresh=YAHOO_GLOBAL.filter(s=>{const x=(series[s]||[]).at(-1);return x&&endMs-x.t<=15000;}).length;
  return {target_age_ms:age,local_fresh:localFresh,global_fresh:globalFresh,usable:age<=15000&&localFresh>=3&&globalFresh>=1};
}
function components(series,endMs){
  const target=series.ORCL||[],w=dynamicWindows(target,endMs);
  const fast=w.fast_s*1000,mid=w.mid_s*1000,slow=w.slow_s*1000;
  const self={fast:stats(target,endMs,fast),mid:stats(target,endMs,mid),slow:stats(target,endMs,slow)};
  const local={fast:groupStats(series,YAHOO_LOCAL,endMs,fast),mid:groupStats(series,YAHOO_LOCAL,endMs,mid),slow:groupStats(series,YAHOO_LOCAL,endMs,slow)};
  const global={fast:groupStats(series,YAHOO_GLOBAL,endMs,fast),mid:groupStats(series,YAHOO_GLOBAL,endMs,mid),slow:groupStats(series,YAHOO_GLOBAL,endMs,slow)};
  if(!self.fast||!self.mid||!self.slow||!local.fast||!local.mid||!global.fast||!global.mid)return null;
  const c={
    self_fast:squash(self.fast.velocity_bps_min,3),
    self_mid:squash(self.mid.velocity_bps_min,2),
    self_slow:squash(self.slow.velocity_bps_min,1.2),
    flow_fast:squash(self.fast.signed_volume_ratio,.35),
    accel:squash(self.fast.velocity_bps_min-self.mid.velocity_bps_min,3),
    local_fast:squash(local.fast.velocity_bps_min,2.5),
    local_mid:squash(local.mid.velocity_bps_min,1.8),
    global_fast:squash(global.fast.velocity_bps_min,2.2),
    global_mid:squash(global.mid.velocity_bps_min,1.5),
    peer_lead:squash(local.fast.velocity_bps_min-self.fast.velocity_bps_min,3),
    hdr_self_local:hdr(self.fast.velocity_bps_min,local.fast.velocity_bps_min),
    hdr_local_global:hdr(local.mid.velocity_bps_min,global.mid.velocity_bps_min)
  };
  return {windows:w,self,local,global,c};
}
function scoreFor(h,c){
  if(h===1)return .30*c.self_fast+.20*c.flow_fast+.20*c.accel+.15*c.local_fast+.10*c.global_fast+.05*c.peer_lead;
  if(h===5)return .20*c.self_fast+.15*c.self_mid+.15*c.flow_fast+.15*c.local_fast+.10*c.local_mid+.10*c.global_fast+.10*c.peer_lead-.05*c.hdr_self_local;
  if(h===15)return .12*c.self_mid+.12*c.self_slow+.12*c.flow_fast+.20*c.local_mid+.17*c.global_mid+.17*c.peer_lead-.10*c.hdr_self_local;
  return .10*c.self_slow+.10*c.self_mid+.10*c.flow_fast+.22*c.local_mid+.22*c.global_mid+.16*c.peer_lead-.10*c.hdr_self_local;
}
function threshold(h){return h===1?.30:h===5?.26:h===15?.24:.22;}

export function forecastYahooShadow(series,nowMs=Date.now(),proof={}){
  const q=quality(series,nowMs);
  if(!q.usable)return {status:'blocked',reason:'insufficient_fresh_peer_events',quality:q,source:'yahoo_shadow'};
  const x=components(series,nowMs);
  if(!x)return {status:'blocked',reason:'insufficient_event_history',quality:q,source:'yahoo_shadow'};
  const forecasts=YAHOO_HORIZONS.map(h=>{
    const score=scoreFor(h,x.c),thr=threshold(h),dir=Math.abs(score)>=thr?Math.sign(score):0;
    return {
      horizon_minutes:h,dir,score,threshold:thr,margin:Math.abs(score)/thr,
      proof:proof[String(h)]||null,mode:'shadow_only'
    };
  });
  return {
    status:'ok',source:'yahoo_shadow',mode:'shadow_only',asof:new Date(nowMs).toISOString(),
    version:YAHOO_SHADOW_VERSION,quality:q,windows:x.windows,
    diagnostics:{self:x.self,local:x.local,global:x.global,coupling:x.c},
    forecasts
  };
}
