import fs from 'node:fs';
import { aggregateMicrostructure } from './microstructure-core.mjs';

const KEY=process.env.APCA_API_KEY_ID||'';
const SECRET=process.env.APCA_API_SECRET_KEY||'';
const FEED=process.env.ALANTU_MARKET_FEED||'sip';
const SYMBOLS=(process.env.MICRO_SYMBOLS||'ORCL,QQQ,IGV').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
const OUT=process.env.MICRO_LIVE_OUT||'microstructure-live.ndjson';
if(!KEY||!SECRET)throw new Error('APCA_API_KEY_ID/APCA_API_SECRET_KEY missing');

const ws=new WebSocket(`wss://stream.data.alpaca.markets/v2/${FEED}`);
const trades={},quotes={}; for(const s of SYMBOLS){trades[s]=[];quotes[s]=[];}
let lastFlush=Date.now();
function flush(){
  for(const s of SYMBOLS){
    const m=aggregateMicrostructure(trades[s],quotes[s]);
    for(const row of m)fs.appendFileSync(OUT,JSON.stringify({symbol:s,...row})+'\n');
    trades[s]=[];quotes[s]=[];
  }
  lastFlush=Date.now();
}
ws.addEventListener('open',()=>ws.send(JSON.stringify({action:'auth',key:KEY,secret:SECRET})));
ws.addEventListener('message',ev=>{
  const msgs=JSON.parse(ev.data);
  for(const m of msgs){
    if(m.T==='success'&&m.msg==='authenticated'){
      ws.send(JSON.stringify({action:'subscribe',trades:SYMBOLS,quotes:SYMBOLS}));
    } else if(m.T==='t'&&trades[m.S]) trades[m.S].push(m);
    else if(m.T==='q'&&quotes[m.S]) quotes[m.S].push(m);
  }
  if(Date.now()-lastFlush>=60000)flush();
});
ws.addEventListener('error',e=>console.error('websocket error',e));
process.on('SIGINT',()=>{flush();process.exit(0)});
process.on('SIGTERM',()=>{flush();process.exit(0)});
