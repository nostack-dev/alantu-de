import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const url=process.env.PDF_CONVERT_URL||'https://www.alantu.de/pdf-convert-anchor.html';
const sample=process.env.PDF_SAMPLE||'assets/sunside-living-expose.pdf';

const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const consoleErrors=[],pageErrors=[],httpErrors=[],failed=[];
page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
page.on('response',r=>{if(r.status()>=400&&!r.url().includes('favicon'))httpErrors.push({status:r.status(),url:r.url()})});
page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));

await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
await page.locator('#pdfInput').setInputFiles(sample);

try{
  await page.waitForFunction(()=>{
    const status=document.getElementById('status')?.textContent||'';
    return /Text.?SVG 100%/i.test(status)&&!!document.getElementById('pageSvg');
  },null,{timeout:45000});
}catch(err){
  const diagnostic=await page.evaluate(()=>({
    status:document.getElementById('status')?.textContent||'',
    svg:!!document.getElementById('pageSvg'),
    metric:document.getElementById('mTextSvg')?.textContent||'',
    mode:document.getElementById('modeBadge')?.textContent||'',
    busy:document.getElementById('busy')?.className||''
  })).catch(()=>({}));
  console.error('READY_TIMEOUT_DIAGNOSTIC',JSON.stringify({diagnostic,consoleErrors,pageErrors,httpErrors,failed},null,2));
  throw err;
}

const initial=await page.evaluate(()=>{
  const svg=document.getElementById('pageSvg');
  const semantic=svg?.querySelectorAll('[data-pdf-text="1"]').length||0;
  const metric=document.getElementById('mTextSvg')?.textContent||'';
  const nodes=Number(document.getElementById('mSvgNodes')?.textContent||0);
  const mode=document.getElementById('modeBadge')?.textContent||'';
  const delta=document.getElementById('mDelta')?.textContent||'';
  return {
    svg:!!svg,
    semantic,
    metric,
    nodes,
    mode,
    delta,
    viewBox:svg?.getAttribute('viewBox')||'',
    tiles:document.querySelectorAll('canvas.tile').length
  };
});

await page.locator('[data-zoom="32"]').click();
await page.waitForTimeout(350);
const deep=await page.evaluate(()=>({
  zoom:document.getElementById('mZoom')?.textContent||'',
  delta:document.getElementById('mDelta')?.textContent||'',
  width:document.getElementById('surface')?.getBoundingClientRect().width||0,
  svgWidth:document.getElementById('pageSvg')?.getBoundingClientRect().width||0,
  semantic:document.querySelectorAll('#pageSvg [data-pdf-text="1"]').length
}));

const downloadPromise=page.waitForEvent('download',{timeout:30000});
await page.locator('#downloadSvgBtn').click();
const download=await downloadPromise;
const path=await download.path();
const source=await fs.readFile(path,'utf8');
const semanticInDownload=(source.match(/data-pdf-text="1"/g)||[]).length;

const errors=[];
if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
if(httpErrors.length)errors.push('http:'+JSON.stringify(httpErrors));
if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));
if(!initial.svg)errors.push('svg-missing');
if(initial.semantic<1)errors.push('semantic-svg-text-missing');
if(!/100%/.test(initial.metric))errors.push('text-coverage-not-100:'+initial.metric);
if(initial.nodes<10)errors.push('svg-node-count-too-low:'+initial.nodes);
if(!/SVG/.test(initial.mode)||!/100%/.test(initial.mode))errors.push('mode-not-svg100:'+initial.mode);
if(initial.tiles!==0)errors.push('canvas-tiles-present:'+initial.tiles);
if(deep.zoom!=='32×')errors.push('deep-zoom-not-32:'+deep.zoom);
if(Math.abs(deep.width-deep.svgWidth)>0.5)errors.push('svg-surface-width-mismatch:'+JSON.stringify(deep));
if(deep.semantic!==initial.semantic)errors.push('svg-text-count-changed-on-zoom:'+initial.semantic+'->'+deep.semantic);
if(!/^<\?xml/.test(source)||!/<svg\b/.test(source))errors.push('download-not-svg');
if(semanticInDownload!==initial.semantic)errors.push('download-text-count-mismatch:'+semanticInDownload+'!='+initial.semantic);

console.log(JSON.stringify({url,initial,deep,download:{name:download.suggestedFilename(),bytes:source.length,semantic:semanticInDownload},consoleErrors,pageErrors,httpErrors,failed,ok:errors.length===0,errors},null,2));
await browser.close();
if(errors.length)throw new Error('PDF Convert Anchor SVG smoke failed: '+errors.join(' | '));
console.log('PDF_CONVERT_ANCHOR_SVG_SMOKE_OK');
