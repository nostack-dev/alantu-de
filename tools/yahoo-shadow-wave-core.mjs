export const YAHOO_SHADOW_VERSION='yahoo-shadow-hdr-dt-v3';
export const YAHOO_HORIZONS=[1,5,15,30];
export const YAHOO_LOCAL=['MSFT','AMZN','GOOGL','NVDA','IGV'];
export const YAHOO_GLOBAL=['QQQ','SPY'];

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function median(a){const x=a.filter(Number.isFinite).sort((p,q)=>p-q);if(!x.length)return null;const m=x.length>>1;return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function mean(a){const x=a.filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:null;}
export function hdr(a,b){a=Number(a);b=Number(b);if(!Number.isFinite(a)||!Number.isFinite(b))return 0;return clamp((a-b)/(Math.abs(a)+Math.abs(b)+1e-12),-1,1);}
function squash(x,scale=1){return Math.tanh(Number(x||0)/Math.max(1e-9,scale));}

function statsRows(a){
  if(!a||a.length<2)return null;
  const first=a[0],last=a[a.length-1],mins=Math.max((last.t-first.t)/60000,1/60);
  if(!(first.p>0&&last.p>0))return null;
  let signedVol=0,totalVol=0,up=0,down=0;
  for(let i=1;i<a.length;i++){
    const dv=Math.max(0,Number(a[i].dv)||0),d=a[i].p-a[i-1].p,s=d>0?1:d<0?-1:0;
    signedVol+=s*dv;totalVol+=dv;if(s>0)up++;else if(s<0)down++;
  }
  const ret=Math.log(last.p/first.p)*10000,dir=ret>0?1:ret<0?-1:0,steps=up+down;
  const eventRatio=steps?(up-down)/steps:0;
  return {
    count:a.length,
    elapsed_s:Math.max(1,(last.t-first.t)/1000),
    return_bps:ret,
    velocity_bps_min:ret/mins,
    signed_volume_ratio:totalVol?signedVol/totalVol:null,
    directional_event_ratio:eventRatio,
    flow_ratio:totalVol?signedVol/totalVol:eventRatio,
    event_rate:a.length/Math.max(1,(last.t-first.t)/1000),
    persistence:steps?(dir>0?up:down)/steps:0
  };
}
function statsN(rows,n){
  if(!rows||rows.length<2)return null;
  return statsRows(rows.slice(Math.max(0,rows.length-n)));
}
function groupStatsN(series,symbols,n){
  const s=symbols.map(sym=>statsN(series[sym]||[],n)).filter(Boolean);
  if(!s.length)return null;
  return {
    members:s.length,
    return_bps:median(s.map(x=>x.return_bps)),
    velocity_bps_min:median(s.map(x=>x.velocity_bps_min)),
    flow_ratio:median(s.map(x=>x.flow_ratio)),
    event_rate:mean(s.map(x=>x.event_rate)),
    persistence:median(s.map(x=>x.persistence))
  };
}
function freshCount(series,symbols,endMs,maxAge){
  return symbols.filter(s=>{const x=(series[s]||[]).at(-1);return x&&endMs-x.t<=maxAge;}).length;
}
function quality(series,endMs){
  const target=series.ORCL||[],last=target.at(-1),age=last?Math.max(0,endMs-last.t):Infinity;
  const maxAge=5*60000;
  const localFresh=freshCount(series,YAHOO_LOCAL,endMs,maxAge);
  const globalFresh=freshCount(series,YAHOO_GLOBAL,endMs,maxAge);
  const peerWeight=clamp((localFresh/3+globalFresh)/2,0,1);
  const ageWeight=clamp(1-(age/maxAge)*0.5,.5,1);
  const usable=target.length>=5&&age<=maxAge&&localFresh>=2&&globalFresh>=1;
  return {
    target_age_ms:age,target_events:target.length,local_fresh:localFresh,global_fresh:globalFresh,
    max_age_ms:maxAge,freshness_weight:usable?ageWeight*peerWeight:0,usable
  };
}
function components(series){
  const target=series.ORCL||[];
  const self={fast:statsN(target,2),mid:statsN(target,3),slow:statsN(target,5)};
  const local={fast:groupStatsN(series,YAHOO_LOCAL,2),mid:groupStatsN(series,YAHOO_LOCAL,3),slow:groupStatsN(series,YAHOO_LOCAL,5)};
  const global={fast:groupStatsN(series,YAHOO_GLOBAL,2),mid:groupStatsN(series,YAHOO_GLOBAL,3),slow:groupStatsN(series,YAHOO_GLOBAL,5)};
  if(!self.fast||!self.mid||!self.slow||!local.fast||!local.mid||!global.fast||!global.mid)return null;
  if(local.fast.members<2||local.mid.members<2||global.fast.members<1||global.mid.members<1)return null;
  const c={
    self_fast:squash(self.fast.velocity_bps_min,3),
    self_mid:squash(self.mid.velocity_bps_min,2),
    self_slow:squash(self.slow.velocity_bps_min,1.2),
    flow_fast:squash(self.fast.flow_ratio,.45),
    accel:squash(self.fast.velocity_bps_min-self.mid.velocity_bps_min,3),
    local_fast:squash(local.fast.velocity_bps_min,2.5),
    local_mid:squash(local.mid.velocity_bps_min,1.8),
    global_fast:squash(global.fast.velocity_bps_min,2.2),
    global_mid:squash(global.mid.velocity_bps_min,1.5),
    peer_lead:squash(local.fast.velocity_bps_min-self.fast.velocity_bps_min,3),
    hdr_self_local:hdr(self.fast.velocity_bps_min,local.fast.velocity_bps_min),
    hdr_local_global:hdr(local.mid.velocity_bps_min,global.mid.velocity_bps_min)
  };
  return {
    windows:{mode:'adaptive_event_count',fast_events:2,mid_events:3,slow_events:5,exact_dt:true},
    self,local,global,c
  };
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
  const x=components(series);
  if(!x)return {status:'blocked',reason:'insufficient_event_history',quality:q,source:'yahoo_shadow'};
  const forecasts=YAHOO_HORIZONS.map(h=>{
    const raw=scoreFor(h,x.c),score=raw*q.freshness_weight,thr=threshold(h),dir=Math.abs(score)>=thr?Math.sign(score):0;
    return {
      horizon_minutes:h,dir,score,raw_score:raw,threshold:thr,margin:Math.abs(score)/thr,
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
