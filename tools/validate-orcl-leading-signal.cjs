const BASE='https://query1.finance.yahoo.com/v8/finance/chart/';
const Q='?range=60d&interval=5m&includePrePost=true&events=div%2Csplits';
const SYMBOLS=['ORCL','QQQ','IGV'];
const DF=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'});
const HF=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function dayKey(t){return DF.format(new Date(t));}
function hm(t){const o={};for(const p of HF.formatToParts(new Date(t)))if(p.type!=='literal')o[p.type]=+p.value;return o.hour*60+o.minute;}
function median(a){const x=(a||[]).filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function pct(a,p){const x=(a||[]).filter(Number.isFinite).slice().sort((a,b)=>a-b);if(!x.length)return null;const i=(x.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return lo===hi?x[lo]:x[lo]+(x[hi]-x[lo])*(i-lo);}
async function fetchBars(sym){
  const r=await fetch(BASE+encodeURIComponent(sym)+Q,{headers:{'user-agent':'Mozilla/5.0'}});if(!r.ok)throw new Error(sym+' '+r.status);
  const j=await r.json(),z=j.chart.result[0],q=z.indicators.quote[0],ts=z.timestamp||[];
  return ts.map((t,i)=>({t:t*1000,open:+q.open?.[i],high:+q.high?.[i],low:+q.low?.[i],close:+q.close?.[i],volume:+q.volume?.[i]})).filter(x=>Number.isFinite(x.close)&&x.close>0).sort((a,b)=>a.t-b.t);
}
function sessions(bars){const o={};for(const b of bars){const m=hm(b.t);if(m<15*60+30||m>22*60)continue;(o[dayKey(b.t)]??=[]).push(b);}return o;}
function nearestAt(arr,t,maxGap=4*60000){let lo=0,hi=arr.length-1,b=null,d0=Infinity;while(lo<=hi){const m=(lo+hi)>>1,d=arr[m].t-t;if(Math.abs(d)<d0){b=arr[m];d0=Math.abs(d);}if(d<0)lo=m+1;else if(d>0)hi=m-1;else break;}return d0<=maxGap?b:null;}
function ret(arr,t,mins){const n=nearestAt(arr,t),p=nearestAt(arr,t-mins*60000,6*60000);return n&&p&&p.close>0?Math.log(n.close/p.close):null;}
function minuteBucket(t){return Math.floor(hm(t)/5)*5;}
function buildVolumeBaseline(sess,train){
  const x={};for(const d of train)for(const b of sess[d]||[]){if(b.volume>0)(x[minuteBucket(b.t)]??=[]).push(b.volume);}
  const o={};for(const [k,v] of Object.entries(x))o[k]=median(v);return o;
}
function rv30(a,i,base){let act=0,exp=0;for(let j=Math.max(0,i-5);j<=i;j++){act+=Math.max(0,+a[j].volume||0);exp+=base[minuteBucket(a[j].t)]||0;}return exp>0?act/exp:null;}
function barRange(b){const hi=Number.isFinite(b.high)?b.high:b.close,lo=Number.isFinite(b.low)?b.low:b.close;return b.close>0?(hi-lo)/b.close:0;}
function recentNoise(a,i){const x=[];for(let j=Math.max(1,i-36);j<=i;j++)x.push(Math.abs(Math.log(a[j].close/a[j-1].close)));return median(x)||0;}
function pressure15(a,i,dir){let sv=0,tv=0;for(let j=Math.max(1,i-2);j<=i;j++){const v=Math.max(0,+a[j].volume||0),d=a[j].close>a[j-1].close?1:a[j].close<a[j-1].close?-1:0;sv+=v*d;tv+=v;}return tv?dir*sv/tv:0;}
function features(sess,bench,days,base){
  const out={};
  for(const d of days){const a=sess[d]||[],q=bench.QQQ[d]||[],g=bench.IGV[d]||[],rows=[];
    for(let i=36;i<a.length;i++){
      const b=a[i],o15=ret(a,b.t,15),q15=ret(q,b.t,15),g15=ret(g,b.t,15);if(![o15,q15,g15].every(Number.isFinite))continue;
      const dir=Math.sign(o15);if(!dir)continue;
      const noise=recentNoise(a,i);if(!(noise>0))continue;
      const ranges=[];for(let j=Math.max(0,i-12);j<i;j++)ranges.push(barRange(a[j]));
      const rangeBase=median(ranges)||0,currentRange=barRange(b),rangeBurst=rangeBase>0?currentRange/rangeBase:null;
      const vol=rv30(a,i,base),mom=Math.abs(o15)/(noise*Math.sqrt(3)),rs=dir*(o15-(q15+g15)/2),press=pressure15(a,i,dir);
      if(![rangeBurst,vol,mom,rs,press].every(Number.isFinite))continue;
      rows.push({day:d,t:b.t,price:b.close,dir,rangeBurst,rv30:vol,mom,rs,press});
    }out[d]=rows;
  }return out;
}
function pass(r,p){return r.rv30>=p.rv&&r.rangeBurst>=p.range&&r.mom>=p.mom&&r.rs>=p.rs&&r.press>=p.press;}
function events(f,days,p){const out=[];for(const d of days){let armed=true,last=0;for(const r of f[d]||[]){const ok=pass(r,p);if(ok&&armed&&r.t-last>=30*60000){out.push(r);last=r.t;armed=false;}if(!ok)armed=true;}}return out;}
function future(a,t,h){const target=t+h*60000;for(const b of a)if(b.t>=target)return b.t-target<=8*60000?b:null;return null;}
function wilson(k,n){if(!n)return [null,null];const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [c-m,c+m];}
function stat(ev,s,h,moveCut){const v=[],big=[];for(const e of ev){const f=future(s[e.day],e.t,h);if(f){const raw=f.close/e.price-1,signed=e.dir*raw;v.push(signed);big.push(Math.abs(raw)>=moveCut?1:0);}}const n=v.length,k=v.filter(x=>x>0).length,ci=wilson(k,n),x=v.slice().sort((a,b)=>a-b);return {n,hit:n?k/n:null,hit95:ci,mean:n?v.reduce((a,b)=>a+b,0)/n:null,median:n?x[Math.floor(n/2)]:null,bigRate:n?big.reduce((a,b)=>a+b,0)/n:null};}
function allForward(sess,days,h){const v=[];for(const d of days){const a=sess[d]||[];for(const b of a){const f=future(a,b.t,h);if(f)v.push(Math.abs(f.close/b.close-1));}}return v;}
function summary(ev,s,moveCut){return {events:ev.length,eventDays:new Set(ev.map(x=>x.day)).size,m15:stat(ev,s,15,moveCut),m30:stat(ev,s,30,moveCut),m60:stat(ev,s,60,moveCut)};}
function score(s,baseBig){if(s.m15.n<35||s.eventDays<20)return -Infinity;const lift=(s.m15.bigRate||0)/baseBig;return 2.2*(s.m15.hit95[0]||0)+.55*Math.min(3,lift)+120*Math.max(-.003,Math.min(.003,s.m15.mean||0));}
(async()=>{
  const bars=Object.fromEntries(await Promise.all(SYMBOLS.map(async x=>[x,await fetchBars(x)]))),sess=Object.fromEntries(SYMBOLS.map(x=>[x,sessions(bars[x])]));
  const days=Object.keys(sess.ORCL).filter(d=>sess.QQQ[d]?.length&&sess.IGV[d]?.length).sort(),cut=Math.floor(days.length*2/3),train=days.slice(0,cut),test=days.slice(cut),base=buildVolumeBaseline(sess.ORCL,train),f=features(sess.ORCL,{QQQ:sess.QQQ,IGV:sess.IGV},days,base);
  const trainMoves=allForward(sess.ORCL,train,15),moveCut=pct(trainMoves,.75),baseBig=trainMoves.filter(x=>x>=moveCut).length/trainMoves.length,grid=[];
  for(const rv of [.9,1.1,1.3,1.6,2])for(const range of [.8,1,1.3,1.6,2])for(const mom of [.7,1,1.4,1.8])for(const rs of [0,.0003,.0006,.001])for(const press of [0,.1,.2,.3]){
    const p={rv,range,mom,rs,press},sm=summary(events(f,train,p),sess.ORCL,moveCut),sc=score(sm,baseBig);if(Number.isFinite(sc))grid.push({p,sm,sc});
  }
  grid.sort((a,b)=>b.sc-a.sc);const best=grid[0];if(!best)throw new Error('No train setup');
  const held=summary(events(f,test,best.p),sess.ORCL,moveCut),testAll=allForward(sess.ORCL,test,15),testBaseBig=testAll.filter(x=>x>=moveCut).length/testAll.length,halves=[test.slice(0,10),test.slice(10)].map(ds=>summary(events(f,ds,best.p),sess.ORCL,moveCut));
  console.log('SIGNAL_VALIDATION_JSON '+JSON.stringify({bars:Object.fromEntries(SYMBOLS.map(x=>[x,bars[x].length])),days:days.length,trainDays:train.length,testDays:test.length,moveCut,baseBigTrain:baseBig,baseBigTest:testBaseBig,bestTrain:best,heldOut:held,heldOutLift:held.m15.bigRate/testBaseBig,heldOutHalves:halves,top5:grid.slice(0,5)}));
})().catch(e=>{console.error(e);process.exit(1);});
