import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';

const base=process.env.PDF_CONVERT_URL||'https://www.alantu.de/pdf-convert-anchor.html';
const url=base+(base.includes('?')?'&':'?')+'mockOcr=1';
const nativeSample=process.env.PDF_SAMPLE||'assets/sunside-living-expose.pdf';

async function makeScanPdf(browser){
  const p=await browser.newPage({viewport:{width:1200,height:1600}});
  await p.setContent('<canvas id="c" width="1200" height="1600"></canvas>');
  const dataUrl=await p.evaluate(()=>{
    const c=document.getElementById('c'),x=c.getContext('2d');
    x.fillStyle='white';x.fillRect(0,0,1200,1600);
    x.fillStyle='#111';x.font='700 72px Arial';x.fillText('ALANTU EXPOSE',90,180);
    x.font='42px Arial';x.fillText('Wohnung mit Seeblick in Konstanz',90,280);
    return c.toDataURL('image/png');
  });
  await p.close();
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]);
  const img=await pdf.embedPng(Buffer.from(dataUrl.split(',')[1],'base64'));
  page.drawImage(img,{x:0,y:0,width:600,height:800});
  const path='/tmp/alantu-scan-test.pdf';await fs.writeFile(path,await pdf.save());return path;
}

async function runCase(browser,file,label){
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const consoleErrors=[],pageErrors=[],failed=[];
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
  page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.locator('#pdfInput').setInputFiles(file);
  await page.waitForFunction(()=>!/disabled/.test(document.getElementById('downloadMergedBtn')?.outerHTML||'')&&!document.getElementById('downloadMergedBtn')?.disabled,null,{timeout:180000});
  const info=await page.evaluate(()=>({
    pages:document.getElementById('mPages')?.textContent||'',
    vector:document.getElementById('mVectorText')?.textContent||'',
    baked:document.getElementById('mBaked')?.textContent||'',
    complete:document.getElementById('mComplete')?.textContent||'',
    engine:document.getElementById('mEngine')?.textContent||'',
    mode:document.querySelector('#previewPage svg')?.getAttribute('data-mode')||'',
    native:document.querySelectorAll('#previewPage [data-native-text="1"]').length,
    unlimited:document.querySelectorAll('#previewPage [data-unlimited-ocr="1"]').length,
    diff:document.querySelectorAll('#previewPage [data-baked-diff="1"]').length,
    anchor:!!document.querySelector('.anchor')
  }));
  const dp=page.waitForEvent('download',{timeout:30000});
  await page.locator('#downloadMergedBtn').click();
  const dl=await dp,path=await dl.path(),source=await fs.readFile(path,'utf8');
  const errors=[];
  if(consoleErrors.length)errors.push(label+':console:'+JSON.stringify(consoleErrors));
  if(pageErrors.length)errors.push(label+':pageerror:'+JSON.stringify(pageErrors));
  if(failed.length)errors.push(label+':requestfailed:'+JSON.stringify(failed));
  if(info.anchor)errors.push(label+':manual-anchor-present');
  if(info.complete!=='100 % vollständig')errors.push(label+':not-complete:'+info.complete);
  if(info.mode!=='hybrid-unlimited')errors.push(label+':wrong-mode:'+info.mode);
  if(info.diff!==1)errors.push(label+':diff-missing:'+info.diff);
  if(!source.includes('data-alantu-merged="1"'))errors.push(label+':merged-marker-missing');
  if(!source.includes('data-ocr-engine="unlimited-ocr-3b"'))errors.push(label+':engine-marker-missing');
  if(!dl.suggestedFilename().endsWith('-alantu.svg'))errors.push(label+':bad-name:'+dl.suggestedFilename());
  await page.close();
  return {label,info,download:{name:dl.suggestedFilename(),bytes:source.length},errors};
}

const browser=await chromium.launch({headless:true});
const scan=await makeScanPdf(browser);
const native=await runCase(browser,nativeSample,'native-pdf');
const scanned=await runCase(browser,scan,'scan-pdf');
await browser.close();

const errors=[...native.errors,...scanned.errors];
if(scanned.info.unlimited<1)errors.push('scan-pdf:mock-unlimited-svg-missing');
console.log(JSON.stringify({url,native,scanned,ok:errors.length===0,errors},null,2));
if(errors.length)throw new Error(errors.join(' | '));
console.log('PDF_UNLIMITED_HYBRID_SMOKE_OK');
