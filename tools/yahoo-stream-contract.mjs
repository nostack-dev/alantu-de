export const YAHOO_EVENT_CONTRACT='yahoo-stream-sint64-first-timestamp-v1';
export function zigZag64(v){v=BigInt(v);return Number((v>>1n)^(-(v&1n)));}
export function finiteNonNegative(v){if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)&&n>=0?n:null;}
export function canonicalVolumeDelta(prevDayVolume,currentDayVolume){
  const prev=finiteNonNegative(prevDayVolume),cur=finiteNonNegative(currentDayVolume);
  if(cur==null||prev==null||cur<prev)return 0;
  return cur-prev;
}
export function canonicalEventCheck(last,e,recvAt=Date.now()){
  const t=Number(e?.t),p=Number(e?.p),recv=Number(recvAt);
  if(!(t>0))return {accept:false,reason:'missing_market_timestamp'};
  if(!(p>0))return {accept:false,reason:'invalid_price'};
  if(Number.isFinite(recv)){
    if(t>recv+5000)return {accept:false,reason:'future_market_timestamp'};
    if(recv-t>120000)return {accept:false,reason:'excessive_delivery_lag'};
  }
  if(last){
    const lt=Number(last.t),lp=Number(last.p);
    if(t<lt)return {accept:false,reason:'out_of_order'};
    if(t===lt)return {accept:false,reason:'duplicate_market_timestamp'};
    const dt=t-lt;
    if(lp>0&&dt>0&&dt<=10000){
      const jump=Math.abs(Math.log(p/lp))*10000;
      if(jump>500)return {accept:false,reason:'implausible_sub10s_jump',jump_bps:jump};
    }
  }
  return {accept:true,reason:null};
}
export function normalizeLegacyYahooEvent(e){
  if(!e||typeof e!=='object')return e;
  if(e.event_contract===YAHOO_EVENT_CONTRACT)return e;
  if(String(e.provider||e.source||'').includes('yahoo')){
    const x={...e,event_contract:'legacy-normalized-at-load'};
    const day=finiteNonNegative(x.day_volume),dv=finiteNonNegative(x.dv);
    if(day!=null)x.day_volume=day/2;
    if(dv!=null)x.dv=(day!=null&&Math.abs(dv-day)<1e-9)?0:dv/2;
    return x;
  }
  return e;
}
