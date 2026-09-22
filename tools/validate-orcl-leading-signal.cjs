const fs=require('fs');

const SYMBOLS=['ORCL','QQQ','IGV'];
const BASE='https://query1.finance.yahoo.com/v8/finance/chart/';
const Q='?range=60d&interval=5m&includePrePost=true&events=div%2Csplits';
const DF=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'});
const HF=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function dayKey(t){return DF.format(new Date(t));}
function hm(t){const o={};for(const p of HF.formatToParts(new Date(t)))if(p.type!=='literal')o[p.type]=+p.value;return o.hour*60+o.minute;}
function median(a){const x=(a||[]).filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
async function fetchBars(sym){
  const r=await fetch(BASE+encodeURIComponent(sym)+Q,{headers:{'user-agent':'Mozilla/5.0'}});
  if(!r.ok)throw new Error(sym+' Yahoo '+r.status);
  const j=await r.json(),z=j.chart.result[0],q=z.indicators.quote[0],ts=z.timestamp||[];
  return ts.map((t,i)=>({t:t*1000,close:Number(q.close?.[i]),volume:Number(q.volume?.[i])}))
    .filter(x=>Number.isFinite(x.close)&&x.close>0).sort((a,b)=>a.t-b.t);
}
function sessions(bars){
  const out={};for(const b of bars){const m=hm(b.t);if(m<8*60||m>22*60)continue;(out[dayKey(b.t)]??=[]).push(b);}return out;
}
function trendFit(points,valueFn,windowMs){
  if(!points||points.length<3)return null;
  const end=points.at(-1).t,a=points.filter(p=>end-p.t<=windowMs&&Number.isFinite(valueFn(p)));
  if(a.length<3)return null;
  const t0=a[0].t;let sx=0,sy=0,sxx=0,sxy=0,n=0,path=0,prev=null,up=0,down=0;
  for(const p of a){const t=(p.t-t0)/60000,y=valueFn(p);sx+=t;sy+=y;sxx+=t*t;sxy+=t*y;n++;if(prev!=null){const d=y-prev;path+=Math.abs(d);if(d>0)up++;else if(d<0)down++;}prev=y;}
  const den=n*sxx-sx*sx,slope=den?(n*sxy-sx*sy)/den:0,net=valueFn(a.at(-1))-valueFn(a[0]),dir=slope>0?1:slope<0?-1:0,steps=up+down,persist=steps?(dir>0?up:down)/steps:0;
  return {slope,net,dir,persist,eff:path?Math.abs(net)/path:0,count:n};
}
function priceWave(a){
  if(a.length<12)return {dir:0};
  const f15=trendFit(a,p=>Math.log(p.close),15*60000),f45=trendFit(a,p=>Math.log(p.close),45*60000),f120=trendFit(a,p=>Math.log(p.close),120*60000);
  const dirs=[f15,f45,f120].filter(Boolean).filter(x=>x.eff>=.18&&x.persist>=.55).map(x=>x.dir);
  const sum=dirs.reduce((x,y)=>x+y,0),dir=Math.abs(sum)>=2?(sum>0?1:-1):0;
  return {dir,short:f15,mid:f45,long:f120};
}
function volumeState(a){
  const u=[];for(let i=1;i<a.length;i++){const v=Number(a[i].volume),p0=a[i-1].close,p1=a[i].close;if(!Number.isFinite(v)||v<=0)continue;u.push({t:a[i].t,v,sgn:p1>p0?1:p1<p0?-1:0});}
  if(u.length<10)return {};
  const end=u.at(-1).t;
  function wf(mins){const x=u.filter(z=>end-z.t<=mins*60000);if(x.length<4)return null;let signed=0,total=0,agree=0;for(const z of x){signed+=z.v*z.sgn;total+=z.v;}const pressure=total?signed/total:0,dir=Math.abs(pressure)>=.12?(pressure>0?1:-1):0;if(dir)for(const z of x)if(z.sgn===dir)agree++;return {pressure,dir,persist:x.length?agree/x.length:0,count:x.length,avg:total/x.length};}
  return {short:wf(30),long:wf(90)};
}
function rel(a,b){if(!Number.isFinite(a)||!Number.isFinite(b))return null;const s=Math.max(1e-9,Math.abs(a)+Math.abs(b));return clamp((a-b)/s,-1,1);}
function rawImpulse(p,v){
  if(!p.short||!p.mid||!v.short||!v.long)return {dir:0,reliable:false};
  const pl=rel(p.short.slope,p.mid.slope),pg=p.long?rel(p.mid.slope,p.long.slope):null;
  const pv=pg==null?pl:.68*pl+.32*pg,vv=rel(v.short.pressure,v.long.pressure);
  if(!Number.isFinite(pv)||!Number.isFinite(vv)||Math.abs(pv)<.12||Math.abs(vv)<.12)return {dir:0,reliable:false};
  if(Math.sign(pv)!==Math.sign(vv))return {dir:0,reliable:false};
  return {dir:pv>0?1:-1,reliable:true,pv,vv};
}
function recentNoise(a){
  const end=a.at(-1).t,x=a.filter(b=>end-b.t<=180*60000),r=[];
  for(let i=1;i<x.length;i++)if(x[i-1].close>0&&x[i].close>0)r.push(Math.abs(Math.log(x[i].close/x[i-1].close)));
  return median(r)||0;
}
function nearestAt(arr,t,maxGap=4*60000){
  let lo=0,hi=arr.length-1,best=null,bestD=Infinity;
  while(lo<=hi){const m=(lo+hi)>>1,d=arr[m].t-t;if(Math.abs(d)<bestD){best=arr[m];bestD=Math.abs(d);}if(d<0)lo=m+1;else if(d>0)hi=m-1;else break;}
  return bestD<=maxGap?best:null;
}
function logReturnTo(arr,t,mins){
  const now=nearestAt(arr,t),past=nearestAt(arr,t-mins*60000,6*60000);
  return now&&past&&now.close>0&&past.close>0?Math.log(now.close/past.close):null;
}
function minuteBucket(t){return Math.floor(hm(t)/5)*5;}
function buildRvolBaseline(allSessions,trainDays){
  const buckets={};
  for(const day of trainDays){for(const b of allSessions[day]||[]){if(!Number.isFinite(b.volume)||b.volume<=0)continue;(buckets[minuteBucket(b.t)]??=[]).push(b.volume);}}
  const med={};for(const [k,v] of Object.entries(buckets))med[k]=median(v);
  return med;
}
function rvolAt(b,baseline){const m=baseline[minuteBucket(b.t)];return Number.isFinite(b.volume)&&b.volume>0&&Number.isFinite(m)&&m>0?b.volume/m:null;}
function signalAt(hist,b,bench,base,thr){
  const p=priceWave(hist),v=volumeState(hist),imp=rawImpulse(p,v);if(!imp.reliable||p.dir)return null;
  const noise=recentNoise(hist);if(!(noise>0)||!p.short)return null;
  const snr=Math.abs(p.short.net)/(noise*Math.sqrt(Math.max(1,p.short.count-1)));
  const pressureDelta=Math.abs(v.short.pressure-v.long.pressure);
  const rv=rvolAt(b,base);
  const r15=Math.log(hist.at(-1).close/(hist.findLast(x=>x.t<=b.t-15*60000)?.close||hist[0].close));
  const q15=logReturnTo(bench.QQQ,b.t,15),i15=logReturnTo(bench.IGV,b.t,15);
  if(!Number.isFinite(q15)||!Number.isFinite(i15)||!Number.isFinite(rv))return null;
  const rs=imp.dir*(r15-(.5*q15+.5*i15));
  const dirOk=imp.dir*Math.sign(p.short.net||0)>0;
  if(!dirOk)return null;
  const ok=snr>=thr.snr&&pressureDelta>=thr.pd&&rv>=thr.rvol&&rs>=thr.rs&&Math.abs(imp.pv)>=thr.pi;
  return ok?{dir:imp.dir,snr,pressureDelta,rvol:rv,rs,pi:Math.abs(imp.pv)}:null;
}
function future(dayBars,t,h){const target=t+h*60000;for(const b of dayBars)if(b.t>=target)return b.t-target<=8*60000?b:null;return null;}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [c-m,c+m];}
function stats(events,sess,h){const vals=[];for(const e of events){const f=future(sess[e.day],e.t,h);if(f)vals.push(e.dir*(f.close/e.price-1));}const n=vals.length,k=vals.filter(x=>x>0).length,ci=wilson(k,n);return {n,hit:n?k/n:null,hit95:ci,mean:n?vals.reduce((a,b)=>a+b,0)/n:null,median:n?[...vals].sort((a,b)=>a-b)[Math.floor(n/2)]:null};}
function featureRowsFor(sess,benchByDay,days,baseline){
  const out={};
  for(const day of days){
    const a=sess[day]||[],bench={QQQ:benchByDay.QQQ[day]||[],IGV:benchByDay.IGV[day]||[]},rows=[];
    for(let i=0;i<a.length;i++){
      const h=a.slice(0,i+1),b=a[i];if(h.length<24)continue;
      const p=priceWave(h),v=volumeState(h),imp=rawImpulse(p,v);
      if(!imp.reliable||p.dir||!p.short)continue;
      const noise=recentNoise(h);if(!(noise>0))continue;
      const snr=Math.abs(p.short.net)/(noise*Math.sqrt(Math.max(1,p.short.count-1)));
      const pressureDelta=v.short&&v.long?Math.abs(v.short.pressure-v.long.pressure):0;
      const rv=rvolAt(b,baseline);
      const past=h.findLast(x=>x.t<=b.t-15*60000),r15=past&&past.close>0?Math.log(b.close/past.close):null;
      const q15=logReturnTo(bench.QQQ,b.t,15),i15=logReturnTo(bench.IGV,b.t,15);
      if(!Number.isFinite(q15)||!Number.isFinite(i15)||!Number.isFinite(rv)||!Number.isFinite(r15))continue;
      const rs=imp.dir*(r15-(.5*q15+.5*i15)),dirOk=imp.dir*Math.sign(p.short.net||0)>0;
      if(!dirOk)continue;
      rows.push({day,t:b.t,price:b.close,dir:imp.dir,snr,pressureDelta,rvol:rv,rs,pi:Math.abs(imp.pv)});
    }
    out[day]=rows;
  }
  return out;
}
function eventsFromFeatures(features,days,thr){
  const out=[];
  for(const day of days){
    const rows=features[day]||[];let prev=0,last=0;
    for(const r of rows){
      const ok=r.snr>=thr.snr&&r.pressureDelta>=thr.pd&&r.rvol>=thr.rvol&&r.rs>=thr.rs&&r.pi>=thr.pi;
      const dir=ok?r.dir:0;
      if(dir&&dir!==prev&&r.t-last>=30*60000){out.push(r);last=r.t;}
      prev=dir;
    }
  }
  return out;
}
function summary(e,sess){return {events:e.length,eventDays:new Set(e.map(x=>x.day)).size,m15:stats(e,sess,15),m30:stats(e,sess,30),m60:stats(e,sess,60)};}
function trainScore(s){
  if(!s.m15||s.m15.n<35||s.eventDays<20||s.m15.mean==null)return -Infinity;
  const lo=s.m15.hit95?.[0]??0;
  return 2.2*lo + 80*s.m15.mean + .15*Math.min(1,s.eventDays/30);
}
(async()=>{
  const bars=Object.fromEntries(await Promise.all(SYMBOLS.map(async s=>[s,await fetchBars(s)])));
  const sess=Object.fromEntries(SYMBOLS.map(s=>[s,sessions(bars[s])]));
  const days=Object.keys(sess.ORCL).filter(d=>sess.QQQ[d]?.length&&sess.IGV[d]?.length).sort();
  const cut=Math.floor(days.length*2/3),train=days.slice(0,cut),test=days.slice(cut),baseline=buildRvolBaseline(sess.ORCL,train);
  const features=featureRowsFor(sess.ORCL,{QQQ:sess.QQQ,IGV:sess.IGV},days,baseline),grid=[];
  for(const snr of [.7,.9,1.1,1.3])for(const pd of [.05,.08,.12,.16])for(const rvol of [.9,1.1,1.3,1.6])for(const rs of [0,.0004,.0008,.0012])for(const pi of [.12,.2,.3]){
    const thr={snr,pd,rvol,rs,pi},ev=eventsFromFeatures(features,train,thr),sm=summary(ev,sess.ORCL),score=trainScore(sm);
    if(Number.isFinite(score))grid.push({thr,sm,score});
  }
  grid.sort((a,b)=>b.score-a.score);
  const best=grid[0];if(!best)throw new Error('No train candidate met minimum sample');
  const testEvents=eventsFromFeatures(features,test,best.thr),testSm=summary(testEvents,sess.ORCL);
  const halves=[test.slice(0,Math.floor(test.length/2)),test.slice(Math.floor(test.length/2))].map(ds=>summary(eventsFromFeatures(features,ds,best.thr),sess.ORCL));
  const out={bars:Object.fromEntries(SYMBOLS.map(s=>[s,bars[s].length])),days:days.length,trainDays:train.length,testDays:test.length,bestTrain:{thresholds:best.thr,summary:best.sm},heldOut:testSm,heldOutHalves:halves,top5:grid.slice(0,5).map(x=>({thresholds:x.thr,summary:x.sm,score:x.score}))};
  console.log('SIGNAL_VALIDATION_JSON '+JSON.stringify(out));
})().catch(e=>{console.error(e);process.exit(1);});
