import { chromium } from 'playwright';

const defaultBuilder='https://www.alantu.de/pdf-to-exposee.html?embed=1&pdf=%2Fassets%2Fsunside-living-expose.pdf&brand=Sunside%20Living&title=Konstanz%20Wollmatingen%20Expos%C3%A9&subtitle=Konstanz%20Wollmatingen';
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
    for(let i=0;i<80;i++){
      const found=page.frames().find(f=>f!==page.mainFrame()&&f.url().includes('pdf-to-exposee.html'));
      if(found){target=found;break}
      await page.waitForTimeout(250);
    }
    if(target===page.mainFrame())throw new Error('landing iframe not attached');
  }

  await target.waitForSelector('#bookCanvas',{timeout:30000});
  await target.waitForSelector('#debugToggle',{timeout:30000});
  await target.waitForFunction(()=>{
    const pc=document.getElementById('pageCount')?.textContent||'';
    return /18/.test(pc)&&pc!=='— / —';
  },null,{timeout:150000});
  await page.waitForTimeout(800);

  const initial=await target.evaluate(()=>{
    const stage=document.getElementById('stage');
    const ui=document.querySelector('.stage-ui');
    const toggle=document.getElementById('debugToggle');
    const cs=ui?getComputedStyle(ui):null;
    return {
      controlsOn:stage?.classList.contains('debug-controls')||false,
      ui:{display:cs?.display||null,visibility:cs?.visibility||null,opacity:Number(cs?.opacity||0)},
      toggle:{exists:!!toggle,pressed:toggle?.getAttribute('aria-pressed')||null,display:toggle?getComputedStyle(toggle).display:null},
      pageCount:(document.getElementById('pageCount')?.textContent||'').trim()
    };
  });

  // Mobile and desktop must both be able to reveal/hide debug controls.
  await target.locator('#debugToggle').click({force:true});
  await page.waitForTimeout(120);
  const shown=await target.evaluate(()=>{
    const stage=document.getElementById('stage');
    const ui=document.querySelector('.stage-ui');
    const cs=ui?getComputedStyle(ui):null;
    const val=id=>document.getElementById(id)?.value||document.getElementById(id)?.textContent||null;
    return {
      controlsOn:stage?.classList.contains('debug-controls')||false,
      ui:{display:cs?.display||null,visibility:cs?.visibility||null,opacity:Number(cs?.opacity||0)},
      pressed:document.getElementById('debugToggle')?.getAttribute('aria-pressed')||null,
      values:{x:val('tiltXValue'),y:val('tiltYValue'),z:val('tiltZValue'),zoom:val('zoomValue')},
      viewerTitle:(document.getElementById('viewerTitle')?.textContent||'').trim()
    };
  });

  await target.locator('#debugToggle').click({force:true});
  await page.waitForTimeout(120);
  const hiddenAgain=await target.evaluate(()=>{
    const stage=document.getElementById('stage');
    const ui=document.querySelector('.stage-ui');
    const cs=ui?getComputedStyle(ui):null;
    return {
      controlsOn:stage?.classList.contains('debug-controls')||false,
      visibility:cs?.visibility||null,
      opacity:Number(cs?.opacity||0),
      pressed:document.getElementById('debugToggle')?.getAttribute('aria-pressed')||null
    };
  });

  // Show controls again and enter fullscreen from the actual button.
  await target.locator('#debugToggle').click({force:true});
  await page.waitForTimeout(120);
  await target.locator('#fullscreenBtn').click({force:true});
  await page.waitForTimeout(650);

  let fullscreen;
  if(label.startsWith('landing')){
    fullscreen=await page.evaluate(()=>{
      const stage=document.getElementById('stage');
      return {
        active:document.fullscreenElement===stage||document.webkitFullscreenElement===stage||stage?.classList.contains('is-faux-fullscreen')||false,
        faux:stage?.classList.contains('is-faux-fullscreen')||false
      };
    });
  }else{
    fullscreen=await target.evaluate(()=>{
      const stage=document.getElementById('stage');
      return {
        active:document.fullscreenElement===stage||document.webkitFullscreenElement===stage||stage?.classList.contains('is-faux-fullscreen')||false,
        faux:stage?.classList.contains('is-faux-fullscreen')||false
      };
    });
  }

  const childFullscreenState=await target.evaluate(()=>{
    const stage=document.getElementById('stage');
    const ui=document.querySelector('.stage-ui');
    const toggle=document.getElementById('debugToggle');
    return {
      host:stage?.classList.contains('is-host-fullscreen')||false,
      uiDisplay:ui?getComputedStyle(ui).display:null,
      toggleDisplay:toggle?getComputedStyle(toggle).display:null
    };
  });

  // Exit through same button path when possible.
  if(fullscreen.active){
    if(label.startsWith('landing')){
      await page.evaluate(()=>{
        const stage=document.getElementById('stage');
        if(document.fullscreenElement===stage&&document.exitFullscreen)return document.exitFullscreen();
        if(document.webkitFullscreenElement===stage&&document.webkitExitFullscreen)return document.webkitExitFullscreen();
        if(stage?.classList.contains('is-faux-fullscreen')){
          window.postMessage({type:'__smoke_noop'},'*');
        }
      }).catch(()=>{});
      if(fullscreen.faux){
        // Child request toggles the parent faux fullscreen off.
        await target.evaluate(()=>window.parent.postMessage({type:'alantu-fullscreen-toggle'},'*'));
      }
    }else{
      await target.locator('#fullscreenBtn').click({force:true}).catch(()=>{});
    }
    await page.waitForTimeout(350);
  }

  const safe=label.replace(/[^a-z0-9_-]+/gi,'-');
  await page.screenshot({path:`${out}/${safe}-${viewport.width}.png`,fullPage:true});

  const errors=[];
  if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
  if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
  if(httpErrors.length)errors.push('http:'+JSON.stringify(httpErrors));
  if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));
  if(initial.controlsOn||initial.ui.visibility!=='hidden'||initial.ui.opacity>.01)errors.push('controls-visible-by-default:'+JSON.stringify(initial));
  if(!initial.toggle.exists||initial.toggle.display==='none'||initial.toggle.pressed!=='false')errors.push('debug-toggle-default:'+JSON.stringify(initial.toggle));
  if(!shown.controlsOn||shown.ui.visibility!=='visible'||shown.ui.opacity<.99||shown.pressed!=='true')errors.push('debug-toggle-show-failed:'+JSON.stringify(shown));
  if(shown.values.x!=='4°'||shown.values.y!=='2°'||shown.values.z!=='0°'||shown.values.zoom!=='100%')errors.push('defaults:'+JSON.stringify(shown.values));
  if(!/SUNSIDE LIVING/.test(shown.viewerTitle)||!/KONSTANZ WOLLMATINGEN EXPOSÉ/.test(shown.viewerTitle))errors.push('sunside-title:'+shown.viewerTitle);
  if(hiddenAgain.controlsOn||hiddenAgain.visibility!=='hidden'||hiddenAgain.opacity>.01||hiddenAgain.pressed!=='false')errors.push('debug-toggle-hide-failed:'+JSON.stringify(hiddenAgain));
  if(!fullscreen.active)errors.push('fullscreen-failed:'+JSON.stringify(fullscreen));
  if(childFullscreenState.uiDisplay!=='none'||childFullscreenState.toggleDisplay!=='none')errors.push('fullscreen-controls-visible:'+JSON.stringify(childFullscreenState));
  if(label.startsWith('landing')&&!childFullscreenState.host)errors.push('host-fullscreen-state-not-forwarded');

  if(label.startsWith('landing')){
    const parent=await page.evaluate(()=>({
      frame:!!document.getElementById('exposeeFrame'),
      duplicateCanvas:!!document.getElementById('bookCanvas'),
      share:!!document.getElementById('shareLinkBtn')
    }));
    if(!parent.frame||parent.duplicateCanvas||!parent.share)errors.push('landing-shared-renderer:'+JSON.stringify(parent));
  }

  console.log(JSON.stringify({url,label,viewport,initial,shown,hiddenAgain,fullscreen,childFullscreenState,consoleErrors,pageErrors,httpErrors,failed,ok:errors.length===0,errors},null,2));
  await browser.close();
  if(errors.length)throw new Error(label+' smoke failed: '+errors.join(' | '));
}

for(const url of urls){
  const label=url.includes('pdf-to-exposee')?'builder':'landing';
  await run(url,label,{width:1440,height:1100});
  await run(url,label+'-mobile',{width:390,height:844});
}

console.log('ALANTU_EXPOSEE_BROWSER_SMOKE_OK');
