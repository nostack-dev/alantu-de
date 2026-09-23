import {spawn} from 'node:child_process';

const env={...process.env};
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
run('node',['market-runtime/trainer-loop.mjs'],'raw-sip-trainer');
console.log(JSON.stringify({
  service:'alantu-market-runtime',
  primary:'raw-sip-wave',
  provider:'alpaca-sip',
  databento:'retired',
  principle:'timing beats speed; precision beats power'
}));
