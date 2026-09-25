import assert from 'node:assert/strict';
import {extractV5Features,evaluateV5Path,V5_VERSION} from './yahoo-monetary-v5.mjs';

assert.equal(V5_VERSION,'yahoo-monetary-dt-v6');

const base=Date.parse('2026-09-24T14:00:00.000Z');
const symbols=['ORCL','MSFT','AMZN','GOOGL','NVDA','IGV','QQQ','SPY'];
const series=Object.fromEntries(symbols.map(s=>[s,[]]));
for(let i=0;i<=360;i++){
  const t=base+i*1000;
  for(let k=0;k<symbols.length;k++){
    const s=symbols[k],p=100+k+i*.0008+(k%3)*Math.sin(i/20)*.002;
    series[s].push({s,t,p,dv:10+(i%7),recv_at:t+250+k});
  }
}
const f=extractV5Features(series,base+360000);
assert.equal(f.status,'ok');
assert.equal(f.clock,'market_event_time');
assert.equal(Date.parse(f.asof),base+360000);

// Receiver delay must not alter market-time features.
const delayed=structuredClone(series);
for(const rows of Object.values(delayed))for(const e of rows)e.recv_at+=7000;
const fd=extractV5Features(delayed,base+360000);
assert.equal(fd.status,'ok');
assert.deepEqual(fd.vector,f.vector);

// Repeated identical observations must not create artificial movement.
const repeated=structuredClone(series);
for(const s of symbols){
  const last=repeated[s].at(-1);
  for(let n=0;n<20;n++)repeated[s].push({...last,recv_at:last.recv_at+10000+n*1000});
}
const fr=extractV5Features(repeated,base+360000);
assert.equal(fr.status,'ok');
assert.deepEqual(fr.vector,f.vector);

// A gap is a gap: no endpoint near target => invalid, never a synthetic flat return.
const pred={at:new Date(base+300000).toISOString(),target_at:new Date(base+360000).toISOString(),entry_price:100,barrier_bps:5,horizon_minutes:1,structural_dir:1,learned_dir:1};
const sparse=[{t:base+300000,p:100,recv_at:base+300250},{t:base+600000,p:101,recv_at:base+600250}];
const ev=evaluateV5Path(pred,sparse,base+700000);
assert.equal(ev.status,'invalid');
assert.equal(ev.reason,'target_price_unavailable');

console.log('DATA_CONTRACT_OK',JSON.stringify({version:V5_VERSION,clock:f.clock,receiver_delay_invariant:true,repeated_sample_invariant:true,gap_not_interpolated:true}));
