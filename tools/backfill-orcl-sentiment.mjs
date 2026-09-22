import fs from 'node:fs/promises';

const OUT='orcl-sentiment-history.json';
const DAY=864e5;
const WINDOW=36*3600e3;
const TARGET_DAYS=370;
const MIN_SOCIAL=50;
const MIN_NEWS=3;
const BERLIN='Europe/Berlin';
const REQUEST_GAP_MS=6500;
const MAX_PAGES=140;
const UA='Mozilla/5.0 (compatible; alantu-sentiment-backfill/1.0; +https://www.alantu.de/)';
const REDDIT_SUBS=['stocks','investing','wallstreetbets','StockMarket','options','ValueInvesting','SecurityAnalysis'];
const ARCTIC='https://arctic-shift.photon-reddit.com/api';

const QUERIES={
  news:'(and tt:orcl (or T:curated T:market T:analysis T:industry T:earning T:sec))',
  tickerSocial:'(and tt:orcl T:ugc)',
  entitySocial:'(and E:oracle T:ugc)'
};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
let lastRequestAt=0;

async function readExisting(){
  try{return JSON.parse(await fs.readFile(OUT,'utf8'));}catch{return null;}
}
async function writeJson(path,obj){await fs.writeFile(path,JSON.stringify(obj,null,2)+'\n');}
function titleKey(s=''){return String(s).replace(/\s+/g,' ').trim().toLowerCase().replace(/[^a-z0-9$]+/g,' ').trim();}
function socialRelevantText(text=''){
  const x=String(text).toLowerCase();
  return /\$orcl\b|\borcl\b/.test(x)||(x.includes('oracle')&&/(stock|share|earn|cloud|database|ai|market|bull|bear|buy|sell|valuation|price|revenue|growth)/.test(x));
}
function classifyHeadline(title=''){
  const s=String(title).toLowerCase();
  const pos=['beat','beats','growth','surge','surges','rally','rallies','rise','rises','gain','gains','upgrade','upgraded','outperform','strong','record','backlog','contract','deal','boost','expands','expansion','demand','wins','win','bullish','buy rating'];
  const neg=['debt','risk','risks','fall','falls','drop','drops','decline','declines','downgrade','downgraded','concern','concerns','lawsuit','probe','headwind','headwinds','cost','costs','capex','stress','stressed','junk bond','layoff','layoffs','slump','miss','misses','bearish','sell rating'];
  let p=0,n=0;
  for(const k of pos)if(s.includes(k))p++;
  for(const k of neg)if(s.includes(k))n++;
  return p>n?'bull':n>p?'bear':'mixed';
}
function recencyWeight(time,anchor){
  const age=Math.max(0,anchor-Number(time||0));
  if(age<=2*3600e3)return 1.5;
  if(age<=8*3600e3)return 1.25;
  if(age<=24*3600e3)return 1;
  return 0.65;
}
function entityRelevant(x){return socialRelevantText(x?.title||'');}
function dedupe(items){
  const seen=new Set(),out=[];
  for(const x of items){
    const k=titleKey(x?.title);
    if(!k||seen.has(k))continue;
    seen.add(k);out.push(x);
  }
  return out;
}
function berlinParts(ms){
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:BERLIN,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  }).formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
function offsetAt(ms){
  const p=berlinParts(ms);
  return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-ms;
}
function berlinLocalToUtc(y,m,d,h=22){
  const localAsUtc=Date.UTC(y,m-1,d,h,0,0);
  let utc=localAsUtc-offsetAt(localAsUtc);
  utc=localAsUtc-offsetAt(utc);
  return utc;
}
function dailyAnchors(now=Date.now()){
  const p=berlinParts(now);
  const todayPseudo=Date.UTC(+p.year,+p.month-1,+p.day);
  const out=[];
  for(let back=365;back>=0;back--){
    const d=new Date(todayPseudo-back*DAY);
    const anchor=berlinLocalToUtc(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),22);
    if(anchor<=now)out.push(anchor);
  }
  return out;
}
async function throttledFetch(url){
  const wait=Math.max(0,REQUEST_GAP_MS-(Date.now()-lastRequestAt));
  if(wait)await sleep(wait);
  let lastErr;
  for(let attempt=1;attempt<=3;attempt++){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),35000);
    try{
      lastRequestAt=Date.now();
      const r=await fetch(url,{headers:{'user-agent':UA,'accept':'application/json'},signal:ctl.signal});
      if(!r.ok)throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){
      lastErr=e;
      await sleep(attempt*2500);
    }finally{clearTimeout(timer);}
  }
  throw lastErr;
}
let archiveLastRequestAt=0;
async function archiveFetch(url){
  const wait=Math.max(0,700-(Date.now()-archiveLastRequestAt));
  if(wait)await sleep(wait);
  let lastErr;
  for(let attempt=1;attempt<=3;attempt++){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),45000);
    try{
      archiveLastRequestAt=Date.now();
      const r=await fetch(url,{headers:{'user-agent':UA,'accept':'application/json'},signal:ctl.signal});
      if(!r.ok)throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){
      lastErr=e;await sleep(attempt*1800);
    }finally{clearTimeout(timer);}
  }
  throw lastErr;
}
async function fetchRedditArchive(cutoff,now){
  const out=[],seen=new Set();
  const after=Math.floor((cutoff-WINDOW)/1000),before=Math.ceil(now/1000);
  for(const sub of REDDIT_SUBS){
    for(const mode of ['posts','comments']){
      try{
        const u=new URL(ARCTIC+'/api/'+mode+'/search');
        u.searchParams.set('subreddit',sub);
        u.searchParams.set('after',String(after));
        u.searchParams.set('before',String(before));
        u.searchParams.set('sort','asc');
        u.searchParams.set('limit','auto');
        if(mode==='posts')u.searchParams.set('query','ORCL OR Oracle');
        else u.searchParams.set('body','ORCL OR Oracle');
        const j=await archiveFetch(u.toString()),arr=Array.isArray(j?.data)?j.data:[];
        let kept=0;
        for(const x of arr){
          const time=Number(x?.created_utc)*1000;
          const text=mode==='posts'?[x?.title,x?.selftext].filter(Boolean).join(' '):String(x?.body||'');
          if(!Number.isFinite(time)||time<cutoff-WINDOW||time>now||!socialRelevantText(text))continue;
          const key=(mode+':'+String(x?.id||''))||titleKey(text);
          if(seen.has(key))continue;seen.add(key);
          out.push({id:key,title:text,url:'https://www.reddit.com/r/'+sub,site:'reddit.com/r/'+sub,time,provider:'Reddit archive'});kept++;
        }
        console.log('Reddit archive',sub,mode,'raw',arr.length,'kept',kept);
      }catch(e){
        console.warn('Reddit archive failed',sub,mode,e.message);
      }
    }
  }
  out.sort((a,b)=>a.time-b.time);
  return out;
}
async function fetchPaged(query,label,cutoff){
  const out=[],seenIds=new Set();
  let last=null,prevLast=null,pages=0,oldest=Infinity;
  while(pages<MAX_PAGES){
    const u=new URL('https://api.tickertick.com/feed');
    u.searchParams.set('q',query);u.searchParams.set('n','200');
    if(last)u.searchParams.set('last',last);
    const j=await throttledFetch(u.toString());
    const arr=Array.isArray(j?.stories)?j.stories:[];
    pages++;
    for(const x of arr){
      const time=Number(x?.time);
      if(!Number.isFinite(time)||time<=0)continue;
      oldest=Math.min(oldest,time);
      const id=String(x.id??(time+'|'+titleKey(x.title)));
      if(seenIds.has(id))continue;
      seenIds.add(id);
      if(time>=cutoff-WINDOW)out.push({id,title:String(x.title||''),url:String(x.url||''),site:String(x.site||''),time});
    }
    console.log(label,'page',pages,'items',arr.length,'kept',out.length,'oldest',Number.isFinite(oldest)?new Date(oldest).toISOString():'—');
    if(!arr.length||oldest<=cutoff-WINDOW)break;
    last=String(j?.last_id??arr.at(-1)?.id??'');
    if(!last||last===prevLast)break;
    prevLast=last;
  }
  out.sort((a,b)=>a.time-b.time);
  return {items:out,pages,oldest:Number.isFinite(oldest)?oldest:null};
}
function pointAt(anchor,newsAll,social1All,social2All,redditAll){
  const start=anchor-WINDOW;
  const news=newsAll.filter(x=>x.time>start&&x.time<=anchor);
  const s1=social1All.filter(x=>x.time>start&&x.time<=anchor);
  const s2=social2All.filter(x=>x.time>start&&x.time<=anchor&&entityRelevant(x));
  const sr=redditAll.filter(x=>x.time>start&&x.time<=anchor);
  const social=dedupe(s1.concat(s2,sr));
  if(social.length<MIN_SOCIAL||news.length<MIN_NEWS)return null;

  const votes={bull:0,bear:0,mixed:0};
  for(const x of news)votes[classifyHeadline(x.title)]+=recencyWeight(x.time,anchor);
  for(const x of social)votes[classifyHeadline(x.title)]+=2*recencyWeight(x.time,anchor);
  const total=Math.max(1,votes.bull+votes.bear+votes.mixed);
  const bull=Math.round(100*votes.bull/total);
  const bear=Math.round(100*votes.bear/total);
  const mixed=clamp(100-bull-bear,0,100);
  const net=bull-bear;
  const confidence=clamp(Math.round(42+Math.min(30,news.length)*0.55+Math.min(120,social.length)*0.28),50,90);
  const signal=net>=25&&confidence>=60?'buy':net<=-25&&confidence>=60?'sell':'hold';
  return {
    at:new Date(anchor).toISOString(),
    signal,
    social_impulse:clamp(Math.round(net/5),-20,20),
    hype_bull:bull,hype_bear:bear,hype_mixed:mixed,hype_net:net,confidence,
    news_count:news.length,social_count:social.length,
    source:'tickertick_plus_reddit_archive_historical_replay',
    sample_window_hours:36
  };
}

const now=Date.now();
const cutoff=now-TARGET_DAYS*DAY;
const existing=await readExisting();
if(existing?.generated_at&&Array.isArray(existing.history)&&existing.history.length){
  const age=now-Date.parse(existing.generated_at);
  const oldest=Date.parse(existing.history[0]?.at||'');
  if(age<21*DAY&&Number.isFinite(oldest)&&oldest<=now-330*DAY){
    console.log('Historical sentiment backfill already sufficient; keeping',existing.history.length,'points from',existing.history[0].at);
    process.exit(0);
  }
}

console.log('Backfilling ORCL sentiment from',new Date(cutoff).toISOString(),'with live-equivalent rules');
const news=await fetchPaged(QUERIES.news,'news',cutoff);
const s1=await fetchPaged(QUERIES.tickerSocial,'ORCL UGC',cutoff);
const s2=await fetchPaged(QUERIES.entitySocial,'Oracle entity UGC',cutoff);
const reddit=await fetchRedditArchive(cutoff,now);

const anchors=dailyAnchors(now);
const history=anchors.map(a=>pointAt(a,news.items,s1.items,s2.items,reddit)).filter(Boolean);
if(!history.length){
  console.warn('Historical replay produced zero points meeting the unchanged 50-social/3-news gate; leaving prior backfill untouched.');
  process.exit(0);
}

const oldestRaw=Math.min(...[news.oldest,s1.oldest,s2.oldest].filter(Number.isFinite));
const oldestPoint=Date.parse(history[0].at);
const newestPoint=Date.parse(history.at(-1).at);
const skipped=anchors.length-history.length;
const out={
  schema_version:1,
  symbol:'ORCL',
  generated_at:new Date(now).toISOString(),
  timezone:BERLIN,
  method:'historical replay of live 36h sentiment rules; no look-ahead',
  rules:{
    news_query:QUERIES.news,
    social_queries:[QUERIES.tickerSocial,QUERIES.entitySocial,'Reddit archive: ORCL/Oracle in finance subreddits'],
    social_min:MIN_SOCIAL,news_min:MIN_NEWS,social_vote_factor:2,
    recency_weights:{lte_2h:1.5,lte_8h:1.25,lte_24h:1,lte_36h:0.65},
    anchor:'22:00 Europe/Berlin daily',
    classifier:'same keyword classifier as browser live sentiment'
  },
  raw:{
    news:news.items.length,ticker_social:s1.items.length,entity_social:s2.items.length,reddit_archive_social:reddit.length,
    pages:{news:news.pages,ticker_social:s1.pages,entity_social:s2.pages},
    oldest_source_at:Number.isFinite(oldestRaw)?new Date(oldestRaw).toISOString():null
  },
  coverage:{
    requested_days:365,
    valid_points:history.length,
    skipped_points:skipped,
    oldest_point_at:new Date(oldestPoint).toISOString(),
    newest_point_at:new Date(newestPoint).toISOString(),
    point_span_days:Math.round((newestPoint-oldestPoint)/DAY)
  },
  history
};
await writeJson(OUT,out);
console.log('Wrote',OUT,out.coverage);
