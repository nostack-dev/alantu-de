import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';

const url=process.env.PDF_CONVERT_URL||'https://www.alantu.de/pdf-convert-anchor.html';
const nativeSample=process.env.PDF_SAMPLE||'assets/sunside-living-expose.pdf';

async function makeScanPdf(browser){
  const p=await browser.newPage({viewport:{width:1200,height:1600}});
  await p.setContent('<!doctype html><html><body style="margin:0;background:white"><canvas id="c" width="1200" height="1600"></canvas></body></html>');
  const dataUrl=await p.evaluate(()=>{
    const c=document.getElementById('c'),ctx=c.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle='#111';ctx.font='700 72px Arial';ctx.fillText('ALANTU EXPOSE',90,180);
    ctx.font='42px Arial';ctx.fillText('Wohnung mit Seeblick in Konstanz',90,280);
    ctx.fillText('Kaufpreis 495.000 EUR',90,360);
    ctx.fillText('Wohnflaeche 92 m2',90,440);
    ctx.strokeStyle='#777';ctx.lineWidth=4;ctx.strokeRect(80,520,1040,700);
    ctx.fillStyle='#ddd';ctx.fillRect(100,540,1000,660);
    ctx.fillStyle='#222';ctx.font='36px Arial';ctx.fillText('Diese Zeile ist Teil des eingescannten Bildes.',120,1280);
    return c.toDataURL('image/png');
  });
  await p.close();
  const png=Buffer.from(dataUrl.split(',')[1],'base64');
  const pdf=await PDFDocument.create();
  const page=pdf.addPage([600,800]);
  const img=await pdf.embedPng(png);
  page.drawImage(img,{x:0,y:0,width:600,height:800});
  const bytes=await pdf.save();
  const out='/tmp/alantu-scan-test.pdf';
  await fs.writeFile(out,bytes);
  return out;
}

async function openConverter(browser){
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const consoleErrors=[],pageErrors=[],httpErrors=[],failed=[];
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
  page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
  page.on('response',r=>{if(r.status()>=400&&!r.url().includes('favicon'))httpErrors.push({status:r.status(),url:r.url()})});
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  return {page,consoleErrors,pageErrors,httpErrors,failed};
}

async function waitReady(page,timeout=180000){
  await page.waitForFunction(()=>{
    const status=document.getElementById('status')?.textContent||'';
    return /Seiten fertig|Seite fertig|Text ist Vektor/i.test(status)&&!document.getElementById('downloadMergedBtn')?.disabled;
  },null,{timeout});
}

async function testNative(browser){
  const ctx=await openConverter(browser);
  const {page}=ctx;
  await page.locator('#pdfInput').setInputFiles(nativeSample);
  await waitReady(page,120000);
  const info=await page.evaluate(()=>({
    pages:document.getElementById('mPages')?.textContent||'',
    vector:document.getElementById('mVectorText')?.textContent||'',
    baked:document.getElementById('mBaked')?.textContent||'',
    complete:document.getElementById('mComplete')?.textContent||'',
    anchor:!!document.querySelector('.anchor'),
    previewMode:document.querySelector('#previewPage svg')?.getAttribute('data-mode')||'',
    nativeText:document.querySelectorAll('#previewPage [data-native-text="1"]').length,
    ocrText:document.querySelectorAll('#previewPage [data-ocr-word="1"]').length
  }));

  const dlPromise=page.waitForEvent('download',{timeout:30000});
  await page.locator('#downloadMergedBtn').click();
  const dl=await dlPromise;
  const path=await dl.path();
  const source=await fs.readFile(path,'utf8');

  const errors=[];
  if(ctx.consoleErrors.length)errors.push('console:'+JSON.stringify(ctx.consoleErrors));
  if(ctx.pageErrors.length)errors.push('pageerror:'+JSON.stringify(ctx.pageErrors));
  if(ctx.httpErrors.length)errors.push('http:'+JSON.stringify(ctx.httpErrors));
  if(ctx.failed.length)errors.push('requestfailed:'+JSON.stringify(ctx.failed));
  if(info.anchor)errors.push('manual-anchor-still-present');
  if(info.complete!=='100 % vollständig')errors.push('document-not-complete:'+info.complete);
  if(Number(info.pages)<1)errors.push('page-count-invalid:'+info.pages);
  if(Number(info.vector)<1)errors.push('native-vector-text-missing:'+info.vector);
  if(info.previewMode!=='native')errors.push('native-page-not-native:'+info.previewMode);
  if(info.nativeText<1)errors.push('semantic-native-text-missing');
  if(!source.includes('data-alantu-merged="1"'))errors.push('merged-svg-marker-missing');
  if(!source.includes('data-native-text="1"'))errors.push('native-text-not-in-download');
  if(!dl.suggestedFilename().endsWith('-alantu.svg'))errors.push('wrong-merged-name:'+dl.suggestedFilename());

  await page.close();
  return {kind:'native',info,download:{name:dl.suggestedFilename(),bytes:source.length},errors,...ctx};
}

async function testOcr(browser,scanPdf){
  const ctx=await openConverter(browser);
  const {page}=ctx;
  await page.locator('#pdfInput').setInputFiles(scanPdf);
  await waitReady(page,300000);

  const info=await page.evaluate(()=>({
    pages:document.getElementById('mPages')?.textContent||'',
    vector:document.getElementById('mVectorText')?.textContent||'',
    baked:document.getElementById('mBaked')?.textContent||'',
    complete:document.getElementById('mComplete')?.textContent||'',
    previewMode:document.querySelector('#previewPage svg')?.getAttribute('data-mode')||'',
    ocrText:document.querySelectorAll('#previewPage [data-ocr-word="1"]').length,
    bakedDiff:document.querySelectorAll('#previewPage [data-baked-diff="1"]').length,
    words:[...document.querySelectorAll('#previewPage [data-ocr-word="1"]')].slice(0,12).map(x=>x.textContent)
  }));

  const dlPromise=page.waitForEvent('download',{timeout:30000});
  await page.locator('#downloadMergedBtn').click();
  const dl=await dlPromise;
  const path=await dl.path();
  const source=await fs.readFile(path,'utf8');

  const errors=[];
  if(ctx.consoleErrors.length)errors.push('console:'+JSON.stringify(ctx.consoleErrors));
  if(ctx.pageErrors.length)errors.push('pageerror:'+JSON.stringify(ctx.pageErrors));
  if(ctx.httpErrors.length)errors.push('http:'+JSON.stringify(ctx.httpErrors));
  if(ctx.failed.length)errors.push('requestfailed:'+JSON.stringify(ctx.failed));
  if(info.complete!=='100 % vollständig')errors.push('ocr-document-not-complete:'+info.complete);
  if(info.previewMode!=='ocr')errors.push('scan-page-not-ocr:'+info.previewMode);
  if(info.ocrText<4)errors.push('too-few-ocr-words:'+info.ocrText);
  if(info.bakedDiff!==1)errors.push('baked-diff-missing:'+info.bakedDiff);
  if(Number(info.baked)<1)errors.push('baked-summary-missing:'+info.baked);
  if(!source.includes('data-ocr-word="1"'))errors.push('ocr-text-not-in-download');
  if(!source.includes('data-baked-diff="1"'))errors.push('residual-diff-not-in-download');
  if(!/ALANTU|EXPOSE|Wohnung|Kaufpreis|Konstanz/i.test(info.words.join(' ')))errors.push('expected-scan-text-not-recognized:'+info.words.join(' '));

  await page.close();
  return {kind:'ocr',info,download:{name:dl.suggestedFilename(),bytes:source.length},errors,...ctx};
}

const browser=await chromium.launch({headless:true});
const scanPdf=await makeScanPdf(browser);
const native=await testNative(browser);
const ocr=await testOcr(browser,scanPdf);
await browser.close();

const errors=[...native.errors,...ocr.errors];
console.log(JSON.stringify({
  url,
  native:{info:native.info,download:native.download},
  ocr:{info:ocr.info,download:ocr.download},
  ok:errors.length===0,
  errors
},null,2));
if(errors.length)throw new Error('PDF Hybrid SVG smoke failed: '+errors.join(' | '));
console.log('PDF_HYBRID_SVG_SMOKE_OK');
