const BASE='https://query1.finance.yahoo.com/v8/finance/chart/';
const Q='?range=60d&interval=5m&includePrePost=true&events=div%2Csplits';
const SYMBOLS=['ORCL','QQQ','IGV'];
const DF=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'});
const HF=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function dayKey(t){return DF.format(new Date(t));}
function hm(t){const o={};for(const p of HF.formatToParts(new Date(t)))if(p.type!=='literal')o[p.type]=+p.value;return o.hour*60+o.minute;}
function median(a){const x=(a||[]).filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
async function fetchBars(sym){
  const r=await fetch(BASE+encodeURIComponent(sym)+Q,{headers:{'user-agent':'Mozilla/5.0'}});if(!r.ok)throw new Error(sym+' '+r.status);
  const j=await r.json(),z=j.chart.result[0],q=z.indicators.quote[0],ts=z.timestamp||[];
  return ts.map((t,i)=>({t:t*1000,open:+q.open?.[i],high:+q.high?.[i],low:+q.low?.[i],close:+q.close?.[i],volume:+q.volume?.[i]})).filter(x=>Number.isFinite(x.close)&&x.close>0).sort((a,b)=>a.t-b.t);
}
function sessions(bars){const o={};for(const b of bars){const m=hm(b.t);if(m<15*60+30||m>22*60)continue;(o[dayKey(b.t)]??=[]).push(b);}return o;}
function nearestAt(arr,t,maxGap=4*60000){let lo=0,hi=arr.length-1,b=null,d0=Infinity;while(lo<=hi){const m=(lo+hi)>>1,d=arr[m].t-t;if(Math.abs(d)<d0){b=arr[m];d0=Math.abs(d);}if(d<0)lo=m+1;else if(d>0)hi=m-1;else break;}return d0<=maxGap?b:null;}
function ret(arr,t,mins){const n=nearestAt(arr,t),p=nearestAt(arr,t-mins*60000,6*60000);return n&&p&&p.close>0?Math.log(n.close/p.close):null;}
function vwap(a,i){let pv=0,v=0;for(let j=0;j<=i;j++){const b=a[j],vol=+b.volume;if(!(vol>0))continue;const typ=(Number.isFinite(b.high)&&Number.isFinite(b.low))?(b.high+b.low+b.close)/3:b.close;pv+=typ*vol;v+=vol;}return v?pv/v:null;}
function recentNoise(a,i,mins=90){const t=a[i].t,r=[];for(let j=i;j>0&&a[j].t>=t-mins*60000;j--)r.push(Math.abs(Math.log(a[j].close/a[j-1].close)));return median(r)||0;}
function features(sess,bench,days){
  const o={};
  for(const d of days){const a=sess[d]||[],q=bench.QQQ[d]||[],g=bench.IGV[d]||[],rows=[];
    for(let i=12;i<a.length;i++){
      const b=a[i],n=recentNoise(a,i),vw=vwap(a,i);if(!(n>0)&&!(vw>0))continue;
      const o30=ret(a,b.t,30),o15=ret(a,b.t,15),q30=ret(q,b.t,30),g30=ret(g,b.t,30);if(![o30,o15,q30,g30].every(Number.isFinite))continue;
      const rel30=o30-(q30+g30)/2,side=Math.sign(rel30||o30),dist=Math.log(b.close/vw);
      if(!side||Math.sign(dist)!==side)continue;
      const last5=Math.log(b.close/a[i-1].close),prev5=Math.log(a[i-1].close/a[i-2].close);
      const turn=side*last5<0,slow=side*last5<side*prev5;
      rows.push({day:d,t:b.t,price:b.close,dir:-side,relExt:Math.abs(rel30),vwapExt:Math.abs(dist),noiseExt:Math.abs(o30)/n,turn,slow,last5:Math.abs(last5)});
    }o[d]=rows;
  }return o;
}
function events(f,days,p){const out=[];for(const d of days){let armed=true,last=0;for(const r of f[d]||[]){const ok=r.relExt>=p.rel&&r.vwapExt>=p.vwap&&r.noiseExt>=p.noise&&(p.turn?r.turn:r.slow)&&r.last5<=p.maxLast;if(ok&&armed&&r.t-last>=30*60000){out.push(r);last=r.t;armed=false;}if(!ok)armed=true;}}return out;}
function future(a,t,h){const target=t+h*60000;for(const b of a)if(b.t>=target)return b.t-target<=8*60000?b:null;return null;}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [c-m,c+m];}
function st(ev,s,h){const v=[];for(const e of ev){const f=future(s[e.day],e.t,h);if(f)v.push(e.dir*(f.close/e.price-1));}const n=v.length,k=v.filter(x=>x>0).length,ci=wilson(k,n),x=v.slice().sort((a,b)=>a-b);return {n,hit:n?k/n:null,hit95:ci,mean:n?v.reduce((a,b)=>a+b,0)/n:null,median:n?x[Math.floor(n/2)]:null};}
function sum(ev,s){return {events:ev.length,eventDays:new Set(ev.map(x=>x.day)).size,m15:st(ev,s,15),m30:st(ev,s,30),m60:st(ev,s,60)};}
function score(s){if(s.m15.n<30||s.eventDays<18)return -Infinity;return 2.5*(s.m15.hit95[0]||0)+120*Math.max(-.003,Math.min(.003,s.m15.mean||0))+(s.m30.mean>0?.08:0)+(s.m30.hit>=.5?.05:0);}
(async()=>{
  const bars=Object.fromEntries(await Promise.all(SYMBOLS.map(async x=>[x,await fetchBars(x)]))),sess=Object.fromEntries(SYMBOLS.map(x=>[x,sessions(bars[x])]));
  const days=Object.keys(sess.ORCL).filter(d=>sess.QQQ[d]?.length&&sess.IGV[d]?.length).sort(),cut=Math.floor(days.length*2/3),train=days.slice(0,cut),test=days.slice(cut),f=features(sess.ORCL,{QQQ:sess.QQQ,IGV:sess.IGV},days),grid=[];
  for(const rel of [.0015,.0025,.004,.006])for(const vwap of [.0015,.0025,.004,.006])for(const noise of [3,5,7,10])for(const turn of [false,true])for(const maxLast of [.002,.0035,.005]){
    const p={rel,vwap,noise,turn,maxLast},sm=sum(events(f,train,p),sess.ORCL),sc=score(sm);if(Number.isFinite(sc))grid.push({p,sm,sc});
  }
  grid.sort((a,b)=>b.sc-a.sc);const best=grid[0];if(!best)throw new Error('No train setup');
  const held=sum(events(f,test,best.p),sess.ORCL),halves=[test.slice(0,10),test.slice(10)].map(ds=>sum(events(f,ds,best.p),sess.ORCL));
  console.log('SIGNAL_VALIDATION_JSON '+JSON.stringify({bars:Object.fromEntries(SYMBOLS.map(x=>[x,bars[x].length])),days:days.length,trainDays:train.length,testDays:test.length,bestTrain:best,heldOut:held,heldOutHalves:halves,top5:grid.slice(0,5)}));
})().catch(e=>{console.error(e);process.exit(1);});
