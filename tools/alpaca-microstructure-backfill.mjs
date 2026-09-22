import fs from 'node:fs/promises';
import { aggregateMicrostructure } from './microstructure-core.mjs';

const KEY=process.env.APCA_API_KEY_ID||'';
const SECRET=process.env.APCA_API_SECRET_KEY||'';
const FEED=process.env.ALANTU_MARKET_FEED||'sip';
const SYMBOL=(process.env.MICRO_SYMBOL||'ORCL').toUpperCase();
const START=process.env.MICRO_START;
const END=process.env.MICRO_END;
const OUT=process.env.MICRO_OUT||'microstructure-report.json';

if(!KEY||!SECRET){
  console.log('ALANTU microstructure: credentials not configured; no fake fallback used.');
  process.exit(0);
}
if(!START||!END) throw new Error('MICRO_START and MICRO_END are required');

const headers={'APCA-API-KEY-ID':KEY,'APCA-API-SECRET-KEY':SECRET};
async function fetchPaged(kind){
  let token='', rows=[], pages=0;
  do{
    const u=new URL(`https://data.alpaca.markets/v2/stocks/${SYMBOL}/${kind}`);
    u.searchParams.set('start',START); u.searchParams.set('end',END);
    u.searchParams.set('limit','10000'); u.searchParams.set('feed',FEED); u.searchParams.set('sort','asc');
    if(token)u.searchParams.set('page_token',token);
    const r=await fetch(u,{headers});
    if(!r.ok)throw new Error(`${kind} HTTP ${r.status}: ${await r.text()}`);
    const j=await r.json(); rows=rows.concat(j[kind]||[]); token=j.next_page_token||''; pages++;
    if(pages>10000)throw new Error('pagination runaway');
  }while(token);
  return rows;
}
const [trades,quotes]=await Promise.all([fetchPaged('trades'),fetchPaged('quotes')]);
const minutes=aggregateMicrostructure(trades,quotes);
const report={
  symbol:SYMBOL, feed:FEED, start:START, end:END,
  generated_at:new Date().toISOString(),
  raw:{trades:trades.length,quotes:quotes.length},
  minutes
};
await fs.writeFile(OUT,JSON.stringify(report,null,2));
console.log(JSON.stringify({symbol:SYMBOL,feed:FEED,trades:trades.length,quotes:quotes.length,minutes:minutes.length,out:OUT}));
