import http from 'node:http';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import {aggregateMicrostructure,microstructureQuality} from '../tools/microstructure-core.mjs';
import {forecastRawLatest} from '../tools/raw-sip-wave-core.mjs';
import {forecastYahooShadow,YAHOO_HORIZONS,YAHOO_LOCAL,YAHOO_GLOBAL,YAHOO_SHADOW_VERSION} from '../tools/yahoo-shadow-wave-core.mjs';
import {HYPOTHESIS_VERSION,HYPOTHESIS_STRATEGIES,PRODUCTION_STRATEGY,HYPOTHESIS_MIN_MARGIN,DEFAULT_ROUNDTRIP_COST_BPS,signalSessionEligible,strategyDirections,actionableNewsContext,summarizeHypothesisState} from '../tools/yahoo-hypothesis-v4.mjs';

const PORT=Number(process.env.PORT||8080);
const KEY=process.env.APCA_API_KEY_ID||'',SECRET=process.env.APCA_API_SECRET_KEY||'';
const FEED=process.env.ALANTU_MARKET_FEED||'sip';
const SYMBOLS=(process.env.MICRO_SYMBOLS||'ORCL,MSFT,AMZN,GOOGL,NVDA,IGV,QQQ,SPY').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
const YAHOO_SYMBOLS=[...new Set(['ORCL',...YAHOO_LOCAL,...YAHOO_GLOBAL])];
const DATA_DIR=process.env.RAW_SIP_DATA_DIR||'/data/alantu';
const MODEL_PATH=process.env.RAW_SIP_MODEL_OUT||DATA_DIR+'/orcl-raw-sip-model.json';
const MODEL_FALLBACK='/app/orcl-raw-sip-model.json';
const ALLOWED=new Set((process.env.ALLOWED_ORIGINS||'https://www.alantu.de,https://alantu.de').split(',').map(x=>x.trim()).filter(Boolean));
const raw=Object.fromEntries(SYMBOLS.map(s=>[s,{trades:[],quotes:[],corrections:0,cancels:0}]));
const clients=new Set();
let upstream=null,reconnectTimer=null,lastUpstreamAt=0,authState=KEY&&SECRET?'connecting':'awaiting_credentials',authError=null,subscriptionVerified=false;
let rawModel=null,rawForecast={status:'blocked',reason:'model_unavailable'},lastForecastAt=0;
const yahooSeries=Object.fromEntries(YAHOO_SYMBOLS.map(s=>[s,[]]));
const yahooDayVolume=Object.fromEntries(YAHOO_SYMBOLS.map(s=>[s,null]));
let yahooWs=null,yahooReconnect=null,yahooLastAt=0,yahooState='connecting',yahooForecast={status:'blocked',reason:'starting_yahoo_shadow',source:'yahoo_shadow'};
let shadowState={predictions:[],outcomes:[],proof:{},updated_at:null};
let hypothesisState={predictions:[],outcomes:[],updated_at:null};
let eventBuffer=[],sourceEventBuffer=[];
const SHADOW_PATH=DATA_DIR+'/yahoo-shadow-state.json';
const HYPOTHESIS_PATH=DATA_DIR+'/yahoo-hypothesis-v4-state.json';
const YAHOO_DIR=DATA_DIR+'/yahoo-events';
const SOURCE_EVENT_DIR=DATA_DIR+'/source-events';
const HYPOTHESIS_COST_BPS=Math.max(0,Number(process.env.SHADOW_ROUNDTRIP_COST_BPS||DEFAULT_ROUNDTRIP_COST_BPS));
const SOURCE_REFRESH_MS=Math.max(8000,Number(process.env.SOURCE_REFRESH_MS||12000));
const SOURCE_MAX_LIVE_LAG_MS=90*1000;
const SOURCE_MARKET_MATCH_MS=60*1000;
const SOURCE_ARCHIVE_WINDOW_MS=36*3600000;
let sourceRefreshBusy=false,sourceLastLogAt=0,sourceLastEventAt=null,sourcePrimed=false;
const sourceSeen=new Map();
let sourceState={
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
const SENT_NEG=['debt','risk','fall','drop','decline','downgrade','concern','lawsuit','probe','headwind','cost','capex','stress','junk bond','layoff','slump','miss','bearish','sell rating'];
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
function dedupeStories(items){
  const seen=new Set(),out=[];
  for(const x of items||[]){
    const key=normalizedText(x.title);if(!key||seen.has(key))continue;
    seen.add(key);out.push(x);
  }
  return out.sort((a,b)=>Number(b.time||0)-Number(a.time||0));
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
    site:'reddit.com',time:Number(x.created_utc)*1000
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
  u.searchParams.set('max_results','50');u.searchParams.set('tweet.fields','created_at');
  const r=await fetch(u,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error('X HTTP '+r.status);
  const j=await r.json(),cut=Date.now()-SOURCE_ARCHIVE_WINDOW_MS;
  return (j.data||[]).map(x=>({
    title:String(x.text||''),url:'https://x.com/i/web/status/'+x.id,site:'x.com',time:Date.parse(x.created_at||'')
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
    return {title:text,url:handle&&rkey?'https://bsky.app/profile/'+handle+'/post/'+rkey:'',site:'bsky.app',time};
  }).filter(x=>x.title&&Number.isFinite(x.time)&&x.time>=cut&&/\borcl\b|oracle/i.test(x.title));
}
async function blueskyRecent(){
  const [ticker,entity]=await Promise.all([
    optionalSource(()=>blueskySearch('ORCL')),
    optionalSource(()=>blueskySearch('"Oracle" stock shares earnings cloud AI'))
  ]);
  return dedupeStories(ticker.concat(entity)).slice(0,160);
}
async function googleNewsQuery(q){
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
    if(title&&url&&Number.isFinite(time)&&Date.now()-time<=SOURCE_ARCHIVE_WINDOW_MS)out.push({title,url,site:'news.google.com',time});
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
async function optionalSource(fn){try{return await fn();}catch{return [];}}
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
function sourceItem(x,type,now=Date.now(),liveKeys=new Set(),delayedKeys=new Set()){
  const channel=sourceChannel(x,type),lean=termScore(x.title),time=Number(x.time),age=Math.max(0,now-time),key=storyKey(x,type),seen=sourceSeen.get(key);
  return {
    type,channel,title:String(x.title||'').slice(0,320),
    summary:String(x.title||'').replace(/\s+/g,' ').trim().slice(0,260),
    url:String(x.url||''),site:String(x.site||''),time,key,
    live:liveKeys.has(key),new:liveKeys.has(key)||delayedKeys.has(key),delayed:delayedKeys.has(key),
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
  const newsArchive=dedupeStories(news).filter(x=>Number(x.time)>=now-SOURCE_ARCHIVE_WINDOW_MS).map(x=>({...x,_type:'news'}));
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
      version:'source-event-v1',key:item.key,type:item.type,channel:item.channel,title:item.title,url:item.url,site:item.site,lean:item.lean,
      published_at:new Date(Number(item.time)).toISOString(),first_seen_at:item.discovered_at,delivery_lag_ms:item.discovery_delay_ms,
      market_at_published:item.market,market_at_first_seen:item.actionable_market
    });
  }
  const liveItems=archiveItems.filter(x=>x.live);
  const groups={};
  for(const x of liveItems){if(!groups[x.channel])groups[x.channel]=[];groups[x.channel].push(x);}
  const weights={news:1.25,reddit:1,x:1,bluesky:1,social:1};
  let wb=0,wr=0,wm=0,wt=0;
  for(const [channel,items] of Object.entries(groups)){
    const p=channelPulse(items,now);if(!p)continue;
    const w=weights[channel]||1;wb+=p.bull*w;wr+=p.bear*w;wm+=p.mixed*w;wt+=w;
  }
  const bull=wt?Math.round(wb/wt):null,bear=wt?Math.round(wr/wt):null;
  const mixed=wt?Math.max(0,100-bull-bear):null,net=wt?bull-bear:null;
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
    score:net==null?null:Math.max(0,Math.min(100,Math.round(50+net/2))),bull,bear,mixed,net,
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
    const [ttNews,ticker,entity,reddit,x,bluesky,gnews]=await Promise.all([
      optionalSource(()=>tickerTick('(and tt:orcl (or T:curated T:market T:analysis T:industry T:earning T:sec))',160)),
      optionalSource(()=>tickerTick('(and tt:orcl T:ugc)',300)),
      optionalSource(()=>tickerTick('(and E:oracle T:ugc)',300)),
      optionalSource(redditRecent),
      optionalSource(xRecent),
      optionalSource(blueskyRecent),
      optionalSource(googleNewsRecent)
    ]);
    const news=dedupeStories(ttNews.concat(gnews)).slice(0,240);
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
        if(!yahooSeries[e.s]||!(Number(e.t)>0)||!(Number(e.p)>0))continue;
        if(now-Number(e.t)>3*3600000)continue;
        yahooSeries[e.s].push(e);
      }
    }catch{}
  }
  for(const s of YAHOO_SYMBOLS)yahooSeries[s].sort((a,b)=>a.t-b.t);
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
      if(field===3){const sv=(v>>1n)^(-(v&1n)),n=Number(sv);out.time=n<1e12?n*1000:n;}
      else if(field===9)out.dayVolume=Number(v);
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
  const s=String(q.id||'').toUpperCase();if(!yahooSeries[s])return;
  const t=Number(q.time)||Date.now(),p=Number(q.price);if(!(p>0))return;
  const prevV=Number(yahooDayVolume[s]),dayV=Number(q.dayVolume);
  const dv=Number.isFinite(dayV)&&Number.isFinite(prevV)&&dayV>=prevV?dayV-prevV:0;
  if(Number.isFinite(dayV))yahooDayVolume[s]=dayV;
  const e={s,t,p,dv,day_volume:Number.isFinite(dayV)?dayV:null,exchange:q.exchange||null,recv_at:Date.now(),provider:'yahoo_streamer'};
  const a=yahooSeries[s],last=a.at(-1);
  if(last&&last.t===e.t&&last.p===e.p&&last.day_volume===e.day_volume)return;
  a.push(e);const cut=Date.now()-3*3600000;while(a.length&&a[0].t<cut)a.shift();
  eventBuffer.push(e);yahooLastAt=Date.now();yahooState='streaming';
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
function shadowTrail(){
  const outcomes=shadowState.outcomes.filter(x=>x.version===YAHOO_SHADOW_VERSION).slice(-36).reverse().map(x=>({
    id:x.id,horizon_minutes:x.horizon_minutes,at:x.at,target_at:x.target_at,entry_price:x.entry_price,dir:x.dir,
    exit_at:x.exit_at||null,exit_price:x.exit_price??null,gross_bps:x.gross_bps??null,hit:x.hit??null,
    status:x.status||'legacy',timing_error_ms:x.timing_error_ms??null,reason:x.reason||null,version:x.version
  }));
  const pending=shadowState.predictions.filter(x=>x.version===YAHOO_SHADOW_VERSION).slice(-12).reverse();
  return {version:YAHOO_SHADOW_VERSION,proof:shadowProof(),pending,outcomes,updated_at:shadowState.updated_at};
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
  const payload={symbol:'ORCL',trail:shadowTrail()};
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
function latestHypothesisCandidate(){
  const a=hypothesisState.predictions.filter(x=>x.version===HYPOTHESIS_VERSION&&x.strategy===PRODUCTION_STRATEGY).sort((x,y)=>Date.parse(y.at)-Date.parse(x.at));
  const p=a[0]||null;if(!p||Date.now()-Date.parse(p.at)>20000)return null;
  return {dir:p.dir,horizon_minutes:p.horizon_minutes,at:p.at,target_at:p.target_at,margin:p.margin,regime_meta:p.regime_meta,news_context:p.news_context};
}
function hypothesisRecommendation(){
  const s=hypothesisSummary(),candidate=latestHypothesisCandidate(),h=Number(s.production.selected_horizon);
  if(!s.production.enabled||!candidate||Number(candidate.horizon_minutes)!==h)return {status:'shadow',action:'WAIT',reason:s.production.enabled?'waiting_fresh_validated_signal':'prospective_gate_not_passed',candidate};
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
  yahooForecast=forecastYahooShadow(yahooSeries,Date.now(),shadowProof());
  maybeCreateShadowPredictions(yahooForecast);
  maybeCreateHypothesisPredictions(yahooForecast);
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
    return {provider:'yahoo',feed:'streamer',symbol,mode:'shadow-live',at:new Date().toISOString(),configured:true,subscription_verified:yahooState==='streaming',auth_state:'no_key_required',auth_error:null,raw:{events:(yahooSeries[symbol]||[]).length,last_upstream_at:yahooLastAt?new Date(yahooLastAt).toISOString():null,persistent:true},quality:yahooForecast?.quality||{status:'warming'},minutes:[],edge_status:'shadow',edge_model_id:m.model_id,live_signal:null,shadow_signal:best?{dir:best.dir,horizon_minutes:best.horizon_minutes,score:best.score,margin:best.margin,asof:yahooForecast.asof,source:'yahoo_shadow'}:null,wave:m,wave_forecast:yahooForecast,sentiment:sourceSummary(),shadow_trail_summary:{version:YAHOO_SHADOW_VERSION,pending:shadowState.predictions.filter(x=>x.version===YAHOO_SHADOW_VERSION).length,evaluated:shadowState.outcomes.filter(x=>x.version===YAHOO_SHADOW_VERSION&&x.status==='evaluated').length,proof:shadowProof(),updated_at:shadowState.updated_at},hypothesis_v4:{...hypothesisSummary(),counts:hypothesisCounts(),recommendation:hypothesisRecommendation()},l2:{status:'retired',provider:'databento',reason:'replaced_by_event_wave'}};
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
function sendEvent(res,obj,eventName='market'){res.write('event: '+eventName+'\ndata: '+JSON.stringify(obj)+'\n\n');}
function broadcast(){
  prune();
  for(const c of [...clients]){try{const s=snapshot(c.symbol);if(s)sendEvent(c.res,s);}catch{clients.delete(c);try{c.res.end();}catch{}}}
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
    return json(res,200,KEY&&SECRET?{ok:true,provider:'alpaca',feed:FEED,symbols:SYMBOLS,configured:true,auth_state:authState,subscription_verified:subscriptionVerified,upstream_fresh:Date.now()-lastUpstreamAt<15000,last_upstream_at:lastUpstreamAt?new Date(lastUpstreamAt).toISOString():null,primary_runtime:'raw-sip-wave',model:modelSummary(),forecast:{status:rawForecast?.status||'blocked',asof:rawForecast?.asof||null,last_compute_at:lastForecastAt?new Date(lastForecastAt).toISOString():null},setup:'automatic'}:{ok:true,provider:'yahoo',feed:'streamer',symbols:YAHOO_SYMBOLS,configured:true,auth_state:'no_key_required',subscription_verified:yahooState==='streaming',upstream_fresh:Date.now()-yahooLastAt<15000,last_upstream_at:yahooLastAt?new Date(yahooLastAt).toISOString():null,primary_runtime:'yahoo-shadow-wave',model:yahooModelSummary(),forecast:{status:yahooForecast?.status||'blocked',asof:yahooForecast?.asof||null,last_compute_at:lastForecastAt?new Date(lastForecastAt).toISOString():null},shadow:{...shadowCounts(),proof:shadowProof()},setup:'zero-cost / zero-key; Alpaca credentials later upgrade provider automatically'});
  }
  if(u.pathname==='/v1/shadow-history')return json(res,200,shadowTrail());
  if(u.pathname==='/v1/hypothesis-v4')return json(res,200,hypothesisTrail());
  if(u.pathname==='/v1/source-state')return json(res,200,sourceState);
  if(u.pathname==='/v1/raw-wave-model')return json(res,200,rawModel||{status:'unavailable'});
  if(u.pathname==='/v1/wave-model')return json(res,200,rawModel||{status:'unavailable'});
  if(u.pathname==='/v1/snapshot'){const symbol=(u.searchParams.get('symbol')||'ORCL').toUpperCase(),s=snapshot(symbol);return s?json(res,200,s):json(res,404,{error:'unknown_symbol'});}
  if(u.pathname==='/v1/stream'){
    const origin=req.headers.origin;if(origin&&!ALLOWED.has(origin))return json(res,403,{error:'origin_not_allowed'});
    const symbol=(u.searchParams.get('symbol')||'ORCL').toUpperCase();if(!raw[symbol])return json(res,404,{error:'unknown_symbol'});
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');const c={res,symbol};clients.add(c);sendEvent(res,{symbol,sentiment:sourceState},'sources');sendEvent(res,{symbol,trail:shadowTrail()},'shadow');req.on('close',()=>clients.delete(c));return;
  }
  json(res,404,{error:'not_found'});
});
await fs.mkdir(DATA_DIR,{recursive:true}).catch(()=>{});
await loadRawModel();
await loadYahooEvents();
await loadShadow();
await loadHypothesis();
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
},60000).unref();
setInterval(broadcast,1000).unref();
setInterval(()=>{if(KEY&&SECRET&&Date.now()-lastUpstreamAt>15000&&authState!=='connecting')connect();},15000).unref();
if(KEY&&SECRET)connect();else connectYahoo();
server.listen(PORT,'0.0.0.0',()=>console.log(JSON.stringify({service:'alantu-market-relay',port:PORT,primary_runtime:KEY&&SECRET?'raw-sip-wave':'yahoo-shadow-wave',provider:KEY&&SECRET?'alpaca':'yahoo',feed:KEY&&SECRET?FEED:'streamer',symbols:KEY&&SECRET?SYMBOLS:YAHOO_SYMBOLS,configured:true,model:KEY&&SECRET?modelSummary():yahooModelSummary()})));
