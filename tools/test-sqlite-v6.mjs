import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {openMarketStore,persistObservation,persistTransportObservation,persistPrediction,persistOutcome,persistEvidence,persistExperiment,storeStats,V6_CONTRACT_ID,V6_CONTRACT_TEXT} from '../market-relay/sqlite-store.mjs';

const file=path.join(os.tmpdir(),'alantu-sqlite-v6-'+Date.now()+'.sqlite');
const s=openMarketStore(file);
const t=Date.parse('2026-09-25T14:00:00Z');

persistTransportObservation(s,{s:'ORCL',t,p:123,day_volume:100,recv_at:t+200},{accepted:true});
persistObservation(s,{s:'ORCL',t,p:123,dv:10,day_volume:100,recv_at:t+200});
persistTransportObservation(s,{s:'ORCL',t,p:123.2,day_volume:101,recv_at:t+900},{accepted:false,reason:'duplicate_market_timestamp'});
persistObservation(s,{s:'ORCL',t,p:123.2,dv:11,day_volume:101,recv_at:t+900}); // canonical row stays frozen
persistObservation(s,{s:'ORCL',t:t+1000,p:123.1,dv:4,day_volume:104,recv_at:t+1200});

let rows=s.db.prepare('select * from market_events order by market_at_ms').all();
assert.equal(rows.length,2);
assert.equal(rows[1].prev_market_at_ms,t);
assert.equal(rows[1].delta_t_ms,1000);
assert.ok(Math.abs(rows[1].return_bps-Math.log(123.1/123)*10000)<1e-9);
assert.equal(rows[0].received_at_ms,t+200); // first actionable observation stays canonical
assert.equal(rows[0].price,123);
assert.equal(s.db.prepare('select count(*) n from transport_observations').get().n,2);

const p={id:'v6-1-'+t,version:'yahoo-monetary-dt-v6-r2',horizon_minutes:1,entry_market_ms:t,entry_market_at:new Date(t).toISOString(),
  entry_received_at:new Date(t+200).toISOString(),target_at:new Date(t+60000).toISOString(),entry_price:123,structural_dir:1,structural_score:.2,
  learned_dir:1,p_up:.6,confidence:.2,model_n:10,barrier_bps:5,assumed_roundtrip_cost_bps:2,gate_sample:true,clock:'market_event_time',
  input_contract:'observed_market_events_only',feature_names:['self5','coverage'],feature_vector:[.1,.9],feature_summary:{x:1},
  evaluation_contract:'market_event_time_true_dt_no_synthetic_samples_v3'};
persistPrediction(s,p);persistPrediction(s,p);
let pr=s.db.prepare('select * from predictions').get();
assert.equal(JSON.parse(pr.feature_names_json)[0],'self5');
assert.equal(pr.clock,'market_event_time');
assert.equal(pr.input_contract,'observed_market_events_only');
assert.equal(pr.contract_text,V6_CONTRACT_TEXT);
const contract=JSON.parse(pr.contract_json);
assert.equal(contract.contract_version,V6_CONTRACT_ID);
assert.deepEqual(contract.feature_names,p.feature_names);
assert.deepEqual(contract.feature_vector,p.feature_vector);

persistOutcome(s,{...p,status:'evaluated',endpoint_market_at:new Date(t+60000).toISOString(),endpoint_received_at:new Date(t+60250).toISOString(),
 endpoint_price:124,endpoint_return_bps:20,timing_error_ms:0,barrier_label:1,barrier_hit:true,barrier_at:new Date(t+30000).toISOString(),
 last_before_target_at:new Date(t+59000).toISOString(),mfe_bps:25,mae_bps:-3,structural_gross_bps:5,structural_net_bps:3,
 structural_profitable:true,learned_gross_bps:5,learned_net_bps:3,learned_profitable:true,path_label:1});
const out=s.db.prepare('select * from outcomes').get();
assert.equal(out.structural_net_bps,3);
assert.equal(out.learned_net_bps,3);
assert.equal(out.learned_profitable,1);
assert.equal(out.barrier_hit,1);
assert.equal(out.last_before_target_at_ms,t+59000);
assert.equal(out.path_label,1);

persistEvidence(s,{evidence_key:'source:test',kind:'source_event',approach_version:'source-event-v1',symbol:'ORCL',event_at_ms:t,payload:{headline:'x'}});
persistEvidence(s,{evidence_key:'source:test',kind:'source_event',approach_version:'source-event-v1',symbol:'ORCL',event_at_ms:t,payload:{headline:'x'}});
persistExperiment(s,{approach_version:'yahoo-monetary-dt-v6-r2',status:'collecting',config:{clock:'market_event_time'}});

const st=storeStats(s);
assert.deepEqual({events:st.events,transport:st.transport,predictions:st.predictions,outcomes:st.outcomes,evidence:st.evidence,experiments:st.experiments},{events:2,transport:2,predictions:1,outcomes:1,evidence:1,experiments:1});

console.log('SQLITE_V6_OK',JSON.stringify(st));
s.db.close();
for(const x of [file,file+'-wal',file+'-shm'])try{fs.unlinkSync(x)}catch{}
