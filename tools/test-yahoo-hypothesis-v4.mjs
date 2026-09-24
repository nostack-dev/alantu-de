import assert from 'node:assert/strict';
import {signalSessionEligible,regimeDecision,strategyDirections,summarizeHypothesisState,HYPOTHESIS_VERSION} from './yahoo-hypothesis-v4.mjs';

const fc={diagnostics:{coupling:{self_fast:.8,self_mid:.4,local_fast:.05,global_fast:.04,peer_lead:-.6,hdr_self_local:.65}}};
const f={dir:1};
assert.equal(strategyDirections(fc,f).continuation,1);
assert.equal(strategyDirections(fc,f).reversal,-1);
assert.equal(regimeDecision(fc,f).dir,-1);
const confirm={diagnostics:{coupling:{self_fast:.4,self_mid:.3,local_fast:.5,global_fast:.35,peer_lead:.1,hdr_self_local:.1}}};
assert.equal(regimeDecision(confirm,f).dir,1);
assert.equal(signalSessionEligible(Date.parse('2026-09-24T14:00:00Z'),15),true);
assert.equal(signalSessionEligible(Date.parse('2026-09-24T19:45:00Z'),30),false);
const outcomes=[];
for(let d=0;d<12;d++)for(let i=0;i<16;i++){
  const at=new Date(Date.UTC(2026,8,1+d,14,0,i)).toISOString();
  for(const strategy of ['continuation','reversal','regime']){
    const good=strategy==='regime'||(i%2===0);
    outcomes.push({version:HYPOTHESIS_VERSION,strategy,horizon_minutes:15,status:'evaluated',at,net_bps:good?2.2:-1.2,gross_bps:good?4.2:.8,direction_hit:good});
  }
}
const s=summarizeHypothesisState({outcomes,updated_at:new Date().toISOString()},2);
assert.equal(s.proof['15'].regime.gate.status,'validated');
assert.equal(s.production.enabled,true);
assert.equal(s.production.selected_horizon,15);
console.log('yahoo-hypothesis-v4 tests ok');
