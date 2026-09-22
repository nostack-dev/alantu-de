import fs from 'node:fs/promises';
import { aggregateMicrostructure, microstructureQuality } from './microstructure-core.mjs';
import { microFeatureAt, evaluateMicroFeature, modelId } from './microstructure-signal.mjs';

const KEY=process.env.APCA_API_KEY_ID||'', SECRET=process.env.APCA_API_SECRET_KEY||'';
const FEED=process.env.ALANTU_MARKET_FEED||'sip', SYMBOL=(process.env.MICRO_SYMBOL||'ORCL').toUpperCase();
const DAYS=Math.max(20,Math.min(90,Number(process.env.EDGE_CALENDAR_DAYS||45)));
const OUT=process.env.EDGE_STATUS_OUT||'microstructure-edge-status.json';
const REPORT=process.env.EDGE_REPORT_OUT||'microstructure-edge-report.json';
const NY=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

function nyParts(v){const o={};for(const p of NY.formatToParts(new Date(v)))if(p.type!=='literal')o[p.type]=p.value;return o;}
function regular(row){const p=nyParts(row.at),m=+p.hour*60+(+p.minute);return m>=570&&m<960;}
function dayKey(v){const p=nyParts(v);return p.year+'-'+p.month+'-'+p.day;}
function isoDay(d){return d.toISOString().slice(0,10);}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,den=1+z*z/n,c=(p+z*z/(2*n))/den,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/den;return [c-m,c+m];}
function med(xs){const a=xs.filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return null;return a[Math.floor(a.length/2)];}
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
  return {n,days:new Set(ev.map(x=>x.day)).size,hit:n?k/n:null,hit95:ci,mean_net_bps:n?net.reduce((a,b)=>a+b,0)/n:null,median_net_bps:n?med(net):null};
}
function trainScore(s){if(s.n<60||s.days<12)return -Infinity;return 3*(s.hit95?.[0]||0)+Math.max(-1,Math.min(3,s.mean_net_bps||0))*.18;}
function gate(s,halves){
  const reasons=[];
  if(s.n<40)reasons.push('holdout_sample_lt_40');
  if(s.days<10)reasons.push('holdout_days_lt_10');
  if((s.hit95?.[0]||0)<=.5)reasons.push('hit_ci_not_above_50');
  if(!(s.mean_net_bps>.5))reasons.push('mean_net_edge_le_0_5bps');
  if(!(s.median_net_bps>0))reasons.push('median_net_not_positive');
  for(let i=0;i<halves.length;i++){if(halves[i].n<12||!(halves[i].mean_net_bps>0)||!(halves[i].hit>=.5))reasons.push('unstable_half_'+(i+1));}
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
if(fetched.length<20)throw new Error('Too few usable SIP trading days: '+fetched.length);

const cut=Math.floor(fetched.length*.7),trainDays=fetched.slice(0,cut),testDays=fetched.slice(cut),trainFeatures=collectFeatures(trainDays),testFeatures=collectFeatures(testDays),grid=[];
for(const min_aggressor of [.04,.08,.12,.18])for(const min_ofi of [.02,.05,.1,.2])for(const min_quote of [.02,.05,.1])for(const min_micro_bps of [.01,.03,.06])for(const min_intensity of [.8,1,1.2,1.5])for(const min_consensus of [3,4])for(const h of [1,5,15]){
  const thresholds={min_aggressor,min_ofi,min_quote,min_micro_bps,min_intensity,min_consensus,min_fresh_quote_share:.8};
  const s=stat(signals(trainFeatures,thresholds,h)),score=trainScore(s);if(Number.isFinite(score))grid.push({thresholds,horizon_minutes:h,train:s,score});
}
grid.sort((a,b)=>b.score-a.score);
const best=grid[0];if(!best)throw new Error('No train model reached minimum sample');
const heldEvents=signals(testFeatures,best.thresholds,best.horizon_minutes),held=stat(heldEvents);
const mid=Math.floor(testDays.length/2),halfDays=[new Set(testDays.slice(0,mid).map(x=>x.day)),new Set(testDays.slice(mid).map(x=>x.day))];
const halves=halfDays.map(set=>stat(heldEvents.filter(x=>set.has(x.day))));
const verdict=gate(held,halves),id=modelId(best.thresholds,best.horizon_minutes);
const status={
  provider:'alpaca',feed:FEED,symbol:SYMBOL,status:verdict.status,configured:true,reasons:verdict.reasons,
  model_id:id,thresholds:best.thresholds,horizon_minutes:best.horizon_minutes,
  train:best.train,holdout:held,holdout_halves:halves,
  usable_days:fetched.length,train_days:trainDays.length,holdout_days:testDays.length,
  source_window:{start:fetched[0].day,end:fetched.at(-1).day},
  validated_at:new Date().toISOString()
};
const report={...status,top_models:grid.slice(0,10),day_quality:fetched.map(x=>({day:x.day,quality:x.quality,raw:x.raw}))};
await fs.writeFile(OUT,JSON.stringify(status,null,2));
await fs.writeFile(REPORT,JSON.stringify(report,null,2));
console.log('SIP_EDGE_STATUS '+JSON.stringify(status));
