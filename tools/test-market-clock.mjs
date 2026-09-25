import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const MarketClock=require('../market-clock-core.js');

assert.equal(MarketClock.closeMinute(2026,9,25),16*60);
assert.equal(MarketClock.closeMinute(2026,11,27),13*60);
assert.equal(MarketClock.closeMinute(2026,12,24),13*60);
assert.equal(MarketClock.closeMinute(2026,7,3),null); // July 4 Saturday -> observed full holiday Friday.
assert.equal(MarketClock.isTradingDay(2026,7,3),false);

const early=MarketClock.sessions(2026,11,27);
assert.equal(early.earlyClose,true);
const parts=MarketClock.parts(early.close,'America/New_York');
assert.equal(parts.hour,13);
assert.equal(parts.minute,0);

console.log('MARKET_CLOCK_OK');
