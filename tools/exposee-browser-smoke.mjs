import { chromium } from 'playwright';

const defaultBuilder='https://www.alantu.de/pdf-to-exposee.html?embed=1&controls=1&pdf=%2Fassets%2Fsunside-living-expose.pdf&brand=Sunside%20Living&title=Konstanz%20Wollmatingen%20Expos%C3%A9&subtitle=Konstanz%20Wollmatingen';
const urls=(process.env.EXPOSEE_URLS||('https://www.alantu.de/index-brand.html,'+defaultBuilder))
  .split(',').map(s=>s.trim()).filter(Boolean);
const out=process.env.SMOKE_OUT||'/tmp/alantu-exposee-smoke';
const fs=await import('node:fs/promises');
await fs.mkdir(out,{recursive:true});

async function run(url,label,viewport){
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewportSize:viewport});
  const consoleErrors=[],pageErrors=[],httpErrors=[],failed=[];
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push({text:m.text(),url:m.location()?.url||''})});
  page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
  page.on('response',r=>{if(r.status()>=400&&!r.url().includes('favicon'))httpErrors.push({status:r.status(),url:r.url()})});
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));

  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});

  let target=page.mainFrame();
  if(label.startsWith('landing')){
    await page.waitForSelector('#exposeeFrame',{timeout:30000});
    for(let i=0;i<60;i++){
      const found=page.frames().find(f=>f!==page.mainFrame()&&f.url().includes('pdf-to-exposee.html'));
      if(found){target=found;break}
      await page.waitForTimeout(250);
    }
    if(target===page.mainFrame())throw new Error('landing iframe not attached');
  }

  await target.waitForSelector('#bookCanvas',{timeout:30000});
  await target.waitForFunction(()=>{
    const pc=document.getElementById('pageCount')?.textContent||'';
    return /18/.test(pc)&&pc!=='— / —';
  },null,{timeout:90000});
  await page.waitForTimeout(1500);

  const state=await target.evaluate(()=>{
    const stage=document.getElementById('stage');
    const ui=document.querySelector('.stage-ui');
    const cs=ui?getComputedStyle(ui):null;
    const val=id=>document.getElementById(id)?.value||document.getElementById(id)?.textContent||null;
    const ids=['tiltXLess','tiltXMore','tiltYLess','tiltYMore','tiltZLess','tiltZMore','zoomLess','zoomMore'];
    const canvas=document.getElementById('bookCanvas');
    const rect=canvas?.getBoundingClientRect();
    return {
      stage:!!stage,
      canvas:!!canvas,
      canvasRect:rect?{width:rect.width,height:rect.height}:null,
      controlsVisible:cs?.display!=='none'&&cs?.visibility!=='hidden'&&Number(cs?.opacity||1)>.9,
      values:{x:val('tiltXValue'),y:val('tiltYValue'),z:val('tiltZValue'),zoom:val('zoomValue')},
      controls:Object.fromEntries(ids.map(id=>[id,!!document.getElementById(id)])),
      pageCount:(document.getElementById('pageCount')?.textContent||'').trim(),
      viewerTitle:(document.getElementById('viewerTitle')?.textContent||'').trim(),
      emptyVisible:document.getElementById('emptyState')?.style.display!=='none',
      overflow:document.documentElement.scrollWidth-window.innerWidth,
      fakeText:(document.body?.innerText||'').includes('Starnberger See')||(document.body?.innerText||'').includes('PRIVATE RESIDENCE')
    };
  });

  await target.locator('#tiltZMore').click();
  await target.locator('#zoomMore').click();
  await page.waitForTimeout(150);
  const changed=await target.evaluate(()=>({
    z:document.getElementById('tiltZValue')?.value||null,
    zoom:document.getElementById('zoomValue')?.value||null
  }));

  const fullscreenBtn=target.locator('#fullscreenBtn');
  await fullscreenBtn.click({force:true});
  await page.waitForTimeout(500);
  const fOn=await target.evaluate(()=>{
    const stage=document.getElementById('stage');
    const ui=document.querySelector('.stage-ui');
    return {
      active:document.fullscreenElement===stage||document.webkitFullscreenElement===stage||stage?.classList.contains('is-faux-fullscreen')||false,
      uiDisplay:ui?getComputedStyle(ui).display:null
    };
  });
  if(fOn.active){
    await fullscreenBtn.click({force:true}).catch(()=>{});
    await page.waitForTimeout(300);
  }

  const safe=label.replace(/[^a-z0-9_-]+/gi,'-');
  await page.screenshot({path:`${out}/${safe}-${viewport.width}.png`,fullPage:true});

  const errors=[];
  if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
  if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
  if(httpErrors.length)errors.push('http:'+JSON.stringify(httpErrors));
  if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));
  if(!state.stage||!state.canvas)errors.push('renderer-missing');
  if(!state.controlsVisible)errors.push('controls-not-visible');
  if(Object.values(state.controls).some(v=>!v))errors.push('controls-missing:'+JSON.stringify(state.controls));
  if(state.values.x!=='4°'||state.values.y!=='2°'||state.values.z!=='0°'||state.values.zoom!=='100%')errors.push('defaults:'+JSON.stringify(state.values));
  if(changed.z!=='1°')errors.push('z-control-failed:'+String(changed.z));
  if(!(parseInt(changed.zoom,10)>100))errors.push('zoom-control-failed:'+String(changed.zoom));
  if(!/18/.test(state.pageCount))errors.push('pdf-not-loaded:'+state.pageCount);
  if(!/SUNSIDE LIVING/.test(state.viewerTitle)||!/KONSTANZ WOLLMATINGEN EXPOSÉ/.test(state.viewerTitle))errors.push('sunside-title:'+state.viewerTitle);
  if(state.emptyVisible)errors.push('empty-state-still-visible');
  if(state.fakeText)errors.push('fake-cover-copy-present');
  if(state.overflow>4)errors.push('horizontal-overflow:'+state.overflow);
  if(!fOn.active)errors.push('fullscreen-failed');
  if(fOn.uiDisplay!=='none')errors.push('controls-visible-in-fullscreen:'+String(fOn.uiDisplay));

  if(label.startsWith('landing')){
    const parent=await page.evaluate(()=>({
      frame:!!document.getElementById('exposeeFrame'),
      share:!!document.getElementById('shareLinkBtn'),
      duplicateCanvas:!!document.getElementById('bookCanvas'),
      body:(document.body?.innerText||'').slice(0,1200)
    }));
    if(!parent.frame)errors.push('landing-frame-missing');
    if(!parent.share)errors.push('share-link-missing');
    if(parent.duplicateCanvas)errors.push('duplicate-landing-renderer-present');
  }

  console.log(JSON.stringify({url,label,viewport,state,changed,fOn,consoleErrors,pageErrors,httpErrors,failed,ok:errors.length===0,errors},null,2));
  await browser.close();
  if(errors.length)throw new Error(label+' smoke failed: '+errors.join(' | '));
}

for(const url of urls){
  const label=url.includes('pdf-to-exposee')?'builder':'landing';
  await run(url,label,{width:1440,height:1100});
  await run(url,label+'-mobile',{width:390,height:844});
}

console.log('ALANTU_EXPOSEE_BROWSER_SMOKE_OK');
