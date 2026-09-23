import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {barsFromYahoo,groupSessions,featureAt,futureReturnBps,FEATURE_NAMES,FEATURE_VERSION,BAR_MINUTES,HORIZONS} from '../wave-model-core.js';

const IN=process.argv[2]||'orcl-wave-history.json';
const OUT=process.argv[3]||'orcl-wave-model.json';
const COST_BPS=Number(process.env.WAVE_COST_BPS||1.5);
const LAMBDA=Number(process.env.WAVE_RIDGE_LAMBDA||12);

function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0;}
function median(a){const x=a.slice().sort((a,b)=>a-b);if(!x.length)return null;const m=x.length>>1;return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function quantile(a,p){const x=a.slice().sort((a,b)=>a-b);if(!x.length)return null;const k=(x.length-1)*p,lo=Math.floor(k),hi=Math.ceil(k);return lo===hi?x[lo]:x[lo]+(x[hi]-x[lo])*(k-lo);}
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
  const p=FEATURE_NAMES.length,mu=Array(p).fill(0),sd=Array(p).fill(0);for(const r of rows)for(let j=0;j<p;j++)mu[j]+=r.x[j];for(let j=0;j<p;j++)mu[j]/=rows.length;
  for(const r of rows)for(let j=0;j<p;j++){const d=r.x[j]-mu[j];sd[j]+=d*d;}for(let j=0;j<p;j++)sd[j]=Math.sqrt(sd[j]/Math.max(1,rows.length-1))||1;return {mean:mu,std:sd};
}
function fit(train,std){
  const p=FEATURE_NAMES.length+1,A=Array.from({length:p},()=>Array(p).fill(0)),b=Array(p).fill(0);
  for(const r of train){const z=[1,...r.x.map((v,j)=>(v-std.mean[j])/std.std[j])],y=r.y;for(let i=0;i<p;i++){b[i]+=z[i]*y;for(let j=0;j<p;j++)A[i][j]+=z[i]*z[j];}}
  for(let i=1;i<p;i++)A[i][i]+=LAMBDA;return solve(A,b);
}
function score(r,std,b){let s=b[0];for(let j=0;j<r.x.length;j++)s+=((r.x[j]-std.mean[j])/std.std[j])*b[j+1];return s;}
function signals(rows,std,b,thr,h){
  const out=[],last={};for(const r of rows){const sc=score(r,std,b);if(Math.abs(sc)<thr)continue;const t=Date.parse(r.at),lt=last[r.day]||0;if(t-lt<h*60000)continue;const dir=Math.sign(sc),gross=dir*r.y,net=gross-COST_BPS;out.push({day:r.day,at:r.at,score:sc,dir,gross,net});last[r.day]=t;}return out;
}
function stats(ev){const n=ev.length,k=ev.filter(e=>e.net>0).length,nets=ev.map(e=>e.net);return {n,days:new Set(ev.map(e=>e.day)).size,hit:n?k/n:null,hit95:wilson(k,n),mean_net_bps:n?mean(nets):null,median_net_bps:n?median(nets):null};}
function baselineAtSignals(sig,allByAt){const ev=[];for(const s of sig){const r=allByAt.get(s.at);if(!r)continue;const d=Math.sign(r.x[0]);if(!d)continue;ev.push({day:r.day,net:d*r.y-COST_BPS});}return stats(ev);}
function halfStats(sig,days){const mid=Math.floor(days.length/2),a=new Set(days.slice(0,mid)),b=new Set(days.slice(mid));return [stats(sig.filter(x=>a.has(x.day))),stats(sig.filter(x=>b.has(x.day)))];}
function gate(hold,halves,base){const reasons=[];if(hold.n<30)reasons.push('signals_lt_30');if(hold.days<5)reasons.push('days_lt_5');if(!(hold.hit>=.57))reasons.push('hit_lt_57pct');if(!(hold.hit95?.[0]>=.45))reasons.push('hit_ci_too_weak');if(!(hold.mean_net_bps>.25))reasons.push('mean_net_le_0_25bps');if(!(hold.median_net_bps>0))reasons.push('median_net_not_positive');for(let i=0;i<halves.length;i++)if(halves[i].n<10||!(halves[i].mean_net_bps>0))reasons.push('unstable_half_'+(i+1));if(base.n>=10&&!(hold.mean_net_bps>base.mean_net_bps+.15))reasons.push('does_not_beat_momentum');return reasons;}

const payload=JSON.parse(await fs.readFile(IN,'utf8')),bars=barsFromYahoo(payload),sessions=groupSessions(bars);
if(sessions.length<40)throw new Error(`need >=40 usable sessions, got ${sessions.length}`);
const dayKeys=sessions.map(s=>s.day),a=Math.floor(dayKeys.length*.60),b=Math.floor(dayKeys.length*.80),trainDays=new Set(dayKeys.slice(0,a)),valDays=new Set(dayKeys.slice(a,b)),holdDays=dayKeys.slice(b),holdSet=new Set(holdDays);
const horizons=[];
for(const H of HORIZONS){
  const rows=[];for(const s of sessions){for(let i=31;i<s.bars.length;i++){const f=featureAt(s.bars,i);if(!f)continue;const y=futureReturnBps(s.bars,i,H);if(!Number.isFinite(y))continue;rows.push({day:s.day,at:f.at,x:f.x,y});}}
  const tr=rows.filter(r=>trainDays.has(r.day)),va=rows.filter(r=>valDays.has(r.day)),ho=rows.filter(r=>holdSet.has(r.day));if(tr.length<500||va.length<100||ho.length<100)throw new Error(`insufficient rows h${H}: ${tr.length}/${va.length}/${ho.length}`);
  const std=standardization(tr),beta=fit(tr,std),abs=va.map(r=>Math.abs(score(r,std,beta))),qs=[.5,.6,.7,.75,.8,.85,.9,.925,.95,.97,.98];let best=null;
  for(const q of qs){const thr=quantile(abs,q),ev=signals(va,std,beta,thr,H),s=stats(ev);if(s.n<20)continue;const objective=(s.hit||0)*4+Math.max(-2,Math.min(5,s.mean_net_bps||-9))*.12+Math.log1p(s.n)*.015;if(!best||objective>best.objective)best={q,thr,validation:s,objective};}
  if(!best)best={q:null,thr:Infinity,validation:stats([]),objective:-Infinity};
  const heldSig=signals(ho,std,beta,best.thr,H),hold=stats(heldSig),allByAt=new Map(ho.map(r=>[r.at,r])),base=baselineAtSignals(heldSig,allByAt),halves=halfStats(heldSig,holdDays),reasons=gate(hold,halves,base),status=reasons.length?'unproven':'validated';
  horizons.push({horizon_minutes:H,status,reasons,threshold:best.thr,threshold_quantile:best.q,coefficients:beta,standardization:std,validation:best.validation,holdout:hold,holdout_halves:halves,momentum_baseline:base,train_rows:tr.length,validation_rows:va.length,holdout_rows:ho.length});
}
const validated=horizons.filter(x=>x.status==='validated'),model={
  status:validated.length?'validated':'unproven',symbol:'ORCL',provider:'yahoo',data_contract:'2m_regular_session_ohlcv',feature_version:FEATURE_VERSION,bar_minutes:BAR_MINUTES,feature_names:FEATURE_NAMES,horizons,cost_bps:COST_BPS,ridge_lambda:LAMBDA,
  training:{usable_sessions:sessions.length,first_day:dayKeys[0],last_day:dayKeys.at(-1),train_days:a,validation_days:b-a,holdout_days:dayKeys.length-b,split:'chronological_60_20_20'},
  production:{enabled:validated.length>0,validated_horizons:validated.map(x=>x.horizon_minutes),principle:'timing beats speed; precision beats power'},
  generated_at:new Date().toISOString(),model_id:null
};
const fingerprint=JSON.stringify({symbol:model.symbol,feature_version:model.feature_version,bar_minutes:model.bar_minutes,feature_names:model.feature_names,horizons:model.horizons.map(h=>({horizon_minutes:h.horizon_minutes,status:h.status,threshold:h.threshold,coefficients:h.coefficients,standardization:h.standardization})),cost_bps:model.cost_bps});
model.model_id='wave-'+crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0,20);
await fs.writeFile(OUT,JSON.stringify(model,null,2)+'\n');
console.log('ORCL_WAVE_MODEL '+JSON.stringify({status:model.status,model_id:model.model_id,validated_horizons:model.production.validated_horizons,training:model.training,horizons:horizons.map(h=>({h:h.horizon_minutes,status:h.status,holdout:h.holdout,baseline:h.momentum_baseline,reasons:h.reasons}))}));
