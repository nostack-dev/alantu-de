import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjsImport from 'pdfjs-dist/legacy/build/pdf.js';
const pdfjsLib=pdfjsImport.default||pdfjsImport;
import fs from 'node:fs/promises';

const base=process.env.PDF_CONVERT_URL||'https://www.alantu.de/pdf-convert-anchor.html';
const url=base+(base.includes('?')?'&':'?')+'mockOcr=1&mockOcrDelay=2500';

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
  const pages=[],items=[];
  for(let i=1;i<=doc.numPages;i++){
    const p=await doc.getPage(i),tc=await p.getTextContent();
    pages.push(tc.items.map(x=>x.str).join(' '));
    items.push(tc.items.map(x=>({str:x.str,x:x.transform?.[4]||0,y:x.transform?.[5]||0,width:x.width||0,height:x.height||0})));
  }
  await doc.destroy();
  return {pages,items};
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

// While OCR is deliberately delayed, the baked original must already be
// visible. Empty/broken IMG placeholders were the live UX regression.
try{
  await page.waitForFunction(()=>{
    const img=document.getElementById('beforeImg');
    return !!img?.src&&img.complete&&img.naturalWidth>0;
  },null,{timeout:20000});
}catch(err){
  const boot=await page.evaluate(()=>({
    status:document.getElementById('status')?.textContent||'',
    moduleScript:document.querySelector('script[src*="alantu-unlimited-ocr"]')?.src||'',
    inputPresent:!!document.getElementById('pdfInput'),
    beforeSrc:document.getElementById('beforeImg')?.src||'',
    empty:document.getElementById('empty')?.textContent||'',
    readyState:document.readyState
  })).catch(()=>({}));
  console.error('BOOT_TIMEOUT_DIAGNOSTIC',JSON.stringify({boot,consoleErrors,pageErrors,failed},null,2));
  throw err;
}
const loadingView=await page.evaluate(()=>({
  emptyDisplay:getComputedStyle(document.getElementById('empty')).display,
  sideHidden:document.getElementById('sideGrid')?.hidden,
  before:{
    src:document.getElementById('beforeImg')?.src||'',
    naturalWidth:document.getElementById('beforeImg')?.naturalWidth||0,
    naturalHeight:document.getElementById('beforeImg')?.naturalHeight||0
  },
  after:{
    src:document.getElementById('afterImg')?.src||'',
    naturalWidth:document.getElementById('afterImg')?.naturalWidth||0,
    naturalHeight:document.getElementById('afterImg')?.naturalHeight||0
  },
  ocrInput:window.__alantuUocrDebug?.lastOcrInput||null,
  status:document.getElementById('status')?.textContent||''
}));
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
  imageTextPercent:document.getElementById('mImageTextPercent')?.textContent||'',
  baked:document.getElementById('mBaked')?.textContent||'',
  visual:document.getElementById('mVisual')?.textContent||'',
  engine:document.getElementById('mEngine')?.textContent||'',
  beforeSrc:document.getElementById('beforeImg')?.src||'',
  afterSrc:document.getElementById('afterImg')?.src||'',
  boxes:document.querySelectorAll('#afterOverlay .ocr-box').length,
  sideBeforeHidden:document.getElementById('sideBefore')?.hidden,
  sideAfterHidden:document.getElementById('sideAfter')?.hidden,
  overlayHidden:document.getElementById('overlayStage')?.hidden,
  vectorTexts:document.querySelectorAll('#afterVectorSvg text[data-kind="image-text-vector"]').length,
  nativeVectorTexts:document.querySelectorAll('#afterVectorSvg text[data-kind="native-text-vector"]').length,
  vectorRole:document.getElementById('afterVectorSvg')?.dataset?.role||'',
  vectorContract:window.__alantuVectorContract||null
}));

await page.locator('#overlayBtn').click();
const overlay=await page.evaluate(()=>({
  hidden:document.getElementById('overlayStage')?.hidden,
  beforeSrc:document.getElementById('overlayBefore')?.src||'',
  afterSrc:document.getElementById('overlayAfter')?.src||'',
  opacity:getComputedStyle(document.getElementById('overlayAfter')).opacity,
  boxes:document.querySelectorAll('#overlayBoxes .ocr-box').length,
  vectorTexts:document.querySelectorAll('#overlayVectorSvg text[data-kind="image-text-vector"]').length,
  nativeVectorTexts:document.querySelectorAll('#overlayVectorSvg text[data-kind="native-text-vector"]').length,
  vectorRole:document.getElementById('overlayVectorSvg')?.dataset?.role||'',
  toolsHidden:document.getElementById('overlayTools')?.hidden
}));

const downloadPromise=page.waitForEvent('download',{timeout:60000});
await page.locator('#downloadPdfBtn').click();
const dl=await downloadPromise;
const pdfPath=await dl.path();
const extracted=await extractPdfText(pdfPath);
const textPages=extracted.pages;
const stat=await fs.stat(pdfPath);

const errors=[];
if(loadingView.emptyDisplay!=='none')errors.push('loading-empty-still-visible:'+loadingView.emptyDisplay);
if(loadingView.sideHidden)errors.push('loading-side-grid-hidden');
if(loadingView.before.naturalWidth<1||loadingView.after.naturalWidth<1)errors.push('loading-image-broken:'+JSON.stringify(loadingView));
if(!loadingView.before.src||loadingView.before.src!==loadingView.after.src)errors.push('loading-before-after-source-mismatch');
if(!loadingView.ocrInput)errors.push('ocr-input-debug-missing');
else{
  if(loadingView.ocrInput.width!==1024||loadingView.ocrInput.height!==1024||loadingView.ocrInput.longEdge!==1024)errors.push('ocr-input-contract:'+JSON.stringify(loadingView.ocrInput));
  if(loadingView.ocrInput.contract!=='DeepEncoder ONNX [1,3,1024,1024]')errors.push('ocr-input-contract-label:'+JSON.stringify(loadingView.ocrInput));
}
if(consoleErrors.length)errors.push('console:'+JSON.stringify(consoleErrors));
if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
if(failed.length)errors.push('requestfailed:'+JSON.stringify(failed));
if(side.pages!=='2')errors.push('pages:'+side.pages);
if(Number(side.native)<2)errors.push('native-text-count:'+side.native);
if(Number(side.imageText)<1)errors.push('image-text-count:'+side.imageText);
if(!/^100 % Bildseiten mit OCR · 3B-OCR · /.test(side.imageTextPercent))errors.push('image-text-percent:'+side.imageTextPercent);
if(side.baked!=='2')errors.push('baked-pages:'+side.baked);
if(!/^Raster-Diff \+ \d+ Vektortext-Runs$/.test(side.visual))errors.push('visual:'+side.visual);
if(!/Unlimited-OCR 3B/.test(side.engine))errors.push('engine:'+side.engine);
if(!side.beforeSrc||!side.afterSrc||side.beforeSrc===side.afterSrc)errors.push('side-by-side-vector-preview-not-distinct');
if(side.boxes<1)errors.push('side-image-text-box-missing');
if(side.sideBeforeHidden||side.sideAfterHidden||!side.overlayHidden)errors.push('side-mode-broken');
if(overlay.hidden||overlay.toolsHidden)errors.push('overlay-mode-hidden');
if(!overlay.beforeSrc||!overlay.afterSrc||overlay.beforeSrc===overlay.afterSrc)errors.push('overlay-vector-preview-not-distinct');
if(overlay.opacity!=='0.5')errors.push('overlay-opacity:'+overlay.opacity);
if(overlay.boxes<1)errors.push('overlay-boxes-missing');
if(stat.size<5000)errors.push('pdf-too-small:'+stat.size);
if(!dl.suggestedFilename().endsWith('-vectorized.pdf'))errors.push('pdf-name:'+dl.suggestedFilename());
const svgDownloadPromise=page.waitForEvent('download',{timeout:60000});
await page.locator('#downloadSvgBtn').click();
const svgDl=await svgDownloadPromise;
const svgPath=await svgDl.path();
const svgText=await fs.readFile(svgPath,'utf8');
if(!svgDl.suggestedFilename().endsWith('-vectorized.svg'))errors.push('svg-name:'+svgDl.suggestedFilename());
if(!/data-baked-diff="1"/.test(svgText))errors.push('svg-raster-diff-missing');
if(!/data-role="visible-vector-text"/.test(svgText)||!/<text[^>]+data-kind="image-text-vector"/.test(svgText))errors.push('svg-visible-image-vector-text-missing');
if(!/<text[^>]+data-kind="native-text-vector"/.test(svgText))errors.push('svg-visible-native-vector-text-missing');
const allText=textPages.join(' | ');
if(!/ALANTU EXPOSE/.test(allText))errors.push('ocr-vector-text-missing:'+allText);
if(!/Native PDF Text/.test(allText)||!/Already searchable/.test(allText))errors.push('native-vector-text-missing:'+allText);
const firstVectorItem=extracted.items?.[0]?.find(x=>/ALANTU EXPOSE/.test(x.str));
if(!firstVectorItem)errors.push('ocr-vector-position-item-missing');
else{
  // Mock bbox [[80,80,920,180]] is mapped from 0..999 into a 600x800 page.
  // x should begin at ~48pt; baseline should stay inside that same OCR box.
  if(Math.abs(firstVectorItem.x-48.05)>6)errors.push('ocr-vector-x-drift:'+JSON.stringify(firstVectorItem));
  if(firstVectorItem.y<645||firstVectorItem.y>690)errors.push('ocr-vector-y-drift:'+JSON.stringify(firstVectorItem));
}
if(side.vectorTexts<1||side.nativeVectorTexts<1||side.vectorRole!=='visible-vector-text')errors.push('vector-preview-missing-visible-svg:'+JSON.stringify(side));
if(overlay.vectorTexts<1||overlay.nativeVectorTexts<1||overlay.vectorRole!=='visible-vector-text')errors.push('overlay-preview-missing-visible-svg:'+JSON.stringify(overlay));
if(side.vectorContract?.nativeText!=='visible-vector'||side.vectorContract?.ocrText!=='visible-vector'||side.vectorContract?.unrecognized!=='baked-diff'||side.vectorContract?.manualAnchor!==false)errors.push('vector-contract:'+JSON.stringify(side.vectorContract));

console.log(JSON.stringify({url,loadingView,side,overlay,download:{name:dl.suggestedFilename(),bytes:stat.size,textPages,firstVectorItem:extracted.items?.[0]?.find(x=>/ALANTU EXPOSE/.test(x.str))||null},svg:{name:svgDl.suggestedFilename(),bytes:svgText.length},ok:errors.length===0,errors},null,2));
if(errors.length){
  await browser.close();
  throw new Error('Unlimited OCR searchable PDF smoke failed: '+errors.join(' | '));
}

// Real lightweight cascade test: skip 3B deliberately and prove that the
// browser falls through to Tesseract, creates real image text, and enables export.
const fallbackPage=await browser.newPage({viewport:{width:1100,height:900}});
const fallbackConsoleErrors=[],fallbackPageErrors=[];
fallbackPage.on('console',m=>{if(m.type()==='error')fallbackConsoleErrors.push(m.text())});
fallbackPage.on('pageerror',e=>fallbackPageErrors.push(String(e?.stack||e)));
const fallbackUrl=base+(base.includes('?')?'&':'?')+'forceFallbackOcr=1';
await fallbackPage.goto(fallbackUrl,{waitUntil:'domcontentloaded',timeout:60000});
await fallbackPage.locator('#pdfInput').setInputFiles(fixture);
await fallbackPage.waitForFunction(()=>{
  const b=document.getElementById('downloadPdfBtn');
  const status=document.getElementById('status')?.textContent||'';
  return b?.disabled===false||/Export gesperrt|Bild-OCR fehlgeschlagen/.test(status);
},null,{timeout:240000});
const fallback=await fallbackPage.evaluate(()=>({
  status:document.getElementById('status')?.textContent||'',
  engine:document.getElementById('mEngine')?.textContent||'',
  imageText:document.getElementById('mImageText')?.textContent||'',
  coverage:document.getElementById('mImageTextPercent')?.textContent||'',
  bottleneck:document.getElementById('mBottleneck')?.textContent||'',
  buttonDisabled:document.getElementById('downloadPdfBtn')?.disabled,
  debug:window.__alantuUocrDebug?.fallback||null
}));
const fallbackErrors=[];
if(fallback.buttonDisabled)fallbackErrors.push('fallback-export-disabled:'+fallback.status);
if(!/Fallback-OCR/.test(fallback.engine))fallbackErrors.push('fallback-engine:'+fallback.engine);
if(Number(fallback.imageText)<1)fallbackErrors.push('fallback-no-image-text:'+fallback.imageText);
if(!/Fallback:/.test(fallback.coverage))fallbackErrors.push('fallback-coverage:'+fallback.coverage);
if(!fallback.debug||fallback.debug.engine!=='tesseract.js 5.1.1')fallbackErrors.push('fallback-debug:'+JSON.stringify(fallback.debug));
if(fallback.debug?.workerStarts!==1)fallbackErrors.push('fallback-worker-restarted:'+JSON.stringify(fallback.debug));
if(fallback.debug?.calls!==2)fallbackErrors.push('fallback-worker-calls:'+JSON.stringify(fallback.debug));
if(!(fallback.debug?.width>0&&fallback.debug?.height>0&&Math.max(fallback.debug.width,fallback.debug.height)<=1600))fallbackErrors.push('fallback-canvas:'+JSON.stringify(fallback.debug));
if(fallbackConsoleErrors.length)fallbackErrors.push('fallback-console:'+JSON.stringify(fallbackConsoleErrors));
if(fallbackPageErrors.length)fallbackErrors.push('fallback-pageerror:'+JSON.stringify(fallbackPageErrors));
console.log(JSON.stringify({fallbackUrl,fallback,ok:fallbackErrors.length===0,errors:fallbackErrors},null,2));
if(fallbackErrors.length){await browser.close();throw new Error('OCR fallback cascade smoke failed: '+fallbackErrors.join(' | '));}

// iPhone-13-Pro-class browser path: the runtime must detect that local 3B is
// not a safe fit, skip every multi-GB model request, and automatically finish
// with the lightweight fallback OCR instead of hanging or returning the input.
const mobileHeavyRequests=[];
const mobileContext=await browser.newContext({
  viewport:{width:390,height:844},
  screen:{width:390,height:844},
  isMobile:true,
  hasTouch:true,
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
});
const mobilePage=await mobileContext.newPage();
const mobileConsoleErrors=[],mobilePageErrors=[];
mobilePage.on('console',m=>{if(m.type()==='error')mobileConsoleErrors.push(m.text())});
mobilePage.on('pageerror',e=>mobilePageErrors.push(String(e?.stack||e)));
mobilePage.on('request',req=>{if(/Unlimited-OCR-Q4_K_M|deepencoder_fp32\.onnx/i.test(req.url()))mobileHeavyRequests.push(req.url())});
await mobilePage.goto(base,{waitUntil:'domcontentloaded',timeout:60000});
await mobilePage.locator('#pdfInput').setInputFiles(fixture);
await mobilePage.waitForFunction(()=>{
  const b=document.getElementById('downloadPdfBtn');
  const status=document.getElementById('status')?.textContent||'';
  return b?.disabled===false||/Export gesperrt|3B- und Fallback-OCR fehlgeschlagen/.test(status);
},null,{timeout:240000});
const mobile=await mobilePage.evaluate(()=>({
  status:document.getElementById('status')?.textContent||'',
  engine:document.getElementById('mEngine')?.textContent||'',
  imageText:document.getElementById('mImageText')?.textContent||'',
  coverage:document.getElementById('mImageTextPercent')?.textContent||'',
  bottleneck:document.getElementById('mBottleneck')?.textContent||'',
  buttonDisabled:document.getElementById('downloadPdfBtn')?.disabled,
  preflight:window.__alantuOcrDiagnostics||null,
  fallback:window.__alantuUocrDebug?.fallback||null,
  cascade:window.__alantuUocrDebug?.cascade||[]
}));
const mobileErrors=[];
if(mobile.buttonDisabled)mobileErrors.push('mobile-export-disabled:'+mobile.status);
if(Number(mobile.imageText)<1)mobileErrors.push('mobile-no-image-text:'+mobile.imageText);
if(!/Fallback-OCR/.test(mobile.engine))mobileErrors.push('mobile-engine:'+mobile.engine);
if(!mobile.bottleneck||mobile.bottleneck==='—')mobileErrors.push('mobile-bottleneck-missing:'+mobile.bottleneck);
if(!/Fallback:/.test(mobile.coverage))mobileErrors.push('mobile-coverage:'+mobile.coverage);
if(mobileHeavyRequests.length)mobileErrors.push('mobile-loaded-heavy-3b:'+JSON.stringify(mobileHeavyRequests));
if(mobile.preflight?.ok!==false)mobileErrors.push('mobile-preflight-not-blocked:'+JSON.stringify(mobile.preflight));
if(!mobile.preflight?.reasons?.some(x=>/WebKit|WebGPU-Adapter/i.test(x)))mobileErrors.push('mobile-preflight-reason:'+JSON.stringify(mobile.preflight));
if(mobile.fallback?.workerStarts!==1||mobile.fallback?.calls!==2)mobileErrors.push('mobile-fallback-worker:'+JSON.stringify(mobile.fallback));
if(mobileConsoleErrors.length)mobileErrors.push('mobile-console:'+JSON.stringify(mobileConsoleErrors));
if(mobilePageErrors.length)mobileErrors.push('mobile-pageerror:'+JSON.stringify(mobilePageErrors));
console.log(JSON.stringify({mobile,mobileHeavyRequests,ok:mobileErrors.length===0,errors:mobileErrors},null,2));
await mobileContext.close();
await browser.close();
if(mobileErrors.length)throw new Error('iPhone-class OCR cascade smoke failed: '+mobileErrors.join(' | '));
console.log('UNLIMITED_OCR_SEARCHABLE_PDF_SMOKE_OK');
console.log('UNLIMITED_OCR_FALLBACK_CASCADE_OK');
console.log('UNLIMITED_OCR_IPHONE_CASCADE_OK');
