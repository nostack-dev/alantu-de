import assert from 'node:assert/strict';
import {YAHOO_EVENT_CONTRACT,zigZag64,canonicalVolumeDelta,canonicalEventCheck,normalizeLegacyYahooEvent} from './yahoo-stream-contract.mjs';

assert.equal(zigZag64(200n),100);
assert.equal(zigZag64(201n),-101);
assert.equal(canonicalVolumeDelta(null,1000),0);
assert.equal(canonicalVolumeDelta(1000,1015),15);
assert.equal(canonicalVolumeDelta(1015,10),0);

const t=Date.parse('2026-09-25T14:00:00Z');
assert.deepEqual(canonicalEventCheck(null,{t,p:100},t+100),{accept:true,reason:null});
assert.equal(canonicalEventCheck({t,p:100},{t,p:100.1},t+200).reason,'duplicate_market_timestamp');
assert.equal(canonicalEventCheck({t,p:100},{t:t-1000,p:99.9},t+200).reason,'out_of_order');
assert.equal(canonicalEventCheck({t,p:100},{t:t+6000,p:100.1},t).reason,'future_market_timestamp');
assert.equal(canonicalEventCheck({t,p:100},{t:t+1000,p:110},t+1200).reason,'implausible_sub10s_jump');
assert.equal(canonicalEventCheck({t,p:100},{t:t+11000,p:110},t+11200).accept,true);

const old={s:'ORCL',t,p:100,day_volume:2000,dv:40,provider:'yahoo_streamer'};
const norm=normalizeLegacyYahooEvent(old);
assert.equal(norm.day_volume,1000);
assert.equal(norm.dv,20);
assert.equal(norm.event_contract,'legacy-normalized-at-load');
const already=normalizeLegacyYahooEvent({...old,event_contract:YAHOO_EVENT_CONTRACT});
assert.equal(already.day_volume,2000);

console.log('YAHOO_STREAM_CONTRACT_OK');
