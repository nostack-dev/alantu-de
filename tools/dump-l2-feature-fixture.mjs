import {FEATURE_NAMES,l2TemporalFeatureVector} from './l2-event-signal.mjs';

const baseNs=1770000000000000000n;
function makeEvent(i){
  const ns=baseNs+BigInt(i)*1000000n;
  return {
    at:new Date(Number(ns/1000000n)).toISOString(),
    ts_event_ns:String(ns),sequence:i,
    levels:Array.from({length:10},(_,j)=>({
      bid_px:100-j*.01,ask_px:100.01+j*.01,
      bid_sz:220-j*4+i*.001,ask_sz:100+j*3
    }))
  };
}
const hist=Array.from({length:1201},(_,i)=>makeEvent(i));
const f=l2TemporalFeatureVector(hist);
if(!f)throw new Error('JS temporal feature fixture failed');
process.stdout.write(JSON.stringify({feature_names:FEATURE_NAMES,values:f.values,trajectory:f.trajectory}));
