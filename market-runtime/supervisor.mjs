import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const env={...process.env};
if(!env.L2_INGEST_TOKEN){
  env.L2_INGEST_TOKEN=crypto.randomBytes(32).toString('hex');
}
env.L2_RELAY_INGEST_URL=env.L2_RELAY_INGEST_URL||'http://127.0.0.1:8080/internal/l2-events';

const children=new Set();
let stopping=false;
function run(cmd,args,name){
  const p=spawn(cmd,args,{env,stdio:'inherit'});
  children.add(p);
  p.once('exit',(code,signal)=>{
    children.delete(p);
    if(stopping)return;
    console.error(JSON.stringify({service:'alantu-market-runtime',child:name,event:'exit',code,signal}));
    shutdown(code??1);
  });
  return p;
}
function shutdown(code=0){
  if(stopping)return;
  stopping=true;
  for(const p of children){try{p.kill('SIGTERM');}catch{}}
  setTimeout(()=>{for(const p of children){try{p.kill('SIGKILL');}catch{}};process.exit(code);},5000).unref();
  if(!children.size)process.exit(code);
}
process.on('SIGTERM',()=>shutdown(0));
process.on('SIGINT',()=>shutdown(0));

run('node',['market-relay/server.mjs'],'relay');
if(process.env.MARKET_RUNTIME_RELAY_ONLY!=='1'&&env.DATABENTO_API_KEY){
  setTimeout(()=>run('python',['tools/databento-orcl-mbp10-live.py'],'l2-collector'),500);
}else if(process.env.MARKET_RUNTIME_RELAY_ONLY!=='1'){
  console.log(JSON.stringify({service:'alantu-market-runtime',child:'l2-collector',event:'disabled',reason:'missing_databento_api_key'}));
}
