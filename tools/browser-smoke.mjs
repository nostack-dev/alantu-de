import { chromium } from 'playwright';

const url=process.env.SMOKE_URL||'https://www.alantu.de/';
const out=process.env.SMOKE_OUT||'/tmp/alantu-browser-smoke';
const fs=await import('node:fs/promises');
await fs.mkdir(out,{recursive:true});

async function run(name,viewport){
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewportSize:viewport});
  const consoleErrors=[],pageErrors=[],httpErrors=[],failed=[];
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
  page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
  page.on('response',r=>{if(r.status()>=400)httpErrors.push({status:r.status(),url:r.url()});});
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(5000);
  const canvases=await page.locator('canvas').all();
  for(const canvas of canvases){
    try{
      const box=await canvas.boundingBox();
      if(!box||box.width<20||box.height<20)continue;
      for(let i=0;i<12;i++){
        const x=box.x+10+(box.width-20)*(i/11);
        const y=box.y+Math.max(10,Math.min(box.height-10,box.height*(.25+.5*((i%3)/2))));
        await page.mouse.move(x,y);
        await page.waitForTimeout(120);
      }
    }catch{}
  }
  await page.waitForTimeout(7000);

  const state=await page.evaluate(()=>{
    let renderForecastError=null;
    try{ if(typeof renderForecastTrail==='function') renderForecastTrail(); }catch(e){ renderForecastError=String(e?.stack||e); }
    const ids=['modelDecision','hypothesisDecision','v5Research','forecastProof','forecastProofStrip','marketFlow'];
    const boxes=Object.fromEntries(ids.map(id=>{
      const el=document.getElementById(id),r=el?.getBoundingClientRect(),cs=el?getComputedStyle(el):null;
      return [id,{exists:!!el,visible:!!r&&r.width>0&&r.height>0,width:r?.width||0,height:r?.height||0,text:(el?.textContent||'').trim().slice(0,500),
        html:(el?.innerHTML||'').slice(0,1200),display:cs?.display||null,visibility:cs?.visibility||null,opacity:cs?.opacity||null}];
    }));
    const st=typeof shadowTrailState!=='undefined'?shadowTrailState:null;
    return {
      title:document.title,
      ready:document.readyState,
      width:{inner:window.innerWidth,scroll:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth-window.innerWidth},
      boxes,renderForecastError,
      shadowTrail:{present:!!st,version:st?.version||null,outcomes:Array.isArray(st?.outcomes)?st.outcomes.length:null,pending:Array.isArray(st?.pending)?st.pending.length:null,
        outcome0:Array.isArray(st?.outcomes)&&st.outcomes.length?st.outcomes[0]:null,pending0:Array.isArray(st?.pending)&&st.pending.length?st.pending[0]:null},
      chartEvents:typeof chartEvents==='function'?chartEvents():null,
      forecastCollapsed:document.getElementById('forecastProof')?.open===false,
      modelDecisionText:(document.getElementById('modelDecision')?.textContent||'').trim(),
      bodyText:(document.body?.innerText||'').slice(0,4000)
    };
  });
  await page.screenshot({path:`${out}/${name}.png`,fullPage:true});

  const allowedHttp=httpErrors.filter(x=>!x.url.includes('favicon'));
  const errors=[];
  const required=['modelDecision','hypothesisDecision','v5Research','forecastProof'];
  const badMarkers=required.map(k=>[k,state.boxes[k]]).filter(([,v])=>!v||!v.exists||!v.visible);
  if(state.renderForecastError)errors.push('forecast-render:'+state.renderForecastError);
  if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
  if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
  if(allowedHttp.length)errors.push('http:'+JSON.stringify(allowedHttp));
  if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));
  if(badMarkers.length)errors.push('hidden:'+JSON.stringify(badMarkers));
  if(state.width.overflow>4)errors.push('horizontal-overflow:'+state.width.overflow);
  if(Array.isArray(state.chartEvents)&&state.chartEvents.length)errors.push('live-chart-events-enabled:'+JSON.stringify(state.chartEvents));
  if(!state.bodyText.includes('Prognosen vs. Realität'))errors.push('forecast-label-missing');
  if(!state.bodyText.includes('v4 Regime'))errors.push('v4-label-missing');
  if(!state.bodyText.includes('v5 ·'))errors.push('v5-label-missing');
  if(!state.forecastCollapsed)errors.push('forecast-not-collapsed-by-default');
  if(!/MODELLSTATUS: (KAUFSIGNAL|KEIN KAUFSIGNAL|VERKAUFSSIGNAL)/.test(state.modelDecisionText))errors.push('model-decision-missing');

  console.log(JSON.stringify({name,url,state,consoleErrors,pageErrors,httpErrors:allowedHttp,failed,ok:errors.length===0,errors},null,2));
  await browser.close();
  if(errors.length)throw new Error(name+' smoke failed: '+errors.join(' | '));
}

await run('desktop',{width:1440,height:1200});
await run('mobile',{width:390,height:844});
console.log('ALANTU_BROWSER_SMOKE_OK');
