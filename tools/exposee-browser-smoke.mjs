import { chromium } from 'playwright';

const urls=(process.env.EXPOSEE_URLS||'https://www.alantu.de/index-brand.html,https://www.alantu.de/pdf-to-exposee.html')
  .split(',').map(s=>s.trim()).filter(Boolean);
const out=process.env.SMOKE_OUT||'/tmp/alantu-exposee-smoke';
const fs=await import('node:fs/promises');
await fs.mkdir(out,{recursive:true});

async function run(url,label,viewport){
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewportSize:viewport});
  const consoleErrors=[],pageErrors=[],httpErrors=[],failed=[];
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
  page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
  page.on('response',r=>{if(r.status()>=400&&!r.url().includes('favicon'))httpErrors.push({status:r.status(),url:r.url()})});
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));

  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(5000);

  const state=await page.evaluate(async()=>{
    const q=s=>document.querySelector(s);
    const rect=el=>{const r=el?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};
    const axis=q('.axis-controls');
    const top=q('.stage-top');
    const x=q('#tiltXValue'), y=q('#tiltYValue');
    const ids=['tiltXLess','tiltXMore','tiltYLess','tiltYMore'];
    const controls=Object.fromEntries(ids.map(id=>[id,!!document.getElementById(id)]));
    const topRect=rect(top), axisRect=rect(axis);
    const beforeFullscreen=axis?getComputedStyle(axis).display:null;

    let fullscreenDisplay=null;
    const stage=q('#stage');
    if(stage&&axis&&stage.requestFullscreen){
      try{
        await stage.requestFullscreen();
        await new Promise(r=>setTimeout(r,300));
        fullscreenDisplay=getComputedStyle(axis).display;
        if(document.fullscreenElement)await document.exitFullscreen();
      }catch(e){
        fullscreenDisplay='fullscreen-api-unavailable:'+String(e?.message||e);
      }
    }

    return {
      title:document.title,
      ready:document.readyState,
      axisExists:!!axis,
      topExists:!!top,
      axisRect,topRect,
      sameTopRow:!!axisRect&&!!topRect&&axisRect.y>=topRect.y-2&&axisRect.y+axisRect.height<=topRect.y+topRect.height+2,
      xValue:x?.value||x?.textContent||null,
      yValue:y?.value||y?.textContent||null,
      controls,
      beforeFullscreen,
      fullscreenDisplay,
      overflow:document.documentElement.scrollWidth-window.innerWidth,
      canvasCount:document.querySelectorAll('canvas').length,
      body:(document.body?.innerText||'').slice(0,1200)
    };
  });

  const safe=label.replace(/[^a-z0-9_-]+/gi,'-');
  await page.screenshot({path:`${out}/${safe}-${viewport.width}.png`,fullPage:true});

  const errors=[];
  if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
  if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
  if(httpErrors.length)errors.push('http:'+JSON.stringify(httpErrors));
  if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));
  if(!state.axisExists||!state.topExists)errors.push('axis-controls-missing');
  if(!state.sameTopRow)errors.push('axis-controls-not-in-top-row');
  if(state.xValue!=='4°')errors.push('x-default:'+String(state.xValue));
  if(state.yValue!=='2°')errors.push('y-default:'+String(state.yValue));
  if(Object.values(state.controls).some(v=>!v))errors.push('axis-buttons-missing:'+JSON.stringify(state.controls));
  if(state.beforeFullscreen==='none')errors.push('axis-hidden-before-fullscreen');
  if(state.fullscreenDisplay!=='none'&&!String(state.fullscreenDisplay||'').startsWith('fullscreen-api-unavailable:')){
    errors.push('axis-visible-in-fullscreen:'+String(state.fullscreenDisplay));
  }
  if(state.overflow>4)errors.push('horizontal-overflow:'+state.overflow);
  if(state.canvasCount<1)errors.push('canvas-missing');

  console.log(JSON.stringify({url,label,viewport,state,consoleErrors,pageErrors,httpErrors,failed,ok:errors.length===0,errors},null,2));
  await browser.close();
  if(errors.length)throw new Error(label+' smoke failed: '+errors.join(' | '));
}

for(const url of urls){
  const label=url.includes('pdf-to-exposee')?'builder':'landing';
  await run(url,label,{width:1440,height:1100});
  await run(url,label+'-mobile',{width:390,height:844});
}

console.log('ALANTU_EXPOSEE_BROWSER_SMOKE_OK');
