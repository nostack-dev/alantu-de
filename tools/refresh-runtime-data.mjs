import fs from 'node:fs/promises';

const BERLIN='Europe/Berlin';
const SOURCE_STATE_URL=process.env.ALANTU_SOURCE_STATE_URL||'https://alantu-market-production.up.railway.app/v1/source-state';

function nowIsoBerlin(){
  const d=new Date(),parts=new Intl.DateTimeFormat('en-CA',{timeZone:BERLIN,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d);
  const x=Object.fromEntries(parts.map(p=>[p.type,p.value])),utc=d.getTime(),asBerlin=Date.UTC(+x.year,+x.month-1,+x.day,+x.hour,+x.minute,+x.second);
  const off=Math.round((asBerlin-utc)/60000),sign=off>=0?'+':'-',a=Math.abs(off);
  return `${x.year}-${x.month}-${x.day}T${x.hour}:${x.minute}:${x.second}${sign}${String(Math.floor(a/60)).padStart(2,'0')}:${String(a%60).padStart(2,'0')}`;
}
async function readJson(path){return JSON.parse(await fs.readFile(path,'utf8'));}
async function writeJson(path,obj){await fs.writeFile(path,JSON.stringify(obj,null,2)+'\n');}
async function fetchJson(url,timeoutMs=15000){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeoutMs);
  try{const r=await fetch(url,{headers:{'user-agent':'alantu-runtime-mirror/3.0'},signal:ctl.signal,cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json();}
  finally{clearTimeout(timer);}
}
async function canonicalSourceState(){
  let last;
  for(let i=0;i<3;i++){
    try{
      const s=await fetchJson(SOURCE_STATE_URL),checked=Date.parse(s?.checked_at||'');
      if(s?.contract!=='source-event-v3')throw new Error('source contract is not source-event-v3');
      if(s?.role!=='raw_observation_only'||s?.interpretation_status!=='unvalidated_not_used')throw new Error('raw source contract role invalid');
      if(!s?.activity||s.activity.model_eligible!==false||s.activity.direction!==null)throw new Error('source activity contract invalid');
      if(['score','bull','bear','mixed','net','archive_sentiment','live_pulse'].some(k=>Object.prototype.hasOwnProperty.call(s,k)))throw new Error('directional source interpretation leaked into source-state');
      if(!Number.isFinite(checked)||Math.abs(Date.now()-checked)>5*60*1000)throw new Error('canonical source-state stale');
      return s;
    }catch(e){last=e;if(i<2)await new Promise(r=>setTimeout(r,1200));}
  }
  throw last||new Error('canonical source-state unavailable');
}
const at=nowIsoBerlin();
const [trend,watch,wl,minute,sourceState]=await Promise.all([readJson('stockstrend-data.json'),readJson('watchlist-data.json'),readJson('watchlist.json'),readJson('orcl-minute.json'),canonicalSourceState()]);
const r=minute?.chart?.result?.[0],ts=r?.timestamp||[],q=r?.indicators?.quote?.[0]||{};
let latestIdx=-1;
for(let i=0;i<ts.length;i++)if(Number.isFinite(Number(q.close?.[i]))&&Number(q.close[i])>0)latestIdx=i;
if(latestIdx<0)throw new Error('No valid ORCL quote in orcl-minute.json');
const price=Number(q.close[latestIdx]),priceAt=new Date(Number(ts[latestIdx])*1000).toISOString();
const counts=sourceState.archive_source_counts||{},agg=sourceState.social_aggregates||{},activity=sourceState.activity||{},checkedAt=sourceState.checked_at,latestPublished=sourceState.latest_published_at||null;
const why=`Beobachtete Quellenaktivität: ${Number(sourceState.archive_news_count||0)} News · ${Number(sourceState.archive_social_count||0)} Social / 36h. Keine Richtungswertung ohne validiertes Feature.`;
const evidence={source_contract:'source-event-v3',role:'raw_observation_only',interpretation_status:'unvalidated_not_used',news:Number(counts.news||0),reddit_posts:Number(counts.reddit||0),x_posts:Number(counts.x||0),bluesky_posts:Number(counts.bluesky||0),social_other:Number(counts.social||0),external_unvalidated_aggregates:agg,snippets:(sourceState.items||[]).slice(0,3).map(x=>x.title)};
const stock=watch.stocks?.ORCL;
if(!stock)throw new Error('watchlist-data.json missing stocks.ORCL');
stock.latest={at:checkedAt,signal:null,confidence:null,source_contract:'source-event-v3',role:'raw_observation_only',interpretation_status:'unvalidated_not_used',source_activity:activity};
stock.signal=null;stock.social_impulse=null;stock.impulse=null;stock.hype_bull=null;stock.hype_bear=null;stock.hype_mixed=null;stock.hype_net=null;stock.confidence=null;stock.hype_state=null;
stock.updated_at=checkedAt;stock.why=why;stock.evidence=evidence;stock.price=price;stock.sentiment_unit='retired_unvalidated';stock.sentiment_role='retired_unvalidated';stock.source_activity=activity;
stock.source_activity_history=Array.isArray(stock.source_activity_history)?stock.source_activity_history:[];
const ah=stock.source_activity_history.at(-1),ahMs=Date.parse(ah?.at||'');
if(!Number.isFinite(ahMs)||Date.parse(checkedAt)-ahMs>=5*60*1000)stock.source_activity_history.push({at:checkedAt,archive_count:Number(sourceState.archive_count||0),news:Number(sourceState.archive_news_count||0),social:Number(sourceState.archive_social_count||0),new_count:Number(sourceState.new_count||0),live_count:Number(sourceState.live_count||0),first_seen_windows:activity.first_seen_windows||{}});
if(stock.source_activity_history.length>12000)stock.source_activity_history=stock.source_activity_history.slice(-12000);
watch.updated_at=at;wl.updated_at=at;
trend.updated_at=at;trend.timezone=BERLIN;trend.tick=trend.tick||{};trend.tick.tick_id=at;trend.tick.scraped_at=at;trend.tick.timezone=BERLIN;
trend.tick.sources={CanonicalEventStream:{status:sourceState.status,provider:'Railway source-event-v3',role:'raw_observation_only',checked_at:checkedAt,latest_published_at:latestPublished,items:Number(sourceState.archive_count||0),window:'36h',activity},Yahoo:{status:'ok',items:1,prices:{ORCL:price},price_at:priceAt,note:'Yahoo chart 5d/1m price feed'}};
trend.tick.totals={content_items_usable:Number(sourceState.archive_count||0),breakdown:{news:Number(counts.news||0),reddit:Number(counts.reddit||0),x_posts:Number(counts.x||0),bluesky:Number(counts.bluesky||0),social:Number(counts.social||0)}};
trend.tick.freshness={freshest_absolute:checkedAt,latest_published_at:latestPublished,primary_signal:'Railway source-event-v3',quality:'single source of truth · raw observations only',scrape_berlin:checkedAt,sample_window:'individual events ≤36h; first_seen_at is actionable clock',freshest_item_age:'',oldest_usable_signal:''};
trend.freshness=trend.tick.freshness;
trend.tick.vector={...(trend.tick.vector||{}),direction:'neutral',magnitude:null,confidence:null,early_signal:false,early_signal_note:'News/Social are observed features only; directional use is fail-closed until prospective validation.'};
trend.tick.stock_signals=[{symbol:'ORCL',name:'Oracle',signal:null,confidence:null,social_impulse:null,why,evidence,price,source_activity:activity}];
const microstructureBootstrap={provider:'yahoo',feed:'streamer',symbol:'ORCL',mode:'shadow-live',configured:true,at,quality:{usable:false,reasons:['static_bootstrap_replaced_by_railway_poll']},minutes:[],live_signal:null,shadow_signal:null,wave:{provider:'yahoo',feed:'streamer',input_contract:'yahoo_stream_events_no_bar_aggregation',status:'shadow',model_id:'yahoo-shadow-yahoo-shadow-hdr-dt-v1',feature_version:'yahoo-shadow-hdr-dt-v1',production_enabled:false,shadow_only:true,horizons:[1,5,15,30].map(h=>({horizon_minutes:h,status:'shadow',proof:{n:0,hit:null,mean_gross_bps:null,mode:'shadow_only'}}))},wave_forecast:{status:'blocked',reason:'awaiting_live_poll',source:'yahoo_shadow'},l2:{status:'retired',provider:'databento',reason:'replaced_by_event_wave'}};
await Promise.all([
  writeJson('stockstrend-data.json',trend),writeJson('watchlist-data.json',watch),writeJson('watchlist.json',wl),writeJson('microstructure-current.json',microstructureBootstrap),
  writeJson('runtime-status.json',{updated_at:at,sources:{source_state:{ok:true,contract:sourceState.contract,role:sourceState.role,interpretation_status:sourceState.interpretation_status,checked_at:checkedAt,archive_count:Number(sourceState.archive_count||0),archive_source_counts:counts,activity,social_aggregates:agg},yahoo:{ok:true,price,price_at:priceAt}},derived:{source_direction:null,source_signal:null,source_confidence:null,source_activity:activity}})
]);
console.log(JSON.stringify({updated_at:at,price,source_contract:sourceState.contract,source_checked_at:checkedAt,archive_count:sourceState.archive_count,archive_source_counts:counts,activity},null,2));
