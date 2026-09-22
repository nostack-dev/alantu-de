import http from 'node:http';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import { aggregateMicrostructure, microstructureQuality } from '../tools/microstructure-core.mjs';
import { currentMicroSignal } from '../tools/microstructure-signal.mjs';

const PORT=Number(process.env.PORT||8080);
const KEY=process.env.APCA_API_KEY_ID||'',SECRET=process.env.APCA_API_SECRET_KEY||'';
const FEED=process.env.ALANTU_MARKET_FEED||'sip';
const SYMBOLS=(process.env.MICRO_SYMBOLS||'ORCL').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
const EDGE_PATH=process.env.EDGE_STATUS_PATH||'/app/microstructure-edge-status.json';
const ALLOWED=new Set((process.env.ALLOWED_ORIGINS||'https://www.alantu.de,https://alantu.de').split(',').map(x=>x.trim()).filter(Boolean));
const raw=Object.fromEntries(SYMBOLS.map(s=>[s,{trades:[],quotes:[]}]));
const clients=new Set();
let upstream=null,edgeModel=null,lastUpstreamAt=0,reconnectTimer=null;

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
  try{edgeModel=JSON.parse(await fs.readFile(EDGE_PATH,'utf8'));}catch{edgeModel=null;}
}
function snapshot(symbol){
  const r=raw[symbol];if(!r)return null;
  const minutes=aggregateMicrostructure(r.trades,r.quotes);
  const quality=microstructureQuality(minutes,{symbol,feed:FEED,minMinutes:15});
  const live_signal=edgeModel?.status==='validated'&&quality.status==='usable'?currentMicroSignal(minutes,edgeModel):null;
  return {provider:'alpaca',feed:FEED,symbol,mode:'live-relay',at:new Date().toISOString(),quality,edge_status:edgeModel?.status||'unavailable',edge_model_id:edgeModel?.model_id||null,live_signal,minutes};
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
    return json(res,200,{ok:true,configured:!!(KEY&&SECRET),feed:FEED,symbols:SYMBOLS,upstream_fresh:Date.now()-lastUpstreamAt<15000,edge_status:edgeModel?.status||'unavailable'});
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
await loadEdge();setInterval(loadEdge,60000).unref();setInterval(broadcast,1000).unref();setInterval(()=>{if(KEY&&SECRET&&Date.now()-lastUpstreamAt>15000)connect();},15000).unref();
connect();
server.listen(PORT,'0.0.0.0',()=>console.log(JSON.stringify({service:'alantu-market-relay',port:PORT,configured:!!(KEY&&SECRET),feed:FEED,symbols:SYMBOLS})));
