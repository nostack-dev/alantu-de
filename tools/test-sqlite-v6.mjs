import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {openMarketStore,persistObservation,persistPrediction,persistOutcome,storeStats,V6_CONTRACT_ID,V6_CONTRACT_TEXT} from '../market-relay/sqlite-store.mjs';
const file=path.join(os.tmpdir(),'alantu-sqlite-test-'+Date.now()+'.sqlite');const s=openMarketStore(file);
const t=Date.parse('2026-09-25T14:00:00Z');
persistObservation(s,{s:'ORCL',t,p:123,dv:10,day_volume:100,recv_at:t+200});
persistObservation(s,{s:'ORCL',t,p:123,dv:10,day_volume:100,recv_at:t+900});
persistObservation(s,{s:'ORCL',t:t+1000,p:123.1,dv:4,day_volume:104,recv_at:t+1200});
const p={id:'v6-1-'+t,version:'yahoo-monetary-dt-v6',horizon_minutes:1,entry_market_ms:t,entry_market_at:new Date(t).toISOString(),entry_received_at:new Date(t+200).toISOString(),target_at:new Date(t+60000).toISOString(),entry_price:123,structural_dir:1,structural_score:.2,learned_dir:1,p_up:.6,confidence:.2,model_n:10,barrier_bps:5,assumed_roundtrip_cost_bps:2,gate_sample:true,feature_vector:[1,2],feature_summary:{x:1},evaluation_contract:'market_event_time_true_dt_no_synthetic_samples_v2'};
persistPrediction(s,p);persistPrediction(s,p);
persistOutcome(s,{...p,status:'invalid',reason:'target_price_unavailable'});
const st=storeStats(s);if(st.events!==2)throw new Error('duplicate market sample stored '+JSON.stringify(st));if(st.predictions!==1)throw new Error('duplicate prediction stored '+JSON.stringify(st));if(st.outcomes!==1)throw new Error('outcome missing '+JSON.stringify(st));
const row=s.db.prepare('select contract_text,contract_json from predictions').get();if(row.contract_text!==V6_CONTRACT_TEXT||!row.contract_json.includes(V6_CONTRACT_ID))throw new Error('contract not persisted');
console.log('SQLITE_V6_OK',JSON.stringify(st));s.db.close();for(const x of [file,file+'-wal',file+'-shm'])try{fs.unlinkSync(x)}catch{}
