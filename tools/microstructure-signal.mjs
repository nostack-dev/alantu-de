import crypto from 'node:crypto';

function finite(v){return Number.isFinite(Number(v));}
function median(xs){
  const a=(xs||[]).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!a.length)return null; const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function sum(rows,key){return rows.reduce((s,x)=>s+(finite(x?.[key])?Number(x[key]):0),0);}
function sign(v,eps=0){return v>eps?1:v<-eps?-1:0;}

export function microFeatureAt(rows,i){
  if(!Array.isArray(rows)||i<14||i>=rows.length)return null;
  const now=rows[i],short=rows.slice(Math.max(0,i-2),i+1),long=rows.slice(Math.max(0,i-14),i+1);
  const knownS=sum(short,'buy_volume')+sum(short,'sell_volume');
  const knownL=sum(long,'buy_volume')+sum(long,'sell_volume');
  if(!(knownS>0&&knownL>0))return null;
  const agS=(sum(short,'buy_volume')-sum(short,'sell_volume'))/knownS;
  const agL=(sum(long,'buy_volume')-sum(long,'sell_volume'))/knownL;
  const depthS=short.reduce((s,x)=>s+Math.max(1,Number(x.bid_size||0)+Number(x.ask_size||0)),0);
  const ofiS=depthS?sum(short,'ofi')/depthS:0;
  const qimb=median(short.map(x=>x.quote_imbalance_median));
  const micro=median(short.map(x=>x.microprice_edge_bps_median));
  const tcS=sum(short,'trade_count')/Math.max(1,short.length);
  const tcL=sum(long,'trade_count')/Math.max(1,long.length);
  const intensity=tcL>0?tcS/tcL:null;
  const spread=median(short.map(x=>x.spread_bps_median));
  const fresh=short.reduce((s,x)=>s+Number(x.fresh_quote_trades||0),0);
  const stale=short.reduce((s,x)=>s+Number(x.stale_quote_trades||0),0);
  const freshShare=(fresh+stale)>0?fresh/(fresh+stale):0;
  if(![agS,agL,ofiS,qimb,micro,intensity,spread].every(Number.isFinite))return null;
  return {
    at:now.at,price:Number(now.price_last||now.vwap||0),
    aggressor_short:agS,aggressor_long:agL,
    aggressor_accel:agS-agL,
    ofi_norm:ofiS,quote_imbalance:qimb,microprice_edge_bps:micro,
    trade_intensity:intensity,spread_bps:spread,fresh_quote_share:freshShare
  };
}

export function evaluateMicroFeature(f,t){
  if(!f||!t)return null;
  if(f.fresh_quote_share<Number(t.min_fresh_quote_share??.8))return null;
  if(f.trade_intensity<Number(t.min_intensity??1))return null;
  const comps=[
    {v:f.aggressor_accel,min:Number(t.min_aggressor??.1)},
    {v:f.ofi_norm,min:Number(t.min_ofi??.05)},
    {v:f.quote_imbalance,min:Number(t.min_quote??.05)},
    {v:f.microprice_edge_bps,min:Number(t.min_micro_bps??.03)}
  ];
  let up=0,down=0,mag=0;
  for(const c of comps){
    const d=sign(c.v,c.min);
    if(d>0)up++; else if(d<0)down++;
    if(d)mag+=Math.min(3,Math.abs(c.v)/Math.max(1e-9,c.min));
  }
  const need=Number(t.min_consensus??3),dir=up>=need&&up>down?1:down>=need&&down>up?-1:0;
  if(!dir)return null;
  return {dir,strength:mag/Math.max(1,up+down),components:{up,down},feature:f};
}

export function currentMicroSignal(rows,model){
  if(!model||model.status!=='validated'||!model.thresholds)return null;
  for(let i=(rows||[]).length-1;i>=14;i--){
    const f=microFeatureAt(rows,i),s=evaluateMicroFeature(f,model.thresholds);
    if(s)return {...s,asof:f.at,model_id:model.model_id||modelId(model.thresholds,model.horizon_minutes)};
    if(i<(rows||[]).length-3)break;
  }
  return null;
}

export function modelId(thresholds,horizon){
  const payload=JSON.stringify({thresholds,horizon:Number(horizon)});
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0,16);
}
