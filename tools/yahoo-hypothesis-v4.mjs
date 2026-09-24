export const HYPOTHESIS_VERSION='yahoo-hypothesis-v4';
export const HYPOTHESIS_STRATEGIES=['continuation','reversal','regime'];
export const PRODUCTION_STRATEGY='regime';
export const PRODUCTION_HORIZON_PRIORITY=[15,5,30,1];
export const HYPOTHESIS_MIN_MARGIN=1.15;
export const DEFAULT_ROUNDTRIP_COST_BPS=2.0;

const NY_PARTS=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const NY_DAY=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function mean(a){const x=a.filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:null;}
function median(a){const x=a.filter(Number.isFinite).sort((a,b)=>a-b);if(!x.length)return null;const m=x.length>>1;return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,den=1+z*z/n,c=(p+z*z/(2*n))/den,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/den;return [Math.max(0,c-m),Math.min(1,c+m)];}
function nyParts(ms){const o={};for(const p of NY_PARTS.formatToParts(new Date(ms)))if(p.type!=='literal')o[p.type]=p.value;return o;}
export function nyDayKey(ms){try{return NY_DAY.format(new Date(ms));}catch{return '';}}
export function signalSessionEligible(nowMs,horizonMinutes){
  const p=nyParts(nowMs),wd=p.weekday,minute=Number(p.hour)*60+Number(p.minute),h=Number(horizonMinutes)||0;
  if(wd==='Sat'||wd==='Sun')return false;
  return minute>=575 && minute<960 && minute+h<=960;
}
export function regimeDecision(forecastState,forecast){
  const d=Math.sign(Number(forecast?.dir)||0),c=forecastState?.diagnostics?.coupling||{};
  if(!d)return {dir:0,mode:'none',reason:'no_base_direction',features:{}};
  const selfFast=Number(c.self_fast)||0,localFast=Number(c.local_fast)||0,globalFast=Number(c.global_fast)||0;
  const peerLead=Number(c.peer_lead)||0,hdrSelfLocal=Number(c.hdr_self_local)||0,selfMid=Number(c.self_mid)||0;
  const stretch=d*hdrSelfLocal,peerRelative=d*peerLead,localSupport=d*localFast,globalSupport=d*globalFast,midSupport=d*selfMid;
  const overextended=stretch>=0.30||peerRelative<=-0.30;
  const peersAgainst=(localSupport<=-0.12&&globalSupport<=0.08)||(globalSupport<=-0.12&&localSupport<=0.08);
  const peersConfirm=localSupport>=0.12&&globalSupport>=0.08&&midSupport>=-0.08;
  const reverse=(overextended&&!peersConfirm)||peersAgainst;
  return {
    dir:reverse?-d:d,mode:reverse?'reversal':'continuation',
    reason:reverse?(peersAgainst?'peers_against_move':'self_overextended_vs_peers'):(peersConfirm?'peers_confirm_move':'no_reversal_condition'),
    features:{stretch,peer_relative:peerRelative,local_support:localSupport,global_support:globalSupport,mid_support:midSupport,overextended,peers_against:peersAgainst,peers_confirm:peersConfirm}
  };
}
export function strategyDirections(forecastState,forecast){
  const d=Math.sign(Number(forecast?.dir)||0),r=regimeDecision(forecastState,forecast);
  return {continuation:d,reversal:d?-d:0,regime:r.dir,regime_meta:r};
}
export function actionableNewsContext(sourceState,nowMs=Date.now()){
  const items=(sourceState?.items||[]).filter(x=>x?.live&&x?.discovered_at).sort((a,b)=>Date.parse(b.discovered_at)-Date.parse(a.discovered_at));
  const newest=items[0]||null,net=Number(sourceState?.net),dir=Number.isFinite(net)&&Math.abs(net)>=15?Math.sign(net):0;
  return {
    active:!!newest,dir,net:Number.isFinite(net)?net:null,coverage:sourceState?.coverage||'quiet',
    live_count:Number(sourceState?.live_count)||0,source_counts:sourceState?.source_counts||{},
    published_at:newest?new Date(Number(newest.time)).toISOString():null,
    first_seen_at:newest?.discovered_at||null,delivery_lag_ms:newest?.discovery_delay_ms??null,
    market_at_published:newest?.market||null,market_at_first_seen:newest?.actionable_market||null,
    age_at_signal_ms:newest?.discovered_at?Math.max(0,nowMs-Date.parse(newest.discovered_at)):null
  };
}
function maxDrawdown(nets){let cum=0,peak=0,dd=0;for(const n of nets){cum+=n;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum);}return dd;}
function basicStats(rows){
  const a=rows.filter(x=>x?.status==='evaluated'&&Number.isFinite(Number(x.net_bps))).slice().sort((x,y)=>Date.parse(x.at)-Date.parse(y.at));
  const nets=a.map(x=>Number(x.net_bps)),gross=a.map(x=>Number(x.gross_bps)).filter(Number.isFinite),wins=nets.filter(x=>x>0),loss=nets.filter(x=>x<=0);
  const profitable=wins.length,n=a.length,pf=loss.length?(wins.reduce((s,x)=>s+x,0)/Math.abs(loss.reduce((s,x)=>s+x,0))):(wins.length?Infinity:null);
  const days=new Set(a.map(x=>nyDayKey(Date.parse(x.at))).filter(Boolean)).size;
  return {
    n,days,profitable_rate:n?profitable/n:null,direction_hit_rate:n?a.filter(x=>x.direction_hit===true).length/n:null,
    profitable95:wilson(profitable,n),mean_gross_bps:mean(gross),mean_net_bps:mean(nets),median_net_bps:median(nets),
    total_net_bps:nets.reduce((s,x)=>s+x,0),avg_win_bps:mean(wins),avg_loss_bps:mean(loss),profit_factor:pf,max_drawdown_bps:maxDrawdown(nets)
  };
}
function strategyStats(outcomes,strategy,h){
  const rows=(outcomes||[]).filter(x=>x.version===HYPOTHESIS_VERSION&&x.strategy===strategy&&Number(x.horizon_minutes)===Number(h)&&x.status==='evaluated').sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const all=basicStats(rows),mid=Math.floor(rows.length/2);
  return {...all,halves:[basicStats(rows.slice(0,mid)),basicStats(rows.slice(mid))]};
}
function gateRegime(s){
  const reasons=[];
  if(s.n<180)reasons.push('signals_lt_180');
  if(s.days<10)reasons.push('trading_days_lt_10');
  if(!(s.profitable_rate>=0.54))reasons.push('profitable_rate_lt_54pct');
  if(!s.profitable95||!(s.profitable95[0]>0.50))reasons.push('profit_rate_ci_not_above_50');
  if(!(s.mean_net_bps>=0.75))reasons.push('mean_net_lt_0_75bps');
  if(!(s.median_net_bps>0))reasons.push('median_net_not_positive');
  if(!(s.profit_factor>=1.20))reasons.push('profit_factor_lt_1_20');
  for(let i=0;i<2;i++){
    const h=s.halves?.[i]||{};
    if((h.n||0)<60||!(h.mean_net_bps>0)||!(h.profit_factor>=1.05))reasons.push('unstable_half_'+(i+1));
  }
  return reasons;
}
export function summarizeHypothesisState(state,costBps=DEFAULT_ROUNDTRIP_COST_BPS){
  const outcomes=state?.outcomes||[],proof={};
  for(const h of [1,5,15,30]){
    proof[String(h)]={};
    for(const s of HYPOTHESIS_STRATEGIES)proof[String(h)][s]=strategyStats(outcomes,s,h);
    const r=proof[String(h)].regime,reasons=gateRegime(r);
    r.gate={status:reasons.length?'collecting':'validated',reasons};
    if(reasons.length&&r.n>=60&&r.days>=3&&r.mean_net_bps>0.5&&r.profit_factor>1.10)r.gate.status='promising';
  }
  const validated=PRODUCTION_HORIZON_PRIORITY.filter(h=>proof[String(h)].regime.gate.status==='validated');
  return {
    version:HYPOTHESIS_VERSION,contract:'frozen_prospective_regime_selector_v1',production_strategy:PRODUCTION_STRATEGY,
    assumed_roundtrip_cost_bps:Number(costBps),min_signal_margin:HYPOTHESIS_MIN_MARGIN,proof,
    production:{enabled:validated.length>0,validated_horizons:validated,selected_horizon:validated[0]||null},
    updated_at:state?.updated_at||null
  };
}
