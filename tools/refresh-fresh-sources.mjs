import fs from 'node:fs/promises';

const queries = [
  ['news', '(and tt:orcl (or T:curated T:market T:analysis T:industry T:earning T:sec))', 100],
  ['ticker', '(and tt:orcl T:ugc)', 200],
  ['entity', '(and E:oracle T:ugc)', 200],
];
const cutoff = Date.now() - 36 * 3600_000;
async function readFeed(query, limit) {
  const url = new URL('https://api.tickertick.com/feed');
  url.searchParams.set('q', query);
  url.searchParams.set('n', String(limit));
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`TickerTick HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.stories)) throw new Error('TickerTick stories missing');
  return body.stories.map(x => ({ title: String(x.title || ''), url: String(x.url || ''), site: String(x.site || ''), time: Number(x.time) }))
    .filter(x => x.title && Number.isFinite(x.time) && x.time >= cutoff && x.time <= Date.now() + 60000);
}
const [news, ticker, entity] = await Promise.all(queries.map(([, q, n]) => readFeed(q, n)));
const relevant = entity.filter(x => /\$orcl\b|\borcl\b/i.test(x.title) || (/oracle/i.test(x.title) && /stock|share|earn|cloud|ai|market|bull|bear|buy|sell|valuation|price/i.test(x.title)));
const seen = new Set();
const social = ticker.concat(relevant).filter(x => {
  const key = x.title.toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim();
  if (!key || seen.has(key)) return false;
  seen.add(key); return true;
}).sort((a, b) => b.time - a.time).slice(0, 300);

const data = { fetched_at: new Date().toISOString(), providers: ['TickerTick News', 'TickerTick ORCL UGC', 'TickerTick Oracle Entity UGC'], news_providers: ['TickerTick News'], social_providers: ['TickerTick ORCL UGC', 'TickerTick Oracle Entity UGC'], social_breakdown: { ticker: ticker.length, entity: relevant.length }, sufficient: news.length > 0 || social.length > 0, news, social };
await fs.writeFile('fresh-sources.json', JSON.stringify(data) + '\n');
console.log(`Fresh source snapshot: ${news.length} news, ${social.length} social`);
