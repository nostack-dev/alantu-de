import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';

const url=process.env.PDF_CONVERT_URL||'https://www.alantu.de/pdf-convert-anchor.html';

async function makeFixture(browser){
  const p=await browser.newPage({viewport:{width:640,height:640}});
  await p.setContent('<canvas id="c" width="640" height="640"></canvas>');
  const png=await p.evaluate(()=>{
    const c=document.getElementById('c'),x=c.getContext('2d');
    x.fillStyle='white';x.fillRect(0,0,640,640);
    x.fillStyle='#111';x.font='700 46px Arial';x.fillText('ALANTU OCR TEST',48,130);
    x.font='30px Arial';x.fillText('Wohnung Konstanz 495000 EUR',48,210);
    return c.toDataURL('image/png');
  });
  await p.close();
  const pdf=await PDFDocument.create(),page=pdf.addPage([640,640]);
  const img=await pdf.embedPng(Buffer.from(png.split(',')[1],'base64'));
  page.drawImage(img,{x:0,y:0,width:640,height:640});
  const path='/tmp/uocr-real.pdf';await fs.writeFile(path,await pdf.save());return path;
}

const browser=await chromium.launch({headless:true,args:[
  '--js-flags=--max-old-space-size=6144',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader'
]});
const fixture=await makeFixture(browser);
const page=await browser.newPage({viewport:{width:1400,height:1000}});
const consoleErrors=[],pageErrors=[],failed=[];
page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
page.on('pageerror',e=>pageErrors.push(String(e?.stack||e)));
page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||'failed'}));
await page.goto(url+'?realUocrSmoke=1',{waitUntil:'domcontentloaded',timeout:60000});
const gpu=await page.evaluate(async()=>({
  hasNavigatorGpu:!!navigator.gpu,
  adapter:!!(navigator.gpu&&await navigator.gpu.requestAdapter())
}));
console.log('WEBGPU_CAPABILITY',JSON.stringify(gpu));
if(!gpu.hasNavigatorGpu||!gpu.adapter)throw new Error('CI Chromium has no usable WebGPU adapter');
await page.locator('#pdfInput').setInputFiles(fixture);
await page.waitForFunction(()=>{
  const status=document.getElementById('status')?.textContent||'';
  const button=document.getElementById('downloadPdfBtn');
  return button?.disabled===false || /fehler|fehlgeschlagen|konnte nicht|absturz/i.test(status);
},null,{timeout:900000});
const result=await page.evaluate(()=>({
  status:document.getElementById('status')?.textContent||'',
  engine:document.getElementById('mEngine')?.textContent||'',
  imageText:document.getElementById('mImageText')?.textContent||'',
  coverage:document.getElementById('mImageTextPercent')?.textContent||'',
  buttonDisabled:document.getElementById('downloadPdfBtn')?.disabled,
  debug:window.__alantuUocrDebug||null
}));
console.log(JSON.stringify({result,consoleErrors,pageErrors,failed},null,2));
await browser.close();
const errors=[];
if(result.buttonDisabled)errors.push('not-complete:'+result.status);
if(!/Unlimited-OCR 3B/.test(result.engine))errors.push('engine:'+result.engine);
if(Number(result.imageText)<1)errors.push('no-image-text:'+result.imageText);
if(!/100 % erkannter OCR-Text → echt/.test(result.coverage))errors.push('coverage:'+result.coverage);
if(consoleErrors.some(x=>/RuntimeError|Vision-Projektor|ABORT|unreachable|crashed/i.test(x)))errors.push('runtime-console:'+JSON.stringify(consoleErrors));
if(pageErrors.length)errors.push('pageerror:'+JSON.stringify(pageErrors));
if(errors.length)throw new Error(errors.join(' | '));
console.log('UNLIMITED_OCR_REAL_BROWSER_OK');
