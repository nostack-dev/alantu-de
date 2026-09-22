import http from 'node:http';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import { aggregateMicrostructure, microstructureQuality } from '../tools/microstructure-core.mjs';
import { currentMicroSignal } from '../tools/microstructure-signal.mjs';
import { forecastL2Event, validateL2ModelContract } from '../tools/l2-event-signal.mjs';

const PORT=Number(process.env.PORT||8080);
const KEY=process.env.APCA_API_KEY_ID||'',SECRET=process.env.APCA_API_SECRET_KEY||'';
const FEED=process.env.ALANTU_MARKET_FEED||'sip';
const SYMBOLS=(process.env.MICRO_SYMBOLS||'ORCL').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
const EDGE_PATH=process.env.EDGE_STATUS_PATH||'/app/microstructure-edge-status.json';
const EDGE_URL=process.env.EDGE_STATUS_URL||'https://www.alantu.de/microstructure-edge-status.json';
const L2_MODEL_PATH=process.env.L2_MODEL_PATH||'/app/orcl-l2-model.json';
const L2_MODEL_URL=process.env.L2_MODEL_URL||'https://www.alantu.de/orcl-l2-model.json';
const L2_INGEST_TOKEN=process.env.L2_INGEST_TOKEN||'';
const ALLOWED=new Set((process.env.ALLOWED_ORIGINS||'https://www.alantu.de,https://alantu.de').split(',').map(x=>x.trim()).filter(Boolean));
const raw=Object.fromEntries(SYMBOLS.map(s=>[s,{trades:[],quotes:[]}]));
const l2Raw=Object.fromEntries(SYMBOLS.map(s=>[s,[]]));
const clients=new Set();
let upstream=null,edgeModel=null,l2Model=null,lastUpstreamAt=0,lastL2At=0,reconnectTimer=null;

function cors(req,res){
  const o=req.headers.origin;
  if(o&&ALLOWED.has(o)){res.setHeader('Access-Control-Allow-Origin',o);res.setHeader('Vary','Origin');}
}
function json(res,code,obj){res.statusCode=code;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(obj));}
function prune(){
  const cut=Date.now()-22*60*1000;
  for(const s of SYMBOLS){
    raw[s].trades=raw[s].trades.filter(x=>Date.parse(x.t||x.timestamp)>=cut);
    raw[s].quotes=raw[s].quotes.filter(x=>Date.parse(x.t||x.timestamp)>=cut);
  }
}
async function loadEdge(){
  try{
    const r=await fetch(EDGE_URL,{cache:'no-store'});
    if(r.ok){edgeModel=await r.json();return;}
  }catch{}
  try{edgeModel=JSON.parse(await fs.readFile(EDGE_PATH,'utf8'));}catch{edgeModel=null;}
}
async function loadL2Model(){
  try{
    const r=await fetch(L2_MODEL_URL,{cache:'no-store'});
    if(r.ok){l2Model=await r.json();return;}
  }catch{}
  try{l2Model=JSON.parse(await fs.readFile(L2_MODEL_PATH,'utf8'));}catch{l2Model=null;}
}
function validL2Event(x){
  return x&&x.provider==='databento'&&x.dataset==='XNAS.ITCH'&&x.schema==='mbp-10'&&SYMBOLS.includes(String(x.symbol||'').toUpperCase())
    &&typeof x.at==='string'&&Number.isFinite(Date.parse(x.at))&&Array.isArray(x.levels)&&x.levels.length>=10;
}
function addL2Events(batch){
  let accepted=0;
  for(const x of batch){
    if(!validL2Event(x))continue;
    const s=String(x.symbol).toUpperCase(),arr=l2Raw[s];
    const t=Date.parse(x.at);
    if(arr.length&&t<=Date.parse(arr.at(-1).at)){
      if(t===Date.parse(arr.at(-1).at)&&Number(x.sequence||0)<=Number(arr.at(-1).sequence||0))continue;
    }
    arr.push(x);accepted++;lastL2At=Date.now();
    if(arr.length>5000)arr.splice(0,arr.length-5000);
  }
  return accepted;
}
function snapshot(symbol){
  const r=raw[symbol];if(!r)return null;
  const minutes=aggregateMicrostructure(r.trades,r.quotes);
  const quality=microstructureQuality(minutes,{symbol,feed:FEED,minMinutes:15});
  const live_signal=edgeModel?.status==='validated'&&quality.status==='usable'?currentMicroSignal(minutes,edgeModel):null;
  const events=l2Raw[symbol]||[],lastEvent=events.at(-1)||null;
  const l2Contract=validateL2ModelContract(l2Model);
  const l2_forecast=l2Contract.ok&&lastEvent&&Date.now()-Date.parse(lastEvent.at)<=5000
    ?forecastL2Event(lastEvent,events,l2Model):null;
  return {
    provider:'alpaca',feed:FEED,symbol,mode:'live-relay',at:new Date().toISOString(),quality,
    edge_status:edgeModel?.status||'unavailable',edge_model_id:edgeModel?.model_id||null,live_signal,minutes,
    l2:{
      provider:'databento',dataset:'XNAS.ITCH',schema:'mbp-10',
      configured:!!L2_INGEST_TOKEN,event_count:events.length,last_at:lastEvent?.at||null,
      fresh:!!lastEvent&&Date.now()-Date.parse(lastEvent.at)<=5000,
      model_status:l2Model?.status||'unavailable',model_id:l2Model?.model_id||null,
      contract:l2Contract.ok?'valid':'blocked',contract_reasons:l2Contract.reasons,
      forecast:l2_forecast?.status==='forecast'?l2_forecast:null
    }
  };
}
function sendEvent(res,obj){res.write('event: market\ndata: '+JSON.stringify(obj)+'\n\n');}
function broadcast(){
  prune();
  for(const c of [...clients]){
    try{const s=snapshot(c.symbol);if(s)sendEvent(c.res,s);}catch{clients.delete(c);try{c.res.end();}catch{}}
  }
}
function connect(){
  if(!KEY||!SECRET)return;
  if(upstream){try{upstream.close();}catch{}}
  const ws=new WebSocket(`wss://stream.data.alpaca.markets/v2/${FEED}`);
  upstream=ws;
  ws.on('open',()=>ws.send(JSON.stringify({action:'auth',key:KEY,secret:SECRET})));
  ws.on('message',buf=>{
    let msgs;try{msgs=JSON.parse(String(buf));}catch{return;}
    for(const m of msgs){
      if(m.T==='success'&&m.msg==='authenticated')ws.send(JSON.stringify({action:'subscribe',trades:SYMBOLS,quotes:SYMBOLS}));
      else if(m.T==='t'&&raw[m.S]){raw[m.S].trades.push(m);lastUpstreamAt=Date.now();}
      else if(m.T==='q'&&raw[m.S]){raw[m.S].quotes.push(m);lastUpstreamAt=Date.now();}
    }
  });
  ws.on('close',()=>scheduleReconnect());
  ws.on('error',()=>scheduleReconnect());
}
function scheduleReconnect(){
  if(reconnectTimer)return;
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect();},3000);
}
const server=http.createServer((req,res)=>{
  cors(req,res);
  if(req.method==='OPTIONS'){res.statusCode=204;return res.end();}
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health'){
    return json(res,200,{ok:true,configured:!!(KEY&&SECRET),feed:FEED,symbols:SYMBOLS,upstream_fresh:Date.now()-lastUpstreamAt<15000,edge_status:edgeModel?.status||'unavailable',
      l2:{configured:!!L2_INGEST_TOKEN,fresh:Date.now()-lastL2At<5000,model_status:l2Model?.status||'unavailable'}});
  }
  if(u.pathname==='/internal/l2-events'){
    if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});
    if(!L2_INGEST_TOKEN||req.headers['x-alantu-ingest-token']!==L2_INGEST_TOKEN)return json(res,403,{error:'forbidden'});
    let body='',tooLarge=false;
    req.on('data',chunk=>{body+=chunk;if(body.length>2_000_000){tooLarge=true;req.destroy();}});
    req.on('end',()=>{
      if(tooLarge)return;
      try{
        const x=JSON.parse(body),batch=Array.isArray(x)?x:[x];
        if(batch.length>1000)return json(res,413,{error:'too_many_events'});
        const accepted=addL2Events(batch);
        return json(res,200,{ok:true,accepted});
      }catch{return json(res,400,{error:'bad_json'});}
    });
    return;
  }
  if(u.pathname==='/v1/snapshot'){
    const symbol=(u.searchParams.get('symbol')||'ORCL').toUpperCase(),s=snapshot(symbol);
    return s?json(res,200,s):json(res,404,{error:'unknown_symbol'});
  }
  if(u.pathname==='/v1/stream'){
    const origin=req.headers.origin;if(origin&&!ALLOWED.has(origin))return json(res,403,{error:'origin_not_allowed'});
    const symbol=(u.searchParams.get('symbol')||'ORCL').toUpperCase();if(!raw[symbol])return json(res,404,{error:'unknown_symbol'});
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write(': connected\n\n');const c={res,symbol};clients.add(c);req.on('close',()=>clients.delete(c));return;
  }
  json(res,404,{error:'not_found'});
});
await loadEdge();await loadL2Model();setInterval(loadEdge,60000).unref();setInterval(loadL2Model,60000).unref();setInterval(broadcast,1000).unref();setInterval(()=>{if(KEY&&SECRET&&Date.now()-lastUpstreamAt>15000)connect();},15000).unref();
connect();
server.listen(PORT,'0.0.0.0',()=>console.log(JSON.stringify({service:'alantu-market-relay',port:PORT,configured:!!(KEY&&SECRET),feed:FEED,symbols:SYMBOLS})));
