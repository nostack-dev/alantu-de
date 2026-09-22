export function classifyTrade(trade, quote, prevTradePrice = null) {
  const p = Number(trade?.p ?? trade?.price);
  const bid = Number(quote?.bp ?? quote?.bid_price);
  const ask = Number(quote?.ap ?? quote?.ask_price);
  if (!(p > 0)) return 0;
  if (bid > 0 && ask > 0 && ask >= bid) {
    if (p >= ask) return 1;
    if (p <= bid) return -1;
    const mid = (bid + ask) / 2;
    if (p > mid) return 1;
    if (p < mid) return -1;
  }
  const prev = Number(prevTradePrice);
  if (prev > 0) return p > prev ? 1 : p < prev ? -1 : 0;
  return 0;
}

export function quoteMetrics(q) {
  const bid = Number(q?.bp ?? q?.bid_price);
  const ask = Number(q?.ap ?? q?.ask_price);
  const bs = Number(q?.bs ?? q?.bid_size);
  const as = Number(q?.as ?? q?.ask_size);
  if (!(bid > 0 && ask > 0 && ask >= bid)) return null;
  const mid = (bid + ask) / 2;
  const depth = (bs > 0 ? bs : 0) + (as > 0 ? as : 0);
  const imbalance = depth > 0 ? ((bs || 0) - (as || 0)) / depth : 0;
  const microprice = depth > 0 ? (ask * (bs || 0) + bid * (as || 0)) / depth : mid;
  return {
    bid, ask, bidSize: bs || 0, askSize: as || 0, mid,
    spreadBps: mid > 0 ? (ask - bid) / mid * 10000 : null,
    quoteImbalance: imbalance,
    microprice,
    micropriceEdgeBps: mid > 0 ? (microprice - mid) / mid * 10000 : null
  };
}

export function ofiDelta(prev, cur) {
  const a = quoteMetrics(prev), b = quoteMetrics(cur);
  if (!a || !b) return 0;
  let e = 0;
  if (b.bid >= a.bid) e += b.bidSize;
  if (b.bid <= a.bid) e -= a.bidSize;
  if (b.ask <= a.ask) e -= b.askSize;
  if (b.ask >= a.ask) e += a.askSize;
  return e;
}

function tsNs(x) {
  const s = x?.t ?? x?.timestamp;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
function minuteKey(ms) { return new Date(Math.floor(ms / 60000) * 60000).toISOString(); }
function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
}

export function aggregateMicrostructure(trades, quotes) {
  const tt = (trades || []).map(x=>({...x,_ms:tsNs(x)})).filter(x=>Number.isFinite(x._ms)).sort((a,b)=>a._ms-b._ms);
  const qq = (quotes || []).map(x=>({...x,_ms:tsNs(x)})).filter(x=>Number.isFinite(x._ms)).sort((a,b)=>a._ms-b._ms);
  const buckets = new Map();
  const get = ms => {
    const k = minuteKey(ms);
    if (!buckets.has(k)) buckets.set(k, {
      at:k, tradeCount:0, tradeVolume:0, buyVolume:0, sellVolume:0, unknownVolume:0,
      signedVolume:0, signedDollar:0, notional:0, priceFirst:null, priceLast:null,
      quoteUpdates:0, ofi:0, spreads:[], quoteImbalances:[], microEdges:[],
      bid:null, ask:null, bidSize:null, askSize:null
    });
    return buckets.get(k);
  };

  let prevQ = null;
  for (const q of qq) {
    const qm = quoteMetrics(q);
    if (!qm) continue;
    const b = get(q._ms);
    b.quoteUpdates++;
    if (prevQ) b.ofi += ofiDelta(prevQ, q);
    b.spreads.push(qm.spreadBps);
    b.quoteImbalances.push(qm.quoteImbalance);
    b.microEdges.push(qm.micropriceEdgeBps);
    b.bid=qm.bid; b.ask=qm.ask; b.bidSize=qm.bidSize; b.askSize=qm.askSize;
    prevQ = q;
  }

  let qi = 0, lastQ = null, prevTradePrice = null;
  for (const t of tt) {
    while (qi < qq.length && qq[qi]._ms <= t._ms) { lastQ = qq[qi++]; }
    const p = Number(t.p ?? t.price), size = Number(t.s ?? t.size);
    if (!(p > 0 && size > 0)) continue;
    const side = classifyTrade(t, lastQ, prevTradePrice);
    const b = get(t._ms);
    b.tradeCount++; b.tradeVolume += size; b.notional += p*size;
    b.signedVolume += side*size; b.signedDollar += side*p*size;
    if (side > 0) b.buyVolume += size; else if (side < 0) b.sellVolume += size; else b.unknownVolume += size;
    if (b.priceFirst == null) b.priceFirst = p;
    b.priceLast = p;
    prevTradePrice = p;
  }

  return [...buckets.values()].sort((a,b)=>a.at.localeCompare(b.at)).map(b => {
    const known = b.buyVolume + b.sellVolume;
    const qm = b.bid && b.ask ? quoteMetrics({bp:b.bid,ap:b.ask,bs:b.bidSize,as:b.askSize}) : null;
    return {
      at:b.at,
      trade_count:b.tradeCount,
      trade_volume:b.tradeVolume,
      buy_volume:b.buyVolume,
      sell_volume:b.sellVolume,
      unknown_volume:b.unknownVolume,
      aggressor_imbalance: known ? (b.buyVolume-b.sellVolume)/known : null,
      signed_volume:b.signedVolume,
      signed_dollar:b.signedDollar,
      vwap:b.tradeVolume ? b.notional/b.tradeVolume : null,
      price_first:b.priceFirst,
      price_last:b.priceLast,
      return_1m:b.priceFirst&&b.priceLast ? b.priceLast/b.priceFirst-1 : null,
      quote_updates:b.quoteUpdates,
      ofi:b.ofi,
      spread_bps_median:median(b.spreads),
      quote_imbalance_median:median(b.quoteImbalances),
      microprice_edge_bps_median:median(b.microEdges),
      bid:b.bid, ask:b.ask, bid_size:b.bidSize, ask_size:b.askSize,
      spread_bps_last:qm?.spreadBps ?? null,
      quote_imbalance_last:qm?.quoteImbalance ?? null,
      microprice_edge_bps_last:qm?.micropriceEdgeBps ?? null
    };
  });
}


export function microstructureQuality(minutes, meta = {}) {
  const rows=(minutes||[]).filter(x=>x&&x.at);
  const trades=rows.reduce((s,x)=>s+Number(x.trade_count||0),0);
  const volume=rows.reduce((s,x)=>s+Number(x.trade_volume||0),0);
  const known=rows.reduce((s,x)=>s+Number(x.buy_volume||0)+Number(x.sell_volume||0),0);
  const unknown=rows.reduce((s,x)=>s+Number(x.unknown_volume||0),0);
  const quoted=rows.filter(x=>Number(x.quote_updates||0)>0).length;
  const spreads=rows.map(x=>Number(x.spread_bps_median)).filter(Number.isFinite);
  const freshMs=rows.length?Date.parse(rows[rows.length-1].at):NaN;
  const unknownShare=(known+unknown)>0?unknown/(known+unknown):1;
  const quoteCoverage=rows.length?quoted/rows.length:0;
  const medianSpread=median(spreads);
  const reasons=[];
  if(rows.length<30)reasons.push('too_few_minutes');
  if(trades<100)reasons.push('too_few_trades');
  if(!(volume>0))reasons.push('no_trade_volume');
  if(quoteCoverage<.8)reasons.push('low_quote_coverage');
  if(unknownShare>.2)reasons.push('high_unknown_aggressor_share');
  if(!Number.isFinite(medianSpread)||medianSpread<=0)reasons.push('invalid_spread');
  return {
    status:reasons.length?'insufficient':'usable',
    reasons,
    minutes:rows.length,
    trades,
    volume,
    quote_coverage:quoteCoverage,
    unknown_aggressor_share:unknownShare,
    median_spread_bps:medianSpread,
    first_at:rows[0]?.at||null,
    last_at:rows.at(-1)?.at||null,
    last_at_ms:Number.isFinite(freshMs)?freshMs:null,
    feed:meta.feed||null,
    symbol:meta.symbol||null
  };
}
