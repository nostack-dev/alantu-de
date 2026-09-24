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
    assert(await page.locator('script[type="module"]').evaluate(node=>node.textContent.includes('view404')),
      'live page did not load the corrected shared view');
    if(kind==='pdf')await page.locator('#pdfInput').setInputFiles(pdf);
    const total=kind==='brand'?6:17;
    await page.waitForFunction(expected=>{
      const value=document.querySelector('#pageCount')?.textContent||'';
      return value.includes(`/ ${String(expected).padStart(2,'0')}`);
    },total,{timeout:120000});
    assert(await page.locator('#bookCanvas').evaluate(node=>!!node.getContext('webgl2')),
      'WebGL book did not initialize');
    const stage=page.locator('#stage');
    const marker=`${kind}-${viewport.width}`;
    await page.waitForTimeout(1500);
    const initial=await stage.screenshot({path:`${out}/${marker}-initial.png`});
    const next=page.locator('#tapNext');
    const prev=page.locator('#tapPrev');

    // The restored pre-switch viewer has a real start hardcover. First tap opens
    // that cover while pageCount intentionally remains 01 / total.
    await next.click({force:true});
    await page.waitForTimeout(1000);
    const opened=await stage.screenshot({path:`${out}/${marker}-opened.png`});
    assert(!initial.equals(opened),'start hardcover did not visibly open');

    // Second tap turns the first paper leaf.
    await next.click({force:true});
    await page.waitForTimeout(1000);
    const afterFirstLeaf=(await page.locator('#pageCount').textContent()).trim();
    assert(!afterFirstLeaf.startsWith('01 /'),
      `paper tap did not advance the book: ${afterFirstLeaf}`);

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

for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  for(const kind of ['brand','pdf'])await run(kind,viewport);
}
