import http from 'node:http';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import {aggregateMicrostructure,microstructureQuality} from '../tools/microstructure-core.mjs';
import {forecastRawLatest} from '../tools/raw-sip-wave-core.mjs';
import {forecastYahooShadow,YAHOO_HORIZONS,YAHOO_LOCAL,YAHOO_GLOBAL,YAHOO_SHADOW_VERSION} from '../tools/yahoo-shadow-wave-core.mjs';
import {HYPOTHESIS_VERSION,HYPOTHESIS_STRATEGIES,PRODUCTION_STRATEGY,HYPOTHESIS_MIN_MARGIN,DEFAULT_ROUNDTRIP_COST_BPS,signalSessionEligible,strategyDirections,actionableNewsContext,summarizeHypothesisState} from '../tools/yahoo-hypothesis-v4.mjs';
import {V5_VERSION,V5_HORIZONS,V5_COST_BPS,V5_SAMPLE_GAP_MS,v5SessionEligible,extractV5Features,structuralV5Score,v5BarrierBps,fitV5Logistic,predictV5Logistic,evaluateV5Path,summarizeV5State} from '../tools/yahoo-monetary-v5.mjs';
import {YAHOO_EVENT_CONTRACT,zigZag64,finiteNonNegative,canonicalVolumeDelta,canonicalEventCheck,normalizeLegacyYahooEvent} from '../tools/yahoo-stream-contract.mjs';
import {openMarketStore,persistObservation,persistTransportObservation,persistPrediction,persistOutcome,persistEvidence,persistExperiment,loadRecentMarketEvents,loadModelState,storeStats,V6_CONTRACT_ID,V6_CONTRACT_TEXT} from './sqlite-store.mjs';

let marketDb=null;
try{
  marketDb=openMarketStore();
  persistExperiment(marketDb,{approach_version:V5_VERSION,status:'collecting',config:{clock:'market_event_time',horizons:V5_HORIZONS,input_contract:'observed_market_events_only',canonical_warmup_ms:300000,execution_basis:'yahoo_last_price_research_proxy'}});
  console.log('[sqlite] ready',storeStats(marketDb));
}
catch(e){console.error('[sqlite] init failed',String(e?.stack||e));process.exit(1);}

const PORT=Number(process.env.PORT||8080);
const KEY=process.env.APCA_API_KEY_ID||'',SECRET=process.env.APCA_API_SECRET_KEY||'';
const FEED=process.env.ALANTU_MARKET_FEED||'sip';
const SYMBOLS=(process.env.MICRO_SYMBOLS||'ORCL,MSFT,AMZN,GOOGL,NVDA,IGV,QQQ,SPY').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
const YAHOO_SYMBOLS=[...new Set(['ORCL','EURUSD=X',...YAHOO_LOCAL,...YAHOO_GLOBAL])];
const DATA_DIR=process.env.RAW_SIP_DATA_DIR||'/data/alantu';
const MODEL_PATH=process.env.RAW_SIP_MODEL_OUT||DATA_DIR+'/orcl-raw-sip-model.json';
const MODEL_FALLBACK='/app/orcl-raw-sip-model.json';
const ALLOWED=new Set((process.env.ALLOWED_ORIGINS||'https://www.alantu.de,https://alantu.de').split(',').map(x=>x.trim()).filter(Boolean));
const raw=Object.fromEntries(SYMBOLS.map(s=>[s,{trades:[],quotes:[],corrections:0,cancels:0}]));
const clients=new Set();
let upstream=null,reconnectTimer=null,lastUpstreamAt=0,authState=KEY&&SECRET?'connecting':'awaiting_credentials',authError=null,subscriptionVerified=false;
let rawModel=null,rawForecast={status:'blocked',reason:'model_unavailable'},lastForecastAt=0;
const yahooSeries=Object.fromEntries(YAHOO_SYMBOLS.map(s=>[s,[]]));
const WGO_SYMBOLS=new Set(['ORCL','QQQ','SPY']);
const wgoSeries=Object.fromEntries([...WGO_SYMBOLS].map(s=>[s,[]]));
const yahooDayVolume=Object.fromEntries(YAHOO_SYMBOLS.map(s=>[s,null]));
let yahooWs=null,yahooReconnect=null,yahooLastAt=0,yahooState='connecting',yahooForecast={status:'blocked',reason:'starting_yahoo_shadow',source:'yahoo_shadow'};
let shadowState={predictions:[],outcomes:[],proof:{},updated_at:null};
let hypothesisState={predictions:[],outcomes:[],updated_at:null};
let v5State={predictions:[],outcomes:[],started_at:null,updated_at:null};
let v5SummaryCache=null,v5SummaryCacheAt=0,v5SummaryOutcomeCount=-1;
let eventBuffer=[],sourceEventBuffer=[];
const SHADOW_PATH=DATA_DIR+'/yahoo-shadow-state.json';
const HYPOTHESIS_PATH=DATA_DIR+'/yahoo-hypothesis-v4-state.json';
const V5_PATH=DATA_DIR+'/yahoo-monetary-v5-state.json';
const YAHOO_DIR=DATA_DIR+'/yahoo-events';
const SOURCE_EVENT_DIR=DATA_DIR+'/source-events';
const HYPOTHESIS_COST_BPS=Math.max(0,Number(process.env.SHADOW_ROUNDTRIP_COST_BPS||DEFAULT_ROUNDTRIP_COST_BPS));
const SOURCE_REFRESH_MS=Math.max(8000,Number(process.env.SOURCE_REFRESH_MS||12000));
const SOURCE_MAX_LIVE_LAG_MS=90*1000;
const SOURCE_MARKET_MATCH_MS=60*1000;
const SOURCE_ARCHIVE_WINDOW_MS=36*3600000;
const V6_RUNTIME_STARTED_AT=Date.now(),V6_CANONICAL_WARMUP_MS=5*60000;
let wgoPreviousCloseCache={checked_at:0,orcl:null,eurusd:null,source:null};
const WHATS_GOING_ON_PROMPT=`Du erklärst ORCL in höchstens 5 kurzen Sätzen. Beginne mit der Bewegung der letzten 5/10 Minuten. Wenn der aktuelle Zeitraum ruhig ist, aber in den letzten 3 Stunden ein deutlich stärkerer 5/10-Minuten-Impuls lag, nenne diesen mit Uhrzeit und Größe. Ordne danach den heutigen Tagesmove ein und nutze relevante Meldungen der letzten 18 Stunden. Vergleiche den Impuls mit QQQ/SPY, um breiten Marktstress von ORCL-spezifischer Bewegung zu unterscheiden. Priorisiere konkrete Unternehmensereignisse vor allgemeiner Stimmung. Unterscheide klar zwischen belegtem Ereignis, wahrscheinlich relevantem Katalysator und bloßer zeitlicher Korrelation. Keine Kauf-/Verkaufsempfehlung.`;
let sourceRefreshBusy=false,sourceLastLogAt=0,sourceLastEventAt=null,sourcePrimed=false;
let redditAggregateCache={at:0,data:null};
const SOCIAL_AGGREGATE_CACHE_MS=2*60*1000;
const wgoRangeCache=new Map(),WGO_RANGE_CACHE_MS=10*60*1000;
const sourceSeen=new Map();
let sourceState={
  contract:'source-event-v2',sentiment_role:'descriptive_only_not_model_signal',
  status:'warming',at:null,checked_at:null,event_mode:'new_since_last_poll',
  poll_interval_seconds:SOURCE_REFRESH_MS/1000,max_live_delay_seconds:SOURCE_MAX_LIVE_LAG_MS/1000,market_match_tolerance_seconds:SOURCE_MARKET_MATCH_MS/1000,
  score:null,bull:null,bear:null,mixed:null,net:null,news_count:0,social_count:0,live_count:0,new_count:0,delayed_count:0,archive_count:0,
  archive_news_count:0,archive_social_count:0,coverage:'none',providers:[],
  source_counts:{news:0,reddit:0,x:0,bluesky:0,social:0},
  archive_source_counts:{news:0,reddit:0,x:0,bluesky:0,social:0},latest_published_at:null,market_anchor:null,actionable_market_anchor:null,items:[],error:null
};

function cors(req,res){const o=req.headers.origin;if(o&&ALLOWED.has(o)){res.setHeader('Access-Control-Allow-Origin',o);res.setHeader('Vary','Origin');}}
function json(res,code,obj){res.statusCode=code;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(obj));}
async function readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}}

const SENT_POS=['beat','growth','surge','rally','rise','gain','upgrade','outperform','strong','record','backlog','contract','deal','boost','expand','demand','win','bullish','buy rating'];
const SENT_NEG=['debt','risk','fall','drop','decline','downgrade','concern','lawsuit','probe','headwind','cost','capex','stress','junk bond','layoff','slump','miss','bearish','sell rating','force majeure','delay','delayed','financing','loan','permit','setback'];
function normalizedText(s){return String(s||'').toLowerCase().replace(/[^a-z0-9$]+/g,' ').replace(/\s+/g,' ').trim();}
function termScore(title){
  const s=' '+normalizedText(title)+' ';
  let pos=0,neg=0;
  const hit=(term)=>s.includes(' '+term+' ')||term.includes(' ')&&s.includes(term);
  const negated=(term)=>{
    const i=s.indexOf(term);if(i<0)return false;
    const pre=s.slice(Math.max(0,i-18),i);
    return /\b(no|not|never|without|cuts?|falls?)\s+$/.test(pre);
  };
  for(const k of SENT_POS)if(hit(k)){if(negated(k))neg++;else pos++;}
  for(const k of SENT_NEG)if(hit(k)){if(negated(k))pos++;else neg++;}
  return pos>neg?1:neg>pos?-1:0;
}
function recencyWeight(ms,now=Date.now()){
  const age=Math.max(0,now-Number(ms||0));
  return age<=15000?1.35:age<=45000?1.15:age<=SOURCE_MAX_LIVE_LAG_MS?1:0;
}
const STORY_STOP=new Set('oracle corporation stock shares share market markets says said amid after before with from into over under about this that will could would should their its the and for are has have new latest report reports'.split(' '));
function storyTokens(title){
  return new Set(normalizedText(title).split(' ').filter(x=>x.length>=3&&!STORY_STOP.has(x)));
}
function nearDuplicateStory(a,b){
  const A=storyTokens(a?.title),B=storyTokens(b?.title);if(A.size<4||B.size<4)return false;
  let common=0;for(const x of A)if(B.has(x))common++;
  const overlap=common/Math.min(A.size,B.size),jaccard=common/(A.size+B.size-common);
  return overlap>=.82||jaccard>=.68;
}
function dedupeStories(items,fuzzy=false){
  const seen=new Set(),out=[];
  for(const x of items||[]){
    const key=normalizedText(x.title);if(!key||seen.has(key))continue;
    if(fuzzy&&out.some(y=>nearDuplicateStory(x,y)))continue;
    seen.add(key);out.push(x);
  }
  return out.sort((a,b)=>Number(b.time||0)-Number(a.time||0));
}
function marketRelevantStory(x){
  const s=normalizedText(x?.title||'');
  if(!s)return false;
  if(/\boracle financial services\b/.test(s)&&!/\borcl\b/.test(s))return false;
  if(/\borcl\b/.test(s))return true;
  if(!/\boracle\b/.test(s))return false;
  const material=/\b(stock|share|shares|earnings|revenue|profit|margin|guidance|cloud|oci|ai|openai|stargate|datacenter|data center|capex|debt|bond|financing|contract|deal|analyst|rating|price target|dividend|acquisition|lawsuit|sec|investor|force majeure|blue owl|project jupiter|tiktok|database|java|software|healthcare|fusion|netsuite|partnership|customer)\b/;
  const nonMarket=/\b(academy|university|workshop|student|students|award|awards|certification|education|classroom|training course)\b/;
  return material.test(s)&&!(nonMarket.test(s)&&!/(stock|earnings|revenue|investor|contract|deal|cloud|oci|ai|database)/.test(s));
}
async function tickerTick(query,n){
  const u=new URL('https://api.tickertick.com/feed');u.searchParams.set('q',query);u.searchParams.set('n',String(n));
  const r=await fetch(u,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('TickerTick HTTP '+r.status);
  const j=await r.json(),cut=Date.now()-SOURCE_ARCHIVE_WINDOW_MS;
  return (j.stories||[]).map(x=>({title:String(x.title||''),url:String(x.url||''),site:String(x.site||''),time:Number(x.time)}))
    .filter(x=>x.title&&Number.isFinite(x.time)&&x.time>=cut&&x.time<=Date.now()+60000);
}
async function redditSearch(q){
  const u=new URL('https://www.reddit.com/search.json');
  u.searchParams.set('q',q);
  u.searchParams.set('sort','new');u.searchParams.set('t','day');u.searchParams.set('limit','100');u.searchParams.set('raw_json','1');
  const r=await fetch(u,{headers:{'user-agent':'alantu-market/1.0 (+https://alantu.de)'},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error('Reddit HTTP '+r.status);
  const j=await r.json(),cut=Date.now()-SOURCE_ARCHIVE_WINDOW_MS;
  return (j?.data?.children||[]).map(x=>x?.data||{}).map(x=>({
    title:String(x.title||''),url:x.permalink?'https://www.reddit.com'+x.permalink:String(x.url||''),
    site:'reddit.com',time:Number(x.created_utc)*1000,engagement:{score:Number(x.score)||0,comments:Number(x.num_comments)||0}
  })).filter(x=>x.title&&Number.isFinite(x.time)&&x.time>=cut&&/\borcl\b|oracle/i.test(x.title));
}
async function redditRecent(){
  const [ticker,entity]=await Promise.all([
    optionalSource(()=>redditSearch('ORCL')),
    optionalSource(()=>redditSearch('"Oracle" stock OR shares OR earnings OR cloud OR AI'))
  ]);
  return dedupeStories(ticker.concat(entity)).slice(0,160);
}
async function xRecent(){
  const token=String(process.env.X_BEARER_TOKEN||'').trim();if(!token)return [];
  const u=new URL('https://api.x.com/2/tweets/search/recent');
  u.searchParams.set('query','(ORCL OR Oracle) (stock OR shares OR earnings OR cloud OR AI) -is:retweet lang:en');
  u.searchParams.set('max_results','50');u.searchParams.set('tweet.fields','created_at,public_metrics');
  const r=await fetch(u,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error('X HTTP '+r.status);
  const j=await r.json(),cut=Date.now()-SOURCE_ARCHIVE_WINDOW_MS;
  return (j.data||[]).map(x=>({
    title:String(x.text||''),url:'https://x.com/i/web/status/'+x.id,site:'x.com',time:Date.parse(x.created_at||''),engagement:x.public_metrics||null
  })).filter(x=>x.title&&Number.isFinite(x.time)&&x.time>=cut);
}
async function blueskySearch(q){
  const u=new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts');
  u.searchParams.set('q',q);u.searchParams.set('limit','100');u.searchParams.set('sort','latest');
  const r=await fetch(u,{headers:{'user-agent':'alantu-market/1.0 (+https://alantu.de)'},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error('Bluesky HTTP '+r.status);
  const j=await r.json(),cut=Date.now()-SOURCE_ARCHIVE_WINDOW_MS;
  return (j.posts||[]).map(x=>{
    const text=String(x?.record?.text||''),time=Date.parse(x?.record?.createdAt||''),uri=String(x?.uri||'');
    const rkey=uri.split('/').pop()||'',handle=String(x?.author?.handle||'');
    return {title:text,url:handle&&rkey?'https://bsky.app/profile/'+handle+'/post/'+rkey:'',site:'bsky.app',time,engagement:{likes:Number(x.likeCount)||0,reposts:Number(x.repostCount)||0,replies:Number(x.replyCount)||0}};
  }).filter(x=>x.title&&Number.isFinite(x.time)&&x.time>=cut&&/\borcl\b|oracle/i.test(x.title));
}
async function blueskyRecent(){
  const [ticker,entity]=await Promise.all([
    optionalSource(()=>blueskySearch('ORCL')),
    optionalSource(()=>blueskySearch('"Oracle" stock shares earnings cloud AI'))
  ]);
  return dedupeStories(ticker.concat(entity)).slice(0,160);
}
async function googleNewsQuery(q,maxAgeMs=SOURCE_ARCHIVE_WINDOW_MS){
  const u=new URL('https://news.google.com/rss/search');
  u.searchParams.set('q',q);u.searchParams.set('hl','en-US');u.searchParams.set('gl','US');u.searchParams.set('ceid','US:en');
  const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0 alantu-market/1.0'},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error('Google News HTTP '+r.status);
  const xml=await r.text(),items=xml.match(/<item>[\s\S]*?<\/item>/gi)||[],out=[];
  const dec=v=>String(v||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  for(const item of items){
    const title=dec((item.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]||'').trim();
    const url=dec((item.match(/<link>([\s\S]*?)<\/link>/i)||[])[1]||'').trim();
    const time=Date.parse(dec((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)||[])[1]||''));
    if(title&&url&&Number.isFinite(time)&&(!Number.isFinite(Number(maxAgeMs))||Number(maxAgeMs)<=0||Date.now()-time<=Number(maxAgeMs)))out.push({title,url,site:'news.google.com',time});
  }
  return out;
}
async function googleNewsRecent(){
  const [market,company]=await Promise.all([
    optionalSource(()=>googleNewsQuery('(Oracle OR ORCL) stock when:1d')),
    optionalSource(()=>googleNewsQuery('Oracle (cloud OR AI OR earnings OR contract OR capex) when:1d'))
  ]);
  return dedupeStories(market.concat(company)).slice(0,160);
}
function wgoRangeSpec(range,now=Date.now()){
  const day=86400000;
  if(range==='1d')return {label:'1T',days:1,query:'when:1d'};
  if(range==='1w')return {label:'1W',days:7,query:'when:7d'};
  if(range==='1m')return {label:'1M',days:31,query:'when:30d'};
  if(range==='year')return {label:'1J',days:366,query:'when:1y'};
  if(range==='5y'){
    const d=new Date(now-5*365.25*day).toISOString().slice(0,10);
    return {label:'5J',days:Math.ceil(5*365.25),query:'after:'+d};
  }
  if(range==='all')return {label:'MAX',days:0,query:'after:2000-01-01'};
  return null;
}
function wgoTheme(title){
  const t=normalizedText(title);
  if(/force majeure|project jupiter|data center|datacenter|new mexico|capex|power|pipeline|infrastructure/.test(t))return 'Rechenzentren & Capex';
  if(/openai|chatgpt|ai |artificial intelligence|cloud|oci|gpu|nvidia|contract|backlog/.test(t))return 'AI, Cloud & Großverträge';
  if(/earnings|revenue|guidance|quarter|profit|margin|forecast|results/.test(t))return 'Ergebnisse & Ausblick';
  if(/debt|loan|financing|bond|credit|downgrade|cash flow|free cash/.test(t))return 'Finanzierung & Verschuldung';
  if(/layoff|job cut|restructur|headcount/.test(t))return 'Restrukturierung';
  if(/lawsuit|antitrust|regulat|probe|privacy|government/.test(t))return 'Regulierung & Recht';
  if(/upgrade|downgrade|price target|analyst|rating/.test(t))return 'Analysten';
  return 'Sonstiges';
}
function wgoRangeBackgroundText(range,items){
  const spec=wgoRangeSpec(range),rows=dedupeStories(items||[]);if(!spec||!rows.length)return {text:'Für diesen Zeitraum ist derzeit kein belastbarer Nachrichtenhintergrund abrufbar.',themes:[],items:[]};
  const counts={},examples={};
  for(const x of rows){
    const th=wgoTheme(x.title);counts[th]=(counts[th]||0)+1;
    if(!examples[th])examples[th]=x;
  }
  const ranked=Object.entries(counts).sort((a,b)=>b[1]-a[1]).filter(x=>x[0]!=='Sonstiges');
  const top=ranked.slice(0,3);
  const tone={pos:0,neg:0,mix:0};for(const x of rows){const z=termScore(x.title);if(z>0)tone.pos++;else if(z<0)tone.neg++;else tone.mix++;}
  const themeText=top.length?top.map(x=>x[0]+' ('+x[1]+')').join(', '):'keine klar dominierende Themenfamilie';
  const reps=top.slice(0,2).map(x=>examples[x[0]]).filter(Boolean);
  const repText=reps.length?' Auffällige Meldungen: '+reps.map(x=>'„'+String(x.title||'').replace(/\s+/g,' ').trim().slice(0,150)+(String(x.title||'').length>150?'…':'')+'“').join(' · ')+'.':'';
  const bias=tone.neg>tone.pos*1.25?'überwiegend negativer':tone.pos>tone.neg*1.25?'überwiegend positiver':'gemischter';
  return {
    text:'Hintergrund '+spec.label+': Dominant waren '+themeText+'. Die Nachrichtenlage war '+bias+' Natur.'+repText,
    themes:top.map(x=>({theme:x[0],count:x[1]})),
    items:reps.map(x=>({title:x.title,url:x.url,time:x.time,site:x.site})),
    counts:{total:rows.length,positive:tone.pos,negative:tone.neg,mixed:tone.mix}
  };
}
async function wgoRangeBackground(range){
  const spec=wgoRangeSpec(range);if(!spec)return {range,generated_at:new Date().toISOString(),background:'Unbekannter Zeitraum.',themes:[],items:[]};
  const cached=wgoRangeCache.get(range),now=Date.now();
  if(cached&&now-cached.at<WGO_RANGE_CACHE_MS)return cached.data;
  const maxAge=spec.days>0?spec.days*86400000:0;
  const suffix=spec.query;
  const [market,company]=await Promise.all([
    optionalSource(()=>googleNewsQuery('(Oracle OR ORCL) stock shares '+suffix,maxAge)),
    optionalSource(()=>googleNewsQuery('Oracle (cloud OR AI OR earnings OR contract OR capex OR debt OR data center) '+suffix,maxAge))
  ]);
  const rows=dedupeStories(market.concat(company)).slice(0,180),bg=wgoRangeBackgroundText(range,rows);
  const data={range,label:spec.label,generated_at:new Date().toISOString(),background:bg.text,themes:bg.themes,items:bg.items,counts:bg.counts||{total:0,positive:0,negative:0,mixed:0},source:'google_news_rss',cache_seconds:600};
  wgoRangeCache.set(range,{at:now,data});return data;
}

async function optionalSource(fn){try{return await fn();}catch{return [];}}
async function sourceAttempt(name,fn){
  try{const items=await fn();return {name,status:'ok',items:Array.isArray(items)?items:[],error:null};}
  catch(e){return {name,status:'error',items:[],error:String(e?.message||e)};}
}
async function apeWisdomAggregate(){
  if(redditAggregateCache.data&&Date.now()-redditAggregateCache.at<SOCIAL_AGGREGATE_CACHE_MS)return redditAggregateCache.data;
  let mentions=null,sentiment=null,provider='apewisdom.io';
  try{
    const r=await fetch('https://apewisdom.io/stocks/ORCL/',{headers:{'user-agent':'Mozilla/5.0 alantu-market/1.0'},signal:AbortSignal.timeout(12000)});
    if(r.ok){
      const text=(await r.text()).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
      const mm=text.match(/Overall Summary.*?Mentions\s+([\d,]+)/i),sm=text.match(/Overall Summary.*?Sentiment\s+([\d]{1,3})%/i);
      if(mm)mentions=Number(mm[1].replace(/,/g,''));
      if(sm)sentiment=Number(sm[1]);
    }
  }catch{}
  if(!Number.isFinite(mentions)){
    try{
      for(let page=1;page<=6;page++){
        const r=await fetch('https://apewisdom.io/api/v1.0/filter/all-stocks/page/'+page,{headers:{'user-agent':'Mozilla/5.0 alantu-market/1.0'},signal:AbortSignal.timeout(12000)});
        if(!r.ok)break;
        const j=await r.json(),hit=(j.results||[]).find(x=>String(x.ticker||'').toUpperCase()==='ORCL');
        if(hit){mentions=Number(hit.mentions);provider='apewisdom.io API';break;}
        if(page>=Number(j.pages||0))break;
      }
    }catch{}
  }
  const data={provider,mentions_24h:Number.isFinite(mentions)?mentions:null,sentiment_pct:Number.isFinite(sentiment)?sentiment:null,checked_at:new Date().toISOString()};
  redditAggregateCache={at:Date.now(),data};return data;
}
function sourceChannel(x,type){
  if(type==='news')return 'news';
  const u=(String(x.url||'')+' '+String(x.site||'')).toLowerCase();
  if(u.includes('reddit.com'))return 'reddit';
  if(u.includes('x.com')||u.includes('twitter.com'))return 'x';
  if(u.includes('bsky.app')||u.includes('bluesky'))return 'bluesky';
  return 'social';
}
function storyKey(x,type){
  const channel=sourceChannel(x,type),url=String(x.url||'').trim(),title=normalizedText(x.title);
  return channel+'|'+(url||title+'|'+String(Number(x.time)||0));
}
function alignedMarketAt(ms){
  ms=Number(ms);if(!Number.isFinite(ms))return null;
  let a,provider;
  if(KEY&&SECRET){
    a=(raw.ORCL?.trades||[]).map(x=>({t:Date.parse(x.t||x.timestamp||''),p:Number(x.p||x.price)})).filter(x=>Number.isFinite(x.t)&&x.p>0);
    provider='alpaca_sip';
  }else{
    a=(yahooSeries.ORCL||[]).map(x=>({t:Number(x.t),p:Number(x.p)})).filter(x=>Number.isFinite(x.t)&&x.p>0);
    provider='yahoo_streamer';
  }
  if(!a.length)return null;
  let lo=0,hi=a.length-1,before=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t<=ms){before=m;lo=m+1;}else hi=m-1;}
  const after=before+1<a.length?before+1:-1;
  const b=before>=0&&ms-a[before].t<=SOURCE_MARKET_MATCH_MS?a[before]:null;
  const n=after>=0&&a[after].t-ms<=SOURCE_MARKET_MATCH_MS?a[after]:null;
  return {
    provider,
    before:b?{at:new Date(b.t).toISOString(),price:b.p,lag_ms:ms-b.t}:null,
    after:n?{at:new Date(n.t).toISOString(),price:n.p,lag_ms:n.t-ms}:null
  };
}
function canonicalStoryId(x){
  return normalizedText(x?.title||'').replace(/\b(reuters|yahoo finance|marketwatch|cnbc|bloomberg|seeking alpha)\b/g,'').replace(/\s+/g,' ').trim().slice(0,220);
}
function sourceQuality(channel,site){
  if(channel==='reddit'||channel==='x'||channel==='bluesky')return 'direct_social';
  if(channel==='news')return /reuters|sec\.gov/i.test(String(site||''))?'primary_or_wire':'news_aggregator';
  return 'ugc_aggregator';
}
function sourceItem(x,type,now=Date.now(),liveKeys=new Set(),delayedKeys=new Set()){
  const channel=sourceChannel(x,type),lean=termScore(x.title),time=Number(x.time),age=Math.max(0,now-time),key=storyKey(x,type),seen=sourceSeen.get(key);
  return {
    version:'source-event-v2',type,channel,title:String(x.title||'').slice(0,320),
    summary:String(x.title||'').replace(/\s+/g,' ').trim().slice(0,260),
    url:String(x.url||''),site:String(x.site||''),provider:String(x.site||channel),time,key,
    canonical_story_id:canonicalStoryId(x),entity_relevance:'orcl_market_material',
    source_quality:sourceQuality(channel,x.site),engagement:x.engagement||null,
    live:liveKeys.has(key),new:liveKeys.has(key)||delayedKeys.has(key),delayed:delayedKeys.has(key),
    novelty:(liveKeys.has(key)||delayedKeys.has(key))?'first_seen':'known',
    first_seen_at:seen?.first_seen_at?new Date(seen.first_seen_at).toISOString():null,
    discovered_at:seen?.first_seen_at?new Date(seen.first_seen_at).toISOString():null,
    discovery_delay_ms:seen?Math.max(0,seen.first_seen_at-time):null,age_ms:age,
    market:alignedMarketAt(time),
    actionable_market:seen?.first_seen_at?alignedMarketAt(seen.first_seen_at):null,
    lean:lean>0?'bull':lean<0?'bear':'mixed'
  };
}
function sourceSummary(){
  const {items,...rest}=sourceState;
  return {...rest,item_count:Array.isArray(items)?items.length:0};
}
function channelPulse(items,now){
  let bp=0,bn=0,bm=0;
  for(const x of items){
    const w=recencyWeight(x.time,now);if(!w)continue;
    const v=termScore(x.title);if(v>0)bp+=w;else if(v<0)bn+=w;else bm+=w;
  }
  const total=bp+bn+bm;if(!total)return null;
  return {bull:100*bp/total,bear:100*bn/total,mixed:100*bm/total,net:100*(bp-bn)/total,count:items.length};
}
function deriveSourceState(news,social,providers,status='ok'){
  const now=Date.now();
  const newsArchive=dedupeStories((news||[]).filter(marketRelevantStory),true).filter(x=>Number(x.time)>=now-SOURCE_ARCHIVE_WINDOW_MS).map(x=>({...x,_type:'news'}));
  const socialArchive=dedupeStories(social).filter(x=>Number(x.time)>=now-SOURCE_ARCHIVE_WINDOW_MS).map(x=>({...x,_type:'social'}));
  const archiveRaw=[...newsArchive,...socialArchive].sort((a,b)=>Number(b.time)-Number(a.time));

  const liveKeys=new Set(),delayedKeys=new Set();
  let newCount=0;
  for(const x of archiveRaw){
    const key=storyKey(x,x._type);
    if(sourceSeen.has(key))continue;
    sourceSeen.set(key,{first_seen_at:now,published_at:Number(x.time)});
    if(sourcePrimed){
      newCount++;
      const lag=now-Number(x.time);
      if(lag>=0&&lag<=SOURCE_MAX_LIVE_LAG_MS)liveKeys.add(key);else delayedKeys.add(key);
    }
  }
  for(const [key,v] of sourceSeen)if(now-Number(v.published_at||0)>SOURCE_ARCHIVE_WINDOW_MS)sourceSeen.delete(key);
  if(!sourcePrimed)sourcePrimed=true;

  const archiveItems=archiveRaw.map(x=>sourceItem(x,x._type,now,liveKeys,delayedKeys)).slice(0,240);
  for(const item of archiveItems.filter(x=>x.new)){
    sourceEventBuffer.push({
      version:'source-event-v2',key:item.key,canonical_story_id:item.canonical_story_id,type:item.type,channel:item.channel,title:item.title,url:item.url,site:item.site,provider:item.provider,lean:item.lean,
      source_quality:item.source_quality,entity_relevance:item.entity_relevance,engagement:item.engagement,novelty:item.novelty,
      published_at:new Date(Number(item.time)).toISOString(),first_seen_at:item.first_seen_at,delivery_lag_ms:item.discovery_delay_ms,
      market_at_published:item.market,market_at_first_seen:item.actionable_market
    });
  }
  const liveItems=archiveItems.filter(x=>x.live);
  const groups={};
  for(const x of liveItems){if(!groups[x.channel])groups[x.channel]=[];groups[x.channel].push(x);}
  const livePulse=channelPulse(liveItems,now);
  const bull=livePulse?Math.round(livePulse.bull):null,bear=livePulse?Math.round(livePulse.bear):null;
  const mixed=livePulse?Math.max(0,100-bull-bear):null,net=livePulse?bull-bear:null;
  const archiveCounts=archiveItems.reduce((m,x)=>(m[x.lean]=(m[x.lean]||0)+1,m),{bull:0,bear:0,mixed:0});
  const archiveTotal=archiveCounts.bull+archiveCounts.bear+archiveCounts.mixed;
  const archiveBull=archiveTotal?Math.round(100*archiveCounts.bull/archiveTotal):null;
  const archiveBear=archiveTotal?Math.round(100*archiveCounts.bear/archiveTotal):null;
  const archiveMixed=archiveTotal?Math.max(0,100-archiveBull-archiveBear):null;
  const archiveNet=archiveTotal?archiveBull-archiveBear:null;
  const archiveSentiment={
    role:'descriptive_only_not_model_signal',method:'equal_weight_unique_market_events_keyword_lean',
    bull:archiveBull,bear:archiveBear,mixed:archiveMixed,net:archiveNet,
    score:archiveNet==null?null:Math.max(0,Math.min(100,Math.round(50+archiveNet/2))),
    unique_events:archiveTotal
  };
  const liveCount=liveItems.length,activeChannels=Object.keys(groups).length;
  const coverage=liveCount>=8&&activeChannels>=3?'high':liveCount>=3&&activeChannels>=2?'medium':liveCount>=1?'low':'quiet';
  const source_counts=liveItems.reduce((m,x)=>(m[x.channel]=(m[x.channel]||0)+1,m),{news:0,reddit:0,x:0,bluesky:0,social:0});
  const archive_source_counts=archiveItems.reduce((m,x)=>(m[x.channel]=(m[x.channel]||0)+1,m),{news:0,reddit:0,x:0,bluesky:0,social:0});
  const newestLive=liveItems.length?liveItems.reduce((a,b)=>a.time>b.time?a:b):null;
  const newestArchive=archiveItems.length?archiveItems[0]:null;
  const marketAnchor=newestLive?.market?.before||newestLive?.market?.after||null;
  const actionableMarketAnchor=newestLive?.actionable_market?.before||newestLive?.actionable_market?.after||null;
  return {
    status:liveCount?status:'quiet',
    at:newestLive?new Date(newestLive.time).toISOString():null,
    checked_at:new Date(now).toISOString(),event_mode:'new_since_last_poll',
    poll_interval_seconds:SOURCE_REFRESH_MS/1000,max_live_delay_seconds:SOURCE_MAX_LIVE_LAG_MS/1000,market_match_tolerance_seconds:SOURCE_MARKET_MATCH_MS/1000,
    contract:'source-event-v2',sentiment_role:'descriptive_only_not_model_signal',
    score:net==null?null:Math.max(0,Math.min(100,Math.round(50+net/2))),bull,bear,mixed,net,
    live_pulse:{role:'time_aligned_event_feature',bull,bear,mixed,net,score:net==null?null:Math.max(0,Math.min(100,Math.round(50+net/2))),unique_events:liveCount},
    archive_sentiment:archiveSentiment,
    news_count:liveItems.filter(x=>x.type==='news').length,social_count:liveItems.filter(x=>x.type==='social').length,
    live_count:liveCount,new_count:newCount,delayed_count:delayedKeys.size,archive_count:archiveItems.length,
    archive_news_count:newsArchive.length,archive_social_count:socialArchive.length,
    coverage,providers,source_counts,archive_source_counts,
    latest_published_at:newestArchive?new Date(newestArchive.time).toISOString():null,
    market_anchor:marketAnchor,actionable_market_anchor:actionableMarketAnchor,items:archiveItems,error:null
  };
}
function broadcastSources(){
  const payload={symbol:'ORCL',sentiment:sourceState};
  for(const c of [...clients]){try{sendEvent(c.res,payload,'sources');}catch{clients.delete(c);try{c.res.end();}catch{}}}
}
async function refreshSources(){
  if(sourceRefreshBusy)return;
  sourceRefreshBusy=true;
  try{
    const xEnabled=!!String(process.env.X_BEARER_TOKEN||'').trim();
    const attempts=await Promise.all([
      sourceAttempt('ticker_news',()=>tickerTick('(and tt:orcl (or T:curated T:market T:analysis T:industry T:earning T:sec))',160)),
      sourceAttempt('ticker_ugc',()=>tickerTick('(and tt:orcl T:ugc)',300)),
      sourceAttempt('entity_ugc',()=>tickerTick('(and E:oracle T:ugc)',300)),
      sourceAttempt('reddit',redditRecent),
      xEnabled?sourceAttempt('x',xRecent):Promise.resolve({name:'x',status:'disabled',items:[],error:'X_BEARER_TOKEN missing'}),
      sourceAttempt('bluesky',blueskyRecent),
      sourceAttempt('google_news',googleNewsRecent),
      sourceAttempt('reddit_aggregate',async()=>[await apeWisdomAggregate()])
    ]);
    const by=Object.fromEntries(attempts.map(a=>[a.name,a]));
    const ttNews=by.ticker_news.items,ticker=by.ticker_ugc.items,entity=by.entity_ugc.items,reddit=by.reddit.items,x=by.x.items,bluesky=by.bluesky.items,gnews=by.google_news.items;
    const redditAggregate=by.reddit_aggregate.items[0]||null;
    const sourceHealth=Object.fromEntries(['ticker_news','ticker_ugc','entity_ugc','reddit','x','bluesky','google_news'].map(k=>[k,{status:by[k].status,count:by[k].items.length,error:by[k].error||null}]));
    sourceHealth.x.enabled=xEnabled;
    const news=dedupeStories(ttNews.concat(gnews).filter(marketRelevantStory),true).slice(0,240);
    const relevant=entity.filter(x=>/\$orcl\b|\borcl\b/i.test(x.title)||(/oracle/i.test(x.title)&&/stock|share|earn|cloud|ai|market|bull|bear|buy|sell|valuation|price|contract|capex/i.test(x.title)));
    const social=dedupeStories(ticker.concat(relevant,reddit,x,bluesky)).slice(0,600);
    if(!news.length&&!social.length)throw new Error('No sentiment sources available');
    const providers=[];
    if(ttNews.length)providers.push('TickerTick News');
    if(gnews.length)providers.push('Google News RSS');
    if(ticker.length||relevant.length)providers.push('TickerTick UGC');
    if(reddit.length)providers.push('Reddit live');
    if(bluesky.length)providers.push('Bluesky public');
    if(x.length)providers.push('X live');
    const degraded=providers.length<2;
    sourceState=deriveSourceState(news,social,providers,degraded?'degraded':'ok');
    sourceState.source_health=sourceHealth;
    sourceState.social_aggregates={reddit:redditAggregate};
    if(marketDb){
      persistEvidence(marketDb,{kind:'source_state',approach_version:'source-state-v1',symbol:'ORCL',event_at:sourceState.checked_at,payload:sourceSummary()});
      for(const item of (sourceState.items||[]).filter(x=>x.new)){
        persistEvidence(marketDb,{evidence_key:'source:'+item.key,kind:'source_event',approach_version:'source-event-v2',symbol:'ORCL',
          event_at_ms:Number(item.time),received_at_ms:Date.parse(item.discovered_at||''),payload:item});
      }
    }
    await flushSourceEvents();
    const eventChanged=sourceState.at!==sourceLastEventAt,logDue=Date.now()-sourceLastLogAt>=60000;
    if(eventChanged||logDue){
      console.log(JSON.stringify({
        type:'source-refresh',status:sourceState.status,event_at:sourceState.at,checked_at:sourceState.checked_at,event_mode:sourceState.event_mode,
        poll_interval_seconds:sourceState.poll_interval_seconds,max_live_delay_seconds:sourceState.max_live_delay_seconds,
        live_count:sourceState.live_count,new_count:sourceState.new_count,delayed_count:sourceState.delayed_count,archive_count:sourceState.archive_count,
        news_count:sourceState.news_count,social_count:sourceState.social_count,market_anchor:sourceState.market_anchor,actionable_market_anchor:sourceState.actionable_market_anchor,
        providers:sourceState.providers,source_counts:sourceState.source_counts,archive_source_counts:sourceState.archive_source_counts
      }));
      sourceLastEventAt=sourceState.at;sourceLastLogAt=Date.now();
    }
  }catch(e){
    const age=sourceState.checked_at?Date.now()-Date.parse(sourceState.checked_at):Infinity;
    sourceState={...sourceState,status:age>2*60000?'stale':'degraded',checked_at:new Date().toISOString(),error:String(e?.message||e)};
  }finally{
    sourceRefreshBusy=false;
    broadcastSources();
  }
}

async function writeJsonAtomic(file,obj){
  const tmp=file+'.tmp';await fs.mkdir(DATA_DIR,{recursive:true});await fs.writeFile(tmp,JSON.stringify(obj,null,2)+'\n');await fs.rename(tmp,file);
}
async function flushSourceEvents(){
  if(!sourceEventBuffer.length)return;
  const batch=sourceEventBuffer.splice(0,sourceEventBuffer.length),by=new Map();
  for(const e of batch){const d=String(e.first_seen_at||'').slice(0,10)||new Date().toISOString().slice(0,10);if(!by.has(d))by.set(d,[]);by.get(d).push(JSON.stringify(e));}
  await fs.mkdir(SOURCE_EVENT_DIR,{recursive:true});
  for(const [d,rows] of by)await fs.appendFile(SOURCE_EVENT_DIR+'/'+d+'.jsonl',rows.join('\n')+'\n');
}
async function loadSourceEvents(){
  await fs.mkdir(SOURCE_EVENT_DIR,{recursive:true}).catch(()=>{});
  const now=Date.now(),days=[0,1,2].map(n=>new Date(now-n*86400000).toISOString().slice(0,10));
  for(const d of days){
    try{
      const txt=await fs.readFile(SOURCE_EVENT_DIR+'/'+d+'.jsonl','utf8');
      for(const line of txt.split('\n')){
        if(!line)continue;let e;try{e=JSON.parse(line);}catch{continue;}
        const pub=Date.parse(e.published_at||''),seen=Date.parse(e.first_seen_at||'');
        if(!e.key||!Number.isFinite(pub)||!Number.isFinite(seen)||now-pub>SOURCE_ARCHIVE_WINDOW_MS)continue;
        const prev=sourceSeen.get(e.key);if(!prev||seen<prev.first_seen_at)sourceSeen.set(e.key,{first_seen_at:seen,published_at:pub});
      }
    }catch{}
  }
  if(sourceSeen.size)sourcePrimed=true;
}
function yahooEventDay(ms){return new Date(ms).toISOString().slice(0,10);}
async function flushYahooEvents(){
  if(!eventBuffer.length)return;
  const batch=eventBuffer.splice(0,eventBuffer.length),by=new Map();
  for(const e of batch){const d=yahooEventDay(e.t);if(!by.has(d))by.set(d,[]);by.get(d).push(JSON.stringify(e));}
  await fs.mkdir(YAHOO_DIR,{recursive:true});
  for(const [d,lines] of by)await fs.appendFile(YAHOO_DIR+'/'+d+'.jsonl',lines.join('\n')+'\n');
}
async function loadYahooEvents(){
  await fs.mkdir(YAHOO_DIR,{recursive:true}).catch(()=>{});
  const now=Date.now(),days=[0,1,2].map(n=>new Date(now-n*86400000).toISOString().slice(0,10));
  for(const d of days){
    try{
      const txt=await fs.readFile(YAHOO_DIR+'/'+d+'.jsonl','utf8');
      for(const line of txt.split('\n')){
        if(!line)continue;let e;try{e=JSON.parse(line);}catch{continue;}
        e=normalizeLegacyYahooEvent(e);
        if(!yahooSeries[e.s]||!(Number(e.t)>0)||!(Number(e.p)>0))continue;
        if(WGO_SYMBOLS.has(e.s)&&now-Number(e.t)<=20*3600000)pushWgoContextEvent(e);
        if(now-Number(e.t)>3*3600000)continue;
        yahooSeries[e.s].push({...e,_load_priority:1});
      }
    }catch{}
  }
  // SQLite is the canonical crash-safe source. Structured columns override legacy JSONL
  // fields and therefore also carry one-time data migrations such as corrected day volume.
  if(marketDb){
    for(const e of loadRecentMarketEvents(marketDb,now-3*3600000)){
      if(yahooSeries[e.s])yahooSeries[e.s].push({...e,_load_priority:2});
    }
  }
  for(const symbol of YAHOO_SYMBOLS){
    const byTime=new Map();
    for(const e of yahooSeries[symbol].sort((a,b)=>Number(a.t)-Number(b.t)||Number(a._load_priority||0)-Number(b._load_priority||0))){
      const key=Number(e.t),prev=byTime.get(key);
      if(!prev||Number(e._load_priority||0)>=Number(prev._load_priority||0))byTime.set(key,e);
    }
    yahooSeries[symbol]=[...byTime.values()].map(e=>{const x={...e};delete x._load_priority;return x;}).sort((a,b)=>a.t-b.t);
    const last=yahooSeries[symbol].at(-1);
    yahooDayVolume[symbol]=last&&Number.isFinite(Number(last.day_volume))?Number(last.day_volume):null;
  }
}
function readPbVarint(bytes,state){
  let out=0n,shift=0n;
  while(state.i<bytes.length&&shift<70n){const b=BigInt(bytes[state.i++]);out|=(b&127n)<<shift;if(!(b&128n))return out;shift+=7n;}
  throw new Error('protobuf varint');
}
function decodeYahoo(raw){
  let txt=Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw||'');
  if(!txt)return null;
  if(txt[0]==='{'){try{txt=JSON.parse(txt).message||'';}catch{return null;}}
  if(!txt)return null;
  let bytes;try{bytes=Buffer.from(txt,'base64');}catch{return null;}
  const state={i:0},out={};
  while(state.i<bytes.length){
    const tag=readPbVarint(bytes,state),field=Number(tag>>3n),wire=Number(tag&7n);
    if(wire===0){
      const v=readPbVarint(bytes,state);
      if(field===3){const n=zigZag64(v);out.time=n<1e12?n*1000:n;}
      else if(field===9)out.dayVolume=zigZag64(v);
    }else if(wire===1){if(state.i+8>bytes.length)break;state.i+=8;}
    else if(wire===2){
      const len=Number(readPbVarint(bytes,state));if(state.i+len>bytes.length)break;
      if(field===1||field===4||field===5)out[field===1?'id':field===4?'currency':'exchange']=bytes.subarray(state.i,state.i+len).toString('utf8');
      state.i+=len;
    }else if(wire===5){
      if(state.i+4>bytes.length)break;
      const v=new DataView(bytes.buffer,bytes.byteOffset+state.i,4).getFloat32(0,true);state.i+=4;
      if(field===2)out.price=v;else if(field===8)out.changePercent=v;else if(field===12)out.change=v;else if(field===16)out.previousClose=v;
    }else break;
  }
  return out.id&&Number.isFinite(out.price)?out:null;
}
function pushYahooEvent(q){
  const symbol=String(q.id||'').toUpperCase();if(!yahooSeries[symbol])return;
  const recvAt=Date.now(),t=Number(q.time),p=Number(q.price),dayV=finiteNonNegative(q.dayVolume);
  const a=yahooSeries[symbol],last=a.at(-1),ctx=(wgoSeries[symbol]&&wgoSeries[symbol].length?wgoSeries[symbol].at(-1):null);
  const prevRaw=yahooDayVolume[symbol],prevV=prevRaw==null?null:finiteNonNegative(prevRaw),dv=canonicalVolumeDelta(prevV,dayV);
  const directPrev=Number(q.previousClose),stickyPrev=Number(last&&last.previous_close)||Number(ctx&&ctx.previous_close);
  const previousClose=Number.isFinite(directPrev)&&directPrev>0?directPrev:(Number.isFinite(stickyPrev)&&stickyPrev>0?stickyPrev:null);
  const directPct=Number(q.changePercent),derivedPct=previousClose>0&&p>0?(p/previousClose-1)*100:null;
  const e={s:symbol,t:Number.isFinite(t)?t:null,p:Number.isFinite(p)?p:null,dv,day_volume:dayV,exchange:q.exchange||null,recv_at:recvAt,provider:'yahoo_streamer',
    event_contract:YAHOO_EVENT_CONTRACT,change_pct:Number.isFinite(directPct)?directPct:(Number.isFinite(derivedPct)?derivedPct:null),
    change:Number.isFinite(Number(q.change))?Number(q.change):(previousClose>0&&p>0?p-previousClose:null),previous_close:previousClose};

  const check=canonicalEventCheck(last,e,recvAt);
  if(!check.accept){
    if(marketDb)persistTransportObservation(marketDb,e,{accepted:false,reason:check.reason});
    yahooLastAt=recvAt;yahooState='streaming';return;
  }

  if(dayV!=null)yahooDayVolume[symbol]=dayV;
  if(marketDb){
    persistTransportObservation(marketDb,e,{accepted:true});
    persistObservation(marketDb,e);
  }
  a.push(e);const cut=Date.now()-3*3600000;while(a.length&&a[0].t<cut)a.shift();
  pushWgoContextEvent(e);
  eventBuffer.push(e);yahooLastAt=recvAt;yahooState='streaming';
}
function pushWgoContextEvent(e){
  const symbol=String(e&&e.s||'').toUpperCase();if(!WGO_SYMBOLS.has(symbol)||!(Number(e.t)>0)||!(Number(e.p)>0))return;
  const a=wgoSeries[symbol],bucket=Math.floor(Number(e.t)/60000)*60000,last=a.at(-1);
  const row={...e,t:Number(e.t),p:Number(e.p),minute:bucket};
  if(last&&last.minute===bucket)a[a.length-1]=row;else a.push(row);
  const cut=Date.now()-20*3600000;while(a.length&&Number(a[0].t)<cut)a.shift();
}
function scheduleYahooReconnect(){
  if(yahooReconnect||KEY&&SECRET)return;
  yahooReconnect=setTimeout(()=>{yahooReconnect=null;connectYahoo();},3000);
}
function connectYahoo(){
  if(KEY&&SECRET)return;
  if(yahooWs){try{yahooWs.close();}catch{}}
  yahooState='connecting';
  const ws=new WebSocket('wss://streamer.finance.yahoo.com/?version=2');yahooWs=ws;
  ws.on('open',()=>{yahooState='subscribed';ws.send(JSON.stringify({subscribe:YAHOO_SYMBOLS}));});
  ws.on('message',buf=>{try{const q=decodeYahoo(buf);if(q)pushYahooEvent(q);}catch{}});
  ws.on('close',()=>{yahooState='disconnected';scheduleYahooReconnect();});
  ws.on('error',()=>{yahooState='error';scheduleYahooReconnect();});
}
function latestYahooPrice(){
  const a=yahooSeries.ORCL||[];return a.length?Number(a.at(-1).p):null;
}
function shadowCounts(){
  const current=shadowState.outcomes.filter(x=>x.version===YAHOO_SHADOW_VERSION);
  return {
    pending:shadowState.predictions.filter(x=>x.version===YAHOO_SHADOW_VERSION).length,
    evaluated:current.filter(x=>x.status==='evaluated').length,
    invalid:current.filter(x=>x.status==='invalid').length
  };
}
function shadowProof(){
  const out={};
  for(const h of YAHOO_HORIZONS){
    const a=shadowState.outcomes.filter(x=>Number(x.horizon_minutes)===h&&x.version===YAHOO_SHADOW_VERSION&&x.status==='evaluated');
    const n=a.length,hits=a.filter(x=>x.hit===true).length;
    out[String(h)]={
      n,
      hit:n?hits/n:null,
      mean_gross_bps:n?a.reduce((s,x)=>s+Number(x.gross_bps||0),0)/n:null,
      invalid:shadowState.outcomes.filter(x=>Number(x.horizon_minutes)===h&&x.version===YAHOO_SHADOW_VERSION&&x.status==='invalid').length,
      mode:'prospective_nonoverlap_target_time',
      version:YAHOO_SHADOW_VERSION
    };
  }
  return out;
}
function shadowTrail(limit=500,scope='update'){
  const lim=Math.max(1,Math.min(5000,Number(limit)||500));
  const outcomes=shadowState.outcomes.filter(x=>x.version===YAHOO_SHADOW_VERSION).slice(-lim).reverse().map(x=>({
    id:x.id,horizon_minutes:x.horizon_minutes,at:x.at,target_at:x.target_at,entry_price:x.entry_price,dir:x.dir,
    exit_at:x.exit_at||null,exit_price:x.exit_price??null,gross_bps:x.gross_bps??null,hit:x.hit??null,
    status:x.status||'legacy',timing_error_ms:x.timing_error_ms??null,reason:x.reason||null,version:x.version
  }));
  const pending=shadowState.predictions.filter(x=>x.version===YAHOO_SHADOW_VERSION).slice(-120).reverse().map(x=>({
    id:x.id,horizon_minutes:x.horizon_minutes,at:x.at,target_at:x.target_at,entry_price:x.entry_price,dir:x.dir,
    score:x.score??null,threshold:x.threshold??null,margin:x.margin??null,status:'pending',version:x.version
  }));
  return {version:YAHOO_SHADOW_VERSION,scope,proof:shadowProof(),pending,outcomes,updated_at:shadowState.updated_at};
}
function targetYahooEvent(targetMs,horizonMinutes){
  const a=yahooSeries.ORCL||[],late=Math.min(120000,Math.max(30000,Number(horizonMinutes||1)*6000));
  let best=null;
  for(const e of a){
    const t=Number(e.t);if(t<targetMs)continue;if(t>targetMs+late)break;
    if(Number(e.p)>0){best=e;break;}
  }
  return {event:best,max_late_ms:late};
}
function broadcastShadow(){
  const payload={symbol:'ORCL',trail:shadowTrail(180,'update')};
  for(const c of [...clients]){try{sendEvent(c.res,payload,'shadow');}catch{clients.delete(c);try{c.res.end();}catch{}}}
}
async function persistShadow(){
  shadowState.proof=shadowProof();shadowState.updated_at=new Date().toISOString();
  await writeJsonAtomic(SHADOW_PATH,shadowState);
  broadcastShadow();
}
async function loadShadow(){
  const x=await readJson(SHADOW_PATH);
  if(x&&Array.isArray(x.predictions)&&Array.isArray(x.outcomes)){
    shadowState=x;
    shadowState.predictions=shadowState.predictions.filter(p=>p.version===YAHOO_SHADOW_VERSION);
  }
}
function maybeCreateShadowPredictions(fc){
  if(fc?.status!=='ok')return;
  const entry=latestYahooPrice();if(!(entry>0))return;
  const now=Date.now();
  for(const f of fc.forecasts||[]){
    const h=Number(f.horizon_minutes),dir=Number(f.dir);if(!YAHOO_HORIZONS.includes(h)||!dir)continue;
    const gap=h*60000;
    const last=[...shadowState.predictions,...shadowState.outcomes].filter(x=>Number(x.horizon_minutes)===h&&x.version===YAHOO_SHADOW_VERSION).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
    if(last&&now-Date.parse(last.at)<gap)continue;
    shadowState.predictions.push({
      id:'ys-'+h+'-'+now,horizon_minutes:h,at:new Date(now).toISOString(),target_at:new Date(now+h*60000).toISOString(),
      entry_price:entry,dir,score:Number(f.score),threshold:Number(f.threshold),margin:Number(f.margin),
      evaluation_contract:'first_event_at_or_after_target_with_bounded_lateness',version:YAHOO_SHADOW_VERSION
    });
  }
  if(shadowState.predictions.length>1000)shadowState.predictions=shadowState.predictions.slice(-1000);
}
function evaluateShadows(){
  const now=Date.now(),keep=[];
  for(const p of shadowState.predictions){
    const target=Date.parse(p.target_at);
    if(now<target){keep.push(p);continue;}
    const pick=targetYahooEvent(target,p.horizon_minutes),e=pick.event;
    if(!e){
      if(now<=target+pick.max_late_ms){keep.push(p);continue;}
      shadowState.outcomes.push({...p,status:'invalid',exit_at:new Date(now).toISOString(),exit_price:null,gross_bps:null,hit:null,timing_error_ms:null,reason:'target_price_unavailable'});
      continue;
    }
    const price=Number(e.p),gross=Number(p.dir)*Math.log(price/Number(p.entry_price))*10000;
    shadowState.outcomes.push({...p,status:'evaluated',exit_at:new Date(Number(e.t)).toISOString(),exit_price:price,gross_bps:gross,hit:gross>0,timing_error_ms:Number(e.t)-target});
  }
  shadowState.predictions=keep;
  if(shadowState.outcomes.length>5000)shadowState.outcomes=shadowState.outcomes.slice(-5000);
}

function hypothesisCounts(){
  const current=hypothesisState.outcomes.filter(x=>x.version===HYPOTHESIS_VERSION);
  return {pending:hypothesisState.predictions.filter(x=>x.version===HYPOTHESIS_VERSION).length,evaluated:current.filter(x=>x.status==='evaluated').length,invalid:current.filter(x=>x.status==='invalid').length};
}
function hypothesisSummary(){return summarizeHypothesisState(hypothesisState,HYPOTHESIS_COST_BPS);}
function latestHypothesisCandidate(horizon=null){
  const a=hypothesisState.predictions.filter(x=>x.version===HYPOTHESIS_VERSION&&x.strategy===PRODUCTION_STRATEGY&&(horizon==null||Number(x.horizon_minutes)===Number(horizon))).sort((x,y)=>Date.parse(y.at)-Date.parse(x.at));
  const p=a[0]||null;if(!p||Date.now()-Date.parse(p.at)>20000)return null;
  return {dir:p.dir,horizon_minutes:p.horizon_minutes,at:p.at,target_at:p.target_at,margin:p.margin,regime_meta:p.regime_meta,news_context:p.news_context};
}
function hypothesisRecommendation(){
  const s=hypothesisSummary(),h=Number(s.production.selected_horizon),candidate=s.production.enabled?latestHypothesisCandidate(h):latestHypothesisCandidate();
  if(!s.production.enabled||!candidate)return {status:'shadow',action:'WAIT',reason:s.production.enabled?'waiting_fresh_validated_signal':'prospective_gate_not_passed',candidate};
  return {status:'validated',action:candidate.dir>0?'BUY':'SELL',dir:candidate.dir,horizon_minutes:h,at:candidate.at,target_at:candidate.target_at,proof:s.proof[String(h)]?.regime||null,contract:s.contract};
}
function hypothesisTrail(){
  const outcomes=hypothesisState.outcomes.filter(x=>x.version===HYPOTHESIS_VERSION).slice(-120).reverse();
  const pending=hypothesisState.predictions.filter(x=>x.version===HYPOTHESIS_VERSION).slice(-36).reverse();
  const summary=hypothesisSummary();return {...summary,pending,outcomes,recommendation:hypothesisRecommendation()};
}
async function loadHypothesis(){const x=await readJson(HYPOTHESIS_PATH);if(x&&Array.isArray(x.predictions)&&Array.isArray(x.outcomes))hypothesisState=x;}
async function persistHypothesis(){hypothesisState.updated_at=new Date().toISOString();await writeJsonAtomic(HYPOTHESIS_PATH,hypothesisState);}
function latestYahooEvent(){const a=yahooSeries.ORCL||[];return a.length?a.at(-1):null;}
function actionableTargetYahooEvent(targetMs,horizonMinutes){
  const a=yahooSeries.ORCL||[],late=Math.min(120000,Math.max(30000,Number(horizonMinutes||1)*6000));let best=null;
  for(const e of a){const seen=Number(e.recv_at)||Number(e.t);if(seen<targetMs)continue;if(seen>targetMs+late)break;if(Number(e.p)>0){best=e;break;}}
  return {event:best,max_late_ms:late};
}
function maybeCreateHypothesisPredictions(fc){
  if(fc?.status!=='ok')return;
  const e=latestYahooEvent(),now=Date.now();if(!e||!(Number(e.p)>0))return;
  const receiveAge=now-Number(e.recv_at||0),marketAge=now-Number(e.t||0);
  if(receiveAge<0||receiveAge>12000||marketAge<0||marketAge>30000)return;
  const news=actionableNewsContext(sourceState,now);
  for(const f of fc.forecasts||[]){
    const h=Number(f.horizon_minutes),baseDir=Number(f.dir),margin=Number(f.margin);
    if(!YAHOO_HORIZONS.includes(h)||!baseDir||!(margin>=HYPOTHESIS_MIN_MARGIN)||!signalSessionEligible(now,h))continue;
    const dirs=strategyDirections(fc,f);
    for(const strategy of HYPOTHESIS_STRATEGIES){
      const dir=Number(dirs[strategy]);if(dir!==1&&dir!==-1)continue;
      const gap=h*60000;
      const last=[...hypothesisState.predictions,...hypothesisState.outcomes].filter(x=>x.version===HYPOTHESIS_VERSION&&x.strategy===strategy&&Number(x.horizon_minutes)===h).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
      if(last&&now-Date.parse(last.at)<gap)continue;
      hypothesisState.predictions.push({
        id:'hv4-'+strategy+'-'+h+'-'+now,version:HYPOTHESIS_VERSION,strategy,horizon_minutes:h,at:new Date(now).toISOString(),target_at:new Date(now+h*60000).toISOString(),
        entry_price:Number(e.p),entry_market_at:new Date(Number(e.t)).toISOString(),entry_received_at:new Date(Number(e.recv_at)).toISOString(),entry_delivery_lag_ms:Math.max(0,Number(e.recv_at)-Number(e.t)),
        dir,base_dir:baseDir,score:Number(f.score),threshold:Number(f.threshold),margin,regime_meta:strategy==='regime'?dirs.regime_meta:null,news_context:news,
        assumed_roundtrip_cost_bps:HYPOTHESIS_COST_BPS,evaluation_contract:'first_observed_market_event_at_or_after_target_regular_session'
      });
    }
  }
  if(hypothesisState.predictions.length>3000)hypothesisState.predictions=hypothesisState.predictions.slice(-3000);
}
function evaluateHypotheses(){
  const now=Date.now(),keep=[];
  for(const p of hypothesisState.predictions){
    const target=Date.parse(p.target_at);if(now<target){keep.push(p);continue;}
    const pick=actionableTargetYahooEvent(target,p.horizon_minutes),e=pick.event;
    if(!e){
      if(now<=target+pick.max_late_ms){keep.push(p);continue;}
      hypothesisState.outcomes.push({...p,status:'invalid',exit_at:new Date(now).toISOString(),exit_price:null,raw_return_bps:null,gross_bps:null,net_bps:null,direction_hit:null,profitable:null,timing_error_ms:null,reason:'target_price_unavailable'});continue;
    }
    const price=Number(e.p),rawRet=Math.log(price/Number(p.entry_price))*10000,gross=Number(p.dir)*rawRet,net=gross-Number(p.assumed_roundtrip_cost_bps||HYPOTHESIS_COST_BPS);
    hypothesisState.outcomes.push({...p,status:'evaluated',exit_at:new Date(Number(e.recv_at||e.t)).toISOString(),exit_market_at:new Date(Number(e.t)).toISOString(),exit_price:price,raw_return_bps:rawRet,gross_bps:gross,net_bps:net,direction_hit:gross>0,profitable:net>0,timing_error_ms:Number(e.recv_at||e.t)-target});
  }
  hypothesisState.predictions=keep;if(hypothesisState.outcomes.length>12000)hypothesisState.outcomes=hypothesisState.outcomes.slice(-12000);
}
function refreshYahooForecast(){
  if(KEY&&SECRET)return;
  evaluateShadows();
  evaluateHypotheses();
  evaluateV5();
  yahooForecast=forecastYahooShadow(yahooSeries,Date.now(),shadowProof());
  maybeCreateShadowPredictions(yahooForecast);
  maybeCreateHypothesisPredictions(yahooForecast);
  maybeCreateV5Predictions();
}

function v5Counts(){
  const rows=v5State.outcomes.filter(x=>x.version===V5_VERSION);
  return {pending:v5State.predictions.filter(x=>x.version===V5_VERSION).length,evaluated:rows.filter(x=>x.status==='evaluated').length,invalid:rows.filter(x=>x.status==='invalid').length};
}
function v5Summary(force=false){
  const n=v5State.outcomes.length,now=Date.now();
  if(force||!v5SummaryCache||n!==v5SummaryOutcomeCount||now-v5SummaryCacheAt>30000){
    v5SummaryCache=summarizeV5State(v5State);v5SummaryOutcomeCount=n;v5SummaryCacheAt=now;
  }
  return v5SummaryCache;
}
function latestV5Candidate(horizon=null){
  const a=v5State.predictions.filter(x=>x.version===V5_VERSION&&(horizon==null||Number(x.horizon_minutes)===Number(horizon))).sort((x,y)=>Date.parse(y.at)-Date.parse(x.at));
  const p=a[0]||null;if(!p||Date.now()-Date.parse(p.at)>75000)return null;
  return {horizon_minutes:p.horizon_minutes,at:p.at,target_at:p.target_at,barrier_bps:p.barrier_bps,structural_dir:p.structural_dir,structural_score:p.structural_score,
    learned_dir:p.learned_dir,p_up:p.p_up,confidence:p.confidence,model_n:p.model_n,gate_sample:p.gate_sample,features:p.feature_summary};
}
function v5Recommendation(){
  const s=v5Summary(),h=Number(s.production.selected_horizon),candidate=latestV5Candidate(s.production.enabled?h:null);
  if(!s.production.enabled||!candidate||!(Number(candidate.learned_dir)===1||Number(candidate.learned_dir)===-1)){
    return {status:'research',action:'WAIT',reason:s.production.enabled?'waiting_fresh_validated_signal':'prospective_gate_not_passed',candidate};
  }
  return {status:'validated',action:candidate.learned_dir>0?'BUY':'SELL',dir:candidate.learned_dir,horizon_minutes:h,at:candidate.at,target_at:candidate.target_at,
    barrier_bps:candidate.barrier_bps,p_up:candidate.p_up,confidence:candidate.confidence,proof:s.proof[String(h)]?.learned||null,contract:s.contract};
}
function v5Trail(){
  const summary=v5Summary(),pending=v5State.predictions.filter(x=>x.version===V5_VERSION).slice(-24).reverse(),outcomes=v5State.outcomes.filter(x=>x.version===V5_VERSION).slice(-80).reverse();
  return {...summary,counts:v5Counts(),pending,outcomes,recommendation:v5Recommendation(),candidate:latestV5Candidate()};
}
async function loadV5(){
  const dbState=marketDb?loadModelState(marketDb,V5_VERSION):null;
  if(dbState&&(dbState.predictions.length||dbState.outcomes.length)){
    v5State={predictions:dbState.predictions,outcomes:dbState.outcomes,started_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  }else{
    const x=await readJson(V5_PATH);
    if(x&&Array.isArray(x.predictions)&&Array.isArray(x.outcomes)){
      v5State=x;v5State.predictions=v5State.predictions.filter(x=>x.version===V5_VERSION);v5State.outcomes=v5State.outcomes.filter(x=>x.version===V5_VERSION);
    }
  }
  if(!v5State.started_at)v5State.started_at=new Date().toISOString();
}
async function persistV5(){v5State.updated_at=new Date().toISOString();v5Summary(true);await writeJsonAtomic(V5_PATH,v5State);}
function v5LatestPredictionAt(){
  const a=[...v5State.predictions,...v5State.outcomes].filter(x=>x.version===V5_VERSION).sort((x,y)=>Date.parse(y.at)-Date.parse(x.at));return a[0]?Date.parse(a[0].at):0;
}
function maybeCreateV5Predictions(){
  const now=Date.now();
  if(now-V6_RUNTIME_STARTED_AT<V6_CANONICAL_WARMUP_MS)return;
  const entry=latestYahooEvent();if(!entry||!(Number(entry.p)>0))return;
  const marketAt=Number(entry.t),receivedAt=Number(entry.recv_at),receiveAge=now-receivedAt,marketAge=now-marketAt;
  if(!Number.isFinite(marketAt)||!Number.isFinite(receivedAt)||receiveAge<0||receiveAge>12000||marketAge<0||marketAge>30000)return;
  // A stalled feed is not new evidence. Prediction identity and horizon are anchored to
  // the exchange event timestamp, never to polling/receiver wall-clock time.
  const already=[...v5State.predictions,...v5State.outcomes].some(x=>x.version===V5_VERSION&&Number(x.entry_market_ms)===marketAt);
  if(already)return;
  const state=extractV5Features(yahooSeries,marketAt);if(state.status!=='ok')return;
  for(const h of V5_HORIZONS){
    if(!v5SessionEligible(marketAt,h))continue;
    const structuralScore=structuralV5Score(state.features,h),structuralDir=Math.abs(structuralScore)>=.14?Math.sign(structuralScore):0;
    const model=fitV5Logistic(v5State.outcomes,h),learned=predictV5Logistic(model,state.vector),barrier=v5BarrierBps(state,h);
    const lastGate=[...v5State.predictions,...v5State.outcomes].filter(x=>x.version===V5_VERSION&&Number(x.horizon_minutes)===h&&x.gate_sample===true).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
    const gateSample=!lastGate||marketAt-Date.parse(lastGate.at)>=h*60000;
    const prediction={
      id:'v6-'+h+'-'+marketAt,version:V5_VERSION,horizon_minutes:h,at:new Date(marketAt).toISOString(),target_at:new Date(marketAt+h*60000).toISOString(),
      entry_price:Number(entry.p),entry_market_ms:marketAt,entry_market_at:new Date(marketAt).toISOString(),entry_received_at:new Date(receivedAt).toISOString(),
      entry_delivery_lag_ms:Math.max(0,receivedAt-marketAt),barrier_bps:barrier,assumed_roundtrip_cost_bps:V5_COST_BPS,gate_sample:gateSample,
      structural_dir:structuralDir,structural_score:structuralScore,learned_dir:learned.dir,p_up:learned.p_up,confidence:learned.confidence,model_n:learned.model_n||model.n||0,
      model_ready:model.ready===true,clock:'market_event_time',input_contract:'observed_market_events_only',
      feature_names:state.feature_names,feature_vector:state.vector,feature_summary:{residual_bps:state.diagnostics.residual_bps,coupling:state.diagnostics.coupling,
        min_coverage:state.diagnostics.min_coverage,median_delivery_lag_ms:state.diagnostics.median_delivery_lag_ms},
      evaluation_contract:'market_event_time_true_dt_no_synthetic_samples_v3'
    };
    v5State.predictions.push(prediction);
    if(marketDb)persistPrediction(marketDb,prediction);
  }
  if(v5State.predictions.length>5000)v5State.predictions=v5State.predictions.slice(-5000);
}
function evaluateV5(){
  const now=Date.now(),keep=[];
  for(const p of v5State.predictions){
    const r=evaluateV5Path(p,yahooSeries.ORCL||[],now);
    if(r.status==='pending'){keep.push(p);continue;}
    if(r.status==='invalid'){const out={...p,status:'invalid',reason:r.reason||'invalid_path'};v5State.outcomes.push(out);if(marketDb)persistOutcome(marketDb,out);continue;}
    const out={...p,status:'evaluated',endpoint_price:r.endpoint_price,endpoint_at:r.endpoint_at,endpoint_market_at:r.endpoint_market_at,
      endpoint_return_bps:r.endpoint_return_bps,endpoint_received_at:r.endpoint_received_at||null,timing_error_ms:r.timing_error_ms,barrier_label:r.barrier_label,path_label:r.path_label,barrier_hit:r.barrier_hit,barrier_at:r.barrier_at,
      last_before_target_at:r.last_before_target_at||null,mfe_bps:r.mfe_bps,mae_bps:r.mae_bps,structural_gross_bps:r.structural.gross_bps,structural_net_bps:r.structural.net_bps,
      structural_profitable:r.structural.profitable,learned_gross_bps:r.learned.gross_bps,learned_net_bps:r.learned.net_bps,learned_profitable:r.learned.profitable};
    v5State.outcomes.push(out);if(marketDb)persistOutcome(marketDb,out);
  }
  v5State.predictions=keep;if(v5State.outcomes.length>20000)v5State.outcomes=v5State.outcomes.slice(-20000);
}
function yahooModelSummary(){
  const p=shadowProof();
  return {
    provider:'yahoo',feed:'streamer',input_contract:'yahoo_stream_events_no_bar_aggregation',status:'shadow',
    model_id:'yahoo-shadow-'+YAHOO_SHADOW_VERSION,feature_version:YAHOO_SHADOW_VERSION,
    validated_horizons:[],horizons:YAHOO_HORIZONS.map(h=>({horizon_minutes:h,status:'shadow',proof:p[String(h)]||null})),
    production_enabled:false,shadow_only:true,proof:p,generated_at:shadowState.updated_at
  };
}
async function loadRawModel(){
  const live=await readJson(MODEL_PATH),fallback=await readJson(MODEL_FALLBACK);
  rawModel=live||fallback||null;
}
function modelSummary(){
  const hs=Array.isArray(rawModel?.horizons)?rawModel.horizons:[];
  return {provider:'alpaca',feed:FEED,input_contract:'raw_sip_trades_quotes_no_bar_aggregation',status:rawModel?.status||'unavailable',model_id:rawModel?.model_id||null,feature_version:rawModel?.feature_version||null,validated_horizons:hs.filter(h=>h?.status==='validated').map(h=>Number(h.horizon_minutes)).filter(Number.isFinite),horizons:hs.map(h=>({horizon_minutes:Number(h.horizon_minutes),status:h.status||'unproven',reasons:h.reasons||[],holdout_hit:Number(h.proof?.holdout?.hit)||null,holdout_n:Number(h.proof?.holdout?.n)||null})),production_enabled:rawModel?.production?.enabled===true,usable_days:Number(rawModel?.usable_days)||null,generated_at:rawModel?.generated_at||null};
}
function prune(){
  const cut=Date.now()-20*60*1000;
  for(const s of SYMBOLS){
    raw[s].trades=raw[s].trades.filter(x=>Date.parse(x.t||x.timestamp)>=cut);
    raw[s].quotes=raw[s].quotes.filter(x=>Date.parse(x.t||x.timestamp)>=cut);
  }
}
function bestForecast(){
  const a=(rawForecast?.forecasts||[]).filter(x=>Number(x.dir)===1||Number(x.dir)===-1);
  if(!a.length)return null;
  a.sort((x,y)=>(Number(y.margin)||0)-(Number(x.margin)||0)||Number(x.horizon_minutes)-Number(y.horizon_minutes));
  return a[0];
}
function snapshot(symbol){
  const r=raw[symbol];if(!r)return null;
  if(!KEY||!SECRET){
    const m=yahooModelSummary(),best=(yahooForecast?.forecasts||[]).filter(x=>x.dir).sort((a,b)=>(b.margin||0)-(a.margin||0))[0]||null;
    const marketEvent=(yahooSeries[symbol]||[]).at(-1)||null,fxEvent=(yahooSeries['EURUSD=X']||[]).at(-1)||null;
    const marketRecv=Number(marketEvent?.recv_at)||0,marketTime=Number(marketEvent?.t)||0,fxRecv=Number(fxEvent?.recv_at)||0,fxTime=Number(fxEvent?.t)||0;
    const market={price_usd:Number(marketEvent?.p)||null,price_at:marketTime?new Date(marketTime).toISOString():null,received_at:marketRecv?new Date(marketRecv).toISOString():null,
      day_volume:Number.isFinite(Number(marketEvent?.day_volume))?Number(marketEvent.day_volume):null,delta_volume:Number.isFinite(Number(marketEvent?.dv))?Number(marketEvent.dv):null,
      eurusd:Number(fxEvent?.p)||null,eurusd_at:fxTime?new Date(fxTime).toISOString():null,eurusd_received_at:fxRecv?new Date(fxRecv).toISOString():null,fresh:!!marketRecv&&Date.now()-marketRecv<=15000};
    return {provider:'yahoo',feed:'streamer',symbol,mode:'shadow-live',at:marketRecv?new Date(marketRecv).toISOString():null,configured:true,subscription_verified:yahooState==='streaming',auth_state:'no_key_required',auth_error:null,raw:{events:(yahooSeries[symbol]||[]).length,last_upstream_at:marketRecv?new Date(marketRecv).toISOString():null,persistent:true},market,quality:yahooForecast?.quality||{status:'warming'},minutes:[],edge_status:'shadow',edge_model_id:m.model_id,live_signal:null,shadow_signal:best?{dir:best.dir,horizon_minutes:best.horizon_minutes,score:best.score,margin:best.margin,asof:yahooForecast.asof,source:'yahoo_shadow'}:null,wave:m,wave_forecast:yahooForecast,sentiment:sourceSummary(),shadow_trail_summary:{version:YAHOO_SHADOW_VERSION,pending:shadowState.predictions.filter(x=>x.version===YAHOO_SHADOW_VERSION).length,evaluated:shadowState.outcomes.filter(x=>x.version===YAHOO_SHADOW_VERSION&&x.status==='evaluated').length,proof:shadowProof(),updated_at:shadowState.updated_at},hypothesis_v4:{...hypothesisSummary(),counts:hypothesisCounts(),recommendation:hypothesisRecommendation()},research_v5:{...v5Summary(),counts:v5Counts(),recommendation:v5Recommendation(),candidate:latestV5Candidate()},l2:{status:'retired',provider:'databento',reason:'replaced_by_event_wave'}};
  }
  const minutes=aggregateMicrostructure(r.trades,r.quotes);
  const quality=microstructureQuality(minutes,{symbol,feed:FEED,minMinutes:10});
  const best=bestForecast();
  return {
    provider:'alpaca',feed:FEED,symbol,mode:'raw-sip-live',at:new Date().toISOString(),
    configured:!!(KEY&&SECRET),subscription_verified:subscriptionVerified,auth_state:authState,auth_error:authError,
    raw:{trades:r.trades.length,quotes:r.quotes.length,corrections:r.corrections,cancels:r.cancels,last_upstream_at:lastUpstreamAt?new Date(lastUpstreamAt).toISOString():null},
    quality,minutes,
    edge_status:rawModel?.status||'unavailable',edge_model_id:rawModel?.model_id||null,
    live_signal:best?{dir:best.dir,score_bps:best.score_bps,horizon_minutes:best.horizon_minutes,margin:best.margin,asof:rawForecast.asof,model_id:best.model_id,source:'raw_sip'}:null,
    wave:modelSummary(),wave_forecast:rawForecast,sentiment:sourceSummary(),shadow_trail_summary:{version:YAHOO_SHADOW_VERSION,pending:shadowState.predictions.filter(x=>x.version===YAHOO_SHADOW_VERSION).length,evaluated:shadowState.outcomes.filter(x=>x.version===YAHOO_SHADOW_VERSION&&x.status==='evaluated').length,proof:shadowProof(),updated_at:shadowState.updated_at},
    l2:{status:'retired',provider:'databento',reason:'replaced_by_raw_alpaca_sip'}
  };
}
function wgoEventMs(x){
  const direct=Number(x&&x.time);if(Number.isFinite(direct)&&direct>0)return direct;
  for(const k of ['published_at','first_seen_at','at']){const t=Date.parse(x&&x[k]||'');if(Number.isFinite(t))return t;}
  return NaN;
}
function wgoSymbolWindowPrice(symbol,minutes,now=Date.now()){
  const cut=now-minutes*60000,base=(wgoSeries[symbol]&&wgoSeries[symbol].length?wgoSeries[symbol]:yahooSeries[symbol])||[],a=base.filter(e=>Number(e.recv_at||e.t)>=cut&&Number(e.recv_at||e.t)<=now&&Number(e.p)>0);
  if(a.length<2)return {available:false};
  const first=a[0],last=a[a.length-1],p0=Number(first.p),p1=Number(last.p),pct=p0>0?(p1/p0-1)*100:null;
  let hi=-Infinity,lo=Infinity;for(const e of a){const p=Number(e.p);if(p>hi)hi=p;if(p<lo)lo=p;}
  return {available:true,from:p0,to:p1,pct,high:hi,low:lo,events:a.length,from_at:new Date(Number(first.t||first.recv_at)).toISOString(),to_at:new Date(Number(last.t||last.recv_at)).toISOString()};
}
function wgoWindowPrice(minutes,now=Date.now()){return wgoSymbolWindowPrice('ORCL',minutes,now);}
function wgoShockScan(minutes,now=Date.now(),scanHours=18,mode='abs'){
  const span=minutes*60000,scan=scanHours*3600000;
  const a=(wgoSeries.ORCL&&wgoSeries.ORCL.length?wgoSeries.ORCL:yahooSeries.ORCL||[]).filter(e=>{
    const t=Number(e.recv_at||e.t),p=Number(e.p);
    return Number.isFinite(t)&&t>=now-scan-span&&t<=now&&Number.isFinite(p)&&p>0;
  }).sort((x,y)=>Number(x.t||x.recv_at)-Number(y.t||y.recv_at));
  if(a.length<3)return null;
  let j=0,best=null;
  for(let i=1;i<a.length;i++){
    const ti=Number(a[i].t||a[i].recv_at),target=ti-span;
    while(j+1<i&&Number(a[j+1].t||a[j+1].recv_at)<=target)j++;
    const tj=Number(a[j].t||a[j].recv_at);
    if(ti-tj<Math.max(60000,span*.55))continue;
    const p0=Number(a[j].p),p1=Number(a[i].p),pct=p0>0?(p1/p0-1)*100:null;
    if(!Number.isFinite(pct))continue;
    const candidate={pct,from:p0,to:p1,from_at:new Date(tj).toISOString(),to_at:new Date(ti).toISOString(),from_ms:tj,to_ms:ti};
    if(mode==='down'){
      if(pct>=0)continue;
      if(!best||pct<best.pct)best=candidate;
    }else if(mode==='up'){
      if(pct<=0)continue;
      if(!best||pct>best.pct)best=candidate;
    }else if(!best||Math.abs(pct)>Math.abs(best.pct))best=candidate;
  }
  return best;
}
function wgoRecentShock(minutes,now=Date.now()){return wgoShockScan(minutes,now,3,'abs');}
function wgoDayDirectionalShock(minutes,now=Date.now(),direction=-1){return wgoShockScan(minutes,now,18,direction<0?'down':'up');}
function wgoItems(minutes,now=Date.now()){
  const cut=now-minutes*60000;
  return (Array.isArray(sourceState.items)?sourceState.items:[]).filter(x=>{const t=wgoEventMs(x);return Number.isFinite(t)&&t>=cut&&t<=now;}).sort((a,b)=>wgoEventMs(b)-wgoEventMs(a));
}
function wgoContextItems(now=Date.now(),hours=18){
  const cut=now-hours*3600000;
  return (Array.isArray(sourceState.items)?sourceState.items:[]).filter(x=>{const t=wgoEventMs(x);return Number.isFinite(t)&&t>=cut&&t<=now;}).sort((a,b)=>wgoEventMs(b)-wgoEventMs(a));
}
function wgoTone(items){
  let pos=0,neg=0,mixed=0;for(const x of items){const v=termScore(x.summary||x.title||'');if(v>0)pos++;else if(v<0)neg++;else mixed++;}
  return {positive:pos,negative:neg,mixed};
}
async function wgoYahooPreviousClose(symbol){
  const enc=encodeURIComponent(symbol),urls=[
    'https://query1.finance.yahoo.com/v8/finance/chart/'+enc+'?range=5d&interval=1d&includePrePost=false&events=div%2Csplits',
    'https://query2.finance.yahoo.com/v8/finance/chart/'+enc+'?range=5d&interval=1d&includePrePost=false&events=div%2Csplits'
  ];
  for(const url of urls){
    try{
      const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept':'application/json'},signal:AbortSignal.timeout(7000)});
      if(!r.ok)continue;
      const j=await r.json(),x=j?.chart?.result?.[0],m=x?.meta||{};
      for(const v of [m.chartPreviousClose,m.previousClose]){
        const n=Number(v);if(Number.isFinite(n)&&n>0)return n;
      }
      const closes=(x?.indicators?.quote?.[0]?.close||[]).map(Number).filter(n=>Number.isFinite(n)&&n>0);
      if(closes.length>=2)return closes[closes.length-2];
    }catch{}
  }
  return null;
}
async function refreshWgoPreviousCloses(now=Date.now()){
  if(now-Number(wgoPreviousCloseCache.checked_at||0)<5*60000&&wgoPreviousCloseCache.orcl&&wgoPreviousCloseCache.eurusd)return wgoPreviousCloseCache;
  const [orcl,eurusd]=await Promise.all([wgoYahooPreviousClose('ORCL'),wgoYahooPreviousClose('EURUSD=X')]);
  if(orcl&&eurusd)wgoPreviousCloseCache={checked_at:now,orcl,eurusd,source:'yahoo_chart_previous_close'};
  else wgoPreviousCloseCache={...wgoPreviousCloseCache,checked_at:now};
  return wgoPreviousCloseCache;
}
function wgoLatestYahoo(symbol){
  const a=yahooSeries[symbol]||[];return a.length?a[a.length-1]:null;
}
function wgoDayPrice(){
  const live=yahooSeries.ORCL||[],ctx=wgoSeries.ORCL||[],a=live.length?live:ctx,last=a.length?a[a.length-1]:null;if(!last||!(Number(last.p)>0))return {available:false};
  const p=Number(last.p),fxNow=Number(wgoLatestYahoo('EURUSD=X')?.p),base=wgoPreviousCloseCache||{};
  if(Number(base.orcl)>0&&Number(base.eurusd)>0&&fxNow>0){
    const currentEur=p/fxNow,previousEur=Number(base.orcl)/Number(base.eurusd);
    return {available:true,current:p,current_eur:currentEur,previous_close:Number(base.orcl),previous_close_eur:previousEur,pct:(currentEur/previousEur-1)*100,
      at:new Date(Number(last.t||last.recv_at)).toISOString(),currency:'EUR',basis:'yahoo_chart_previous_close_fx'};
  }
  let prev=null,cp=null;
  for(let i=ctx.length-1;i>=0&&!(prev>0);i--){const v=Number(ctx[i].previous_close);if(Number.isFinite(v)&&v>0)prev=v;}
  for(let i=live.length-1;i>=0&&!(prev>0);i--){const v=Number(live[i].previous_close);if(Number.isFinite(v)&&v>0)prev=v;}
  if(!(prev>0)){
    for(let i=ctx.length-1;i>=0&&!Number.isFinite(cp);i--){const v=Number(ctx[i].change_pct);if(Number.isFinite(v))cp=v;}
    for(let i=live.length-1;i>=0&&!Number.isFinite(cp);i--){const v=Number(live[i].change_pct);if(Number.isFinite(v))cp=v;}
  }
  if(prev>0)return {available:true,current:p,previous_close:prev,pct:(p/prev-1)*100,at:new Date(Number(last.t||last.recv_at)).toISOString(),currency:'USD',basis:'stream_previous_close'};
  if(Number.isFinite(cp))return {available:true,current:p,previous_close:null,pct:cp,at:new Date(Number(last.t||last.recv_at)).toISOString(),currency:'USD',basis:'stream_change_pct'};
  const cut=Date.now()-14*3600000,rows=ctx.filter(e=>Number(e.t||e.recv_at)>=cut&&Number(e.p)>0);
  if(rows.length>1){const first=Number(rows[0].p);return {available:true,current:p,previous_close:null,pct:first>0?(p/first-1)*100:null,at:new Date(Number(last.t||last.recv_at)).toISOString(),currency:'USD',basis:'14h_runtime_fallback'};}
  return {available:false,current:p,at:new Date(Number(last.t||last.recv_at)).toISOString()};
}
function wgoMarketContext(minutes,anchorMs){
  const end=Number.isFinite(anchorMs)?anchorMs:Date.now(),qqq=wgoSymbolWindowPrice('QQQ',minutes,end),spy=wgoSymbolWindowPrice('SPY',minutes,end);
  const vals=[qqq,spy].filter(x=>x.available&&Number.isFinite(Number(x.pct))).map(x=>Number(x.pct));
  const avg=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;
  return {qqq,spy,average_pct:avg};
}
function wgoStoryImpact(x,now=Date.now(),direction=0,anchorMs=null){
  const txt=normalizedText(x&&(x.summary||x.title)||''),t=wgoEventMs(x),ageH=Math.max(0,(now-t)/3600000);
  let score=x&&x.type==='news'?4:1;
  const add=(re,n)=>{if(re.test(txt))score+=n;};
  add(/force majeure/,14);add(/project jupiter|jupiter/,10);add(/data center|datacenter|new mexico/,5);
  add(/delay|delayed|permit|pipeline|water|power|infrastructure setback/,4);
  add(/debt|loan|financing|credit|downgrade|junk/,4);add(/layoff|job cut|restructur/,3);
  add(/earnings|guidance|revenue|cloud backlog|contract/,3);
  add(/stock drop|stock fall|shares fall|shares fell|shares drop|slid|selloff|sell-off/,4);
  add(/reuters|bloomberg|financial times|wall street journal|cnbc/,2);
  const sentiment=termScore(txt);if(direction<0&&sentiment<0)score+=3;if(direction>0&&sentiment>0)score+=3;
  score+=Math.max(0,3-ageH/4);
  if(Number.isFinite(anchorMs)&&Number.isFinite(t)){
    const delta=Math.abs(t-anchorMs);
    score+=Math.max(0,5-delta/(90*60000));
    if(t>anchorMs+25*60000)score-=2;
  }
  return score;
}
function wgoCatalyst(items,now=Date.now(),direction=0,anchorMs=null){
  if(!items.length)return null;
  const ranked=items.map(x=>({item:x,score:wgoStoryImpact(x,now,direction,anchorMs)})).sort((a,b)=>b.score-a.score||wgoEventMs(b.item)-wgoEventMs(a.item));
  const top=ranked[0],txt=normalizedText(top.item.summary||top.item.title||'');
  let theme='other',summary=String(top.item.summary||top.item.title||'').replace(/\s+/g,' ').trim();
  if(/force majeure|project jupiter|jupiter|data center|datacenter|new mexico/.test(txt)){
    theme='project_jupiter';
    const related=items.filter(x=>/force majeure|project jupiter|jupiter|data center|datacenter|new mexico/.test(normalizedText(x.summary||x.title||'')));
    summary='Project Jupiter / New-Mexico-Rechenzentrum: Im heutigen Feed häufen sich Meldungen zu Oracles Force-Majeure-Mitteilung sowie Verzögerungs-, Infrastruktur- und Kostenrisiken.';
    return {theme,summary,item:top.item,score:top.score,related_count:related.length,confidence:top.score>=15?'high':'moderate'};
  }
  if(/layoff|job cut|restructur/.test(txt)){theme='restructuring';summary='Restrukturierung/Entlassungen sind heute ein auffälliger negativer Oracle-Themenblock.';}
  else if(/debt|loan|financing|credit|downgrade|junk/.test(txt)){theme='financing';summary='Finanzierungs- und Kreditrisiken rund um Oracle sind heute der auffälligste negative Themenblock.';}
  return {theme,summary,item:top.item,score:top.score,related_count:1,confidence:top.score>=12?'high':top.score>=7?'moderate':'low'};
}
function wgoDeterministic(minutes,now=Date.now()){
  const price=wgoWindowPrice(minutes,now),day=wgoDayPrice(),recentShock=wgoRecentShock(minutes,now),items=wgoItems(minutes,now),contextItems=wgoContextItems(now,18);
  const pct=Number(price.pct),abs=Math.abs(pct||0),dayPct=Number(day.pct),dayDir=Math.sign(dayPct||pct||0),dayShock=dayDir?wgoDayDirectionalShock(minutes,now,dayDir):null;
  const recentPct=Number(recentShock&&recentShock.pct),recentAbs=Math.abs(recentPct||0),dayShockPct=Number(dayShock&&dayShock.pct),dayShockAbs=Math.abs(dayShockPct||0);
  const useDayShock=!!dayShock&&Math.abs(dayPct)>=1&&dayShockAbs>=.35;
  const useRecentShock=!useDayShock&&!!recentShock&&recentAbs>=.25&&(recentAbs>abs+.12||now-recentShock.to_ms>minutes*60000*.55);
  const shock=useDayShock?dayShock:(useRecentShock?recentShock:null),shockPct=Number(shock&&shock.pct),shockAbs=Math.abs(shockPct||0);
  const direction=Math.sign(shock?shockPct:(pct||dayPct||0));
  const anchorMs=shock?shock.from_ms:(price.available?Date.parse(price.from_at):now);
  const tone=wgoTone(contextItems),catalyst=wgoCatalyst(contextItems,now,direction,anchorMs),market=wgoMarketContext(minutes,shock?shock.to_ms:now);
  const move=!price.available?'Für die letzten '+minutes+' Minuten liegt kein ausreichend frischer Kursverlauf vor.':('Kurzfristig: ORCL ist in den letzten '+minutes+' Minuten '+(abs<0.02?'praktisch unverändert':(pct>0?'um '+abs.toFixed(2)+' % gestiegen':'um '+abs.toFixed(2)+' % gefallen'))+' ('+price.from.toFixed(2)+' → '+price.to.toFixed(2)+' USD).');
  let shockSentence='';
  if(shock){
    const t0=new Date(shock.from_ms).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'});
    const t1=new Date(shock.to_ms).toLocaleTimeString('de-DE',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit'});
    shockSentence=useDayShock
      ?(' Der stärkste '+minutes+'-Minuten-'+(shockPct<0?'Abverkauf':'Anstieg')+' heute war '+(shockPct>=0?'+':'')+shockPct.toFixed(2)+' % zwischen '+t0+' und '+t1+'.')
      :(' Der relevante jüngste Impuls war '+(shockPct<0?'ein Rückgang':'ein Anstieg')+' von '+shockAbs.toFixed(2)+' % zwischen '+t0+' und '+t1+'.');
  }
  const daySentence=day.available&&Number.isFinite(Number(day.pct))?(' Heute liegt ORCL gegenüber dem Vortag'+(day.currency==='EUR'?' in EUR':'')+' bei '+(day.pct>=0?'+':'')+Number(day.pct).toFixed(2)+' %.'):'';
  let marketSentence='';
  if(Number.isFinite(market.average_pct)){
    const ref=Math.abs(market.average_pct),orclRef=Math.abs(shock?shockPct:pct||0);
    if(direction&&Math.sign(market.average_pct)===direction&&ref>=.15)marketSentence=' QQQ/SPY liefen im selben Impuls im Mittel '+(market.average_pct>=0?'+':'')+market.average_pct.toFixed(2)+' % – die breite Marktbewegung spielte also mit.';
    if(orclRef>=Math.max(.5,ref*2))marketSentence=' QQQ/SPY bewegten sich im selben Fenster nur etwa '+(market.average_pct>=0?'+':'')+market.average_pct.toFixed(2)+' % – der ORCL-Move war damit deutlich aktienspezifischer.';
  }
  if(!catalyst)return {brief:move+shockSentence+daySentence+marketSentence+' Für den heutigen Move findet der Feed aktuell keinen ausreichend konkreten Unternehmens-Katalysator; deshalb wäre eine Ursachenbehauptung Spekulation.',price,day,shock,market,items:items.slice(0,8),context_items:contextItems.slice(0,12),tone,catalyst:null,evidence:'thin'};
  const topTitle=String(catalyst.item.summary||catalyst.item.title||'').replace(/\s+/g,' ').trim(),topMs=wgoEventMs(catalyst.item),ageMin=Math.max(0,Math.round((now-topMs)/60000)),age=ageMin<60?ageMin+' Min':Math.round(ageMin/60)+' Std';
  const lead=' Tageskontext: '+catalyst.summary;
  const support=catalyst.related_count>1?(' Dazu liegen '+catalyst.related_count+' thematisch passende Meldungen im 18-Stunden-Kontext vor.'):(' Wichtigste Meldung ('+age+' alt): „'+topTitle.slice(0,190)+(topTitle.length>190?'…':'')+'“.');
  const explicit=/after the report|after.*reported|shares?.{0,35}(fell|fall|drop|slid)|stock.{0,35}(fell|fall|drop|slid)/i.test(topTitle);
  const caveat=explicit?' Die Meldung verknüpft den Kursrückgang ausdrücklich mit dem Ereignis.':(catalyst.confidence==='high'?' Das ist der stärkste bekannte Katalysator im heutigen Feed und passt zum Move; zusätzliche Markt- und Positionierungseffekte sind möglich.':' Das passt zur Bewegung, ist aber keine allein bewiesene Ursache.');
  return {brief:move+shockSentence+daySentence+marketSentence+lead+support+caveat,price,day,shock,market,items:items.slice(0,8),context_items:contextItems.slice(0,12),tone,catalyst:{theme:catalyst.theme,score:catalyst.score,confidence:catalyst.confidence,related_count:catalyst.related_count,title:topTitle,url:catalyst.item.url||'',site:catalyst.item.site||'',time:topMs},evidence:catalyst.confidence};
}
async function wgoAiBrief(base){
  const key=String(process.env.OPENAI_API_KEY||'').trim(),model=String(process.env.OPENAI_MODEL||'').trim();if(!key||!model)return null;
  try{
    const payload={model,input:[{role:'system',content:WHATS_GOING_ON_PROMPT},{role:'user',content:JSON.stringify({minutes:base.minutes,price:base.price,day:base.day,shock:base.shock,market:base.market,tone:base.tone,catalyst:base.catalyst,window_items:base.items.map(x=>({title:x.summary||x.title,site:x.site,channel:x.channel,time:wgoEventMs(x)})),day_context:base.context_items.map(x=>({title:x.summary||x.title,site:x.site,channel:x.channel,time:wgoEventMs(x)}))})}],max_output_tokens:360};
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+key},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
    if(!r.ok)return null;const j=await r.json();const txt=String(j.output_text||'').trim();return txt||null;
  }catch{return null;}
}
async function whatsGoingOn(minutes){
  await refreshWgoPreviousCloses();
  const m=minutes===5?5:10,base=wgoDeterministic(m);base.minutes=m;base.generated_at=new Date().toISOString();
  const ai=await wgoAiBrief(base);return {...base,brief:ai||base.brief,mode:ai?'ai':'deterministic',prompt_contract:'short_window_plus_recent_shock_plus_market_and_18h_catalyst_context'};
}

function sendEvent(res,obj,eventName='market'){
  if(res.writableEnded||res.destroyed)return false;
  try{return res.write('event: '+eventName+'\ndata: '+JSON.stringify(obj)+'\n\n');}catch{return false;}
}
function broadcast(){
  prune();
  for(const c of [...clients]){
    try{
      const s=snapshot(c.symbol);
      if(!s||sendEvent(c.res,s)===false){clearInterval(c.heartbeat);clients.delete(c);try{c.res.end();}catch{}}
    }catch{clearInterval(c.heartbeat);clients.delete(c);try{c.res.end();}catch{}}
  }
}
function applyCorrection(symbol,m){
  const a=raw[symbol]?.trades;if(!a)return;
  const i=a.findIndex(t=>Number(t.i)===Number(m.oi)&&String(t.x||'')===String(m.x||''));
  if(i>=0){const old=a[i];a[i]={...old,i:m.ci??old.i,p:m.cp??old.p,s:m.cs??old.s,c:m.cc??old.c};raw[symbol].corrections++;}
}
function applyCancel(symbol,m){
  const a=raw[symbol]?.trades;if(!a)return;
  const i=a.findIndex(t=>Number(t.i)===Number(m.i)&&String(t.x||'')===String(m.x||''));
  if(i>=0){a.splice(i,1);raw[symbol].cancels++;}
}
function scheduleReconnect(){if(reconnectTimer||!KEY||!SECRET)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect();},3000);}
function connect(){
  if(!KEY||!SECRET){authState='awaiting_credentials';return;}
  if(upstream){try{upstream.close();}catch{}}
  authState='connecting';authError=null;subscriptionVerified=false;
  const ws=new WebSocket('wss://stream.data.alpaca.markets/v2/'+FEED);upstream=ws;
  ws.on('open',()=>ws.send(JSON.stringify({action:'auth',key:KEY,secret:SECRET})));
  ws.on('message',buf=>{
    let msgs;try{msgs=JSON.parse(String(buf));}catch{return;}
    for(const m of msgs){
      if(m.T==='success'&&m.msg==='authenticated'){authState='authenticated';ws.send(JSON.stringify({action:'subscribe',trades:SYMBOLS,quotes:SYMBOLS}));}
      else if(m.T==='subscription'){
        const ts=new Set(m.trades||[]),qs=new Set(m.quotes||[]);
        subscriptionVerified=SYMBOLS.every(s=>ts.has(s)&&qs.has(s));authState=subscriptionVerified?'streaming':'subscription_incomplete';
      } else if(m.T==='error'){authError={code:m.code??null,message:m.msg||'unknown'};authState='error';}
      else if(m.T==='t'&&raw[m.S]){raw[m.S].trades.push(m);lastUpstreamAt=Date.now();}
      else if(m.T==='q'&&raw[m.S]){raw[m.S].quotes.push(m);lastUpstreamAt=Date.now();}
      else if(m.T==='c'&&raw[m.S]){applyCorrection(m.S,m);lastUpstreamAt=Date.now();}
      else if(m.T==='x'&&raw[m.S]){applyCancel(m.S,m);lastUpstreamAt=Date.now();}
    }
  });
  ws.on('close',()=>{if(authState!=='awaiting_credentials')authState='disconnected';scheduleReconnect();});
  ws.on('error',e=>{authError={message:String(e?.message||e)};authState='error';scheduleReconnect();});
}
function refreshForecast(){
  if(!KEY||!SECRET){refreshYahooForecast();lastForecastAt=Date.now();return;}
  const s=SYMBOLS[0],r=raw[s];
  if(!subscriptionVerified){rawForecast={status:'blocked',reason:'sip_not_verified'};return;}
  if(!rawModel||rawModel.status!=='validated'||rawModel.production?.enabled!==true){rawForecast={status:'blocked',reason:'model_not_validated',model_status:rawModel?.status||'unavailable'};return;}
  try{rawForecast=forecastRawLatest(r.trades,r.quotes,rawModel);lastForecastAt=Date.now();}
  catch(e){rawForecast={status:'blocked',reason:'runtime_error',error:String(e?.message||e)};}
}
const server=http.createServer((req,res)=>{
  cors(req,res);if(req.method==='OPTIONS'){res.statusCode=204;return res.end();}
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health'){
    const dbStats=marketDb?storeStats(marketDb):null;
    return json(res,200,KEY&&SECRET?{ok:true,provider:'alpaca',feed:FEED,symbols:SYMBOLS,configured:true,auth_state:authState,subscription_verified:subscriptionVerified,upstream_fresh:Date.now()-lastUpstreamAt<15000,last_upstream_at:lastUpstreamAt?new Date(lastUpstreamAt).toISOString():null,primary_runtime:'raw-sip-wave',model:modelSummary(),forecast:{status:rawForecast?.status||'blocked',asof:rawForecast?.asof||null,last_compute_at:lastForecastAt?new Date(lastForecastAt).toISOString():null},sqlite:dbStats,data_contract:{id:V6_CONTRACT_ID,text:V6_CONTRACT_TEXT},setup:'automatic'}:{ok:true,provider:'yahoo',feed:'streamer',symbols:YAHOO_SYMBOLS,configured:true,auth_state:'no_key_required',subscription_verified:yahooState==='streaming',upstream_fresh:Date.now()-yahooLastAt<15000,last_upstream_at:yahooLastAt?new Date(yahooLastAt).toISOString():null,primary_runtime:'yahoo-shadow-wave',model:yahooModelSummary(),forecast:{status:yahooForecast?.status||'blocked',asof:yahooForecast?.asof||null,last_compute_at:lastForecastAt?new Date(lastForecastAt).toISOString():null},shadow:{...shadowCounts(),proof:shadowProof()},sqlite:dbStats,data_contract:{id:V6_CONTRACT_ID,text:V6_CONTRACT_TEXT},setup:'zero-cost / zero-key; Alpaca credentials later upgrade provider automatically'});
  }
  if(u.pathname==='/v1/shadow-history')return json(res,200,shadowTrail());
  if(u.pathname==='/v1/hypothesis-v4')return json(res,200,hypothesisTrail());
  if(u.pathname==='/v1/research-v6'||u.pathname==='/v1/research-v5')return json(res,200,{api_version:'v6',legacy_alias:u.pathname==='/v1/research-v5',...v5Trail()});
  if(u.pathname==='/v1/whats-going-on'){
    const range=String(u.searchParams.get('range')||'').trim();
    if(['1d','1w','1m','year','5y','all'].includes(range)){
      return wgoRangeBackground(range).then(x=>json(res,200,x)).catch(e=>json(res,200,{range,generated_at:new Date().toISOString(),background:'Für diesen Zeitraum konnte der Nachrichtenhintergrund gerade nicht geladen werden.',themes:[],items:[],error:String(e&&e.message||e)}));
    }
    const minutes=10;
    return whatsGoingOn(minutes).then(x=>json(res,200,x)).catch(e=>json(res,200,{minutes,generated_at:new Date().toISOString(),mode:'fallback',brief:'Die Kurzlage konnte gerade nicht vollständig berechnet werden.',error:String(e&&e.message||e)}));
  }
  if(u.pathname==='/v1/source-state')return json(res,200,sourceState);
  if(u.pathname==='/v1/raw-wave-model')return json(res,200,rawModel||{status:'unavailable'});
  if(u.pathname==='/v1/wave-model')return json(res,200,rawModel||{status:'unavailable'});
  if(u.pathname==='/v1/snapshot'){const symbol=(u.searchParams.get('symbol')||'ORCL').toUpperCase(),s=snapshot(symbol);return s?json(res,200,s):json(res,404,{error:'unknown_symbol'});}
  if(u.pathname==='/v1/stream'){
    const origin=req.headers.origin;if(origin&&!ALLOWED.has(origin))return json(res,403,{error:'origin_not_allowed'});
    const symbol=(u.searchParams.get('symbol')||'ORCL').toUpperCase();if(!raw[symbol])return json(res,404,{error:'unknown_symbol'});
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});
    if(typeof res.flushHeaders==='function')res.flushHeaders();
    res.write(': connected\n\n');
    const heartbeat=setInterval(()=>{if(res.writableEnded||res.destroyed)return;try{res.write(': heartbeat '+Date.now()+'\n\n');}catch{}},15000);
    heartbeat.unref?.();
    const c={res,symbol,heartbeat};clients.add(c);
    sendEvent(res,{symbol,sentiment:sourceState},'sources');
    sendEvent(res,{symbol,trail:shadowTrail(5000,'history')},'shadow');
    const cleanup=()=>{clearInterval(heartbeat);clients.delete(c);};
    req.on('close',cleanup);res.on('close',cleanup);res.on('error',cleanup);return;
  }
  json(res,404,{error:'not_found'});
});
await fs.mkdir(DATA_DIR,{recursive:true}).catch(()=>{});
await loadRawModel();
await loadYahooEvents();
await loadShadow();
await loadHypothesis();
await loadV5();
await loadSourceEvents();
refreshSources().catch(()=>{});
if(!KEY||!SECRET){
  console.log(JSON.stringify({
    type:'yahoo-shadow-proof-startup',
    at:new Date().toISOString(),
    ...shadowCounts(),
    proof:shadowProof()
  }));
}
setInterval(loadRawModel,30000).unref();
setInterval(()=>refreshSources().catch(()=>{}),SOURCE_REFRESH_MS).unref();
setInterval(refreshForecast,5000).unref();
setInterval(()=>flushYahooEvents().catch(()=>{}),1000).unref();
setInterval(()=>persistShadow().catch(()=>{}),15000).unref();
setInterval(()=>persistHypothesis().catch(()=>{}),15000).unref();
setInterval(()=>persistV5().catch(()=>{}),15000).unref();
setInterval(()=>flushSourceEvents().catch(()=>{}),5000).unref();
setInterval(()=>{
  if(KEY&&SECRET)return;
  const p=shadowProof();
  console.log(JSON.stringify({
    type:'yahoo-shadow-proof',
    at:new Date().toISOString(),
    ...shadowCounts(),
    proof:p
  }));
  const hv=hypothesisSummary();
  console.log(JSON.stringify({
    type:'yahoo-hypothesis-v4',at:new Date().toISOString(),...hypothesisCounts(),production:hv.production,
    regime:Object.fromEntries(Object.entries(hv.proof).map(([h,x])=>[h,x.regime]))
  }));
  const v5=v5Summary();
  console.log(JSON.stringify({
    type:'yahoo-monetary-v6',at:new Date().toISOString(),...v5Counts(),production:v5.production,
    proof:Object.fromEntries(Object.entries(v5.proof).map(([h,x])=>[h,{model_n:x.model.n,model_ready:x.model.ready,learned:x.learned,structural:x.structural,comparison:x.learned_vs_structural,gate:x.gate}]))
  }));
},60000).unref();
setInterval(broadcast,1000).unref();
setInterval(()=>{if(KEY&&SECRET&&Date.now()-lastUpstreamAt>15000&&authState!=='connecting')connect();},15000).unref();
if(KEY&&SECRET)connect();else connectYahoo();
server.listen(PORT,'0.0.0.0',()=>console.log(JSON.stringify({service:'alantu-market-relay',port:PORT,primary_runtime:KEY&&SECRET?'raw-sip-wave':'yahoo-shadow-wave',provider:KEY&&SECRET?'alpaca':'yahoo',feed:KEY&&SECRET?FEED:'streamer',symbols:KEY&&SECRET?SYMBOLS:YAHOO_SYMBOLS,configured:true,model:KEY&&SECRET?modelSummary():yahooModelSummary()})));
