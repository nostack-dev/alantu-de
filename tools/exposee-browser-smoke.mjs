import assert from 'node:assert/strict';
import {mkdir,rename} from 'node:fs/promises';
import {chromium} from 'playwright';

const origin=process.env.EXPOSEE_ORIGIN||'https://www.alantu.de';
const out=process.env.SMOKE_OUT||'/tmp/alantu-exposee-smoke';
const pdf=process.env.EXPOSEE_PDF||'assets/sunside-living-expose.pdf';
await mkdir(out,{recursive:true});

async function run(kind,viewport){
  const browser=await chromium.launch({
    headless:true,
    args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
  });
  const context=await browser.newContext({
    viewport,deviceScaleFactor:1,
    recordVideo:{dir:out,size:viewport}
  });
  const page=await context.newPage();
  const video=page.video();
  const errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{
    if(message.type()==='error')errors.push(message.text());
  });
  try{
    const path=kind==='brand'?'index-brand.html':'pdf-to-exposee.html';
    await page.goto(`${origin}/${path}?smoke=${process.env.GITHUB_SHA||Date.now()}`,{
      waitUntil:'domcontentloaded',timeout:60000
    });
    assert(await page.locator('script[type="module"]').evaluate(node=>node.textContent.includes('prepdf-fix1')),
      'live page did not load the corrected shared view');
    if(kind==='pdf')await page.locator('#pdfInput').setInputFiles(pdf);
    const total=kind==='brand'?6:17;
    await page.waitForFunction(expected=>{
      const value=document.querySelector('#pageCount')?.textContent||'';
      return value.includes(`/ ${String(expected).padStart(2,'0')}`);
    },total,{timeout:120000});
    assert(await page.locator('#bookCanvas').evaluate(node=>!!node.getContext('webgl2')),
      'WebGL book did not initialize');
    if(kind==='brand'){
      const html=await page.content();
      assert(!html.includes('Starnberger See · Bayern'),'stale Starnberger cover copy still present');
      assert(!html.includes('PRIVATE RESIDENCE'),'stale private-residence cover copy still present');
    }
    const stage=page.locator('#stage');

    if(viewport.width<=700){
      const axisLock=await stage.evaluate(el=>{
        const fire=(type,x,y)=>{
          const event=new Event(type,{bubbles:true,cancelable:true});
          const touches=type==='touchend'||type==='touchcancel'
            ? []
            : [{clientX:x,clientY:y}];
          Object.defineProperty(event,'touches',{value:touches});
          el.dispatchEvent(event);
          return {
            prevented:event.defaultPrevented,
            locked:el.classList.contains('is-book-scroll-locked')
          };
        };

        fire('touchstart',120,320);
        const horizontal=fire('touchmove',190,326);
        const horizontalEnd=fire('touchend',190,326);

        fire('touchstart',120,320);
        const vertical=fire('touchmove',125,390);
        fire('touchend',125,390);

        return {horizontal,horizontalEnd,vertical};
      });
      assert.equal(axisLock.horizontal.prevented,true,
        `horizontal touch did not suppress page scroll: ${JSON.stringify(axisLock)}`);
      assert.equal(axisLock.horizontal.locked,true,
        `horizontal touch did not engage book scroll lock: ${JSON.stringify(axisLock)}`);
      assert.equal(axisLock.horizontalEnd.locked,false,
        `book scroll lock survived touch end: ${JSON.stringify(axisLock)}`);
      assert.equal(axisLock.vertical.prevented,false,
        `vertical touch was incorrectly blocked: ${JSON.stringify(axisLock)}`);
    }

    const marker=`${kind}-${viewport.width}`;
    await page.waitForTimeout(1500);
    const initial=await stage.screenshot({path:`${out}/${marker}-initial.png`});
    const next=page.locator('#tapNext');
    const prev=page.locator('#tapPrev');

    // Restored viewer starts with the cover open. A short tap must turn the
    // first paper leaf instead of being swallowed by stage pointer capture.
    await next.click({force:true});
    await page.waitForTimeout(1000);
    const afterFirst=(await page.locator('#pageCount').textContent()).trim();
    assert(!afterFirst.startsWith('01 /'),
      `tap did not advance the book: ${afterFirst}`);
    const opened=await stage.screenshot({path:`${out}/${marker}-opened.png`});
    assert(!initial.equals(opened),'first paper turn image unchanged');

    const leaves=viewport.width<=700?total:Math.ceil(total/2);
    for(let i=1;i<leaves;i++)await next.click({force:true});
    // One final tap closes the end hardcover.
    await next.click({force:true});
    await page.waitForTimeout(1000);
    await stage.screenshot({path:`${out}/${marker}-end-cover.png`});
    await prev.click({force:true});
    await page.waitForTimeout(850);
    const reopened=await stage.screenshot({path:`${out}/${marker}-reopened.png`});
    assert(!opened.equals(reopened),'end cover image unchanged');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log(`${marker}: WebGL, opening, page turns, closing, reverse and screenshots OK`);
  }finally{
    await context.close();
    if(video)await rename(await video.path(),`${out}/${kind}-${viewport.width}-motion.webm`);
    await browser.close();
  }
}

for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:844,height:390}]){
  for(const kind of ['brand','pdf'])await run(kind,viewport);
}
