import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {barsFromYahoo,groupSessions,featureAt,futureReturnBps,FEATURE_NAMES,FEATURE_VERSION,BAR_MINUTES,HORIZONS} from '../wave-model-core.js';

const IN=process.argv[2]||'orcl-wave-history.json';
const OUT=process.argv[3]||'orcl-wave-model.json';
const COST_BPS=Number(process.env.WAVE_COST_BPS||1.5);
const LAMBDA=Number(process.env.WAVE_RIDGE_LAMBDA||12);
const LOOKBACK_DAYS=30;
const INNER_TRAIN_DAYS=20;
const INNER_VALIDATION_DAYS=10;
const Q_GRID=[.50,.60,.70,.75,.80,.85,.90,.925,.95,.965,.975,.985,.99];

function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0;}
function median(a){const x=a.filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!x.length)return null;const m=x.length>>1;return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function quantile(a,p){const x=a.filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!x.length)return null;const k=(x.length-1)*p,lo=Math.floor(k),hi=Math.ceil(k);return lo===hi?x[lo]:x[lo]+(x[hi]-x[lo])*(k-lo);}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,den=1+z*z/n,c=(p+z*z/(2*n))/den,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/den;return [c-m,c+m];}
function solve(A,b){
  const n=A.length,M=A.map((r,i)=>r.slice().concat([b[i]]));
  for(let k=0;k<n;k++){
    let p=k;for(let i=k+1;i<n;i++)if(Math.abs(M[i][k])>Math.abs(M[p][k]))p=i;
    if(Math.abs(M[p][k])<1e-12)M[p][k]+=1e-9;
    [M[k],M[p]]=[M[p],M[k]];const d=M[k][k];for(let j=k;j<=n;j++)M[k][j]/=d;
    for(let i=0;i<n;i++){if(i===k)continue;const f=M[i][k];if(!f)continue;for(let j=k;j<=n;j++)M[i][j]-=f*M[k][j];}
  }
  return M.map(r=>r[n]);
}
function standardization(rows){
  const p=FEATURE_NAMES.length,mu=Array(p).fill(0),sd=Array(p).fill(0);
  for(const r of rows)for(let j=0;j<p;j++)mu[j]+=r.x[j];
  for(let j=0;j<p;j++)mu[j]/=Math.max(1,rows.length);
  for(const r of rows)for(let j=0;j<p;j++){const d=r.x[j]-mu[j];sd[j]+=d*d;}
  for(let j=0;j<p;j++)sd[j]=Math.sqrt(sd[j]/Math.max(1,rows.length-1))||1;
  return {mean:mu,std:sd};
}
function fit(train,std){
  const p=FEATURE_NAMES.length+1,A=Array.from({length:p},()=>Array(p).fill(0)),b=Array(p).fill(0);
  for(const r of train){
    const z=[1,...r.x.map((v,j)=>(v-std.mean[j])/std.std[j])],y=r.y;
    for(let i=0;i<p;i++){b[i]+=z[i]*y;for(let j=0;j<p;j++)A[i][j]+=z[i]*z[j];}
  }
  for(let i=1;i<p;i++)A[i][i]+=LAMBDA;
  return solve(A,b);
}
function score(r,std,b){let s=b[0];for(let j=0;j<r.x.length;j++)s+=((r.x[j]-std.mean[j])/std.std[j])*b[j+1];return s;}
function independentSignals(rows,std,b,thr,h){
  const out=[],lastByDay=new Map();
  for(const r of rows){
    const sc=score(r,std,b);if(!Number.isFinite(sc)||Math.abs(sc)<thr)continue;
    const t=Date.parse(r.at),last=lastByDay.get(r.day)||0;if(t-last<h*60000)continue;
    const dir=Math.sign(sc);if(!dir)continue;
    const gross=dir*r.y,net=gross-COST_BPS;
    out.push({day:r.day,at:r.at,score:sc,dir,gross,net});
    lastByDay.set(r.day,t);
  }
  return out;
}
function stats(ev){
  const n=ev.length,k=ev.filter(e=>e.net>0).length,nets=ev.map(e=>e.net);
  return {n,days:new Set(ev.map(e=>e.day)).size,hit:n?k/n:null,hit95:wilson(k,n),mean_net_bps:n?mean(nets):null,median_net_bps:n?median(nets):null};
}
function baselineAtSignals(sig,rowsByAt){
  const ev=[];
  for(const s of sig){
    const r=rowsByAt.get(s.at);if(!r)continue;
    const d=Math.sign(r.x[0]);if(!d)continue;
    ev.push({day:r.day,at:r.at,net:d*r.y-COST_BPS});
  }
  return ev;
}
function rowsForDays(rows,days){const set=days instanceof Set?days:new Set(days);return rows.filter(r=>set.has(r.day));}
function chooseQuantile(trainRows,valRows,h){
  if(trainRows.length<400||valRows.length<120)return null;
  const std=standardization(trainRows),beta=fit(trainRows,std),abs=valRows.map(r=>Math.abs(score(r,std,beta)));
  let best=null;
  for(const q of Q_GRID){
    const thr=quantile(abs,q);if(!(thr>0))continue;
    const ev=independentSignals(valRows,std,beta,thr,h),s=stats(ev);
    if(s.n<12||s.days<5||!(s.mean_net_bps>0)||!(s.median_net_bps>0)||!(s.hit>=.54))continue;
    const objective=(s.hit95?.[0]||0)*10+(s.hit||0)*2+Math.min(5,s.mean_net_bps||0)*.08+Math.log1p(s.n)*.01;
    if(!best||objective>best.objective)best={q,threshold:thr,validation:s,objective};
  }
  return best;
}
function fitProduction(rows,days,h){
  const windowDays=days.slice(-LOOKBACK_DAYS);
  if(windowDays.length<LOOKBACK_DAYS)return null;
  const innerTrain=windowDays.slice(0,INNER_TRAIN_DAYS),innerVal=windowDays.slice(INNER_TRAIN_DAYS);
  const tr=rowsForDays(rows,innerTrain),va=rowsForDays(rows,innerVal),choice=chooseQuantile(tr,va,h);
  if(!choice)return null;
  const all=rowsForDays(rows,windowDays),std=standardization(all),beta=fit(all,std);
  const thr=quantile(all.map(r=>Math.abs(score(r,std,beta))),choice.q);
  return {q:choice.q,threshold:thr,standardization:std,coefficients:beta,inner_validation:choice.validation,window_days:windowDays};
}
function walkForward(rows,days,h){
  const modelEvents=[],baseEvents=[],daily=[];
  for(let di=LOOKBACK_DAYS;di<days.length;di++){
    const evalDay=days[di],windowDays=days.slice(di-LOOKBACK_DAYS,di);
    const innerTrain=windowDays.slice(0,INNER_TRAIN_DAYS),innerVal=windowDays.slice(INNER_TRAIN_DAYS);
    const tr=rowsForDays(rows,innerTrain),va=rowsForDays(rows,innerVal),choice=chooseQuantile(tr,va,h);
    if(!choice){daily.push({day:evalDay,status:'no_prior_validation'});continue;}
    const fitRows=rowsForDays(rows,windowDays),std=standardization(fitRows),beta=fit(fitRows,std);
    const thr=quantile(fitRows.map(r=>Math.abs(score(r,std,beta))),choice.q);
    const er=rowsForDays(rows,[evalDay]),sig=independentSignals(er,std,beta,thr,h),byAt=new Map(er.map(r=>[r.at,r])),base=baselineAtSignals(sig,byAt);
    modelEvents.push(...sig);baseEvents.push(...base);
    daily.push({day:evalDay,q:choice.q,threshold:thr,n:sig.length,stats:stats(sig),validation:choice.validation});
  }
  const evaluatedDays=days.slice(LOOKBACK_DAYS),mid=Math.floor(evaluatedDays.length/2),halves=[
    stats(modelEvents.filter(e=>new Set(evaluatedDays.slice(0,mid)).has(e.day))),
    stats(modelEvents.filter(e=>new Set(evaluatedDays.slice(mid)).has(e.day)))
  ];
  return {events:modelEvents,baseline_events:baseEvents,daily,evaluated_days:evaluatedDays,stats:stats(modelEvents),baseline:stats(baseEvents),halves};
}
function gate(wf,current){
  const s=wf.stats,b=wf.baseline,reasons=[];
  if(s.n<50)reasons.push('walkforward_signals_lt_50');
  if(s.days<15)reasons.push('walkforward_days_lt_15');
  if(!(s.hit>=.56))reasons.push('walkforward_hit_lt_56pct');
  if(!s.hit95||!(s.hit95[0]>.50))reasons.push('walkforward_hit_ci_not_above_50');
  if(!(s.mean_net_bps>.25))reasons.push('walkforward_mean_net_le_0_25bps');
  if(!(s.median_net_bps>0))reasons.push('walkforward_median_net_not_positive');
  for(let i=0;i<wf.halves.length;i++){
    const x=wf.halves[i];
    if(x.n<20||!(x.mean_net_bps>0)||!(x.median_net_bps>0)||!(x.hit>=.52))reasons.push('walkforward_unstable_half_'+(i+1));
  }
  if(b.n>=30&&!(s.mean_net_bps>b.mean_net_bps+.15))reasons.push('walkforward_does_not_beat_momentum');
  if(!current)reasons.push('current_window_no_valid_threshold');
  else{
    const v=current.inner_validation;
    if(!(v.hit>=.54&&v.mean_net_bps>0&&v.median_net_bps>0))reasons.push('current_validation_not_positive');
  }
  return reasons;
}

const payload=JSON.parse(await fs.readFile(IN,'utf8')),bars=barsFromYahoo(payload),sessions=groupSessions(bars),days=sessions.map(s=>s.day);
if(days.length<50)throw new Error(`need >=50 usable sessions, got ${days.length}`);

const rowsByH=new Map();
for(const H of HORIZONS){
  const rows=[];
  for(const s of sessions){
    for(let i=36;i<s.bars.length;i++){
      const f=featureAt(s.bars,i);if(!f)continue;
      const y=futureReturnBps(s.bars,i,H);if(!Number.isFinite(y))continue;
      rows.push({day:s.day,at:f.at,x:f.x,y});
    }
  }
  rowsByH.set(H,rows);
}

const horizons=[];
for(const H of HORIZONS){
  const rows=rowsByH.get(H),wf=walkForward(rows,days,H),current=fitProduction(rows,days,H),reasons=gate(wf,current),status=reasons.length?'unproven':'validated';
  horizons.push({
    horizon_minutes:H,status,reasons,
    threshold:current?.threshold??null,threshold_quantile:current?.q??null,
    coefficients:current?.coefficients??[],standardization:current?.standardization??{mean:[],std:[]},
    validation:current?.inner_validation??null,
    walk_forward:{stats:wf.stats,halves:wf.halves,matched_momentum_baseline:wf.baseline,evaluated_days:wf.evaluated_days.length,daily:wf.daily},
    train_rows:rows.length,lookback_days:LOOKBACK_DAYS,inner_train_days:INNER_TRAIN_DAYS,inner_validation_days:INNER_VALIDATION_DAYS
  });
}

const validated=horizons.filter(x=>x.status==='validated');
const model={
  status:validated.length?'validated':'unproven',
  symbol:'ORCL',provider:'yahoo',data_contract:'5m_regular_session_ohlcv',
  feature_version:FEATURE_VERSION,bar_minutes:BAR_MINUTES,feature_names:FEATURE_NAMES,horizons,
  cost_bps:COST_BPS,ridge_lambda:LAMBDA,
  training:{usable_sessions:days.length,first_day:days[0],last_day:days.at(-1),protocol:'rolling-30d-causal-walkforward-v1',lookback_days:LOOKBACK_DAYS,inner_train_days:INNER_TRAIN_DAYS,inner_validation_days:INNER_VALIDATION_DAYS,oos_days:days.length-LOOKBACK_DAYS},
  production:{enabled:validated.length>0,validated_horizons:validated.map(x=>x.horizon_minutes),principle:'timing beats speed; precision beats power',retrain:'twice daily plus on model changes'},
  generated_at:new Date().toISOString(),model_id:null
};
const fingerprint=JSON.stringify({symbol:model.symbol,feature_version:model.feature_version,bar_minutes:model.bar_minutes,protocol:model.training.protocol,feature_names:model.feature_names,horizons:model.horizons.map(h=>({horizon_minutes:h.horizon_minutes,status:h.status,threshold:h.threshold,threshold_quantile:h.threshold_quantile,coefficients:h.coefficients,standardization:h.standardization})),cost_bps:model.cost_bps});
model.model_id='wave-'+crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0,20);
await fs.writeFile(OUT,JSON.stringify(model,null,2)+'\n');
console.log('ORCL_WAVE_MODEL '+JSON.stringify({
  status:model.status,model_id:model.model_id,validated_horizons:model.production.validated_horizons,training:model.training,
  horizons:horizons.map(h=>({h:h.horizon_minutes,status:h.status,q:h.threshold_quantile,validation:h.validation,walk_forward:h.walk_forward.stats,baseline:h.walk_forward.matched_momentum_baseline,halves:h.walk_forward.halves,reasons:h.reasons}))
}));
