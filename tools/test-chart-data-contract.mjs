import assert from 'node:assert/strict';
import fs from 'node:fs';
const DAY=864e5,FX_MAX_AGE=7*DAY;
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function yahoo(path){const j=read(path),r=j?.chart?.result?.[0],ts=r?.timestamp||[],q=r?.indicators?.quote?.[0]||{};assert.ok(r,path+' missing result');return {meta:r.meta||{},rows:ts.map((t,i)=>({t:Number(t)*1000,close:Number(q.close?.[i])})).filter(x=>Number.isFinite(x.t)&&Number.isFinite(x.close)&&x.close>0)};}
function ordered(name,rows,min){assert.ok(rows.length>=min,name+' rows '+rows.length);const seen=new Set();for(let i=0;i<rows.length;i++){assert.ok(!seen.has(rows[i].t),name+' duplicate');seen.add(rows[i].t);if(i)assert.ok(rows[i].t>rows[i-1].t,name+' non-monotone');}}
const minute=yahoo('orcl-minute.json'),german=yahoo('orcl-germany-minute.json'),daily=yahoo('orcl-history.json'),fx=yahoo('eurusd-history.json');
assert.equal(minute.meta.symbol,'ORCL');assert.equal(minute.meta.currency,'USD');ordered('ORCL minute',minute.rows,1000);assert.ok(minute.rows.at(-1).t-minute.rows[0].t>=3*DAY);
assert.ok(['ORC.F','ORC.DE'].includes(german.meta.symbol));assert.equal(german.meta.currency,'EUR');ordered('German minute',german.rows,5);
assert.equal(daily.meta.symbol,'ORCL');assert.equal(daily.meta.currency,'USD');ordered('ORCL daily',daily.rows,2000);assert.ok(daily.rows.at(-1).t-daily.rows[0].t>=8*365*DAY);
assert.equal(fx.meta.symbol,'EURUSD=X');ordered('EURUSD daily',fx.rows,2000);assert.ok(fx.rows.at(-1).t-fx.rows[0].t>=8*365*DAY);
let fi=-1,covered=0,maxAge=0;for(const row of daily.rows){while(fi+1<fx.rows.length&&fx.rows[fi+1].t<=row.t)fi++;const rate=fi>=0?fx.rows[fi]:null;assert.ok(!rate||rate.t<=row.t,'future FX leakage');if(rate){const age=row.t-rate.t;maxAge=Math.max(maxAge,age);if(age<=FX_MAX_AGE)covered++;}}
assert.equal(covered,daily.rows.length,'ORCL daily missing as-of FX within 7 days');
const html=fs.readFileSync('index.html','utf8'),alias=fs.readFileSync('stockstrend.html','utf8');assert.equal(alias,html,'index/stockstrend drift');
for(const m of ['var HISTORICAL_FX_MAX_AGE_MS=7*864e5;','if(bv>0&&t-bt<=HISTORICAL_FX_MAX_AGE_MS)return bv;',"session.source==='us_orcl_fx'",'var cut=t-14*864e5,firstKeep=0;','var rangeRenderSeq={price:0,forecast:0,sentiment:0,magnitude:0,opinions:0};','compactCoverage(v.priceRows','function stablePriceYBounds'])assert.ok(html.includes(m),'missing invariant '+m);
const live=read('microstructure-live-config.json');assert.equal(live.transport,'poll');
const refreshSource=fs.readFileSync('tools/refresh-runtime-data.mjs','utf8');
assert.ok(!refreshSource.includes('awaiting_railway_sse'),'refresh script contains retired SSE state');
assert.ok(refreshSource.includes('static_bootstrap_replaced_by_railway_poll'));
assert.ok(refreshSource.includes('awaiting_live_poll'));
console.log('CHART_DATA_CONTRACT_OK',JSON.stringify({minuteBars:minute.rows.length,germanMinuteBars:german.rows.length,dailyBars:daily.rows.length,fxBars:fx.rows.length,fxCoverage:covered,maxObservedFxAgeHours:Number((maxAge/36e5).toFixed(1))}));
