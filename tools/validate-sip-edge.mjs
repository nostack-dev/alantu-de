import fs from 'node:fs/promises';
import { aggregateMicrostructure, microstructureQuality } from './microstructure-core.mjs';
import { microFeatureAt, evaluateMicroFeature, modelId } from './microstructure-signal.mjs';

const KEY=process.env.APCA_API_KEY_ID||'', SECRET=process.env.APCA_API_SECRET_KEY||'';
const FEED=process.env.ALANTU_MARKET_FEED||'sip', SYMBOL=(process.env.MICRO_SYMBOL||'ORCL').toUpperCase();
const DAYS=Math.max(365,Math.min(800,Number(process.env.EDGE_CALENDAR_DAYS||540)));
const OUT=process.env.EDGE_STATUS_OUT||'microstructure-edge-status.json';
const REPORT=process.env.EDGE_REPORT_OUT||'microstructure-edge-report.json';
const NY=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

function nyParts(v){const o={};for(const p of NY.formatToParts(new Date(v)))if(p.type!=='literal')o[p.type]=p.value;return o;}
function regular(row){const p=nyParts(row.at),m=+p.hour*60+(+p.minute);return m>=570&&m<960;}
function dayKey(v){const p=nyParts(v);return p.year+'-'+p.month+'-'+p.day;}
function isoDay(d){return d.toISOString().slice(0,10);}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,den=1+z*z/n,c=(p+z*z/(2*n))/den,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/den;return [c-m,c+m];}
function med(xs){const a=xs.filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return null;return a[Math.floor(a.length/2)];}
function mean(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;}
function dayVol(day){
  const rows=day.minutes||[],r=[];
  for(let i=1;i<rows.length;i++){const a=Number(rows[i-1].price_last||rows[i-1].vwap),b=Number(rows[i].price_last||rows[i].vwap);if(a>0&&b>0)r.push(Math.abs(Math.log(b/a)));}
  return r.length?mean(r):0;
}
function lcg(seed){let s=seed>>>0;return()=>((s=(1664525*s+1013904223)>>>0)/4294967296);}
function bootstrapMeanByDay(ev,iters=2000){
  const by=new Map();for(const e of ev){if(!by.has(e.day))by.set(e.day,[]);by.get(e.day).push(e.net_bps);}
  const days=[...by.keys()];if(days.length<2)return [null,null];
  const rnd=lcg(0x0A17A);const out=[];
  for(let k=0;k<iters;k++){let vals=[];for(let i=0;i<days.length;i++){const d=days[Math.floor(rnd()*days.length)];vals=vals.concat(by.get(d));}out.push(mean(vals));}
  out.sort((a,b)=>a-b);return [out[Math.floor(.025*(out.length-1))],out[Math.floor(.975*(out.length-1))]];
}
const headers={'APCA-API-KEY-ID':KEY,'APCA-API-SECRET-KEY':SECRET};

async function paged(kind,start,end){
  let token='',rows=[],pages=0;
  do{
    const u=new URL(`https://data.alpaca.markets/v2/stocks/${SYMBOL}/${kind}`);
    u.searchParams.set('start',start);u.searchParams.set('end',end);u.searchParams.set('limit','10000');u.searchParams.set('feed',FEED);u.searchParams.set('sort','asc');
    if(token)u.searchParams.set('page_token',token);
    const r=await fetch(u,{headers});if(!r.ok)throw new Error(kind+' '+r.status+': '+await r.text());
    const j=await r.json();rows.push(...(j[kind]||[]));token=j.next_page_token||'';if(++pages>2000)throw new Error('pagination runaway');
  }while(token);
  return rows;
}
async function fetchDay(day){
  const start=day+'T00:00:00Z',end=day+'T23:59:59Z';
  const [trades,quotes]=await Promise.all([paged('trades',start,end),paged('quotes',start,end)]);
  const minutes=aggregateMicrostructure(trades,quotes).filter(regular);
  return {day,minutes,quality:microstructureQuality(minutes,{symbol:SYMBOL,feed:FEED}),raw:{trades:trades.length,quotes:quotes.length}};
}
function futurePrice(rows,i,h){
  const target=Date.parse(rows[i].at)+h*60000,day=dayKey(rows[i].at);
  for(let j=i+1;j<rows.length;j++){
    if(dayKey(rows[j].at)!==day)break;
    const t=Date.parse(rows[j].at);if(t>=target&&t-target<=90000){const p=Number(rows[j].price_last||rows[j].vwap);return p>0?p:null;}
  }
  return null;
}
function collectFeatures(days){
  const out=[];
  for(const d of days){
    const rows=d.minutes;
    for(let i=14;i<rows.length;i++){const f=microFeatureAt(rows,i);if(f&&f.price>0)out.push({day:d.day,i,rows,f});}
  }
  return out;
}
function signals(features,t,h){
  const out=[],lastByDay=new Map();
  for(const x of features){
    const s=evaluateMicroFeature(x.f,t);if(!s)continue;
    const last=lastByDay.get(x.day)||0,ms=Date.parse(x.f.at);if(ms-last<5*60000)continue;
    const fp=futurePrice(x.rows,x.i,h);if(!(fp>0))continue;
    const gross=s.dir*(fp/x.f.price-1)*10000;
    const cost=Math.max(.1,Number(x.f.spread_bps||0))+.35;
    out.push({day:x.day,at:x.f.at,dir:s.dir,gross_bps:gross,cost_bps:cost,net_bps:gross-cost,strength:s.strength});
    lastByDay.set(x.day,ms);
  }
  return out;
}
function stat(ev){
  const n=ev.length,k=ev.filter(x=>x.net_bps>0).length,net=ev.map(x=>x.net_bps),ci=wilson(k,n);
  return {n,days:new Set(ev.map(x=>x.day)).size,hit:n?k/n:null,hit95:ci,mean_net_bps:n?mean(net):null,median_net_bps:n?med(net):null,mean_net_bps95:bootstrapMeanByDay(ev)};
}
function trainScore(s){if(s.n<300||s.days<60)return -Infinity;return 3*(s.hit95?.[0]||0)+Math.max(-1,Math.min(3,s.mean_net_bps||0))*.18;}
function gate(s,halves,regimes,baseline){
  const reasons=[];
  if(s.n<500)reasons.push('holdout_sample_lt_500');
  if(s.days<60)reasons.push('holdout_days_lt_60');
  if((s.hit95?.[0]||0)<=.5)reasons.push('hit_ci_not_above_50');
  if(!(s.mean_net_bps>.5))reasons.push('mean_net_edge_le_0_5bps');
  if(!(s.median_net_bps>0))reasons.push('median_net_not_positive');
  if(!s.mean_net_bps95||!(s.mean_net_bps95[0]>0))reasons.push('day_block_bootstrap_ci_not_positive');
  for(let i=0;i<halves.length;i++){if(halves[i].n<150||halves[i].days<20||!(halves[i].mean_net_bps>0)||!(halves[i].median_net_bps>0)||!(halves[i].hit>=.5))reasons.push('unstable_half_'+(i+1));}
  for(const [name,r] of Object.entries(regimes||{})){if(r.n<100||r.days<15||!(r.mean_net_bps>0)||!(r.median_net_bps>0))reasons.push('unstable_regime_'+name);}
  if(baseline&&Number.isFinite(baseline.mean_net_bps)&&!(s.mean_net_bps>baseline.mean_net_bps+.25))reasons.push('does_not_beat_matched_baseline');
  return {status:reasons.length?'unproven':'validated',reasons};
}

if(!KEY||!SECRET){
  await fs.writeFile(OUT,JSON.stringify({provider:'alpaca',feed:FEED,symbol:SYMBOL,status:'unavailable',configured:false,reasons:['missing_credentials']},null,2));
  console.log('SIP edge: credentials missing; fail closed.');
  process.exit(0);
}

const end=new Date(),start=new Date(end.getTime()-DAYS*86400000),calendar=[];
for(let d=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),start.getUTCDate()));d<=end;d=new Date(d.getTime()+86400000)){const wd=d.getUTCDay();if(wd!==0&&wd!==6)calendar.push(isoDay(d));}
const fetched=[];
for(const day of calendar){const x=await fetchDay(day);if(x.minutes.length>=120&&x.quality.status==='usable')fetched.push(x);}
if(fetched.length<252)throw new Error('Too few usable SIP trading days for long-form proof: '+fetched.length+' < 252');

const finalCut=Math.floor(fetched.length*.80);
const development=fetched.slice(0,finalCut),finalTest=fetched.slice(finalCut);
if(finalTest.length<50)throw new Error('Final untouched test block too short: '+finalTest.length);

const devCut=Math.floor(development.length*.75);
const trainDays=development.slice(0,devCut),validationDays=development.slice(devCut);
const trainFeatures=collectFeatures(trainDays),validationFeatures=collectFeatures(validationDays),finalFeatures=collectFeatures(finalTest),grid=[];

for(const min_aggressor of [.04,.08,.12,.18])for(const min_ofi of [.02,.05,.1,.2])for(const min_quote of [.02,.05,.1])for(const min_micro_bps of [.01,.03,.06])for(const min_intensity of [.8,1,1.2,1.5])for(const min_consensus of [3,4])for(const h of [1,5,15]){
  const thresholds={min_aggressor,min_ofi,min_quote,min_micro_bps,min_intensity,min_consensus,min_fresh_quote_share:.8};
  const train=stat(signals(trainFeatures,thresholds,h));
  if(!Number.isFinite(trainScore(train)))continue;
  const validation=stat(signals(validationFeatures,thresholds,h));
  if(validation.n<150||validation.days<25||!(validation.mean_net_bps>0)||!(validation.median_net_bps>0))continue;
  const score=2*(validation.hit95?.[0]||0)+Math.max(-1,Math.min(3,validation.mean_net_bps||0))*.22;
  grid.push({thresholds,horizon_minutes:h,train,validation,score});
}
grid.sort((a,b)=>b.score-a.score);
const best=grid[0];if(!best)throw new Error('No development model reached minimum train+validation evidence');

const heldEvents=signals(finalFeatures,best.thresholds,best.horizon_minutes),held=stat(heldEvents);
const mid=Math.floor(finalTest.length/2),halfDays=[new Set(finalTest.slice(0,mid).map(x=>x.day)),new Set(finalTest.slice(mid).map(x=>x.day))];
const halves=halfDays.map(set=>stat(heldEvents.filter(x=>set.has(x.day))));

const vols=finalTest.map(d=>({day:d.day,v:dayVol(d)})).filter(x=>Number.isFinite(x.v)).sort((a,b)=>a.v-b.v);
const vm=vols.length?vols[Math.floor(vols.length/2)].v:0;
const lowDays=new Set(vols.filter(x=>x.v<=vm).map(x=>x.day)),highDays=new Set(vols.filter(x=>x.v>vm).map(x=>x.day));
const regimes={low_vol:stat(heldEvents.filter(x=>lowDays.has(x.day))),high_vol:stat(heldEvents.filter(x=>highDays.has(x.day)))};

// Matched-coverage no-model baseline: sign of current 1-minute return, sampled at the
// same timestamps as model events. This deliberately gives the baseline identical
// opportunity count and transaction-cost treatment.
const baseEvents=[];
for(const e of heldEvents){
  const day=finalTest.find(d=>d.day===e.day);if(!day)continue;
  const rows=day.minutes||[],idx=rows.findIndex(x=>x.at===e.at);if(idx<1)continue;
  const p0=Number(rows[idx-1].price_last||rows[idx-1].vwap),p1=Number(rows[idx].price_last||rows[idx].vwap);
  if(!(p0>0&&p1>0))continue;
  const dir=p1>p0?1:p1<p0?-1:0;if(!dir)continue;
  const fp=futurePrice(rows,idx,best.horizon_minutes);if(!(fp>0))continue;
  const gross=dir*(fp/p1-1)*10000,cost=Math.max(.1,Number(rows[idx].spread_bps_median||0))+.35;
  baseEvents.push({day:e.day,net_bps:gross-cost});
}
const baseline={n:baseEvents.length,mean_net_bps:baseEvents.length?mean(baseEvents.map(x=>x.net_bps)):null,median_net_bps:baseEvents.length?med(baseEvents.map(x=>x.net_bps)):null};

const verdict=gate(held,halves,regimes,baseline),id=modelId(best.thresholds,best.horizon_minutes);
const status={
  provider:'alpaca',feed:FEED,symbol:SYMBOL,status:verdict.status,configured:true,reasons:verdict.reasons,
  model_id:id,thresholds:best.thresholds,horizon_minutes:best.horizon_minutes,
  train:best.train,validation:best.validation,holdout:held,holdout_halves:halves,holdout_regimes:regimes,matched_momentum_baseline:baseline,
  usable_days:fetched.length,train_days:trainDays.length,validation_days:validationDays.length,holdout_days:finalTest.length,
  source_window:{start:fetched[0].day,end:fetched.at(-1).day},
  protocol:{minimum_usable_days:252,minimum_holdout_signals:500,minimum_holdout_days:60,final_untouched_fraction:.20,day_block_bootstrap:true,regime_checks:['low_vol','high_vol'],costs:'observed spread + 0.35 bps slippage'},
  validated_at:new Date().toISOString()
};
const report={...status,top_models:grid.slice(0,10),day_quality:fetched.map(x=>({day:x.day,quality:x.quality,raw:x.raw}))};
await fs.writeFile(OUT,JSON.stringify(status,null,2));
await fs.writeFile(REPORT,JSON.stringify(report,null,2));
console.log('SIP_EDGE_STATUS '+JSON.stringify(status));
