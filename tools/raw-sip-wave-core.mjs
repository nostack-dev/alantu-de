export const RAW_FEATURE_VERSION='raw-sip-hdr-dt-v1';
export const RAW_HORIZONS=[1,5,15,30];
export const RAW_SAMPLE_SECONDS=30;
const NS=1000000000n;

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
export function hdr(a,b){
  a=Number(a);b=Number(b);
  if(!Number.isFinite(a)||!Number.isFinite(b))return 0;
  return clamp((a-b)/(Math.abs(a)+Math.abs(b)+1e-12),-1,1);
}
function safeLog(v){return Math.sign(v)*Math.log1p(Math.abs(v));}
function avg(sum,n){return n>0?sum/n:0;}

export function timestampNs(v){
  const s=String(v||'');
  const m=s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
  if(m){
    const ms=Date.parse(m[1]+'Z');
    if(Number.isFinite(ms))return BigInt(ms)*1000000n+BigInt((m[2]||'').padEnd(9,'0')||'0');
  }
  const ms=Date.parse(s);
  return Number.isFinite(ms)?BigInt(Math.trunc(ms))*1000000n:null;
}
export function nsIso(ns){
  if(typeof ns!=='bigint')ns=BigInt(ns);
  return new Date(Number(ns/1000000n)).toISOString();
}
function lowerBound(a,ns){
  let lo=0,hi=a.length;
  while(lo<hi){const m=(lo+hi)>>1;if(a[m]._ns<ns)lo=m+1;else hi=m;}
  return lo;
}
function upperBound(a,ns){
  let lo=0,hi=a.length;
  while(lo<hi){const m=(lo+hi)>>1;if(a[m]._ns<=ns)lo=m+1;else hi=m;}
  return lo;
}
function prefix(rows,key){
  const p=new Float64Array(rows.length+1);
  for(let i=0;i<rows.length;i++)p[i+1]=p[i]+Number(rows[i][key]||0);
  return p;
}
function rangeSum(p,a,b){return p[b]-p[a];}

export function quoteMetrics(q){
  const bid=Number(q?.bp??q?.bid_price),ask=Number(q?.ap??q?.ask_price);
  const bs=Number(q?.bs??q?.bid_size)||0,as=Number(q?.as??q?.ask_size)||0;
  if(!(bid>0&&ask>0&&ask>=bid))return null;
  const mid=(bid+ask)/2,depth=Math.max(0,bs)+Math.max(0,as);
  const imbalance=depth?((bs-as)/depth):0;
  const micro=depth?(ask*Math.max(0,bs)+bid*Math.max(0,as))/depth:mid;
  return {bid,ask,bs,as,depth,mid,spread_bps:mid?(ask-bid)/mid*10000:0,imbalance,micro_edge_bps:mid?(micro-mid)/mid*10000:0};
}
function ofi(prev,cur){
  if(!prev||!cur)return 0;
  let e=0;
  if(cur.bid>=prev.bid)e+=cur.bs;
  if(cur.bid<=prev.bid)e-=prev.bs;
  if(cur.ask<=prev.ask)e-=cur.as;
  if(cur.ask>=prev.ask)e+=prev.as;
  return e;
}
function tradeSide(t,q,prevPrice){
  const p=Number(t.p??t.price);
  if(!(p>0))return 0;
  if(q){
    if(p>=q.ask)return 1;
    if(p<=q.bid)return -1;
    if(p>q.mid)return 1;
    if(p<q.mid)return -1;
  }
  return prevPrice>0?(p>prevPrice?1:p<prevPrice?-1:0):0;
}

export function prepareRawDay(tradesIn,quotesIn){
  const quotes=(quotesIn||[]).map(q=>({...q,_ns:timestampNs(q.t??q.timestamp)}))
    .filter(q=>q._ns!==null&&quoteMetrics(q)).sort((a,b)=>a._ns<b._ns?-1:a._ns>b._ns?1:0);
  let prevQm=null,prevQns=null;
  for(const q of quotes){
    const m=quoteMetrics(q);
    q._mid=m.mid;q._spread=m.spread_bps;q._qimb=m.imbalance;q._micro=m.micro_edge_bps;q._depth=m.depth;
    q._ofi=(prevQm&&prevQns!==null&&q._ns-prevQns<=5n*NS)?ofi(prevQm,m):0;
    prevQm=m;prevQns=q._ns;
  }

  const trades=(tradesIn||[]).map(t=>({...t,_ns:timestampNs(t.t??t.timestamp)}))
    .filter(t=>t._ns!==null&&Number(t.p??t.price)>0&&Number(t.s??t.size)>0)
    .sort((a,b)=>a._ns<b._ns?-1:a._ns>b._ns?1:0);
  let qi=0,lastQ=null,prevPrice=null;
  for(const t of trades){
    while(qi<quotes.length&&quotes[qi]._ns<=t._ns)lastQ=quotes[qi++];
    const age=lastQ?Number(t._ns-lastQ._ns)/1e6:Infinity;
    const qm=lastQ&&age<=2000?quoteMetrics(lastQ):null;
    const side=tradeSide(t,qm,prevPrice),p=Number(t.p??t.price),s=Number(t.s??t.size);
    t._side=side;t._vol=s;t._signed=side*s;t._notional=p*s;t._signedDollar=side*p*s;t._quoteAgeMs=age;
    prevPrice=p;
  }

  const tp={
    vol:prefix(trades,'_vol'),signed:prefix(trades,'_signed'),notional:prefix(trades,'_notional'),
    signedDollar:prefix(trades,'_signedDollar')
  };
  const qp={
    spread:prefix(quotes,'_spread'),qimb:prefix(quotes,'_qimb'),micro:prefix(quotes,'_micro'),
    ofi:prefix(quotes,'_ofi'),depth:prefix(quotes,'_depth')
  };
  return {trades,quotes,tp,qp};
}
function countBetween(rows,start,end){return upperBound(rows,end)-lowerBound(rows,start);}
function firstLastTrade(ctx,start,end){
  const a=lowerBound(ctx.trades,start),b=upperBound(ctx.trades,end);
  if(b<=a)return null;
  return {first:Number(ctx.trades[a].p??ctx.trades[a].price),last:Number(ctx.trades[b-1].p??ctx.trades[b-1].price),count:b-a,a,b};
}
function quoteAtOrBefore(ctx,ns){
  const i=upperBound(ctx.quotes,ns)-1;
  if(i<0)return null;
  const q=ctx.quotes[i],age=Number(ns-q._ns)/1e6;
  return age<=5000?{q,i,age,...quoteMetrics(q)}:null;
}
function tradeAtOrBefore(ctx,ns){
  const i=upperBound(ctx.trades,ns)-1;
  return i>=0?ctx.trades[i]:null;
}
function currentPrice(ctx,ns){
  const q=quoteAtOrBefore(ctx,ns);if(q&&q.mid>0)return q.mid;
  const t=tradeAtOrBefore(ctx,ns);return t?Number(t.p??t.price):null;
}
function windowStats(ctx,end,durSec){
  const start=end-BigInt(Math.round(durSec*1e9));
  const ta=lowerBound(ctx.trades,start),tb=upperBound(ctx.trades,end),qa=lowerBound(ctx.quotes,start),qb=upperBound(ctx.quotes,end);
  const tc=tb-ta,qc=qb-qa,vol=rangeSum(ctx.tp.vol,ta,tb),signed=rangeSum(ctx.tp.signed,ta,tb);
  const notional=rangeSum(ctx.tp.notional,ta,tb),signedDollar=rangeSum(ctx.tp.signedDollar,ta,tb);
  const depth=rangeSum(ctx.qp.depth,qa,qb),ofiRaw=rangeSum(ctx.qp.ofi,qa,qb);
  const fl=firstLastTrade(ctx,start,end);
  const minutes=Math.max(durSec/60,1/60);
  const vel=fl&&fl.first>0&&fl.last>0?Math.log(fl.last/fl.first)*10000/minutes:0;
  return {
    sec:durSec,trade_count:tc,quote_count:qc,trade_rate:tc/Math.max(.001,durSec),quote_rate:qc/Math.max(.001,durSec),
    volume:vol,signed_ratio:vol?signed/vol:0,signed_dollar_ratio:notional?signedDollar/notional:0,
    qimb:avg(rangeSum(ctx.qp.qimb,qa,qb),qc),micro:avg(rangeSum(ctx.qp.micro,qa,qb),qc),
    spread:avg(rangeSum(ctx.qp.spread,qa,qb),qc),ofi_norm:depth?ofiRaw/depth:0,price_velocity_bps_min:vel
  };
}
function adaptiveWindows(ctx,anchor){
  const recent=60;
  const start=anchor-60n*NS;
  const events=countBetween(ctx.trades,start,anchor)+countBetween(ctx.quotes,start,anchor);
  const rate=Math.max(.05,events/recent);
  let self=clamp(128/rate,2,20);
  let local=clamp(1024/rate,15,180);
  let global=clamp(8192/rate,90,900);
  local=Math.max(local,self*3);
  global=Math.max(global,local*3);
  return {self:Math.min(self,20),local:Math.min(local,180),global:Math.min(global,900),event_rate_60s:rate};
}

export const RAW_FEATURE_NAMES=[
  'log_dt_trade_ms','log_dt_quote_ms','event_rate_60s',
  'flow_self','flow_local','flow_global','hdr_flow_local','hdr_flow_global',
  'ofi_self','ofi_local','ofi_global','hdr_ofi_local','hdr_ofi_global',
  'qimb_self','qimb_local','qimb_global','hdr_qimb_local','hdr_qimb_global',
  'vel_self','vel_local','vel_global','hdr_vel_local','hdr_vel_global',
  'trade_rate_self','trade_rate_local','trade_rate_global','hdr_trade_rate_local','hdr_trade_rate_global',
  'quote_rate_self','quote_rate_local','quote_rate_global','hdr_quote_rate_local','hdr_quote_rate_global',
  'spread_self','micro_self','window_self_s','window_local_s','window_global_s'
];

export function rawFeatureAt(ctx,anchorNs){
  const anchor=typeof anchorNs==='bigint'?anchorNs:BigInt(anchorNs);
  const q=quoteAtOrBefore(ctx,anchor),t=tradeAtOrBefore(ctx,anchor);
  if(!q||!t)return null;
  const dtTrade=Math.max(0,Number(anchor-t._ns)/1e6),dtQuote=Math.max(0,Number(anchor-q.q._ns)/1e6);
  if(dtTrade>5000||dtQuote>5000)return null;
  const w=adaptiveWindows(ctx,anchor),s=windowStats(ctx,anchor,w.self),l=windowStats(ctx,anchor,w.local),g=windowStats(ctx,anchor,w.global);
  if(s.trade_count<2||l.trade_count<5||g.trade_count<20||s.quote_count<5||l.quote_count<20||g.quote_count<50)return null;
  const x=[
    Math.log1p(dtTrade),Math.log1p(dtQuote),safeLog(w.event_rate_60s),
    s.signed_ratio,l.signed_ratio,g.signed_ratio,hdr(s.signed_ratio,l.signed_ratio),hdr(l.signed_ratio,g.signed_ratio),
    s.ofi_norm,l.ofi_norm,g.ofi_norm,hdr(s.ofi_norm,l.ofi_norm),hdr(l.ofi_norm,g.ofi_norm),
    s.qimb,l.qimb,g.qimb,hdr(s.qimb,l.qimb),hdr(l.qimb,g.qimb),
    safeLog(s.price_velocity_bps_min),safeLog(l.price_velocity_bps_min),safeLog(g.price_velocity_bps_min),hdr(s.price_velocity_bps_min,l.price_velocity_bps_min),hdr(l.price_velocity_bps_min,g.price_velocity_bps_min),
    safeLog(s.trade_rate),safeLog(l.trade_rate),safeLog(g.trade_rate),hdr(s.trade_rate,l.trade_rate),hdr(l.trade_rate,g.trade_rate),
    safeLog(s.quote_rate),safeLog(l.quote_rate),safeLog(g.quote_rate),hdr(s.quote_rate,l.quote_rate),hdr(l.quote_rate,g.quote_rate),
    safeLog(s.spread),s.micro,Math.log1p(w.self),Math.log1p(w.local),Math.log1p(w.global)
  ];
  if(!x.every(Number.isFinite))return null;
  return {
    at:nsIso(anchor),anchor_ns:String(anchor),price:q.mid,spread_bps:q.spread_bps,
    x,windows:w,diagnostics:{self:s,local:l,global:g,current_quote_age_ms:q.age,current_trade_age_ms:dtTrade}
  };
}
export function latestRawFeature(trades,quotes){
  const ctx=prepareRawDay(trades,quotes);
  if(!ctx.trades.length||!ctx.quotes.length)return null;
  const anchor=ctx.trades.at(-1)._ns>ctx.quotes.at(-1)._ns?ctx.trades.at(-1)._ns:ctx.quotes.at(-1)._ns;
  return rawFeatureAt(ctx,anchor);
}
function futurePrice(ctx,target){
  const qi=lowerBound(ctx.quotes,target);
  if(qi<ctx.quotes.length&&ctx.quotes[qi]._ns-target<=2n*NS){
    const qm=quoteMetrics(ctx.quotes[qi]);if(qm?.mid>0)return qm.mid;
  }
  const ti=lowerBound(ctx.trades,target);
  if(ti<ctx.trades.length&&ctx.trades[ti]._ns-target<=2n*NS)return Number(ctx.trades[ti].p??ctx.trades[ti].price);
  return null;
}
export function futureReturnBpsRaw(ctx,anchorNs,horizonMinutes,entryPrice=null){
  const anchor=typeof anchorNs==='bigint'?anchorNs:BigInt(anchorNs),p0=Number(entryPrice)||currentPrice(ctx,anchor);
  const p1=futurePrice(ctx,anchor+BigInt(Math.round(horizonMinutes*60*1e9)));
  return p0>0&&p1>0?Math.log(p1/p0)*10000:null;
}
export function extractRawSamples(trades,quotes,{sampleSeconds=RAW_SAMPLE_SECONDS,horizons=RAW_HORIZONS}={}){
  const ctx=prepareRawDay(trades,quotes),out=[];
  if(!ctx.trades.length||!ctx.quotes.length)return out;
  const lo=(ctx.trades[0]._ns>ctx.quotes[0]._ns?ctx.trades[0]._ns:ctx.quotes[0]._ns)+900n*NS;
  const hi=ctx.trades.at(-1)._ns<ctx.quotes.at(-1)._ns?ctx.trades.at(-1)._ns:ctx.quotes.at(-1)._ns;
  const step=BigInt(Math.max(1,Math.round(sampleSeconds)))*NS;
  let a=((lo+step-1n)/step)*step;
  for(;a<=hi;a+=step){
    const f=rawFeatureAt(ctx,a);if(!f)continue;
    const y={};let any=false;
    for(const h of horizons){const r=futureReturnBpsRaw(ctx,a,h,f.price);if(Number.isFinite(r)){y[h]=r;any=true;}}
    if(any)out.push({...f,y});
  }
  return out;
}
function zscore(x,m){return x.map((v,i)=>(v-m.mean[i])/Math.max(1e-12,m.std[i]));}
export function scoreRawFeature(feature,h){const z=zscore(feature.x,h.standardization);let s=h.coefficients[0];for(let i=0;i<z.length;i++)s+=z[i]*h.coefficients[i+1];return s;}
export function forecastRawLatest(trades,quotes,model){
  if(!model||model.feature_version!==RAW_FEATURE_VERSION)return {status:'blocked',reason:'model_contract'};
  const f=latestRawFeature(trades,quotes);if(!f)return {status:'blocked',reason:'insufficient_live_raw_events'};
  const age=Date.now()-Date.parse(f.at);if(!Number.isFinite(age)||age>5000)return {status:'blocked',reason:'stale_live_raw_events',asof:f.at};
  const forecasts=[];
  for(const h of model.horizons||[]){
    if(h?.status!=='validated')continue;
    const score=scoreRawFeature(f,h),thr=Number(h.threshold)||Infinity,dir=Math.abs(score)>=thr?Math.sign(score):0;
    forecasts.push({horizon_minutes:h.horizon_minutes,dir,score_bps:score,threshold_bps:thr,margin:Math.abs(score)/Math.max(1e-9,thr),proof:h.proof||null,model_id:model.model_id});
  }
  return {status:'ok',source:'raw_sip',asof:f.at,windows:f.windows,diagnostics:f.diagnostics,forecasts};
}
