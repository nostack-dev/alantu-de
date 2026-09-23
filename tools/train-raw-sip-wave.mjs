import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {extractRawSamples,RAW_FEATURE_NAMES,RAW_FEATURE_VERSION,RAW_HORIZONS,RAW_SAMPLE_SECONDS} from './raw-sip-wave-core.mjs';

const gzip=promisify(zlib.gzip),gunzip=promisify(zlib.gunzip);
const KEY=process.env.APCA_API_KEY_ID||'',SECRET=process.env.APCA_API_SECRET_KEY||'';
const FEED=process.env.ALANTU_MARKET_FEED||'sip',SYMBOL=(process.env.MICRO_SYMBOL||'ORCL').toUpperCase();
const DAYS=Math.max(120,Math.min(800,Number(process.env.RAW_EDGE_CALENDAR_DAYS||365)));
const MIN_DAYS=Math.max(80,Math.min(300,Number(process.env.RAW_EDGE_MIN_USABLE_DAYS||200)));
const DATA_DIR=process.env.RAW_SIP_DATA_DIR||'/data/alantu';
const CACHE_DIR=path.join(DATA_DIR,'raw-sip-features',RAW_FEATURE_VERSION,SYMBOL);
const MODEL_OUT=process.env.RAW_SIP_MODEL_OUT||path.join(DATA_DIR,'orcl-raw-sip-model.json');
const STATUS_OUT=process.env.RAW_SIP_STATUS_OUT||path.join(DATA_DIR,'orcl-raw-sip-status.json');
const COST_SLIPPAGE_BPS=Math.max(0,Number(process.env.RAW_EDGE_SLIPPAGE_BPS||0.35));
const LAMBDA=Math.max(.01,Number(process.env.RAW_EDGE_RIDGE_LAMBDA||12));
const Q=[.80,.85,.90,.925,.95,.965,.975,.985,.99,.995];

function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;}
function med(a){const x=a.filter(Number.isFinite).sort((a,b)=>a-b);if(!x.length)return null;const m=x.length>>1;return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function quantile(a,p){const x=a.filter(Number.isFinite).sort((a,b)=>a-b);if(!x.length)return null;const k=(x.length-1)*p,l=Math.floor(k),h=Math.ceil(k);return l===h?x[l]:x[l]+(x[h]-x[l])*(k-l);}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [c-m,c+m];}
function lcg(seed){let s=seed>>>0;return()=>((s=(1664525*s+1013904223)>>>0)/4294967296);}
function bootstrapDayMean(ev,iters=1000){const m=new Map();for(const e of ev){if(!m.has(e.day))m.set(e.day,[]);m.get(e.day).push(e.net_bps);}const days=[...m.keys()];if(days.length<2)return [null,null];const rnd=lcg(0xA1A17),o=[];for(let k=0;k<iters;k++){let vals=[];for(let i=0;i<days.length;i++)vals=vals.concat(m.get(days[Math.floor(rnd()*days.length)]));o.push(mean(vals));}o.sort((a,b)=>a-b);return [o[Math.floor(.025*(o.length-1))],o[Math.floor(.975*(o.length-1))]];}
function stats(ev){const n=ev.length,k=ev.filter(x=>x.net_bps>0).length,nets=ev.map(x=>x.net_bps);return {n,days:new Set(ev.map(x=>x.day)).size,hit:n?k/n:null,hit95:wilson(k,n),mean_net_bps:n?mean(nets):null,median_net_bps:n?med(nets):null,mean_net_bps95:bootstrapDayMean(ev)};}
function isoDay(d){return d.toISOString().slice(0,10);}
function calendarDays(){const end=new Date(),start=new Date(end.getTime()-DAYS*86400000),out=[];for(let d=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),start.getUTCDate()));d<=end;d=new Date(d.getTime()+86400000)){const wd=d.getUTCDay();if(wd!==0&&wd!==6)out.push(isoDay(d));}return out;}
const headers={'APCA-API-KEY-ID':KEY,'APCA-API-SECRET-KEY':SECRET};

async function writeJsonAtomic(file,obj){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(obj,null,2)+'\n');await fs.rename(tmp,file);}
async function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function requestJson(url,attempt=0){
  const r=await fetch(url,{headers});
  if(r.ok)return r.json();
  const body=await r.text();
  if((r.status===429||r.status>=500)&&attempt<7){const ra=Number(r.headers.get('retry-after'));await sleep(Number.isFinite(ra)&&ra>0?ra*1000:Math.min(30000,500*Math.pow(2,attempt)));return requestJson(url,attempt+1);}
  throw new Error('HTTP '+r.status+' '+body.slice(0,500));
}
async function verifySIP(){
  const u=new URL('https://data.alpaca.markets/v2/stocks/'+SYMBOL+'/quotes/latest');u.searchParams.set('feed','sip');
  const j=await requestJson(u);if(!j?.quote)throw new Error('SIP latest quote unavailable');
  return {ok:true,at:j.quote.t||null};
}
async function paged(kind,day){
  let token='',rows=[],pages=0;
  const start=day+'T00:00:00Z',end=day+'T23:59:59.999999999Z';
  do{
    const u=new URL('https://data.alpaca.markets/v2/stocks/'+SYMBOL+'/'+kind);
    u.searchParams.set('start',start);u.searchParams.set('end',end);u.searchParams.set('limit','10000');u.searchParams.set('feed',FEED);u.searchParams.set('sort','asc');if(token)u.searchParams.set('page_token',token);
    const j=await requestJson(u);rows.push(...(j[kind]||[]));token=j.next_page_token||'';if(++pages>10000)throw new Error('pagination runaway '+kind+' '+day);
  }while(token);
  return rows;
}
async function readCache(day){
  const f=path.join(CACHE_DIR,day+'.json.gz');
  try{return JSON.parse((await gunzip(await fs.readFile(f))).toString('utf8'));}catch{return null;}
}
async function cacheDay(day,obj){
  await fs.mkdir(CACHE_DIR,{recursive:true});const f=path.join(CACHE_DIR,day+'.json.gz'),tmp=f+'.tmp';await fs.writeFile(tmp,await gzip(Buffer.from(JSON.stringify(obj))));await fs.rename(tmp,f);
}
async function buildDay(day){
  const cached=await readCache(day);if(cached?.feature_version===RAW_FEATURE_VERSION)return cached;
  const [trades,quotes]=await Promise.all([paged('trades',day),paged('quotes',day)]);
  const samples=extractRawSamples(trades,quotes,{sampleSeconds:RAW_SAMPLE_SECONDS,horizons:RAW_HORIZONS}).map(s=>({
    at:s.at,anchor_ns:s.anchor_ns,price:s.price,spread_bps:s.spread_bps,x:s.x,y:s.y,
    baseline_dir:Math.sign(Number(s.diagnostics?.self?.price_velocity_bps_min)||0),
    windows:s.windows
  }));
  const out={day,feature_version:RAW_FEATURE_VERSION,symbol:SYMBOL,feed:FEED,raw:{trades:trades.length,quotes:quotes.length},samples,usable:samples.length>=200&&trades.length>=1000&&quotes.length>=1000};
  await cacheDay(day,out);return out;
}
function standardization(rows){const p=RAW_FEATURE_NAMES.length,mu=Array(p).fill(0),sd=Array(p).fill(0);for(const r of rows)for(let j=0;j<p;j++)mu[j]+=r.x[j];for(let j=0;j<p;j++)mu[j]/=Math.max(1,rows.length);for(const r of rows)for(let j=0;j<p;j++){const d=r.x[j]-mu[j];sd[j]+=d*d;}for(let j=0;j<p;j++)sd[j]=Math.sqrt(sd[j]/Math.max(1,rows.length-1))||1;return {mean:mu,std:sd};}
function solve(A,b){const n=A.length,M=A.map((r,i)=>r.slice().concat([b[i]]));for(let k=0;k<n;k++){let p=k;for(let i=k+1;i<n;i++)if(Math.abs(M[i][k])>Math.abs(M[p][k]))p=i;if(Math.abs(M[p][k])<1e-12)M[p][k]+=1e-9;[M[k],M[p]]=[M[p],M[k]];const d=M[k][k];for(let j=k;j<=n;j++)M[k][j]/=d;for(let i=0;i<n;i++){if(i===k)continue;const f=M[i][k];if(!f)continue;for(let j=k;j<=n;j++)M[i][j]-=f*M[k][j];}}return M.map(r=>r[n]);}
function fit(rows,std,h){const p=RAW_FEATURE_NAMES.length+1,A=Array.from({length:p},()=>Array(p).fill(0)),b=Array(p).fill(0);for(const r of rows){const y=Number(r.y?.[h]);if(!Number.isFinite(y))continue;const z=[1,...r.x.map((v,j)=>(v-std.mean[j])/std.std[j])];for(let i=0;i<p;i++){b[i]+=z[i]*y;for(let j=0;j<p;j++)A[i][j]+=z[i]*z[j];}}for(let i=1;i<p;i++)A[i][i]+=LAMBDA;return solve(A,b);}
function score(r,std,b){let s=b[0];for(let j=0;j<r.x.length;j++)s+=((r.x[j]-std.mean[j])/std.std[j])*b[j+1];return s;}
function rowsFor(days,h){const out=[];for(const d of days)for(const s of d.samples||[])if(Number.isFinite(Number(s.y?.[h])))out.push({...s,day:d.day});return out;}
function events(rows,std,b,thr,h){
  const out=[],last=new Map(),sep=Math.max(30000,Math.min(900000,h*30000));
  for(const r of rows){const sc=score(r,std,b);if(!Number.isFinite(sc)||Math.abs(sc)<thr)continue;const ms=Date.parse(r.at),prev=last.get(r.day)||0;if(ms-prev<sep)continue;const dir=Math.sign(sc);if(!dir)continue;const gross=dir*Number(r.y[h]),cost=Math.max(.1,Number(r.spread_bps)||0)+COST_SLIPPAGE_BPS;out.push({day:r.day,at:r.at,dir,score:sc,net_bps:gross-cost,gross_bps:gross,cost_bps:cost,baseline_dir:Number(r.baseline_dir)||0,y:Number(r.y[h])});last.set(r.day,ms);}return out;
}
function baseline(ev){const b=[];for(const e of ev){if(!e.baseline_dir)continue;const gross=e.baseline_dir*e.y;b.push({day:e.day,net_bps:gross-e.cost_bps});}return {n:b.length,mean_net_bps:b.length?mean(b.map(x=>x.net_bps)):null,median_net_bps:b.length?med(b.map(x=>x.net_bps)):null};}
function dayVol(d){const a=(d.samples||[]).map(s=>Math.abs(Number(s.y?.[1]))).filter(Number.isFinite);return a.length?mean(a):0;}
function gate(s,halves,regimes,base){
  const reasons=[];if(s.n<250)reasons.push('holdout_signals_lt_250');if(s.days<30)reasons.push('holdout_days_lt_30');if(!(s.hit>=.54))reasons.push('holdout_hit_lt_54pct');if((s.hit95?.[0]||0)<=.50)reasons.push('hit_ci_not_above_50');if(!(s.mean_net_bps>.5))reasons.push('mean_net_edge_le_0_5bps');if(!(s.median_net_bps>0))reasons.push('median_net_not_positive');if(!s.mean_net_bps95||!(s.mean_net_bps95[0]>0))reasons.push('day_bootstrap_ci_not_positive');
  for(let i=0;i<halves.length;i++)if(halves[i].n<80||halves[i].days<12||!(halves[i].mean_net_bps>0)||!(halves[i].median_net_bps>0)||!(halves[i].hit>=.51))reasons.push('unstable_half_'+(i+1));
  for(const [n,r] of Object.entries(regimes))if(r.n<60||r.days<10||!(r.mean_net_bps>0)||!(r.median_net_bps>0))reasons.push('unstable_regime_'+n);
  if(base.n>=100&&Number.isFinite(base.mean_net_bps)&&!(s.mean_net_bps>base.mean_net_bps+.25))reasons.push('does_not_beat_matched_momentum');
  return reasons;
}

async function main(){
  await fs.mkdir(DATA_DIR,{recursive:true});
  if(!KEY||!SECRET){
    const status={provider:'alpaca',feed:FEED,symbol:SYMBOL,status:'awaiting_credentials',configured:false,feature_version:RAW_FEATURE_VERSION,reasons:['missing_credentials'],updated_at:new Date().toISOString()};
    await writeJsonAtomic(STATUS_OUT,status);console.log('RAW_SIP_EDGE '+JSON.stringify(status));return;
  }
  const entitlement=await verifySIP();
  const built=[];
  for(const day of calendarDays()){
    try{const d=await buildDay(day);if(d.usable)built.push(d);}
    catch(e){console.error(JSON.stringify({event:'raw_sip_day_failed',day,error:String(e.message||e)}));}
  }
  if(built.length<MIN_DAYS){
    const status={provider:'alpaca',feed:FEED,symbol:SYMBOL,status:'collecting',configured:true,feature_version:RAW_FEATURE_VERSION,usable_days:built.length,minimum_days:MIN_DAYS,subscription_verified:entitlement.ok,reasons:['usable_days_below_gate'],updated_at:new Date().toISOString()};
    await writeJsonAtomic(STATUS_OUT,status);console.log('RAW_SIP_EDGE '+JSON.stringify(status));return;
  }
  built.sort((a,b)=>a.day.localeCompare(b.day));
  const holdN=Math.max(30,Math.floor(built.length*.20)),dev=built.slice(0,-holdN),hold=built.slice(-holdN),valN=Math.max(20,Math.floor(dev.length*.25)),train=dev.slice(0,-valN),val=dev.slice(-valN);
  const horizons=[];
  for(const h of RAW_HORIZONS){
    const tr=rowsFor(train,h),va=rowsFor(val,h),ho=rowsFor(hold,h);
    if(tr.length<1000||va.length<500||ho.length<500){horizons.push({horizon_minutes:h,status:'unproven',reasons:['too_few_samples']});continue;}
    const std=standardization(tr),beta=fit(tr,std,h),scores=va.map(r=>Math.abs(score(r,std,beta)));
    let best=null;
    for(const q of Q){const thr=quantile(scores,q);if(!(thr>0))continue;const ev=events(va,std,beta,thr,h),s=stats(ev);if(s.n<100||s.days<15||!(s.mean_net_bps>0)||!(s.median_net_bps>0))continue;const obj=(s.hit95?.[0]||0)*10+Math.min(5,s.mean_net_bps||0)*.2+Math.log1p(s.n)*.02;if(!best||obj>best.obj)best={q,thr,s,obj};}
    if(!best){horizons.push({horizon_minutes:h,status:'unproven',reasons:['no_validation_threshold']});continue;}
    const devRows=rowsFor(dev,h),std2=standardization(devRows),beta2=fit(devRows,std2,h),thr2=quantile(devRows.map(r=>Math.abs(score(r,std2,beta2))),best.q),heldEv=events(ho,std2,beta2,thr2,h),held=stats(heldEv);
    const mid=Math.floor(hold.length/2),a=new Set(hold.slice(0,mid).map(x=>x.day)),b=new Set(hold.slice(mid).map(x=>x.day)),halves=[stats(heldEv.filter(x=>a.has(x.day))),stats(heldEv.filter(x=>b.has(x.day)))];
    const vols=hold.map(d=>({day:d.day,v:dayVol(d)})).sort((x,y)=>x.v-y.v),vm=vols[Math.floor(vols.length/2)]?.v||0,low=new Set(vols.filter(x=>x.v<=vm).map(x=>x.day)),high=new Set(vols.filter(x=>x.v>vm).map(x=>x.day)),regimes={low_vol:stats(heldEv.filter(x=>low.has(x.day))),high_vol:stats(heldEv.filter(x=>high.has(x.day)))};
    const base=baseline(heldEv),reasons=gate(held,halves,regimes,base),status=reasons.length?'unproven':'validated';
    const allRows=rowsFor(built,h),allStd=standardization(allRows),allBeta=fit(allRows,allStd,h),allThr=quantile(allRows.map(r=>Math.abs(score(r,allStd,allBeta))),best.q);
    horizons.push({horizon_minutes:h,status,reasons,threshold_quantile:best.q,threshold:allThr,coefficients:allBeta,standardization:allStd,proof:{validation:best.s,holdout:held,holdout_halves:halves,holdout_regimes:regimes,matched_momentum_baseline:base,train_days:train.length,validation_days:val.length,holdout_days:hold.length}});
  }
  const valid=horizons.filter(x=>x.status==='validated');
  const model={status:valid.length?'validated':'unproven',provider:'alpaca',feed:FEED,symbol:SYMBOL,input_contract:'raw_sip_trades_quotes_no_bar_aggregation',feature_version:RAW_FEATURE_VERSION,feature_names:RAW_FEATURE_NAMES,sample_seconds:RAW_SAMPLE_SECONDS,horizons,usable_days:built.length,source_window:{start:built[0].day,end:built.at(-1).day},production:{enabled:valid.length>0,validated_horizons:valid.map(x=>x.horizon_minutes),principle:'timing beats speed; precision beats power'},subscription_verified:true,generated_at:new Date().toISOString(),model_id:null};
  model.model_id='raw-sip-'+crypto.createHash('sha256').update(JSON.stringify({feature_version:model.feature_version,horizons:horizons.map(h=>({h:h.horizon_minutes,status:h.status,q:h.threshold_quantile,threshold:h.threshold,coefficients:h.coefficients,standardization:h.standardization}))})).digest('hex').slice(0,20);
  const status={provider:'alpaca',feed:FEED,symbol:SYMBOL,status:model.status,configured:true,feature_version:model.feature_version,model_id:model.model_id,usable_days:model.usable_days,validated_horizons:model.production.validated_horizons,source_window:model.source_window,subscription_verified:true,updated_at:model.generated_at};
  await writeJsonAtomic(MODEL_OUT,model);await writeJsonAtomic(STATUS_OUT,status);
  console.log('RAW_SIP_EDGE '+JSON.stringify(status));
}
main().catch(async e=>{const status={provider:'alpaca',feed:FEED,symbol:SYMBOL,status:'error',configured:!!(KEY&&SECRET),feature_version:RAW_FEATURE_VERSION,error:String(e?.message||e),updated_at:new Date().toISOString()};try{await writeJsonAtomic(STATUS_OUT,status);}catch{}console.error(e);process.exitCode=1;});
