import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {FEATURE_NAMES,l2FeatureVector,estimateEventClock,forecastL2Event} from './l2-event-signal.mjs';

const event={
  at:'2026-09-22T15:30:00.000Z',
  levels:Array.from({length:10},(_,i)=>({
    bid_px:100-i*.01,ask_px:100.01+i*.01,bid_sz:200-i*5,ask_sz:100+i*3
  }))
};
const f=l2FeatureVector(event);
assert.equal(f.values.length,7);
assert(f.values[0]>0);
assert(f.values[4]>0);
const hist=Array.from({length:201},(_,i)=>({...event,at:new Date(Date.parse(event.at)+i*10).toISOString()}));
const clock=estimateEventClock(hist,100);
assert(clock.events_per_second>90&&clock.events_per_second<110);
assert(clock.eta_seconds>.9&&clock.eta_seconds<1.1);

const base={
 status:'validated',symbol:'ORCL',dataset:'XNAS.ITCH',schema:'mbp-10',horizon_events:100,
 feature_names:FEATURE_NAMES,standardization:{mean:Array(7).fill(0),std:Array(7).fill(1)},
 coefficients:[0,10,0,0,0,0,0,0],threshold:.2,
 evidence:{usable_days:300,holdout_signals:800,holdout_days:70}
};
base.model_id=crypto.createHash('sha256').update(JSON.stringify({
 symbol:base.symbol,dataset:base.dataset,schema:base.schema,horizon_events:base.horizon_events,
 feature_names:base.feature_names,mean:base.standardization.mean,std:base.standardization.std,
 coefficients:base.coefficients,threshold:base.threshold
})).digest('hex').slice(0,16);
const s=forecastL2Event(event,hist,base);
assert.equal(s.status,'forecast');
assert.equal(s.direction,'up');
assert.equal(s.horizon_events,100);
console.log(JSON.stringify({ok:true,feature:f.values,clock,forecast:s}));
