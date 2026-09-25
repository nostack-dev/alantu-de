import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjsImport from 'pdfjs-dist/legacy/build/pdf.js';
const pdfjsLib=pdfjsImport.default||pdfjsImport;
import fs from 'node:fs/promises';

const base=process.env.PDF_CONVERT_URL||'https://www.alantu.de/pdf-convert-anchor.html';
const url=base+(base.includes('?')?'&':'?')+'mockOcr=1';

async function makeFixture(browser){
  const p=await browser.newPage({viewport:{width:1200,height:1600}});
  await p.setContent('<canvas id="c" width="1200" height="1600"></canvas>');
  const png=await p.evaluate(()=>{
    const c=document.getElementById('c'),x=c.getContext('2d');
    x.fillStyle='white';x.fillRect(0,0,1200,1600);
    x.fillStyle='#111';x.font='700 72px Arial';x.fillText('ALANTU EXPOSE',90,180);
    x.font='42px Arial';x.fillText('Wohnung mit Seeblick in Konstanz',90,280);
    x.fillStyle='#ddd';x.fillRect(90,380,1020,700);
    return c.toDataURL('image/png');
  });
  await p.close();

  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  const image=await pdf.embedPng(Buffer.from(png.split(',')[1],'base64'));

  const a=pdf.addPage([600,800]);
  a.drawImage(image,{x:0,y:0,width:600,height:800});

  const b=pdf.addPage([600,800]);
  b.drawText('Native PDF Text',{x:60,y:720,size:26,font});
  b.drawText('Already searchable',{x:60,y:680,size:16,font});
  b.drawImage(image,{x:60,y:140,width:480,height:480});

  const path='/tmp/alantu-uocr-fixture.pdf';
  await fs.writeFile(path,await pdf.save());
  return path;
}

async function extractPdfText(path){
  const bytes=new Uint8Array(await fs.readFile(path));
  const doc=await pdfjsLib.getDocument({data:bytes,disableWorker:true}).promise;
  const pages=[];
  for(let i=1;i<=doc.numPages;i++){
    const p=await doc.getPage(i),tc=await p.getTextContent();
    pages.push(tc.items.map(x=>x.str).join(' '));
  }
  await doc.destroy();
  return pages;
}

const browser=await chromium.launch({headless:true});
const fixture=await makeFixture(browser);
const page=await browser.newPage({viewport:{width:1500,height:1100}});
const consoleErrors=[],pageErrors=[],failed=[];
page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));

await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
await page.locator('#pdfInput').setInputFiles(fixture);
try{
  await page.waitForFunction(()=>document.getElementById('downloadPdfBtn')?.disabled===false,null,{timeout:45000});
}catch(err){
  const diagnostic=await page.evaluate(()=>({
    status:document.getElementById('status')?.textContent||'',
    progress:document.getElementById('progressBar')?.style.width||'',
    engine:document.getElementById('mEngine')?.textContent||'',
    pages:document.getElementById('mPages')?.textContent||'',
    imageText:document.getElementById('mImageText')?.textContent||'',
    busy:document.getElementById('busy')?.textContent||'',
    busyClass:document.getElementById('busy')?.className||'',
    buttonDisabled:document.getElementById('downloadPdfBtn')?.disabled,
    moduleScript:document.querySelector('script[src*="alantu-unlimited-ocr"]')?.src||''
  })).catch(()=>({}));
  console.error('READY_TIMEOUT_DIAGNOSTIC',JSON.stringify({diagnostic,consoleErrors,pageErrors,failed},null,2));
  throw err;
}

const side=await page.evaluate(()=>({
  pages:document.getElementById('mPages')?.textContent||'',
  native:document.getElementById('mNative')?.textContent||'',
  imageText:document.getElementById('mImageText')?.textContent||'',
  baked:document.getElementById('mBaked')?.textContent||'',
  visual:document.getElementById('mVisual')?.textContent||'',
  engine:document.getElementById('mEngine')?.textContent||'',
  beforeSrc:document.getElementById('beforeImg')?.src||'',
  afterSrc:document.getElementById('afterImg')?.src||'',
  boxes:document.querySelectorAll('#afterOverlay .ocr-box').length,
  sideBeforeHidden:document.getElementById('sideBefore')?.hidden,
  sideAfterHidden:document.getElementById('sideAfter')?.hidden,
  overlayHidden:document.getElementById('overlayStage')?.hidden
}));

await page.locator('#overlayBtn').click();
const overlay=await page.evaluate(()=>({
  hidden:document.getElementById('overlayStage')?.hidden,
  beforeSrc:document.getElementById('overlayBefore')?.src||'',
  afterSrc:document.getElementById('overlayAfter')?.src||'',
  opacity:getComputedStyle(document.getElementById('overlayAfter')).opacity,
  boxes:document.querySelectorAll('#overlayBoxes .ocr-box').length,
  toolsHidden:document.getElementById('overlayTools')?.hidden
}));

const downloadPromise=page.waitForEvent('download',{timeout:60000});
await page.locator('#downloadPdfBtn').click();
const dl=await downloadPromise;
const pdfPath=await dl.path();
const textPages=await extractPdfText(pdfPath);
const stat=await fs.stat(pdfPath);

const errors=[];
if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));
if(side.pages!=='2')errors.push('pages:'+side.pages);
if(Number(side.native)<2)errors.push('native-text-count:'+side.native);
if(Number(side.imageText)<1)errors.push('image-text-count:'+side.imageText);
if(side.baked!=='2')errors.push('baked-pages:'+side.baked);
if(side.visual!=='100 % Originalbild')errors.push('visual:'+side.visual);
if(!/Unlimited-OCR 3B/.test(side.engine))errors.push('engine:'+side.engine);
if(!side.beforeSrc||side.beforeSrc!==side.afterSrc)errors.push('side-by-side-not-identical-source');
if(side.boxes<1)errors.push('side-image-text-box-missing');
if(side.sideBeforeHidden||side.sideAfterHidden||!side.overlayHidden)errors.push('side-mode-broken');
if(overlay.hidden||overlay.toolsHidden)errors.push('overlay-mode-hidden');
if(!overlay.beforeSrc||overlay.beforeSrc!==overlay.afterSrc)errors.push('overlay-not-identical-source');
if(overlay.opacity!=='0.5')errors.push('overlay-opacity:'+overlay.opacity);
if(overlay.boxes<1)errors.push('overlay-boxes-missing');
if(stat.size<5000)errors.push('pdf-too-small:'+stat.size);
if(!dl.suggestedFilename().endsWith('-searchable.pdf'))errors.push('pdf-name:'+dl.suggestedFilename());
const allText=textPages.join(' | ');
if(!/Native PDF Text/.test(allText))errors.push('native-text-not-searchable:'+allText);
if(!/ALANTU EXPOSE/.test(allText))errors.push('ocr-text-not-searchable:'+allText);

console.log(JSON.stringify({url,side,overlay,download:{name:dl.suggestedFilename(),bytes:stat.size,textPages},ok:errors.length===0,errors},null,2));
await browser.close();
if(errors.length)throw new Error('Unlimited OCR searchable PDF smoke failed: '+errors.join(' | '));
console.log('UNLIMITED_OCR_SEARCHABLE_PDF_SMOKE_OK');
