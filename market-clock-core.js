(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.MarketClock=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var NY='America/New_York', BERLIN='Europe/Berlin';
  function parts(ms,tz){
    var out={};
    new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).forEach(function(p){if(p.type!=='literal')out[p.type]=p.value;});
    return {year:+out.year,month:+out.month,day:+out.day,hour:+out.hour,minute:+out.minute,second:+out.second};
  }
  function ymdKey(y,m,d){return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');}
  function addDays(y,m,d,n){
    var z=new Date(Date.UTC(y,m-1,d+n));
    return {year:z.getUTCFullYear(),month:z.getUTCMonth()+1,day:z.getUTCDate()};
  }
  function weekday(y,m,d){return new Date(Date.UTC(y,m-1,d)).getUTCDay();}
  function nthWeekday(y,m,w,n){
    var first=weekday(y,m,1),day=1+((w-first+7)%7)+(n-1)*7;
    return {year:y,month:m,day:day};
  }
  function lastWeekday(y,m,w){
    var last=new Date(Date.UTC(y,m,0)).getUTCDate(),lw=weekday(y,m,last);
    return {year:y,month:m,day:last-((lw-w+7)%7)};
  }
  function easter(y){
    var a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
    var h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
    var month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1;
    return {year:y,month:month,day:day};
  }
  function observedFixed(y,m,d){
    var w=weekday(y,m,d);
    if(w===6)return addDays(y,m,d,-1);
    if(w===0)return addDays(y,m,d,1);
    return {year:y,month:m,day:d};
  }
  function same(a,y,m,d){return a.year===y&&a.month===m&&a.day===d;}
  function isHoliday(y,m,d){
    var w=weekday(y,m,d);
    // NYSE New Year's: Sunday -> Monday; Saturday is not observed on the prior Friday.
    if(m===1&&d===1&&w>=1&&w<=5)return true;
    if(m===1&&d===2&&weekday(y,1,1)===0)return true;
    if(same(nthWeekday(y,1,1,3),y,m,d))return true;   // MLK
    if(same(nthWeekday(y,2,1,3),y,m,d))return true;   // Presidents
    var gf=addDays(easter(y).year,easter(y).month,easter(y).day,-2);
    if(same(gf,y,m,d))return true;
    if(same(lastWeekday(y,5,1),y,m,d))return true;    // Memorial
    if(y>=2022&&same(observedFixed(y,6,19),y,m,d))return true;
    if(same(observedFixed(y,7,4),y,m,d))return true;
    if(same(nthWeekday(y,9,1,1),y,m,d))return true;   // Labor
    if(same(nthWeekday(y,11,4,4),y,m,d))return true;  // Thanksgiving
    if(same(observedFixed(y,12,25),y,m,d))return true;
    return false;
  }
  function isTradingDay(y,m,d){
    var w=weekday(y,m,d);
    return w!==0&&w!==6&&!isHoliday(y,m,d);
  }
  function zonedMs(y,m,d,h,min,tz){
    var target=Date.UTC(y,m-1,d,h,min,0),guess=target;
    for(var i=0;i<4;i++){
      var p=parts(guess,tz),shown=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second||0);
      var diff=target-shown;
      if(Math.abs(diff)<1000)break;
      guess+=diff;
    }
    return guess;
  }
  function closeMinute(y,m,d){
    if(!isTradingDay(y,m,d))return null;
    var thanksgiving=nthWeekday(y,11,4,4);
    // NYSE regular early-close patterns. Full-day observed holidays win above.
    if((m===11&&d===thanksgiving.day+1)||(m===12&&d===24)||(m===7&&d===3))return 13*60;
    return 16*60;
  }
  function sessions(y,m,d){
    var close=closeMinute(y,m,d),ch=close==null?16:Math.floor(close/60),cm=close==null?0:close%60;
    return {
      pre:zonedMs(y,m,d,4,0,NY),
      open:zonedMs(y,m,d,9,30,NY),
      close:zonedMs(y,m,d,ch,cm,NY),
      earlyClose:close===13*60
    };
  }
  function nextTrading(y,m,d){
    var p={year:y,month:m,day:d};
    for(var i=0;i<15;i++){
      p=addDays(p.year,p.month,p.day,1);
      if(isTradingDay(p.year,p.month,p.day))return p;
    }
    return p;
  }
  function fmtCountdown(target,now){
    var mins=Math.max(0,Math.ceil((target-now)/60000));
    if(mins<1)return '<1 Min.';
    var h=Math.floor(mins/60),m=mins%60;
    return h?(h+' Std.'+(m?' '+m+' Min.':'')):(m+' Min.');
  }
  function berlinTime(ms){
    return new Intl.DateTimeFormat('de-DE',{timeZone:BERLIN,hour:'2-digit',minute:'2-digit'}).format(new Date(ms));
  }
  function berlinDate(ms){
    var p=parts(ms,BERLIN); return {year:p.year,month:p.month,day:p.day};
  }
  function dayLabel(target,now){
    var a=berlinDate(now),b=berlinDate(target);
    var a0=Date.UTC(a.year,a.month-1,a.day),b0=Date.UTC(b.year,b.month-1,b.day),dd=Math.round((b0-a0)/864e5);
    if(dd===0)return 'heute';
    if(dd===1)return 'morgen';
    return new Intl.DateTimeFormat('de-DE',{timeZone:BERLIN,weekday:'long'}).format(new Date(target));
  }
  function state(now){
    now=Number(now==null?Date.now():now);
    var n=parts(now,NY), trading=isTradingDay(n.year,n.month,n.day);
    if(trading){
      var s=sessions(n.year,n.month,n.day);
      if(now<s.pre)return {phase:'premarket_countdown',targetAt:s.pre,text:'Vorbörse öffnet in '+fmtCountdown(s.pre,now)+' · '+berlinTime(s.pre)};
      if(now<s.open)return {phase:'open_countdown',targetAt:s.open,text:'US-Markt öffnet in '+fmtCountdown(s.open,now)+' · '+berlinTime(s.open)};
      if(now<s.close)return {phase:'open',targetAt:s.close,text:'US-Markt geöffnet · schließt in '+fmtCountdown(s.close,now)+' · '+berlinTime(s.close)};
    }
    var nxt=nextTrading(n.year,n.month,n.day),ns=sessions(nxt.year,nxt.month,nxt.day);
    return {phase:'closed',targetAt:ns.open,text:'US-Markt geschlossen · nächste Öffnung '+dayLabel(ns.open,now)+' '+berlinTime(ns.open)};
  }
  return {state:state,isTradingDay:isTradingDay,isHoliday:isHoliday,closeMinute:closeMinute,sessions:sessions,parts:parts};
});
