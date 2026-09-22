import fs from 'node:fs/promises';
import {l2ModelId} from './l2-event-signal.mjs';

const path=process.argv[2]||process.env.L2_MODEL_OUT||'orcl-l2-model.json';
const model=JSON.parse(await fs.readFile(path,'utf8'));
if(model.status==='validated'){
  model.model_id=l2ModelId(model);
}else{
  model.model_id=null;
}
await fs.writeFile(path,JSON.stringify(model,null,2));
console.log(JSON.stringify({status:model.status,model_id:model.model_id,horizon_events:model.horizon_events||null}));
