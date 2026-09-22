import fs from 'node:fs/promises';
import { currentMicroSignal } from './microstructure-signal.mjs';

const DATA=process.env.MICRO_OUT||'microstructure-current.json';
const EDGE=process.env.EDGE_STATUS_OUT||'microstructure-edge-status.json';
try{
  const d=JSON.parse(await fs.readFile(DATA,'utf8')),m=JSON.parse(await fs.readFile(EDGE,'utf8'));
  d.live_signal=(m.status==='validated'&&d.quality?.status==='usable')?currentMicroSignal(d.minutes||[],m):null;
  d.edge_model_id=m.model_id||null;
  d.edge_status=m.status||'unavailable';
  await fs.writeFile(DATA,JSON.stringify(d,null,2));
  console.log(JSON.stringify({edge_status:d.edge_status,model_id:d.edge_model_id,live_signal:d.live_signal?{dir:d.live_signal.dir,asof:d.live_signal.asof}:null}));
}catch(e){
  console.error('apply micro edge:',e.message);
  process.exit(1);
}
