const BASE='https://query1.finance.yahoo.com/v8/finance/chart/';
const Q='?range=60d&interval=5m&includePrePost=true&events=div%2Csplits';
const SYMBOLS=['ORCL','QQQ','IGV'];
const DF=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'});
const HF=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function dayKey(t){return DF.format(new Date(t));}
function hm(t){const o={};for(const p of HF.formatToParts(new Date(t)))if(p.type!=='literal')o[p.type]=+p.value;return o.hour*60+o.minute;}
function median(a){const x=(a||[]).filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
async function fetchBars(sym){
  const r=await fetch(BASE+encodeURIComponent(sym)+Q,{headers:{'user-agent':'Mozilla/5.0'}});
  if(!r.ok)throw new Error(sym+' '+r.status);
  const j=await r.json(),z=j.chart.result[0],q=z.indicators.quote[0],ts=z.timestamp||[];
  return ts.map((t,i)=>({t:t*1000,open:+q.open?.[i],high:+q.high?.[i],low:+q.low?.[i],close:+q.close?.[i],volume:+q.volume?.[i]}))
    .filter(x=>Number.isFinite(x.close)&&x.close>0).sort((a,b)=>a.t-b.t);
}
function regularSessions(bars){
  const out={};
  for(const b of bars){const m=hm(b.t);if(m<15*60+30||m>22*60)continue;(out[dayKey(b.t)]??=[]).push(b);}
  return out;
}
function nearestAt(arr,t,maxGap=4*60000){
  let lo=0,hi=arr.length-1,best=null,d0=Infinity;
  while(lo<=hi){const m=(lo+hi)>>1,d=arr[m].t-t;if(Math.abs(d)<d0){best=arr[m];d0=Math.abs(d);}if(d<0)lo=m+1;else if(d>0)hi=m-1;else break;}
  return d0<=maxGap?best:null;
}
function ret(arr,t,mins){const n=nearestAt(arr,t),p=nearestAt(arr,t-mins*60000,6*60000);return n&&p&&p.close>0?Math.log(n.close/p.close):null;}
function minuteBucket(t){return Math.floor(hm(t)/5)*5;}
function buildVolumeBaseline(sess,trainDays){
  const x={};for(const d of trainDays)for(const b of sess[d]||[]){if(Number.isFinite(b.volume)&&b.volume>0)(x[minuteBucket(b.t)]??=[]).push(b.volume);}
  const out={};for(const [k,v] of Object.entries(x))out[k]=median(v);return out;
}
function rvol(b,base){const m=base[minuteBucket(b.t)];return Number.isFinite(b.volume)&&b.volume>0&&m>0?b.volume/m:null;}
function rolling(a,i,mins){
  const t=a[i].t,from=t-mins*60000,x=[];for(let j=i-1;j>=0&&a[j].t>=from;j--)x.push(a[j]);return x.reverse();
}
function sessionVwap(a,i){
  let pv=0,v=0;for(let j=0;j<=i;j++){const b=a[j],vol=Number(b.volume);if(!(vol>0))continue;const typ=(Number.isFinite(b.high)&&Number.isFinite(b.low)&&Number.isFinite(b.open))?(b.high+b.low+b.close)/3:b.close;pv+=typ*vol;v+=vol;}return v?pv/v:null;
}
function rangeStats(x){
  if(!x.length)return null;let hi=-Infinity,lo=Infinity;const rets=[];
  for(let i=0;i<x.length;i++){hi=Math.max(hi,Number.isFinite(x[i].high)?x[i].high:x[i].close);lo=Math.min(lo,Number.isFinite(x[i].low)?x[i].low:x[i].close);if(i)rets.push(Math.abs(Math.log(x[i].close/x[i-1].close)));}
  return {hi,lo,noise:median(rets)||0};
}
function featureRows(sess,benchByDay,days,base){
  const out={};
  for(const day of days){
    const a=sess[day]||[],q=benchByDay.QQQ[day]||[],g=benchByDay.IGV[day]||[],rows=[];
    for(let i=12;i<a.length;i++){
      const b=a[i],r60=rolling(a,i,60),r90=rolling(a,i,90),s60=rangeStats(r60),s90=rangeStats(r90);
      if(!s60||!s90)continue;
      let dir=0,break60=0,break90=0;
      if(b.close>s60.hi){dir=1;break60=Math.log(b.close/s60.hi);}
      else if(b.close<s60.lo){dir=-1;break60=Math.log(s60.lo/b.close);}
      if(b.close>s90.hi)break90=1; else if(b.close<s90.lo)break90=-1;
      if(!dir)continue;
      const q15=ret(q,b.t,15),g15=ret(g,b.t,15),o15=ret(a,b.t,15);
      if(!Number.isFinite(q15)||!Number.isFinite(g15)||!Number.isFinite(o15))continue;
      const rs=dir*(o15-(q15+g15)/2),rv=rvol(b,base),vwap=sessionVwap(a,i),vwapSide=vwap?dir*Math.log(b.close/vwap):null;
      const prev30=rolling(a,i,30),vol30=prev30.reduce((s,x)=>s+(Number.isFinite(x.volume)?x.volume:0),0)+(Number.isFinite(b.volume)?b.volume:0);
      const typicalVol30=prev30.map(x=>{const m=base[minuteBucket(x.t)];return Number.isFinite(m)?m:0;}).reduce((s,x)=>s+x,0)+(base[minuteBucket(b.t)]||0);
      const rv30=typicalVol30>0?vol30/typicalVol30:null;
      const noise=s60.noise,impulse=noise>0?break60/noise:0;
      const ext=noise>0?Math.abs(o15)/noise:0;
      rows.push({day,t:b.t,price:b.close,dir,break90,impulse,rs,rv,rv30,vwapSide,ext});
    }
    out[day]=rows;
  }
  return out;
}
function pass(r,p){
  if(p.break90&&r.break90!==r.dir)return false;
  if(!(r.impulse>=p.impulse&&r.rs>=p.rs&&r.rv30>=p.rv30&&r.vwapSide>=p.vwap))return false;
  if(p.maxExt&&r.ext>p.maxExt)return false;
  return true;
}
function events(features,days,p){
  const out=[];for(const day of days){let last=0,armed=true;for(const r of features[day]||[]){const ok=pass(r,p);if(ok&&armed&&r.t-last>=30*60000){out.push(r);last=r.t;armed=false;}if(!ok)armed=true;}}return out;
}
function future(dayBars,t,h){const target=t+h*60000;for(const b of dayBars)if(b.t>=target)return b.t-target<=8*60000?b:null;return null;}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [c-m,c+m];}
function stat(ev,sess,h){const vals=[];for(const e of ev){const f=future(sess[e.day],e.t,h);if(f)vals.push(e.dir*(f.close/e.price-1));}const n=vals.length,k=vals.filter(x=>x>0).length,ci=wilson(k,n),sorted=vals.slice().sort((a,b)=>a-b);return {n,hit:n?k/n:null,hit95:ci,mean:n?vals.reduce((a,b)=>a+b,0)/n:null,median:n?sorted[Math.floor(n/2)]:null};}
function summary(ev,sess){return {events:ev.length,eventDays:new Set(ev.map(x=>x.day)).size,m15:stat(ev,sess,15),m30:stat(ev,sess,30),m60:stat(ev,sess,60)};}
function score(s){
  if(s.m15.n<30||s.eventDays<18)return -Infinity;
  const lo=s.m15.hit95[0]||0;
  const edge=Math.min(.003,Math.max(-.003,s.m15.mean||0));
  return lo*2.5+edge*120+(s.m30.mean>0?.08:0)+(s.m30.hit>=.5?.05:0);
}
(async()=>{
  const bars=Object.fromEntries(await Promise.all(SYMBOLS.map(async s=>[s,await fetchBars(s)])));
  const sess=Object.fromEntries(SYMBOLS.map(s=>[s,regularSessions(bars[s])]));
  const days=Object.keys(sess.ORCL).filter(d=>sess.QQQ[d]?.length&&sess.IGV[d]?.length).sort(),cut=Math.floor(days.length*2/3),train=days.slice(0,cut),test=days.slice(cut);
  const base=buildVolumeBaseline(sess.ORCL,train),features=featureRows(sess.ORCL,{QQQ:sess.QQQ,IGV:sess.IGV},days,base);
  const grid=[];
  for(const break90 of [false,true])for(const impulse of [0,.15,.3,.5])for(const rs of [0,.0004,.0008,.0012])for(const rv30 of [.9,1.1,1.3,1.6])for(const vwap of [0,.0005,.001])for(const maxExt of [0,6,10]){
    const p={break90,impulse,rs,rv30,vwap,maxExt},ev=events(features,train,p),sm=summary(ev,sess.ORCL),sc=score(sm);if(Number.isFinite(sc))grid.push({p,sm,sc});
  }
  grid.sort((a,b)=>b.sc-a.sc);const best=grid[0];if(!best)throw new Error('No setup passed train minimums');
  const held=summary(events(features,test,best.p),sess.ORCL),halves=[test.slice(0,10),test.slice(10)].map(ds=>summary(events(features,ds,best.p),sess.ORCL));
  console.log('SIGNAL_VALIDATION_JSON '+JSON.stringify({bars:Object.fromEntries(SYMBOLS.map(s=>[s,bars[s].length])),days:days.length,trainDays:train.length,testDays:test.length,bestTrain:best,heldOut:held,heldOutHalves:halves,top5:grid.slice(0,5)}));
})().catch(e=>{console.error(e);process.exit(1);});
