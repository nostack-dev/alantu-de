import { chromium } from 'playwright';

const urls=(process.env.EXPOSEE_TOUCH_URLS||'https://www.alantu.de/index-brand.html,https://www.alantu.de/pdf-to-exposee.html')
  .split(',').map(s=>s.trim()).filter(Boolean);
const sample=process.env.PDF_SAMPLE||'assets/sunside-living-expose.pdf';

async function test(url){
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewportSize:{width:390,height:844},isMobile:true,hasTouch:true});
  const consoleErrors=[],pageErrors=[],httpErrors=[],failed=[];
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
  page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
  page.on('response',r=>{if(r.status()>=400&&!r.url().includes('favicon'))httpErrors.push({status:r.status(),url:r.url()})});
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));

  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(3500);

  if(url.includes('pdf-to-exposee.html')){
    await page.locator('#pdfInput').setInputFiles(sample);
    await page.waitForFunction(()=>{
      const s=document.getElementById('status')?.textContent||'';
      return /Seiten bereit/.test(s);
    },null,{timeout:120000});
  }

  await page.evaluate(()=>{
    const stage=document.getElementById('stage');
    window.__touchProof={down:0,move:0,up:0,cancel:0,lost:0};
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']){
      stage.addEventListener(type,e=>{
        if(type!=='lostpointercapture'&&e.pointerType!=='touch')return;
        const key=type==='lostpointercapture'?'lost':type.replace('pointer','');
        window.__touchProof[key]=(window.__touchProof[key]||0)+1;
      },{capture:true});
    }
    const r=stage.getBoundingClientRect();
    window.scrollTo(0,Math.max(0,window.scrollY+r.top-55));
  });
  await page.waitForTimeout(120);

  const stageBox=await page.locator('#stage').boundingBox();
  if(!stageBox)throw new Error('stage missing');
  const touchAction=await page.locator('#stage').evaluate(el=>getComputedStyle(el).touchAction);
  const pageBefore=await page.locator('#pageCount').textContent();
  const scrollBefore=await page.evaluate(()=>window.scrollY);

  const session=await page.context().newCDPSession(page);
  const x=stageBox.x+stageBox.width*.68,y=stageBox.y+stageBox.height*.53;
  const pt=(px,py)=>({x:px,y:py,id:31,radiusX:3,radiusY:3,force:1});

  // Start almost vertically. The browser must NOT steal this touch.
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[pt(x,y)]});
  await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[pt(x+4,y-105)]});
  await page.waitForTimeout(80);
  const vertical=await page.evaluate(()=>({
    scrollY:window.scrollY,
    ev:{...window.__touchProof},
    dragging:document.getElementById('stage').classList.contains('is-book-dragging')
  }));

  // Now convert the same continuous gesture into a page turn.
  await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[pt(x-155,y-108)]});
  await page.waitForTimeout(100);
  const horizontal=await page.evaluate(()=>({
    scrollY:window.scrollY,
    ev:{...window.__touchProof},
    dragging:document.getElementById('stage').classList.contains('is-book-dragging')
  }));

  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await session.detach();
  await page.waitForTimeout(900);

  const end=await page.evaluate(()=>({
    scrollY:window.scrollY,
    ev:{...window.__touchProof},
    dragging:document.getElementById('stage').classList.contains('is-book-dragging'),
    page:document.getElementById('pageCount')?.textContent||''
  }));

  const errors=[];
  if(touchAction!=='none')errors.push('touch-action:'+touchAction);
  const drift=Math.max(Math.abs(vertical.scrollY-scrollBefore),Math.abs(horizontal.scrollY-scrollBefore),Math.abs(end.scrollY-scrollBefore));
  if(drift>2)errors.push('vertical-scroll-drift:'+drift);
  if((end.ev.cancel||0)>0)errors.push('pointercancel:'+end.ev.cancel);
  if(!vertical.dragging||!horizontal.dragging)errors.push('book-did-not-own-gesture');
  if(end.dragging)errors.push('drag-not-released');
  if((end.ev.down||0)<1||(end.ev.move||0)<2||(end.ev.up||0)<1)errors.push('incomplete-pointer-sequence:'+JSON.stringify(end.ev));
  if(end.page===pageBefore)errors.push('page-did-not-turn:'+pageBefore);
  if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
  if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
  if(httpErrors.length)errors.push('http:'+JSON.stringify(httpErrors));
  if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));

  console.log(JSON.stringify({url,touchAction,pageBefore,scrollBefore,vertical,horizontal,end,consoleErrors,pageErrors,httpErrors,failed,ok:errors.length===0,errors},null,2));
  await browser.close();
  if(errors.length)throw new Error(url+' touch smoke failed: '+errors.join(' | '));
}

for(const url of urls)await test(url);
console.log('ALANTU_TOUCH_PAGE_TURN_SMOKE_OK');
