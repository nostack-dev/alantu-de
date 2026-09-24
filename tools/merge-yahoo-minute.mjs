#!/usr/bin/env node
import fs from 'node:fs';

const [oldPath,freshPath,outPath,daysArg] = process.argv.slice(2);
if(!freshPath||!outPath){
  console.error('usage: merge-yahoo-minute.mjs <old.json|-> <fresh.json> <out.json> [retentionDays]');
  process.exit(2);
}
const retentionDays=Math.max(7,Number(daysArg)||14);
const read=p=>{
  if(!p||p==='-'||!fs.existsSync(p))return null;
  try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;}
};
const result=p=>p?.chart?.result?.[0]||null;
const old=read(oldPath),fresh=read(freshPath),fr=result(fresh);
if(!fr)throw new Error('fresh Yahoo chart missing result[0]');

function rows(payload){
  const r=result(payload); if(!r)return [];
  const ts=r.timestamp||[],q=r.indicators?.quote?.[0]||{};
  return ts.map((t,i)=>({
    t:Number(t),
    open:q.open?.[i]??null,
    high:q.high?.[i]??null,
    low:q.low?.[i]??null,
    close:q.close?.[i]??null,
    volume:q.volume?.[i]??null
  })).filter(x=>Number.isFinite(x.t)&&Number.isFinite(Number(x.close))&&Number(x.close)>0);
}
const freshRows=rows(fresh), oldRows=rows(old);
if(freshRows.length<5)throw new Error('fresh Yahoo minute chart has fewer than 5 valid rows');

const newest=Math.max(...freshRows.map(x=>x.t),...oldRows.map(x=>x.t),0);
const cutoff=newest-retentionDays*86400;
const by=new Map();

function mergeRow(x,prefer){
  if(x.t<cutoff)return;
  const prev=by.get(x.t);
  if(!prev){by.set(x.t,{...x});return;}
  const out={...prev};
  for(const k of ['open','high','low','close','volume']){
    const v=x[k];
    if(v!==null&&v!==undefined&&Number.isFinite(Number(v))&&(prefer||out[k]==null))out[k]=v;
  }
  by.set(x.t,out);
}
oldRows.forEach(x=>mergeRow(x,false));
freshRows.forEach(x=>mergeRow(x,true));

const merged=[...by.values()].sort((a,b)=>a.t-b.t);
const preservedOld=oldRows.filter(x=>x.t>=cutoff).length;
if(merged.length<freshRows.length||merged.length<preservedOld){
  throw new Error(`merge would lose rows: merged=${merged.length} fresh=${freshRows.length} oldEligible=${preservedOld}`);
}

const base=structuredClone(fresh);
const rr=result(base);
rr.timestamp=merged.map(x=>x.t);
rr.indicators=rr.indicators||{};
rr.indicators.quote=[{
  open:merged.map(x=>x.open),
  high:merged.map(x=>x.high),
  low:merged.map(x=>x.low),
  close:merged.map(x=>x.close),
  volume:merged.map(x=>x.volume)
}];
if(rr.indicators.adjclose)delete rr.indicators.adjclose;
base.chart.error=null;
fs.writeFileSync(outPath,JSON.stringify(base));
console.log(JSON.stringify({
  symbol:rr.meta?.symbol||null,
  old:oldRows.length,
  fresh:freshRows.length,
  merged:merged.length,
  retentionDays,
  first:new Date(merged[0].t*1000).toISOString(),
  last:new Date(merged.at(-1).t*1000).toISOString()
}));
