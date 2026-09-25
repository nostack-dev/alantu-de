import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_PATH=process.env.ALANTU_SQLITE_PATH||'/data/alantu/alantu-market.sqlite';
export const V6_CONTRACT_ID='market_event_time_true_dt_no_synthetic_samples_v2';
export const V6_CONTRACT_TEXT=[
  'V6 prediction data contract.',
  'Observation identity is (source, symbol, market_event_time_ms).',
  'Only strictly newer exchange/market event timestamps create samples; same-timestamp transport repeats are UPSERT metadata, never new evidence; older/out-of-order events are rejected from the ordered model stream.',
  'dt_ms is market_event_time_ms(current)-market_event_time_ms(previous) for the same symbol/source. Poll time and receiver time are not market dt and are diagnostic only.',
  'Missing intervals remain gaps: no synthetic flat samples, forward fill, interpolation, or duplicated zero returns.',
  'Model features use observed price/volume/market-event timing only; transport latency is excluded from the feature vector.',
  'A prediction is created at a unique observed ORCL market event timestamp, once per horizon, and target time is entry market time + horizon.',
  'Predicted points never become observations or model features.',
  'Evaluation uses later real ORCL observations only. If no real endpoint is sufficiently close to target under the evaluator tolerance, outcome is invalid rather than interpolated.',
  'Training consumes evaluated real outcomes only; predictions are retained separately for audit.',
  'All persisted timestamps are UTC epoch milliseconds plus ISO UTC renderings where useful.'
].join(' ');

function ensureDir(file){fs.mkdirSync(path.dirname(file),{recursive:true});}
export function openMarketStore(file=DEFAULT_PATH){
  ensureDir(file);
  const db=new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;

    CREATE TABLE IF NOT EXISTS data_contracts(
      contract_id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      contract_text TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_observations(
      source TEXT NOT NULL,
      symbol TEXT NOT NULL,
      market_event_time_ms INTEGER NOT NULL,
      market_event_time_utc TEXT NOT NULL,
      received_at_ms INTEGER,
      received_at_utc TEXT,
      price REAL NOT NULL,
      day_volume REAL,
      delta_volume REAL,
      dt_ms INTEGER,
      previous_price REAL,
      return_bps REAL,
      contract_id TEXT NOT NULL,
      raw_json TEXT,
      inserted_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(source,symbol,market_event_time_ms),
      FOREIGN KEY(contract_id) REFERENCES data_contracts(contract_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_market_obs_symbol_time ON market_observations(symbol,market_event_time_ms);

    CREATE TABLE IF NOT EXISTS predictions(
      prediction_id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      horizon_minutes INTEGER NOT NULL,
      entry_market_time_ms INTEGER NOT NULL,
      target_market_time_ms INTEGER NOT NULL,
      entry_received_at_ms INTEGER,
      entry_price REAL NOT NULL,
      structural_dir INTEGER,
      structural_score REAL,
      learned_dir INTEGER,
      p_up REAL,
      confidence REAL,
      barrier_bps REAL,
      model_n INTEGER,
      model_ready INTEGER NOT NULL DEFAULT 0,
      gate_sample INTEGER NOT NULL DEFAULT 0,
      feature_vector_json TEXT NOT NULL,
      feature_summary_json TEXT,
      created_at_ms INTEGER NOT NULL,
      raw_json TEXT,
      UNIQUE(model_version,symbol,horizon_minutes,entry_market_time_ms),
      FOREIGN KEY(contract_id) REFERENCES data_contracts(contract_id)
    );
    CREATE INDEX IF NOT EXISTS idx_predictions_entry ON predictions(entry_market_time_ms);

    CREATE TABLE IF NOT EXISTS prediction_outcomes(
      prediction_id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      horizon_minutes INTEGER NOT NULL,
      entry_market_time_ms INTEGER NOT NULL,
      target_market_time_ms INTEGER NOT NULL,
      endpoint_market_time_ms INTEGER,
      endpoint_received_at_ms INTEGER,
      endpoint_price REAL,
      endpoint_return_bps REAL,
      timing_error_ms INTEGER,
      barrier_label INTEGER,
      barrier_at_ms INTEGER,
      mfe_bps REAL,
      mae_bps REAL,
      structural_net_bps REAL,
      learned_net_bps REAL,
      status TEXT NOT NULL,
      reason TEXT,
      evaluated_at_ms INTEGER NOT NULL,
      raw_json TEXT,
      FOREIGN KEY(prediction_id) REFERENCES predictions(prediction_id),
      FOREIGN KEY(contract_id) REFERENCES data_contracts(contract_id)
    );

    CREATE TABLE IF NOT EXISTS runtime_snapshots(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      model_version TEXT,
      contract_id TEXT,
      asof_market_time_ms INTEGER,
      computed_at_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_kind_time ON runtime_snapshots(kind,computed_at_ms);
  `);
  db.prepare(`INSERT INTO data_contracts(contract_id,model_version,contract_text,created_at_ms)
    VALUES(?,?,?,?) ON CONFLICT(contract_id) DO UPDATE SET model_version=excluded.model_version,contract_text=excluded.contract_text`)
    .run(V6_CONTRACT_ID,'yahoo-monetary-dt-v6',V6_CONTRACT_TEXT,Date.now());
  return db;
}
export function persistObservation(db,e,previous=null){
  const t=Number(e?.t),p=Number(e?.p),r=Number(e?.recv_at),dv=Number(e?.dv),day=Number(e?.day_volume);
  if(!e?.s||!Number.isFinite(t)||!(p>0))return;
  const pt=Number(previous?.t),pp=Number(previous?.p);
  const dt=Number.isFinite(pt)&&t>pt?t-pt:null;
  const ret=pp>0?(p/pp-1)*10000:null;
  db.prepare(`INSERT INTO market_observations(source,symbol,market_event_time_ms,market_event_time_utc,received_at_ms,received_at_utc,price,day_volume,delta_volume,dt_ms,previous_price,return_bps,contract_id,raw_json,inserted_at_ms,updated_at_ms)
    VALUES('yahoo',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source,symbol,market_event_time_ms) DO UPDATE SET
      received_at_ms=excluded.received_at_ms,received_at_utc=excluded.received_at_utc,price=excluded.price,
      day_volume=MAX(COALESCE(market_observations.day_volume,0),COALESCE(excluded.day_volume,0)),
      delta_volume=MAX(COALESCE(market_observations.delta_volume,0),COALESCE(excluded.delta_volume,0)),
      raw_json=excluded.raw_json,updated_at_ms=excluded.updated_at_ms`)
    .run(String(e.s),t,new Date(t).toISOString(),Number.isFinite(r)?r:null,Number.isFinite(r)?new Date(r).toISOString():null,p,
      Number.isFinite(day)?day:null,Number.isFinite(dv)?dv:null,dt,pp>0?pp:null,Number.isFinite(ret)?ret:null,V6_CONTRACT_ID,JSON.stringify(e),Date.now(),Date.now());
}
export function persistPrediction(db,p){
  const entry=Number(p.entry_market_ms??Date.parse(p.entry_market_at||p.at)),target=Date.parse(p.target_at);
  if(!p?.id||!Number.isFinite(entry)||!Number.isFinite(target))return;
  db.prepare(`INSERT INTO predictions(prediction_id,model_version,contract_id,symbol,horizon_minutes,entry_market_time_ms,target_market_time_ms,entry_received_at_ms,entry_price,structural_dir,structural_score,learned_dir,p_up,confidence,barrier_bps,model_n,model_ready,gate_sample,feature_vector_json,feature_summary_json,created_at_ms,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(prediction_id) DO UPDATE SET raw_json=excluded.raw_json,feature_summary_json=excluded.feature_summary_json`)
    .run(p.id,p.version,V6_CONTRACT_ID,'ORCL',Number(p.horizon_minutes),entry,target,Date.parse(p.entry_received_at||'' )||null,Number(p.entry_price),
      p.structural_dir??null,p.structural_score??null,p.learned_dir??null,p.p_up??null,p.confidence??null,p.barrier_bps??null,p.model_n??null,p.model_ready?1:0,p.gate_sample?1:0,
      JSON.stringify(p.feature_vector||[]),JSON.stringify(p.feature_summary||{}),Date.now(),JSON.stringify(p));
}
export function persistOutcome(db,o){
  if(!o?.id)return;
  const entry=Number(o.entry_market_ms??Date.parse(o.entry_market_at||o.at)),target=Date.parse(o.target_at||''),end=Date.parse(o.endpoint_market_at||o.endpoint_at||'');
  db.prepare(`INSERT INTO prediction_outcomes(prediction_id,model_version,contract_id,horizon_minutes,entry_market_time_ms,target_market_time_ms,endpoint_market_time_ms,endpoint_received_at_ms,endpoint_price,endpoint_return_bps,timing_error_ms,barrier_label,barrier_at_ms,mfe_bps,mae_bps,structural_net_bps,learned_net_bps,status,reason,evaluated_at_ms,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(prediction_id) DO UPDATE SET endpoint_market_time_ms=excluded.endpoint_market_time_ms,endpoint_received_at_ms=excluded.endpoint_received_at_ms,endpoint_price=excluded.endpoint_price,endpoint_return_bps=excluded.endpoint_return_bps,timing_error_ms=excluded.timing_error_ms,barrier_label=excluded.barrier_label,barrier_at_ms=excluded.barrier_at_ms,mfe_bps=excluded.mfe_bps,mae_bps=excluded.mae_bps,structural_net_bps=excluded.structural_net_bps,learned_net_bps=excluded.learned_net_bps,status=excluded.status,reason=excluded.reason,evaluated_at_ms=excluded.evaluated_at_ms,raw_json=excluded.raw_json`)
    .run(o.id,o.version,V6_CONTRACT_ID,Number(o.horizon_minutes),entry,Number.isFinite(target)?target:entry+Number(o.horizon_minutes)*60000,Number.isFinite(end)?end:null,Date.parse(o.endpoint_received_at||'')||null,
      o.endpoint_price??null,o.endpoint_return_bps??null,o.timing_error_ms??null,o.barrier_label??null,Date.parse(o.barrier_at||'')||null,o.mfe_bps??null,o.mae_bps??null,o.structural_net_bps??null,o.learned_net_bps??null,o.status||'unknown',o.reason||null,Date.now(),JSON.stringify(o));
}
export function persistSnapshot(db,kind,payload){
  const asof=Date.parse(payload?.asof||payload?.entry_market_at||'');
  db.prepare('INSERT INTO runtime_snapshots(kind,model_version,contract_id,asof_market_time_ms,computed_at_ms,payload_json) VALUES(?,?,?,?,?,?)')
    .run(kind,payload?.version||null,V6_CONTRACT_ID,Number.isFinite(asof)?asof:null,Date.now(),JSON.stringify(payload||{}));
}
export function storeStats(db){
  const one=t=>Number(db.prepare('SELECT COUNT(*) n FROM '+t).get().n);
  const last=db.prepare('SELECT MAX(market_event_time_ms) t FROM market_observations').get().t;
  return {path:DEFAULT_PATH,contract_id:V6_CONTRACT_ID,observations:one('market_observations'),predictions:one('predictions'),outcomes:one('prediction_outcomes'),snapshots:one('runtime_snapshots'),latest_market_event_ms:last||null,latest_market_event_at:last?new Date(Number(last)).toISOString():null};
}
