(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.PriceShock=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function median(xs){
    var a=(xs||[]).filter(Number.isFinite).slice().sort(function(x,y){return x-y;});
    if(!a.length) return null;
    var m=Math.floor(a.length/2);
    return a.length%2?a[m]:(a[m-1]+a[m])/2;
  }
  function robustSigma(xs){
    var m=median(xs); if(m==null) return null;
    var mad=median(xs.map(function(x){return Math.abs(x-m);}));
    if(mad==null) return null;
    return Math.max(0.015,1.4826*mad);
  }
  function pct(a,b){return a&&b?((b/a)-1)*100:0;}
  function nyParts(ts){
    try{
      var parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ts));
      var o={}; parts.forEach(function(p){o[p.type]=p.value;});
      return {date:o.year+'-'+o.month+'-'+o.day,minute:Number(o.hour)*60+Number(o.minute)};
    }catch(e){
      var d=new Date(ts); return {date:d.toISOString().slice(0,10),minute:d.getUTCHours()*60+d.getUTCMinutes()};
    }
  }
  function linearity(points){
    if(!points||points.length<3) return 1;
    var n=points.length,sx=0,sy=0,sxx=0,sxy=0;
    for(var i=0;i<n;i++){var y=Math.log(points[i].close);sx+=i;sy+=y;sxx+=i*i;sxy+=i*y;}
    var den=n*sxx-sx*sx; if(!den) return 0;
    var b=(n*sxy-sx*sy)/den,a=(sy-b*sx)/n,mean=sy/n,ssTot=0,ssRes=0;
    for(var j=0;j<n;j++){var yy=Math.log(points[j].close),fit=a+b*j;ssTot+=(yy-mean)*(yy-mean);ssRes+=(yy-fit)*(yy-fit);}
    return ssTot<=1e-14?1:clamp(1-ssRes/ssTot,0,1);
  }
  function monotonicity(points,dir){
    if(!points||points.length<2) return 0;
    var ok=0,total=0;
    for(var i=1;i<points.length;i++){
      var r=points[i].close-points[i-1].close;
      if(r===0) continue;
      total++; if((dir>0&&r>0)||(dir<0&&r<0)) ok++;
    }
    return total?ok/total:0;
  }
  function parseYahoo(payload){
    var r=payload&&payload.chart&&payload.chart.result&&payload.chart.result[0];
    if(!r) return [];
    var ts=r.timestamp||[],q=r.indicators&&r.indicators.quote&&r.indicators.quote[0]||{};
    var out=[];
    for(var i=0;i<ts.length;i++){
      var c=Number(q.close&&q.close[i]); if(!Number.isFinite(c)||c<=0) continue;
      var v=Number(q.volume&&q.volume[i]);
      out.push({at:new Date(ts[i]*1000).toISOString(),close:c,volume:Number.isFinite(v)&&v>=0?v:null});
    }
    return out.sort(function(a,b){return new Date(a.at)-new Date(b.at);});
  }
  function analyze(input,opts){
    opts=opts||{};
    var bars=(input||[]).filter(function(b){return b&&Number.isFinite(Number(b.close))&&Number(b.close)>0&&b.at;})
      .map(function(b){return {at:b.at,close:Number(b.close),volume:Number.isFinite(Number(b.volume))?Number(b.volume):null};})
      .sort(function(a,b){return new Date(a.at)-new Date(b.at);});
    if(bars.length<25) return {triggered:false,score:0,reason:'Zu wenig 1-Minuten-Daten',bars:bars.length};
    var returns=[];
    for(var i=1;i<bars.length;i++) returns.push({at:bars[i].at,p:pct(bars[i-1].close,bars[i].close),volume:bars[i].volume});
    var lastParts=nyParts(bars[bars.length-1].at), cut=Math.max(0,returns.length-6);
    var hist=returns.slice(0,cut);
    var sameTime=hist.filter(function(x){
      var p=nyParts(x.at),d=Math.abs(p.minute-lastParts.minute);
      return p.date!==lastParts.date&&d<=45;
    });
    var base=(sameTime.length>=20?sameTime:hist.slice(-600));
    var sigma=robustSigma(base.map(function(x){return x.p;}));
    if(!sigma||!Number.isFinite(sigma)) sigma=0.06;
    var volMed=median(base.map(function(x){return x.volume;}).filter(function(v){return Number.isFinite(v)&&v>0;}));
    var prevAbs=median(returns.slice(Math.max(0,returns.length-16),Math.max(0,returns.length-1)).map(function(x){return Math.abs(x.p);}));
    if(!prevAbs||!Number.isFinite(prevAbs)) prevAbs=sigma;
    var best=null,windows=opts.windows||[1,3,5];

    windows.forEach(function(w){
      if(bars.length<w+1) return;
      var pts=bars.slice(-(w+1)),move=pct(pts[0].close,pts[pts.length-1].close);
      var dir=move>=0?1:-1,absMove=Math.abs(move),r2=linearity(pts),mono=monotonicity(pts,dir);
      var z=absMove/Math.max(0.02,sigma*Math.sqrt(w));
      var lastStep=Math.abs(pct(bars[bars.length-2].close,bars[bars.length-1].close));
      var accel=lastStep/Math.max(0.015,prevAbs);
      var floor=Math.max(0.16*Math.sqrt(w),2.4*sigma*Math.sqrt(w));
      var vols=pts.slice(1).map(function(x){return x.volume;}).filter(function(v){return Number.isFinite(v)&&v>=0;});
      var volRatio=null;
      if(volMed&&vols.length){var sum=vols.reduce(function(a,b){return a+b;},0);volRatio=sum/(volMed*w);}
      var score=
        38*clamp(z/4.5,0,1)+
        18*clamp(absMove/Math.max(floor,0.01),0,1)+
        14*(w===1?1:r2)+
        10*mono+
        10*clamp(accel/4,0,1)+
        10*(volRatio==null?0:clamp(volRatio/3,0,1));
      score=Math.round(clamp(score,0,100));
      var shapeOk=w===1||r2>=0.82||mono>=0.80||accel>=3;
      var triggered=score>=70&&z>=3&&absMove>=floor&&shapeOk;
      var pattern='impuls';
      if(w===1||(lastStep>=absMove*0.65&&accel>=3)) pattern='sprung';
      else if(w>=3&&r2>=0.88&&mono>=0.75) pattern='rampe';
      else if(accel>=3) pattern='beschleunigung';
      var c={triggered:triggered,score:score,direction:dir>0?'up':'down',pattern:pattern,window_minutes:w,move_pct:Number(move.toFixed(3)),z:Number(z.toFixed(2)),baseline_sigma_1m_pct:Number(sigma.toFixed(4)),linearity:Number(r2.toFixed(3)),monotonicity:Number(mono.toFixed(3)),acceleration:Number(accel.toFixed(2)),volume_ratio:volRatio==null?null:Number(volRatio.toFixed(2)),at:bars[bars.length-1].at,last_price:bars[bars.length-1].close,bars:bars.length};
      var rank=c.score+(c.triggered&&c.pattern==='rampe'?8:0)+(c.triggered&&c.pattern==='beschleunigung'?3:0);
      var bestRank=best?(best.score+(best.triggered&&best.pattern==='rampe'?8:0)+(best.triggered&&best.pattern==='beschleunigung'?3:0)):-1;
      if(!best||c.triggered&&!best.triggered||c.triggered===best.triggered&&(rank>bestRank||(rank===bestRank&&c.window_minutes>best.window_minutes))) best=c;
    });
    return best||{triggered:false,score:0,reason:'Kein Fenster'};
  }
  return {analyze:analyze,parseYahoo:parseYahoo,median:median,robustSigma:robustSigma};
});
