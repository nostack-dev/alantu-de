import {spawn} from 'node:child_process';

const INTERVAL_HOURS=Math.max(1,Number(process.env.RAW_EDGE_TRAIN_INTERVAL_HOURS||12));
let running=false,stopping=false,timer=null,child=null;

function log(obj){console.log(JSON.stringify({service:'raw-sip-trainer-loop',...obj}));}
function schedule(ms){if(stopping)return;clearTimeout(timer);timer=setTimeout(run,ms);}
function run(){
  if(stopping||running)return;
  running=true;
  child=spawn('node',['tools/train-raw-sip-wave.mjs'],{env:{...process.env},stdio:'inherit'});
  child.once('exit',(code,signal)=>{
    running=false;child=null;
    log({event:'trainer_exit',code,signal,next_hours:INTERVAL_HOURS});
    schedule(INTERVAL_HOURS*3600000);
  });
}
function stop(){
  stopping=true;clearTimeout(timer);
  if(child){try{child.kill('SIGTERM');}catch{}}
  setTimeout(()=>process.exit(0),3000).unref();
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
log({event:'start',interval_hours:INTERVAL_HOURS});
schedule(5000);
