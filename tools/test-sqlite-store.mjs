import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from '../market-relay/node_modules/better-sqlite3/lib/index.js';

process.env.ALANTU_SQLITE_PATH='/tmp/alantu-migration-test.sqlite';
for(const x of [process.env.ALANTU_SQLITE_PATH,process.env.ALANTU_SQLITE_PATH+'-wal',process.env.ALANTU_SQLITE_PATH+'-shm'])try{fs.unlinkSync(x)}catch{}

// Simulate the already-live V6-v1 schema. Opening the new store must migrate in place without data loss.
{
  const old=new Database(process.env.ALANTU_SQLITE_PATH);
  old.exec(`
    CREATE TABLE contracts(contract_version TEXT PRIMARY KEY,contract_text TEXT NOT NULL,created_at_ms INTEGER NOT NULL);
    CREATE TABLE market_events(id INTEGER PRIMARY KEY,symbol TEXT NOT NULL,market_at_ms INTEGER NOT NULL,received_at_ms INTEGER,price REAL NOT NULL,day_volume REAL,delta_volume REAL,source TEXT NOT NULL DEFAULT 'yahoo',contract_version TEXT NOT NULL,raw_json TEXT,inserted_at_ms INTEGER NOT NULL,UNIQUE(symbol,market_at_ms));
    CREATE TABLE predictions(id TEXT PRIMARY KEY,model_version TEXT NOT NULL,horizon_minutes INTEGER NOT NULL,entry_market_at_ms INTEGER NOT NULL,entry_received_at_ms INTEGER,target_market_at_ms INTEGER NOT NULL,entry_price REAL NOT NULL,structural_dir INTEGER,structural_score REAL,learned_dir INTEGER,p_up REAL,confidence REAL,model_n INTEGER,barrier_bps REAL,assumed_roundtrip_cost_bps REAL,gate_sample INTEGER NOT NULL DEFAULT 0,feature_vector_json TEXT NOT NULL,feature_summary_json TEXT,evaluation_contract TEXT NOT NULL,contract_version TEXT NOT NULL,contract_text TEXT NOT NULL,contract_json TEXT NOT NULL,computed_at_ms INTEGER NOT NULL,UNIQUE(model_version,horizon_minutes,entry_market_at_ms));
    CREATE TABLE outcomes(prediction_id TEXT PRIMARY KEY REFERENCES predictions(id),status TEXT NOT NULL,reason TEXT,evaluated_at_ms INTEGER NOT NULL,endpoint_market_at_ms INTEGER,endpoint_received_at_ms INTEGER,endpoint_price REAL,endpoint_return_bps REAL,timing_error_ms INTEGER,barrier_label INTEGER,barrier_at_ms INTEGER,mfe_bps REAL,mae_bps REAL,net_return_bps REAL,correct INTEGER,raw_json TEXT NOT NULL);
  `);
  old.prepare("insert into market_events(symbol,market_at_ms,received_at_ms,price,day_volume,delta_volume,source,contract_version,raw_json,inserted_at_ms) values('ORCL',?,?,?,?,?,?,?,?,?)")
    .run(1000,1100,100,2000,40,'yahoo_streamer','alantu-v6-market-event-time-v2','{"provider":"yahoo_streamer"}',1200);
  old.close();
}

const {openMarketStore,persistObservation,persistPrediction,persistOutcome,loadRecentMarketEvents,storeStats,V6_CONTRACT_ID}=await import('../market-relay/sqlite-store.mjs');
const db=openMarketStore();
assert.equal(db.db.prepare('select count(*) n from market_events').get().n,1);
const migratedLegacy=db.db.prepare('select day_volume,delta_volume from market_events where market_at_ms=1000').get();
assert.equal(migratedLegacy.day_volume,1000);
assert.equal(migratedLegacy.delta_volume,null);
assert.equal(db.db.prepare("select count(*) n from store_migrations where migration_id='2026-09-yahoo-sint64-volume-v1'").get().n,1);
const eventCols=new Set(db.db.prepare('pragma table_info(market_events)').all().map(x=>x.name));
for(const c of ['prev_market_at_ms','delta_t_ms','return_bps','source_time_resolution_ms','market_day_ny','session_phase'])assert.ok(eventCols.has(c),c);
const predCols=new Set(db.db.prepare('pragma table_info(predictions)').all().map(x=>x.name));
for(const c of ['feature_names_json','clock','input_contract'])assert.ok(predCols.has(c),c);
const outcomeCols=new Set(db.db.prepare('pragma table_info(outcomes)').all().map(x=>x.name));
for(const c of ['learned_net_bps','structural_net_bps','barrier_hit','last_before_target_at_ms','path_label'])assert.ok(outcomeCols.has(c),c);

const t=2000;
persistObservation(db,{s:'ORCL',t,p:100.1,day_volume:1015,dv:15,recv_at:2200});
const row=db.db.prepare('select * from market_events where market_at_ms=?').get(t);
assert.equal(row.prev_market_at_ms,1000);
assert.equal(row.delta_t_ms,1000);
const recent=loadRecentMarketEvents(db,0);
assert.equal(recent.length,2);
assert.equal(recent[0].day_volume,1000);
assert.equal(recent[1].day_volume,1015);

const p={id:'migration-v6-'+t,version:'yahoo-monetary-dt-v6-r2',horizon_minutes:1,at:new Date(t).toISOString(),target_at:new Date(t+60000).toISOString(),
 entry_market_ms:t,entry_received_at:new Date(t+200).toISOString(),entry_price:100.1,structural_dir:1,structural_score:.2,learned_dir:1,p_up:.6,confidence:.2,
 barrier_bps:5,model_n:10,model_ready:true,gate_sample:true,feature_names:['a','b'],feature_vector:[1,2],feature_summary:{x:1},
 clock:'market_event_time',input_contract:'observed_market_events_only',evaluation_contract:'market_event_time_true_dt_no_synthetic_samples_v3'};
persistPrediction(db,p);
persistOutcome(db,{...p,status:'invalid',reason:'target_price_unavailable'});
assert.equal(db.db.prepare('select contract_version from predictions where id=?').get(p.id).contract_version,V6_CONTRACT_ID);
assert.equal(storeStats(db).events,2);
assert.equal(db.db.prepare("select count(*) n from sqlite_master where type='table' and name='transport_observations'").get().n,1);
console.log('SQLITE_MIGRATION_OK',storeStats(db));
db.db.close();
