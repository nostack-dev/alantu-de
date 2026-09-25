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

  const initial=await page.evaluate(()=>{
    const stage=document.getElementById('stage');
    const ui=document.querySelector('.stage-ui');
    const cs=ui?getComputedStyle(ui):null;
    const share=document.getElementById('shareLinkBtn');
    return {
      stage:!!stage,
      canvas:!!document.getElementById('bookCanvas'),
      debug:stage?.classList.contains('debug-controls')||false,
      ui:{exists:!!ui,display:cs?.display||null,visibility:cs?.visibility||null,opacity:cs?.opacity||null},
      share:{exists:!!share,outsideStage:!!share&&!!stage&&!stage.contains(share)},
      overflow:document.documentElement.scrollWidth-window.innerWidth
    };
  });

  await page.keyboard.press('d');
  await page.waitForTimeout(250);

  const debug=await page.evaluate(()=>{
    const stage=document.getElementById('stage');
    const ui=document.querySelector('.stage-ui');
    const cs=ui?getComputedStyle(ui):null;
    const val=id=>document.getElementById(id)?.value||document.getElementById(id)?.textContent||null;
    const ids=['tiltXLess','tiltXMore','tiltYLess','tiltYMore','tiltZLess','tiltZMore','zoomLess','zoomMore'];
    return {
      debug:stage?.classList.contains('debug-controls')||false,
      ui:{display:cs?.display||null,visibility:cs?.visibility||null,opacity:cs?.opacity||null},
      values:{x:val('tiltXValue'),y:val('tiltYValue'),z:val('tiltZValue'),zoom:val('zoomValue')},
      controls:Object.fromEntries(ids.map(id=>[id,!!document.getElementById(id)]))
    };
  });

  await page.locator('#tiltZMore').click();
  await page.locator('#zoomMore').click();
  await page.waitForTimeout(100);
  const changed=await page.evaluate(()=>({
    z:document.getElementById('tiltZValue')?.value||null,
    zoom:document.getElementById('zoomValue')?.value||null
  }));

  // Keyboard fullscreen must work even though normal controls start hidden.
  await page.keyboard.press('f');
  await page.waitForTimeout(450);
  const fOn=await page.evaluate(()=>{
    const stage=document.getElementById('stage');
    const ui=document.querySelector('.stage-ui');
    return {
      active:document.fullscreenElement===stage||document.webkitFullscreenElement===stage||stage?.classList.contains('is-faux-fullscreen')||false,
      uiDisplay:ui?getComputedStyle(ui).display:null
    };
  });
  await page.keyboard.press('f');
  await page.waitForTimeout(350);

  // Canvas double click must independently toggle fullscreen.
  await page.locator('#bookCanvas').dblclick({force:true});
  await page.waitForTimeout(450);
  const dblOn=await page.evaluate(()=>{
    const stage=document.getElementById('stage');
    return document.fullscreenElement===stage||document.webkitFullscreenElement===stage||stage?.classList.contains('is-faux-fullscreen')||false;
  });
  await page.locator('#bookCanvas').dblclick({force:true});
  await page.waitForTimeout(350);

  let touchOwnership=null;
  if(viewport.width<=500){
    await page.evaluate(()=>{
      const stage=document.getElementById('stage');
      window.__alantuTouchSmoke={down:0,move:0,up:0,cancel:0};
      for(const type of ['pointerdown','pointermove','pointerup','pointercancel']){
        stage?.addEventListener(type,e=>{
          if(e.pointerType!=='touch')return;
          const key=type.replace('pointer','');
          window.__alantuTouchSmoke[key]=(window.__alantuTouchSmoke[key]||0)+1;
        },{capture:true});
      }
      if(stage){
        const rect=stage.getBoundingClientRect();
        const desired=Math.max(0,window.scrollY+rect.top-80);
        window.scrollTo(0,desired);
      }
    });
    await page.waitForTimeout(120);

    const box=await page.locator('#stage').boundingBox();
    if(box){
      const session=await page.context().newCDPSession(page);
      const x=box.x+box.width*.62;
      const y=box.y+box.height*.55;
      const point=(px,py)=>({x:px,y:py,id:7,radiusX:2,radiusY:2,force:1});
      const scrollBefore=await page.evaluate(()=>window.scrollY);

      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(x,y)]});
      // Start intentionally almost vertical. This used to hand the gesture to
      // page scrolling and trigger pointercancel before the user could swipe.
      await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(x+7,y-95)]});
      await page.waitForTimeout(80);
      const afterVertical=await page.evaluate(()=>({
        scrollY:window.scrollY,
        events:{...window.__alantuTouchSmoke},
        dragging:document.getElementById('stage')?.classList.contains('is-book-dragging')||false
      }));

      // Then turn it into an obvious horizontal page gesture. Ownership must
      // still belong to the book; there must be no cancel/handoff.
      await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(x-105,y-102)]});
      await page.waitForTimeout(80);
      const afterHorizontal=await page.evaluate(()=>({
        scrollY:window.scrollY,
        events:{...window.__alantuTouchSmoke},
        dragging:document.getElementById('stage')?.classList.contains('is-book-dragging')||false
      }));

      await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForTimeout(120);
      const afterEnd=await page.evaluate(()=>({
        scrollY:window.scrollY,
        events:{...window.__alantuTouchSmoke},
        dragging:document.getElementById('stage')?.classList.contains('is-book-dragging')||false
      }));

      touchOwnership={scrollBefore,afterVertical,afterHorizontal,afterEnd};
      await session.detach();
    }
  }

  const safe=label.replace(/[^a-z0-9_-]+/gi,'-');
  await page.screenshot({path:`${out}/${safe}-${viewport.width}.png`,fullPage:true});

  const errors=[];
  if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
  if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
  if(httpErrors.length)errors.push('http:'+JSON.stringify(httpErrors));
  if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));
  if(!initial.stage||!initial.canvas||!initial.ui.exists)errors.push('renderer-ui-missing');
  if(initial.debug)errors.push('debug-controls-enabled-by-default');
  if(initial.ui.visibility!=='hidden'||Number(initial.ui.opacity)>0.01)errors.push('controls-visible-by-default:'+JSON.stringify(initial.ui));
  if(!debug.debug||debug.ui.visibility!=='visible'||Number(debug.ui.opacity)<.99)errors.push('debug-key-did-not-show-controls:'+JSON.stringify(debug.ui));
  if(Object.values(debug.controls).some(v=>!v))errors.push('debug-controls-missing:'+JSON.stringify(debug.controls));
  if(debug.values.x!=='4°'||debug.values.y!=='2°'||debug.values.z!=='0°'||debug.values.zoom!=='100%')errors.push('debug-defaults:'+JSON.stringify(debug.values));
  if(changed.z!=='1°')errors.push('z-control-failed:'+String(changed.z));
  if(!(parseInt(changed.zoom,10)>100))errors.push('zoom-control-failed:'+String(changed.zoom));
  if(!fOn.active)errors.push('keyboard-fullscreen-failed');
  if(fOn.uiDisplay!=='none')errors.push('controls-visible-in-fullscreen:'+String(fOn.uiDisplay));
  if(!dblOn)errors.push('doubleclick-fullscreen-failed');
  if(touchOwnership){
    const drift=Math.max(
      Math.abs(touchOwnership.afterVertical.scrollY-touchOwnership.scrollBefore),
      Math.abs(touchOwnership.afterHorizontal.scrollY-touchOwnership.scrollBefore),
      Math.abs(touchOwnership.afterEnd.scrollY-touchOwnership.scrollBefore)
    );
    if(drift>2)errors.push('touch-gesture-scrolled-page:'+JSON.stringify(touchOwnership));
    if((touchOwnership.afterEnd.events.cancel||0)>0)errors.push('touch-gesture-pointercancel:'+JSON.stringify(touchOwnership));
    if((touchOwnership.afterEnd.events.down||0)<1||(touchOwnership.afterEnd.events.move||0)<2||(touchOwnership.afterEnd.events.up||0)<1){
      errors.push('touch-gesture-incomplete:'+JSON.stringify(touchOwnership));
    }
    if(!touchOwnership.afterHorizontal.dragging)errors.push('touch-drag-not-owned:'+JSON.stringify(touchOwnership));
    if(touchOwnership.afterEnd.dragging)errors.push('touch-drag-not-released:'+JSON.stringify(touchOwnership));
  }
  if(initial.overflow>4)errors.push('horizontal-overflow:'+initial.overflow);
  if(label.startsWith('landing')&&(!initial.share.exists||!initial.share.outsideStage))errors.push('share-link-not-outside-renderer');
  if(label.startsWith('builder')&&initial.share.exists)errors.push('share-link-present-in-builder');

  console.log(JSON.stringify({url,label,viewport,initial,debug,changed,fOn,dblOn,touchOwnership,consoleErrors,pageErrors,httpErrors,failed,ok:errors.length===0,errors},null,2));
  await browser.close();
  if(errors.length)throw new Error(label+' smoke failed: '+errors.join(' | '));
}

for(const url of urls){
  const label=url.includes('pdf-to-exposee')?'builder':'landing';
  await run(url,label,{width:1440,height:1100});
  await run(url,label+'-mobile',{width:390,height:844});
}

console.log('ALANTU_EXPOSEE_BROWSER_SMOKE_OK');
