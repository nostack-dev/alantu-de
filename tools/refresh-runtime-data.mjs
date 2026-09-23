import fs from 'node:fs/promises';

const UA = 'Mozilla/5.0 (compatible; StockstrendRuntime/1.0; +https://www.alantu.de/)';
const BERLIN = 'Europe/Berlin';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v) { return Math.round(v); }
function nowIsoBerlin() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BERLIN, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const x = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const utc = d.getTime();
  const asBerlin = Date.UTC(+x.year, +x.month - 1, +x.day, +x.hour, +x.minute, +x.second);
  const offsetMin = Math.round((asBerlin - utc) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${x.year}-${x.month}-${x.day}T${x.hour}:${x.minute}:${x.second}${sign}${oh}:${om}`;
}
function xmlDecode(s='') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function stripHtml(s='') {
  return xmlDecode(s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
async function fetchText(url, timeoutMs=20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {headers:{'user-agent':UA,'accept':'text/html,application/rss+xml,application/json;q=0.9,*/*;q=0.8'}, signal:ctl.signal});
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
function parseNewsRss(xml) {
  const out = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const item of items) {
    const title = xmlDecode((item.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]||'').replace(/\s+-\s+[^-]+$/, '').trim();
    const link = xmlDecode((item.match(/<link>([\s\S]*?)<\/link>/i)||[])[1]||'').trim();
    const pub = xmlDecode((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)||[])[1]||'').trim();
    const ts = Date.parse(pub);
    if (!title || !link || !Number.isFinite(ts)) continue;
    if (Date.now() - ts > 36*3600e3) continue;
    out.push({title, link, at:new Date(ts).toISOString()});
  }
  const seen = new Set();
  return out.filter(x => {
    const k = x.title.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 20);
}
async function getNews() {
  const urls = [
    'https://news.google.com/rss/search?q=%28Oracle+OR+ORCL%29+stock+when%3A1d&hl=en-US&gl=US&ceid=US%3Aen',
    'https://www.bing.com/news/search?q=Oracle+ORCL+stock&format=rss'
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const items = parseNewsRss(await fetchText(url));
      if (items.length >= 3) return {items, provider:new URL(url).hostname};
      lastErr = new Error('fewer than 3 recent items');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('news unavailable');
}
async function getApeWisdom() {
  try {
    const html = await fetchText('https://apewisdom.io/stocks/ORCL/');
    const text = stripHtml(html);
    const mentions = Number((text.match(/Overall Summary.*?Mentions\s+([\d,]+)/i)||[])[1]?.replace(/,/g,''));
    const sentiment = Number((text.match(/Overall Summary.*?Sentiment\s+([\d]{1,3})%/i)||[])[1]);
    const upvotes = Number((text.match(/Overall Summary.*?Upvotes\s+([\d,]+)/i)||[])[1]?.replace(/,/g,''));
    if (Number.isFinite(mentions) && Number.isFinite(sentiment) && sentiment >= 0 && sentiment <= 100) {
      return {ok:true, mentions, sentiment, upvotes:Number.isFinite(upvotes)?upvotes:null, provider:'apewisdom.io'};
    }
  } catch (e) {
    console.warn('ApeWisdom page unavailable:', e.message);
  }

  // Mentions-only API fallback. We do not invent sentiment if the detail page is unavailable.
  try {
    for (let page=1; page<=6; page++) {
      const raw = await fetchText(`https://apewisdom.io/api/v1.0/filter/all-stocks/page/${page}`);
      const j = JSON.parse(raw);
      const hit = (j.results||[]).find(x => String(x.ticker||'').toUpperCase()==='ORCL');
      if (hit) {
        const mentions = Number(hit.mentions);
        return {ok:true, mentions:Number.isFinite(mentions)?mentions:0, sentiment:null, upvotes:Number(hit.upvotes)||null, provider:'apewisdom.io API'};
      }
      if (page >= Number(j.pages||0)) break;
    }
  } catch (e) {
    console.warn('ApeWisdom API unavailable:', e.message);
  }
  return {ok:false, mentions:0, sentiment:null, upvotes:null, provider:'apewisdom.io'};
}
function classifyHeadline(title) {
  const s = title.toLowerCase();
  const pos = ['beat','beats','growth','surge','surges','rally','rallies','rise','rises','gain','gains','upgrade','upgraded','outperform','strong','record','backlog','contract','deal','boost','expands','expansion','demand','wins','win','bullish','buy rating'];
  const neg = ['debt','risk','risks','fall','falls','drop','drops','decline','declines','downgrade','downgraded','concern','concerns','lawsuit','probe','headwind','headwinds','cost','costs','capex','stress','stressed','junk bond','layoff','layoffs','slump','miss','misses','bearish','sell rating'];
  const p = pos.reduce((n,k)=>n+(s.includes(k)?1:0),0);
  const n = neg.reduce((n,k)=>n+(s.includes(k)?1:0),0);
  return p>n ? 'bull' : n>p ? 'bear' : 'mixed';
}
async function readJson(path) { return JSON.parse(await fs.readFile(path,'utf8')); }
async function writeJson(path, obj) { await fs.writeFile(path, JSON.stringify(obj,null,2)+'\n'); }

const at = nowIsoBerlin();
const [trend, watch, wl, minute, news, reddit] = await Promise.all([
  readJson('stockstrend-data.json'),
  readJson('watchlist-data.json'),
  readJson('watchlist.json'),
  readJson('orcl-minute.json'),
  getNews(),
  getApeWisdom()
]);

const r = minute?.chart?.result?.[0];
const ts = r?.timestamp || [];
const q = r?.indicators?.quote?.[0] || {};
let latestIdx = -1;
for (let i=0;i<ts.length;i++) if (Number.isFinite(Number(q.close?.[i])) && Number(q.close[i])>0) latestIdx=i;
if (latestIdx < 0) throw new Error('No valid ORCL quote in orcl-minute.json');
const price = Number(q.close[latestIdx]);
const priceAt = new Date(Number(ts[latestIdx])*1000).toISOString();

const newsVotes = {bull:0,bear:0,mixed:0};
for (const n of news.items) newsVotes[classifyHeadline(n.title)]++;
if (!reddit.ok && news.items.length < 5) throw new Error('Not enough fresh public signal sources');

let bullWeight = newsVotes.bull * 2;
let bearWeight = newsVotes.bear * 2;
let mixedWeight = newsVotes.mixed * 2;
if (reddit.ok && Number.isFinite(reddit.sentiment)) {
  const rw = clamp(reddit.mentions || 1, 4, 40);
  bullWeight += rw * (reddit.sentiment/100);
  bearWeight += rw * (1-reddit.sentiment/100);
} else if (reddit.ok && reddit.mentions > 0) {
  // Mentions are fresh, but with no fresh sentiment they only improve coverage, not direction.
  mixedWeight += clamp(reddit.mentions, 1, 12) * 0.5;
}
const denom = Math.max(1, bullWeight+bearWeight+mixedWeight);
const bull = round(100*bullWeight/denom);
const bear = round(100*bearWeight/denom);
const mixed = clamp(100-bull-bear,0,100);
const net = bull-bear;
const confidence = clamp(round(48 + Math.min(12,news.items.length)*1.5 + Math.min(20,reddit.mentions||0)*0.6 + (Number.isFinite(reddit.sentiment)?5:0)),45,80);
const socialImpulse = clamp(round(net/5),-20,20);
const signal = net >= 25 && confidence >= 60 ? 'buy' : net <= -25 && confidence >= 60 ? 'sell' : 'hold';
const state = net >= 15 ? 'bullish' : net <= -15 ? 'bearish' : 'mixed';
const direction = net >= 12 ? 'leicht_bullish_risk_on' : net <= -12 ? 'leicht_bearish_risk_off' : 'mixed_cautious';
const magnitude = clamp(round(28 + Math.abs(net)*0.55),25,75);

const snippets = news.items.slice(0,3).map(x=>x.title);
const whyBits = [];
if (Number.isFinite(reddit.sentiment)) whyBits.push(`Reddit ${reddit.sentiment}% positiv bei ${reddit.mentions} Erwähnungen/24h`);
else if (reddit.ok) whyBits.push(`Reddit ${reddit.mentions} Erwähnungen/24h`);
whyBits.push(`${news.items.length} aktuelle Schlagzeilen`);
whyBits.push(`ORCL zuletzt $${price.toFixed(2)}`);
const why = whyBits.join(' · ')+'.';

const evidence = {
  x_posts: 0,
  reddit_posts: reddit.mentions || 0,
  news: news.items.length,
  snippets: [
    ...(Number.isFinite(reddit.sentiment)?[`ApeWisdom: ${reddit.mentions} Mentions/24h, Sentiment ${reddit.sentiment}%`]:[]),
    ...snippets.slice(0,3)
  ]
};
const voices = {
  bull: newsVotes.bull + (Number.isFinite(reddit.sentiment) && reddit.sentiment>=55 ? 1 : 0),
  bear: newsVotes.bear + (Number.isFinite(reddit.sentiment) && reddit.sentiment<=45 ? 1 : 0),
  mixed: newsVotes.mixed + (reddit.ok ? 1 : 0),
  updated_at: at
};

const stock = watch.stocks?.ORCL;
if (!stock) throw new Error('watchlist-data.json missing stocks.ORCL');
stock.latest = {at, signal, social_impulse:socialImpulse, hype_bull:bull, hype_bear:bear, hype_net:net, confidence};
stock.signal = signal;
stock.social_impulse = socialImpulse;
stock.impulse = socialImpulse;
stock.hype_bull = bull;
stock.hype_bear = bear;
stock.hype_net = net;
stock.hype_mixed = mixed;
stock.confidence = confidence;
stock.hype_state = state;
stock.updated_at = at;
stock.why = why;
stock.evidence = evidence;
stock.voices = voices;
stock.price = price;
stock.sentiment_unit = 'percent_all_classified';
stock.history = Array.isArray(stock.history) ? stock.history : [];
if (!stock.history.length || stock.history.at(-1)?.at !== at) {
  stock.history.push({at,hype_bull:bull,hype_bear:bear,hype_net:net,social_impulse:socialImpulse,signal,confidence,hype_mixed:mixed,voice_bull:voices.bull,voice_bear:voices.bear,voice_mixed:voices.mixed,price});
}
watch.updated_at = at;

wl.updated_at = at;

trend.updated_at = at;
trend.timezone = BERLIN;
trend.tick = trend.tick || {};
trend.tick.tick_id = at;
trend.tick.scraped_at = at;
trend.tick.timezone = BERLIN;
trend.tick.sources = {
  PublicReddit: {
    status: reddit.ok ? (Number.isFinite(reddit.sentiment)?'ok':'ok_mentions_only') : 'unavailable',
    items: reddit.mentions || 0,
    provider: reddit.provider,
    window: '24h aggregate snapshot',
    freshest: at,
    sentiment_pct_bullish: Number.isFinite(reddit.sentiment) ? reddit.sentiment : null,
    upvotes_24h: reddit.upvotes
  },
  NewsRSS: {
    status: 'ok',
    items: news.items.length,
    provider: news.provider,
    window: 'last 36h, fetched now',
    freshest: at,
    notes: snippets
  },
  Yahoo: {
    status: 'ok',
    items: 1,
    prices: {ORCL:price},
    price_at: priceAt,
    note: 'Yahoo chart 5d/1m fallback feed'
  }
};
trend.tick.totals = {
  content_items_usable: news.items.length + (reddit.ok?1:0),
  breakdown: {x_trends:0,x_news:0,x_posts:0,reddit:reddit.ok?1:0,tiktok:0,websearch:news.items.length}
};
trend.tick.freshness = {
  freshest_absolute: at,
  primary_signal: `fresh ${reddit.ok?'Reddit aggregate + ':''}News RSS + Yahoo quote`,
  quality: Number.isFinite(reddit.sentiment) ? 'medium-high public sources' : 'medium public sources; Reddit sentiment unavailable',
  scrape_berlin: at,
  sample_window: 'Reddit 24h aggregate; news ≤36h; Yahoo latest available quote',
  freshest_item_age: 'snapshot fetched now',
  oldest_usable_signal: snippets.at(-1) || ''
};
trend.freshness = trend.tick.freshness;
trend.tick.vector = {
  ...(trend.tick.vector||{}),
  direction, magnitude, confidence,
  early_signal: Math.abs(net) >= 12,
  early_signal_note: why
};
trend.tick.stock_signals = [{
  symbol:'ORCL', name:'Oracle', hype_state:state, signal, confidence,
  social_impulse:socialImpulse, hype_bull:bull, hype_bear:bear, hype_net:net,
  why, evidence,
  links:{tradingview:'https://www.tradingview.com/symbols/ORCL/',yahoo:'https://finance.yahoo.com/quote/ORCL'},
  price
}];
trend.history = Array.isArray(trend.history) ? trend.history : [];
if (!trend.history.length || trend.history.at(-1)?.tick_id !== at) {
  trend.history.push({tick_id:at,scraped_at:at,magnitude,confidence,direction,items:trend.tick.totals.content_items_usable,early_signal:Math.abs(net)>=12});
}

const sentimentHistory = Array.isArray(stock.history) ? stock.history : [];
const sentimentHistoryOut = {
  symbol: 'ORCL',
  source: 'watchlist-data.json',
  coverage: {
    points: sentimentHistory.length,
    first_at: sentimentHistory[0]?.at || null,
    last_at: sentimentHistory.at(-1)?.at || null
  },
  history: sentimentHistory
};
const microstructureBootstrap = {
  provider: 'alpaca',
  feed: 'sip',
  symbol: 'ORCL',
  mode: 'awaiting_live_stream',
  configured: false,
  at,
  quality: {status:'unavailable', reasons:['awaiting_railway_sse']},
  minutes: [],
  live_signal: null,
  wave_forecast: {status:'blocked', reason:'awaiting_railway_sse'},
  l2: {status:'retired', provider:'databento', reason:'replaced_by_raw_alpaca_sip'}
};

await Promise.all([
  writeJson('stockstrend-data.json', trend),
  writeJson('watchlist-data.json', watch),
  writeJson('watchlist.json', wl),
  writeJson('orcl-sentiment-history.json', sentimentHistoryOut),
  writeJson('microstructure-current.json', microstructureBootstrap),
  writeJson('runtime-status.json', {
    updated_at: at,
    sources: {
      reddit:{ok:reddit.ok,mentions:reddit.mentions,sentiment:reddit.sentiment,provider:reddit.provider},
      news:{ok:true,count:news.items.length,provider:news.provider},
      yahoo:{ok:true,price,price_at:priceAt}
    },
    derived:{signal,hype_bull:bull,hype_bear:bear,hype_mixed:mixed,hype_net:net,confidence}
  })
]);

console.log(JSON.stringify({updated_at:at,price,reddit,news:news.items.length,newsVotes,bull,bear,mixed,net,confidence,signal},null,2));
