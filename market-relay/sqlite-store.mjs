import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const V6_CONTRACT_ID='alantu-v6-market-event-time-v3';
export const V6_CONTRACT_TEXT=[
  'One canonical market sample = the first received observation for one distinct (symbol, market_at_ms); later frames with the same source timestamp are archived as transport observations but never become extra model samples.',
  'Yahoo source market timestamps have second-level semantics; received_at_ms and computed_at_ms may be millisecond precision but are transport/system clocks only.',
  'market_at_ms is the sole model clock. Missing source timestamps are rejected rather than replaced with wall-clock time.',
  'Older out-of-order observations are archived for diagnostics but rejected from the canonical causal series.',
  'Gaps remain gaps: no forward-fill, interpolation, synthetic zero-return, or poll-derived samples.',
  'For each canonical event, prev_market_at_ms is the preceding accepted market event for that symbol, delta_t_ms = market_at_ms - prev_market_at_ms, and return_bps = ln(price/prev_price)*10000.',
  'Source-provided cumulative day volume is decoded as protobuf sint64; delta volume is measured only between distinct canonical timestamps and is never initialized from zero after restart.',
  'Provider event cadence and network latency are diagnostics only and are excluded from predictive features.',
  'Predictions train only on prospective non-overlapping gate samples; the training path label is the first barrier direction, or endpoint direction if no barrier was hit.',
  'Predictions use only observed canonical events at or before entry_market_at_ms. Predicted points never become market inputs.',
  'Each prediction stores model version, model clock, feature names, feature vector, feature summary, horizon, barrier, cost assumption and evaluation contract.',
  'Outcomes use only later observed market events. If no acceptable real endpoint exists near target time, the outcome is invalid rather than invented.',
  'Evidence from auxiliary approaches is stored separately and may not silently enter V6 features.',
  'The contract_json column is the machine-readable immutable recipe for reproducing each prediction.'
].join(' ');

function addColumn(db,table,def){
  const name=def.trim().split(/\s+/)[0];
  const cols=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
  if(!cols.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function bool(v){return v==null?null:(v?1:0);}
function ms(v){const n=typeof v==='number'?v:Date.parse(v||'');return Number.isFinite(n)?n:null;}

export function openMarketStore(file=process.env.ALANTU_SQLITE_PATH||'/data/alantu-market.sqlite'){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts(
      contract_version TEXT PRIMARY KEY,
      contract_text TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_events(
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      market_at_ms INTEGER NOT NULL,
      received_at_ms INTEGER,
      price REAL NOT NULL,
      day_volume REAL,
      delta_volume REAL,
      source TEXT NOT NULL DEFAULT 'yahoo',
      contract_version TEXT NOT NULL,
      raw_json TEXT,
      inserted_at_ms INTEGER NOT NULL,
      UNIQUE(symbol,market_at_ms)
    );
    CREATE INDEX IF NOT EXISTS market_events_symbol_time ON market_events(symbol,market_at_ms);

    CREATE TABLE IF NOT EXISTS predictions(
      id TEXT PRIMARY KEY,
      model_version TEXT NOT NULL,
      horizon_minutes INTEGER NOT NULL,
      entry_market_at_ms INTEGER NOT NULL,
      entry_received_at_ms INTEGER,
      target_market_at_ms INTEGER NOT NULL,
      entry_price REAL NOT NULL,
      structural_dir INTEGER,
      structural_score REAL,
      learned_dir INTEGER,
      p_up REAL,
      confidence REAL,
      model_n INTEGER,
      barrier_bps REAL,
      assumed_roundtrip_cost_bps REAL,
      gate_sample INTEGER NOT NULL DEFAULT 0,
      feature_vector_json TEXT NOT NULL,
      feature_summary_json TEXT,
      evaluation_contract TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      contract_text TEXT NOT NULL,
      contract_json TEXT NOT NULL,
      computed_at_ms INTEGER NOT NULL,
      UNIQUE(model_version,horizon_minutes,entry_market_at_ms)
    );
    CREATE INDEX IF NOT EXISTS predictions_entry_time ON predictions(entry_market_at_ms);

    CREATE TABLE IF NOT EXISTS outcomes(
      prediction_id TEXT PRIMARY KEY REFERENCES predictions(id),
      status TEXT NOT NULL,
      reason TEXT,
      evaluated_at_ms INTEGER NOT NULL,
      endpoint_market_at_ms INTEGER,
      endpoint_received_at_ms INTEGER,
      endpoint_price REAL,
      endpoint_return_bps REAL,
      timing_error_ms INTEGER,
      barrier_label INTEGER,
      barrier_at_ms INTEGER,
      mfe_bps REAL,
      mae_bps REAL,
      net_return_bps REAL,
      correct INTEGER,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transport_observations(
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      market_at_ms INTEGER,
      received_at_ms INTEGER NOT NULL,
      price REAL,
      day_volume REAL,
      source TEXT NOT NULL,
      accepted_canonical INTEGER NOT NULL DEFAULT 0,
      reject_reason TEXT,
      raw_json TEXT NOT NULL,
      inserted_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transport_symbol_market ON transport_observations(symbol,market_at_ms);
    CREATE INDEX IF NOT EXISTS transport_received ON transport_observations(received_at_ms);

    CREATE TABLE IF NOT EXISTS evidence_events(
      evidence_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      approach_version TEXT NOT NULL,
      symbol TEXT,
      event_at_ms INTEGER NOT NULL,
      received_at_ms INTEGER,
      contract_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      inserted_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evidence_events_kind_time ON evidence_events(kind,event_at_ms);

    CREATE TABLE IF NOT EXISTS experiment_runs(
      approach_version TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      config_json TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);

  addColumn(db,'market_events','prev_market_at_ms INTEGER');
  addColumn(db,'market_events','delta_t_ms INTEGER');
  addColumn(db,'market_events','return_bps REAL');
  addColumn(db,'market_events','source_time_resolution_ms INTEGER');
  addColumn(db,'market_events','market_day_ny TEXT');
  addColumn(db,'market_events','session_phase TEXT');
  addColumn(db,'predictions','feature_names_json TEXT');
  addColumn(db,'predictions',"clock TEXT");
  addColumn(db,'predictions',"input_contract TEXT");
  addColumn(db,'outcomes','barrier_hit INTEGER');
  addColumn(db,'outcomes','last_before_target_at_ms INTEGER');
  addColumn(db,'outcomes','structural_gross_bps REAL');
  addColumn(db,'outcomes','structural_net_bps REAL');
  addColumn(db,'outcomes','structural_profitable INTEGER');
  addColumn(db,'outcomes','learned_gross_bps REAL');
  addColumn(db,'outcomes','learned_net_bps REAL');
  addColumn(db,'outcomes','learned_profitable INTEGER');
  addColumn(db,'outcomes','path_label INTEGER');

  db.prepare('INSERT OR IGNORE INTO contracts(contract_version,contract_text,created_at_ms) VALUES(?,?,?)')
    .run(V6_CONTRACT_ID,V6_CONTRACT_TEXT,Date.now());

  const exactEvent=db.prepare('SELECT id,market_at_ms,price FROM market_events WHERE symbol=? AND market_at_ms=?');
  const previousEvent=db.prepare('SELECT market_at_ms,price FROM market_events WHERE symbol=? AND market_at_ms<? ORDER BY market_at_ms DESC LIMIT 1');
  const latestEvent=db.prepare('SELECT market_at_ms FROM market_events WHERE symbol=? ORDER BY market_at_ms DESC LIMIT 1');
  const insertEvent=db.prepare(`
    INSERT INTO market_events(symbol,market_at_ms,received_at_ms,price,day_volume,delta_volume,source,contract_version,raw_json,inserted_at_ms,prev_market_at_ms,delta_t_ms,return_bps,source_time_resolution_ms,market_day_ny,session_phase)
    VALUES(@symbol,@market_at_ms,@received_at_ms,@price,@day_volume,@delta_volume,@source,@contract_version,@raw_json,@inserted_at_ms,@prev_market_at_ms,@delta_t_ms,@return_bps,@source_time_resolution_ms,@market_day_ny,@session_phase)
  `);

  const pred=db.prepare(`
    INSERT OR IGNORE INTO predictions(
      id,model_version,horizon_minutes,entry_market_at_ms,entry_received_at_ms,target_market_at_ms,entry_price,
      structural_dir,structural_score,learned_dir,p_up,confidence,model_n,barrier_bps,assumed_roundtrip_cost_bps,gate_sample,
      feature_vector_json,feature_summary_json,evaluation_contract,contract_version,contract_text,contract_json,computed_at_ms,
      feature_names_json,clock,input_contract
    ) VALUES(
      @id,@model_version,@horizon_minutes,@entry_market_at_ms,@entry_received_at_ms,@target_market_at_ms,@entry_price,
      @structural_dir,@structural_score,@learned_dir,@p_up,@confidence,@model_n,@barrier_bps,@assumed_roundtrip_cost_bps,@gate_sample,
      @feature_vector_json,@feature_summary_json,@evaluation_contract,@contract_version,@contract_text,@contract_json,@computed_at_ms,
      @feature_names_json,@clock,@input_contract
    )
  `);

  const outcome=db.prepare(`
    INSERT INTO outcomes(
      prediction_id,status,reason,evaluated_at_ms,endpoint_market_at_ms,endpoint_received_at_ms,endpoint_price,endpoint_return_bps,
      timing_error_ms,barrier_label,barrier_at_ms,mfe_bps,mae_bps,net_return_bps,correct,raw_json,barrier_hit,last_before_target_at_ms,
      structural_gross_bps,structural_net_bps,structural_profitable,learned_gross_bps,learned_net_bps,learned_profitable,path_label
    ) VALUES(
      @prediction_id,@status,@reason,@evaluated_at_ms,@endpoint_market_at_ms,@endpoint_received_at_ms,@endpoint_price,@endpoint_return_bps,
      @timing_error_ms,@barrier_label,@barrier_at_ms,@mfe_bps,@mae_bps,@net_return_bps,@correct,@raw_json,@barrier_hit,@last_before_target_at_ms,
      @structural_gross_bps,@structural_net_bps,@structural_profitable,@learned_gross_bps,@learned_net_bps,@learned_profitable,@path_label
    )
    ON CONFLICT(prediction_id) DO UPDATE SET
      status=excluded.status,reason=excluded.reason,evaluated_at_ms=excluded.evaluated_at_ms,
      endpoint_market_at_ms=excluded.endpoint_market_at_ms,endpoint_received_at_ms=excluded.endpoint_received_at_ms,
      endpoint_price=excluded.endpoint_price,endpoint_return_bps=excluded.endpoint_return_bps,timing_error_ms=excluded.timing_error_ms,
      barrier_label=excluded.barrier_label,barrier_at_ms=excluded.barrier_at_ms,mfe_bps=excluded.mfe_bps,mae_bps=excluded.mae_bps,
      net_return_bps=excluded.net_return_bps,correct=excluded.correct,raw_json=excluded.raw_json,barrier_hit=excluded.barrier_hit,
      last_before_target_at_ms=excluded.last_before_target_at_ms,structural_gross_bps=excluded.structural_gross_bps,
      structural_net_bps=excluded.structural_net_bps,structural_profitable=excluded.structural_profitable,
      learned_gross_bps=excluded.learned_gross_bps,learned_net_bps=excluded.learned_net_bps,learned_profitable=excluded.learned_profitable,
      path_label=excluded.path_label
  `);

  const transport=db.prepare(`
    INSERT INTO transport_observations(symbol,market_at_ms,received_at_ms,price,day_volume,source,accepted_canonical,reject_reason,raw_json,inserted_at_ms)
    VALUES(@symbol,@market_at_ms,@received_at_ms,@price,@day_volume,@source,@accepted_canonical,@reject_reason,@raw_json,@inserted_at_ms)
  `);
    const evidence=db.prepare(`
    INSERT OR IGNORE INTO evidence_events(evidence_key,kind,approach_version,symbol,event_at_ms,received_at_ms,contract_version,payload_json,inserted_at_ms)
    VALUES(@evidence_key,@kind,@approach_version,@symbol,@event_at_ms,@received_at_ms,@contract_version,@payload_json,@inserted_at_ms)
  `);
  const experiment=db.prepare(`
    INSERT INTO experiment_runs(approach_version,status,contract_version,config_json,started_at_ms,updated_at_ms)
    VALUES(@approach_version,@status,@contract_version,@config_json,@started_at_ms,@updated_at_ms)
    ON CONFLICT(approach_version) DO UPDATE SET status=excluded.status,contract_version=excluded.contract_version,config_json=excluded.config_json,updated_at_ms=excluded.updated_at_ms
  `);

  const NY_FMT=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  function marketMeta(t){
    const o={};for(const p of NY_FMT.formatToParts(new Date(t)))if(p.type!=='literal')o[p.type]=p.value;
    const minute=Number(o.hour)*60+Number(o.minute);
    return {market_day_ny:o.year+'-'+o.month+'-'+o.day,session_phase:minute<240?'overnight':minute<570?'premarket':minute<960?'regular':'afterhours'};
  }
  const api={db,file,
    recordEvent(e){
      const symbol=String(e?.s||'').toUpperCase(),marketAt=num(e?.t),price=num(e?.p);
      if(!symbol||!(marketAt>0)||!(price>0))return {stored:false,reason:'invalid_event'};
      const receivedAt=num(e?.recv_at),dayVolume=num(e?.day_volume),deltaVolume=num(e?.dv);
      const exact=exactEvent.get(symbol,marketAt);
      if(exact)return {stored:false,reason:'duplicate_timestamp'};
      const latest=latestEvent.get(symbol);
      if(latest&&marketAt<Number(latest.market_at_ms))return {stored:false,reason:'out_of_order'};
      const prev=previousEvent.get(symbol,marketAt);
      const prevAt=prev?Number(prev.market_at_ms):null,prevPrice=prev?Number(prev.price):null;
      const dt=prevAt==null?null:marketAt-prevAt;
      const ret=prevPrice>0?Math.log(price/prevPrice)*10000:null;
      const meta=marketMeta(marketAt);
      insertEvent.run({symbol,market_at_ms:marketAt,received_at_ms:receivedAt,price,day_volume:dayVolume,delta_volume:deltaVolume,
        source:e.source||e.provider||'yahoo',contract_version:V6_CONTRACT_ID,raw_json:JSON.stringify(e),inserted_at_ms:Date.now(),
        prev_market_at_ms:prevAt,delta_t_ms:dt,return_bps:ret,source_time_resolution_ms:1000,market_day_ny:meta.market_day_ny,session_phase:meta.session_phase});
      return {stored:true,prev_market_at_ms:prevAt,delta_t_ms:dt,return_bps:ret};
    },
    recordTransport(e,{accepted=false,reason=null}={}){
      const symbol=String(e?.s||e?.id||'').toUpperCase(),receivedAt=num(e?.recv_at)||Date.now(),marketAt=num(e?.t),price=num(e?.p??e?.price),dayVolume=num(e?.day_volume??e?.dayVolume);
      if(!symbol)return;
      transport.run({symbol,market_at_ms:marketAt,received_at_ms:receivedAt,price,day_volume:dayVolume,source:e?.source||e?.provider||'yahoo_streamer',
        accepted_canonical:accepted?1:0,reject_reason:reason,raw_json:JSON.stringify(e),inserted_at_ms:Date.now()});
    },
    recordPrediction(p){
      const em=num(p.entry_market_ms)||ms(p.entry_market_at)||ms(p.at),tm=ms(p.target_at),er=ms(p.entry_received_at);
      if(!(em>0)||!(tm>0)||!(Number(p.entry_price)>0))throw new Error('invalid_prediction_contract');
      const featureNames=Array.isArray(p.feature_names)?p.feature_names:[];
      const cj={contract_version:V6_CONTRACT_ID,contract_text:V6_CONTRACT_TEXT,model_version:p.version,horizon_minutes:p.horizon_minutes,
        clock:p.clock||'market_event_time',input_contract:p.input_contract||'observed_market_events_only',
        entry_market_at_ms:em,target_market_at_ms:tm,feature_names:featureNames,feature_vector:p.feature_vector||[],
        feature_summary:p.feature_summary||{},barrier_bps:p.barrier_bps,assumed_roundtrip_cost_bps:p.assumed_roundtrip_cost_bps,
        evaluation_contract:p.evaluation_contract};
      pred.run({id:p.id,model_version:p.version,horizon_minutes:p.horizon_minutes,entry_market_at_ms:em,entry_received_at_ms:er,
        target_market_at_ms:tm,entry_price:p.entry_price,structural_dir:p.structural_dir??null,structural_score:p.structural_score??null,
        learned_dir:p.learned_dir??null,p_up:p.p_up??null,confidence:p.confidence??null,model_n:p.model_n??null,barrier_bps:p.barrier_bps??null,
        assumed_roundtrip_cost_bps:p.assumed_roundtrip_cost_bps??null,gate_sample:p.gate_sample?1:0,
        feature_vector_json:JSON.stringify(p.feature_vector||[]),feature_summary_json:JSON.stringify(p.feature_summary||{}),
        evaluation_contract:p.evaluation_contract,contract_version:V6_CONTRACT_ID,contract_text:V6_CONTRACT_TEXT,
        contract_json:JSON.stringify(cj),computed_at_ms:Date.now(),feature_names_json:JSON.stringify(featureNames),
        clock:p.clock||'market_event_time',input_contract:p.input_contract||'observed_market_events_only'});
      return {stored:true};
    },
    recordOutcome(o){
      if(!db.prepare('SELECT 1 FROM predictions WHERE id=?').get(o.id))api.recordPrediction(o);
      const pm=ms(o.endpoint_market_at||o.endpoint_at),pr=ms(o.endpoint_received_at),ba=ms(o.barrier_at),lb=ms(o.last_before_target_at);
      outcome.run({prediction_id:o.id,status:o.status,reason:o.reason||null,evaluated_at_ms:Date.now(),endpoint_market_at_ms:pm,
        endpoint_received_at_ms:pr,endpoint_price:o.endpoint_price??null,endpoint_return_bps:o.endpoint_return_bps??null,
        timing_error_ms:o.timing_error_ms??null,barrier_label:o.barrier_label??null,barrier_at_ms:ba,mfe_bps:o.mfe_bps??null,
        mae_bps:o.mae_bps??null,net_return_bps:o.learned_net_bps??o.net_return_bps??null,
        correct:o.learned_profitable==null?(o.correct==null?null:bool(o.correct)):bool(o.learned_profitable),
        raw_json:JSON.stringify(o),barrier_hit:bool(o.barrier_hit),last_before_target_at_ms:lb,
        structural_gross_bps:o.structural_gross_bps??null,structural_net_bps:o.structural_net_bps??null,
        structural_profitable:bool(o.structural_profitable),learned_gross_bps:o.learned_gross_bps??null,
        learned_net_bps:o.learned_net_bps??null,learned_profitable:bool(o.learned_profitable),path_label:o.path_label??null});
      return {stored:true};
    },
    recordEvidence(e){
      const eventAt=num(e?.event_at_ms)||ms(e?.event_at)||Date.now();
      const approach=String(e?.approach_version||'unknown'),kind=String(e?.kind||'evidence'),symbol=e?.symbol?String(e.symbol).toUpperCase():null;
      const key=String(e?.evidence_key||[kind,approach,symbol||'',eventAt].join(':'));
      evidence.run({evidence_key:key,kind,approach_version:approach,symbol,event_at_ms:eventAt,received_at_ms:num(e?.received_at_ms),
        contract_version:V6_CONTRACT_ID,payload_json:JSON.stringify(e?.payload??e),inserted_at_ms:Date.now()});
    },
    recordExperiment(x){
      const now=Date.now(),started=num(x?.started_at_ms)||now;
      experiment.run({approach_version:String(x.approach_version),status:String(x.status||'collecting'),contract_version:V6_CONTRACT_ID,
        config_json:JSON.stringify(x.config||{}),started_at_ms:started,updated_at_ms:now});
    },
    loadModelState(modelVersion){
      const pending=db.prepare(`SELECT p.* FROM predictions p LEFT JOIN outcomes o ON o.prediction_id=p.id WHERE p.model_version=? AND o.prediction_id IS NULL ORDER BY p.entry_market_at_ms`).all(modelVersion)
        .map(r=>({id:r.id,version:r.model_version,horizon_minutes:r.horizon_minutes,at:new Date(r.entry_market_at_ms).toISOString(),target_at:new Date(r.target_market_at_ms).toISOString(),
          entry_price:r.entry_price,entry_market_ms:r.entry_market_at_ms,entry_market_at:new Date(r.entry_market_at_ms).toISOString(),entry_received_at:r.entry_received_at_ms?new Date(r.entry_received_at_ms).toISOString():null,
          structural_dir:r.structural_dir,structural_score:r.structural_score,learned_dir:r.learned_dir,p_up:r.p_up,confidence:r.confidence,model_n:r.model_n,barrier_bps:r.barrier_bps,
          assumed_roundtrip_cost_bps:r.assumed_roundtrip_cost_bps,gate_sample:r.gate_sample===1,feature_names:JSON.parse(r.feature_names_json||'[]'),feature_vector:JSON.parse(r.feature_vector_json||'[]'),
          feature_summary:JSON.parse(r.feature_summary_json||'{}'),clock:r.clock,input_contract:r.input_contract,evaluation_contract:r.evaluation_contract}));
      const outcomes=db.prepare(`SELECT o.raw_json FROM outcomes o JOIN predictions p ON p.id=o.prediction_id WHERE p.model_version=? ORDER BY p.entry_market_at_ms`).all(modelVersion)
        .map(r=>{try{return JSON.parse(r.raw_json);}catch{return null;}}).filter(Boolean);
      return {predictions:pending,outcomes};
    },
    stats(){
      const q=t=>db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
      return {file,contract_version:V6_CONTRACT_ID,events:q('market_events'),transport:q('transport_observations'),predictions:q('predictions'),outcomes:q('outcomes'),
        evidence:q('evidence_events'),experiments:q('experiment_runs')};
    }
  };
  return api;
}
export function persistObservation(store,e){return store.recordEvent(e);}
export function persistTransportObservation(store,e,meta){return store.recordTransport(e,meta);}
export function persistPrediction(store,p){return store.recordPrediction(p);}
export function persistOutcome(store,o){return store.recordOutcome(o);}
export function persistEvidence(store,e){return store.recordEvidence(e);}
export function persistExperiment(store,e){return store.recordExperiment(e);}
export function loadModelState(store,version){return store.loadModelState(version);}
export function storeStats(store){return store.stats();}
