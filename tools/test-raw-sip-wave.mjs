import assert from 'node:assert/strict';
import {timestampNs,extractRawSamples,RAW_FEATURE_NAMES,forecastRawLatest,RAW_FEATURE_VERSION} from './raw-sip-wave-core.mjs';

assert.equal(String(timestampNs('2026-09-23T13:30:00.123456789Z')).slice(-9),'123456789');

const start=Date.parse('2026-09-23T13:30:00Z');
const trades=[],quotes=[];
for(let i=0;i<1500;i++){
  const ms=start+i*1000;
  const iso=new Date(ms).toISOString().replace('.000Z','.123456789Z');
  const p=150+Math.sin(i/40)*.2+i*.00005;
  quotes.push({t:iso,bp:p-.01,ap:p+.01,bs:10+(i%7),as:9+(i%5)});
  trades.push({t:iso,p:p+(i%2?.01:-.01),s:10+(i%11),i:i+1,x:'N'});
}
const samples=extractRawSamples(trades,quotes,{sampleSeconds:30,horizons:[1,5]});
assert(samples.length>5,'raw samples should be produced');
assert.equal(samples[0].x.length,RAW_FEATURE_NAMES.length);
assert(samples.every(s=>s.windows.self<=20&&s.windows.local<=180&&s.windows.global<=900));
assert(samples.every(s=>s.windows.self<s.windows.local&&s.windows.local<s.windows.global));
assert(samples.some(s=>Number.isFinite(s.y[1])));

const blocked=forecastRawLatest(trades.slice(-1200),quotes.slice(-1200),{feature_version:RAW_FEATURE_VERSION,status:'unproven',production:{enabled:false},horizons:[]});
assert.equal(blocked.status,'ok');
assert.deepEqual(blocked.forecasts,[]);

console.log(JSON.stringify({ok:true,samples:samples.length,features:RAW_FEATURE_NAMES.length,first_windows:samples[0].windows}));
