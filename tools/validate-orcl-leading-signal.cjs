const fs=require('fs');

const URL='https://query1.finance.yahoo.com/v8/finance/chart/ORCL?range=60d&interval=5m&includePrePost=true&events=div%2Csplits';
const DAY=864e5;
const DF=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'});
const HF=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function dayKey(t){return DF.format(new Date(t));}
function hm(t){const o={};for(const p of HF.formatToParts(new Date(t)))if(p.type!=='literal')o[p.type]=+p.value;return o.hour*60+o.minute;}
function median(a){const x=a.filter(v=>Number.isFinite(v)&&v>0).slice().sort((a,b)=>a-b);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
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
  const f20=trendFit(a,p=>Math.log(p.close),20*60000),f60=trendFit(a,p=>Math.log(p.close),60*60000),f180=trendFit(a,p=>Math.log(p.close),180*60000);
  const dirs=[f20,f60,f180].filter(Boolean).filter(x=>x.eff>=.18&&x.persist>=.55).map(x=>x.dir);
  const sum=dirs.reduce((x,y)=>x+y,0),dir=Math.abs(sum)>=2?(sum>0?1:-1):0;
  return {dir,short:f20,mid:f60,long:f180};
}
function volumeWave(a){
  const u=[];
  for(let i=1;i<a.length;i++){const v=Number(a[i].volume),p0=a[i-1].close,p1=a[i].close;if(!Number.isFinite(v)||v<=0)continue;u.push({t:a[i].t,v,sgn:p1>p0?1:p1<p0?-1:0});}
  if(u.length<10)return {dir:0,pressure:0,ratio:null,persist:0};
  const end=u.at(-1).t;
  function wf(mins){const x=u.filter(z=>end-z.t<=mins*60000);if(x.length<4)return null;let signed=0,total=0,agree=0;for(const z of x){signed+=z.v*z.sgn;total+=z.v;}const pressure=total?signed/total:0,dir=Math.abs(pressure)>=.12?(pressure>0?1:-1):0;if(dir)for(const z of x)if(z.sgn===dir)agree++;return {pressure,dir,persist:x.length?agree/x.length:0,count:x.length,avg:total/x.length};}
  const f30=wf(30),f90=wf(90);let dir=0;
  if(f30&&f90&&f30.dir&&f30.dir===f90.dir&&f30.persist>=.52)dir=f30.dir;
  else if(f30&&Math.abs(f30.pressure)>=.28&&f30.persist>=.58)dir=f30.dir;
  const base=u.slice(Math.max(0,u.length-240),Math.max(0,u.length-(f30?f30.count:0))).map(x=>x.v),med=median(base),ratio=f30&&med?f30.avg/med:null;
  return {dir,pressure:f30?.pressure||0,pressure90:f90?.pressure||0,ratio,persist:f30?.persist||0,short:f30,long:f90};
}
function rel(a,b){if(!Number.isFinite(a)||!Number.isFinite(b))return null;const s=Math.max(1e-9,Math.abs(a)+Math.abs(b));return clamp((a-b)/s,-1,1);}
function rawImpulse(p,v){
  const comp=[];
  if(p.short&&p.mid){const l=rel(p.short.slope,p.mid.slope),g=p.long?rel(p.mid.slope,p.long.slope):null;comp.push({name:'Kurs',value:g==null?l:.68*l+.32*g,q:Math.max(p.short.persist||0,p.mid.persist||0)});}
  if(v.short&&v.long)comp.push({name:'Volumen',value:rel(v.short.pressure,v.long.pressure),q:Math.max(v.short.persist||0,v.long.persist||0)});
  const active=comp.filter(x=>Math.abs(x.value)>=.12&&x.q>=.35);if(active.length<2)return {dir:0,reliable:false};
  const up=active.filter(x=>x.value>0),dn=active.filter(x=>x.value<0),win=up.length>dn.length?up:(dn.length>up.length?dn:[]);
  if(win.length<2)return {dir:0,reliable:false};
  const dir=win[0].value>0?1:-1;let weighted=0,weight=0,total=0,aligned=0;
  for(const x of active){const w=.35+.65*x.q,a=Math.abs(x.value)*w;total+=a;if(Math.sign(x.value)===dir){aligned+=a;weighted+=x.value*w;weight+=w;}}
  const strength=weight?Math.abs(weighted/weight):0,coherence=total?aligned/total:0,reliable=win.length>=2&&strength>=.16&&coherence>=.62;
  return {dir:reliable?dir:0,reliable,strength,coherence};
}
function recentNoise(a){
  const end=a.at(-1).t,x=a.filter(b=>end-b.t<=180*60000),r=[];
  for(let i=1;i<x.length;i++)if(x[i-1].close>0&&x[i].close>0)r.push(Math.abs(Math.log(x[i].close/x[i-1].close)));
  return median(r)||0;
}
function candidate(a,p,v){
  const base=rawImpulse(p,v);if(!base.reliable)return {dir:0,reliable:false};
  const noise=recentNoise(a),snr=p.short&&noise>0?Math.abs(p.short.net)/(noise*Math.sqrt(Math.max(1,p.short.count-1))):0;
  const pressureDelta=v.short&&v.long?Math.abs(v.short.pressure-v.long.pressure):0;
  const participation=Number(v.ratio);
  const reliable=snr>=0.9&&pressureDelta>=0.08&&Number.isFinite(participation)&&participation>=1.05;
  return {dir:reliable?base.dir:0,reliable,snr,pressureDelta,participation};
}
function future(dayBars,t,h){const target=t+h*60000;for(const b of dayBars)if(b.t>=target)return b.t-target<=8*60000?b:null;return null;}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [c-m,c+m];}
function stats(events,sessions,h){const vals=[];for(const e of events){const f=future(sessions[e.day],e.t,h);if(f)vals.push(e.dir*(f.close/e.price-1));}const n=vals.length,k=vals.filter(x=>x>0).length,ci=wilson(k,n);return {n,hit:n?k/n:null,hit95:ci,mean:n?vals.reduce((a,b)=>a+b,0)/n:null,median:n?[...vals].sort((a,b)=>a-b)[Math.floor(n/2)]:null};}
function eventsFor(sessions,mode,days){
  const out=[];for(const day of days){const a=sessions[day]||[];let prev=0,lastT=0;for(let i=0;i<a.length;i++){const hist=a.slice(0,i+1);if(hist.length<12)continue;const p=priceWave(hist),v=volumeWave(hist),s=mode==='candidate'?candidate(hist,p,v):rawImpulse(p,v),b=a[i],dir=s.reliable?s.dir:0;if(dir&&dir!==prev&&b.t-lastT>=20*60000){out.push({day,t:b.t,price:b.close,dir});lastT=b.t;}prev=dir;}}return out;
}
function summarize(events,sessions){return {events:events.length,eventDays:new Set(events.map(e=>e.day)).size,m15:stats(events,sessions,15),m30:stats(events,sessions,30),m60:stats(events,sessions,60),m180:stats(events,sessions,180)};}

(async()=>{
  const r=await fetch(URL,{headers:{'user-agent':'Mozilla/5.0'}});
  if(!r.ok)throw new Error('Yahoo '+r.status);
  const j=await r.json(),z=j.chart.result[0],q=z.indicators.quote[0],ts=z.timestamp||[];
  const bars=ts.map((t,i)=>({t:t*1000,close:Number(q.close?.[i]),volume:Number(q.volume?.[i])})).filter(x=>Number.isFinite(x.close)&&x.close>0).sort((a,b)=>a.t-b.t);
  const sessions={};for(const b of bars){const m=hm(b.t);if(m<8*60||m>22*60)continue;(sessions[dayKey(b.t)]??=[]).push(b);}
  const days=Object.keys(sessions).sort(),cut=Math.max(1,Math.floor(days.length*2/3)),train=days.slice(0,cut),test=days.slice(cut);
  const currentAll=eventsFor(sessions,'current',days),candAll=eventsFor(sessions,'candidate',days);
  const currentTest=eventsFor(sessions,'current',test),candTest=eventsFor(sessions,'candidate',test);
  let crowd={points:0,priced:0,days:0};
  try{const w=JSON.parse(fs.readFileSync('watchlist-data.json','utf8')),h=w?.stocks?.ORCL?.history||[];crowd={points:h.length,priced:h.filter(x=>Number.isFinite(Number(x.price))).length,days:new Set(h.map(x=>String(x.at||'').slice(0,10))).size};}catch{}
  const out={bars:bars.length,days:days.length,trainDays:train.length,testDays:test.length,crowd,current:{all:summarize(currentAll,sessions),test:summarize(currentTest,sessions)},candidate:{all:summarize(candAll,sessions),test:summarize(candTest,sessions)}};
  console.log('SIGNAL_VALIDATION_JSON '+JSON.stringify(out));
})().catch(e=>{console.error(e);process.exit(1);});
