import { Wllama } from "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.6.1/esm/index.js";
import { PDFDocument, StandardFonts, rgb } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

const pdfjsLib=window.pdfjsLib;
if(!pdfjsLib)throw new Error("PDF.js fehlt.");
pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js";

const WLLAMA_PATHS={default:"https://cdn.jsdelivr.net/npm/@wllama/wllama@3.6.1/src/wasm/wllama.wasm"};

const MODEL={
  name:"Unlimited-OCR 3B · Q5",
  modelUrl:"https://huggingface.co/sahilchachra/Unlimited-OCR-GGUF/resolve/main/Unlimited-OCR-Q5_K_S.gguf?download=true",
  mmprojUrl:"https://huggingface.co/sahilchachra/Unlimited-OCR-GGUF/resolve/main/mmproj-Unlimited-OCR-F16.gguf?download=true",
  approxGiB:2.71,
  context:8192
};
const MAX_PAGES=60;
const RENDER_LONG_EDGE=2200;
const QUERY=new URLSearchParams(location.search);
const MOCK_OCR=QUERY.get("mockOcr")==="1";
const MOCK_OCR_DELAY=Math.max(0,Number(QUERY.get("mockOcrDelay"))||0);

const $=id=>document.getElementById(id);
const pdfInput=$("pdfInput"),dropzone=$("dropzone"),statusEl=$("status"),progressBar=$("progressBar"),fileBadge=$("fileBadge");
const mPages=$("mPages"),mNative=$("mNative"),mImageText=$("mImageText"),mBaked=$("mBaked"),mEngine=$("mEngine"),mVisual=$("mVisual");
const downloadPdfBtn=$("downloadPdfBtn"),downloadSvgBtn=$("downloadSvgBtn"),clearModelBtn=$("clearModelBtn");
const prevBtn=$("prevBtn"),nextBtn=$("nextBtn"),pageCounter=$("pageCounter");
const sideBtn=$("sideBtn"),overlayBtn=$("overlayBtn"),overlayTools=$("overlayTools"),overlayOpacity=$("overlayOpacity"),overlayValue=$("overlayValue"),showBoxes=$("showBoxes");
const compare=$("compare"),beforeImg=$("beforeImg"),afterImg=$("afterImg"),beforeOverlay=$("beforeOverlay"),afterOverlay=$("afterOverlay");
const sideBefore=$("sideBefore"),sideAfter=$("sideAfter"),sideGrid=$("sideGrid"),overlayWrap=$("overlayWrap"),overlayStage=$("overlayStage"),overlayBefore=$("overlayBefore"),overlayAfter=$("overlayAfter"),overlayBoxes=$("overlayBoxes");
const busy=$("busy"),empty=$("empty"),emptyTitle=$("emptyTitle"),emptyText=$("emptyText");

let pdfDoc=null,sourceName="exposee",pages=[],currentPage=0,loadToken=0;
let wllama=null,modelPromise=null,modelLoaded=false,modelGpu=false;
let compareMode="side";

function setStatus(text,kind=""){
  statusEl.className="status"+(kind?" "+kind:"");
  statusEl.querySelector("span:last-child").textContent=text;
}
function setProgress(v){progressBar.style.width=Math.max(0,Math.min(100,Number(v)||0))+"%"}
function sanitizeName(n){return (n||"document").replace(/\.pdf$/i,"").replace(/[\\/:*?"<>|]+/g,"-").replace(/\s+/g," ").trim()||"document"}
function normalizeText(v){return String(v??"").replace(/\s+/g," ").trim()}
function escapeXml(v){return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}
function area(b){return Math.max(0,b.x1-b.x0)*Math.max(0,b.y1-b.y0)}
function intersection(a,b){
  const x0=Math.max(a.x0,b.x0),y0=Math.max(a.y0,b.y0),x1=Math.min(a.x1,b.x1),y1=Math.min(a.y1,b.y1);
  return Math.max(0,x1-x0)*Math.max(0,y1-y0);
}
function overlapSmall(a,b){const d=Math.min(area(a),area(b));return d>0?intersection(a,b)/d:0}
function cleanForCompare(s){return normalizeText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"")}
function textSimilar(a,b){
  const x=cleanForCompare(a),y=cleanForCompare(b);
  if(!x||!y)return false;
  if(x.includes(y)||y.includes(x))return true;
  const short=x.length<y.length?x:y,long=x.length<y.length?y:x;
  let hit=0;for(const c of short)if(long.includes(c))hit++;
  return hit/Math.max(1,short.length)>.78;
}
function canvasToBlob(canvas,type="image/png",quality=.98){
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Seite konnte nicht gebacken werden.")),type,quality));
}
async function blobToArrayBuffer(blob){return blob.arrayBuffer()}

function hasRasterImages(opList){
  const O=pdfjsLib.OPS;
  const ops=new Set([O.paintImageXObject,O.paintJpegXObject,O.paintInlineImageXObject,O.paintImageMaskXObject]);
  return opList.fnArray.some(x=>ops.has(x));
}
function nativeTextRuns(textContent,viewport){
  const out=[];
  for(const item of textContent.items||[]){
    if(typeof item?.str!=="string"||!item.str.trim())continue;
    const tx=pdfjsLib.Util.transform(viewport.transform,item.transform);
    const h=Math.max(1,Math.hypot(tx[2],tx[3]));
    const w=Math.max(1,Math.abs((item.width||item.str.length*h*.52)*viewport.scale));
    const x=tx[4],yTop=tx[5]-h;
    out.push({
      text:item.str,
      bbox:{x0:x,y0:yTop,x1:x+w,y1:yTop+h*1.12},
      fontSize:h,
      angle:Math.atan2(tx[1],tx[0]),
      kind:"native"
    });
  }
  return out;
}
function parseNumbers(s){return (String(s||"").match(/-?\d+(?:\.\d+)?/g)||[]).map(Number)}
function unionBox(nums){
  if(nums.length<4)return null;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(let i=0;i+3<nums.length;i+=4){
    const a=nums[i],b=nums[i+1],c=nums[i+2],d=nums[i+3];
    x0=Math.min(x0,a,c);y0=Math.min(y0,b,d);x1=Math.max(x1,a,c);y1=Math.max(y1,b,d);
  }
  if(![x0,y0,x1,y1].every(Number.isFinite))return null;
  return {x0,y0,x1,y1};
}
function parseUnlimited(raw,pageW,pageH){
  raw=String(raw||"");
  const found=[];
  const add=(text,coord,type="text")=>{
    text=normalizeText(String(text||"").replace(/<\|[^>]+\|>/g," "));
    if(!text)return;
    const nums=parseNumbers(coord),u=unionBox(nums);if(!u)return;
    // Unlimited/DeepSeek OCR groundings use 0..999 image coordinates.
    const b={x0:u.x0/999*pageW,y0:u.y0/999*pageH,x1:u.x1/999*pageW,y1:u.y1/999*pageH};
    if(area(b)<1)return;
    found.push({text,bbox:b,type,kind:"image-text"});
  };

  for(const m of raw.matchAll(/<\|ref\|>([\s\S]*?)<\|\/ref\|>\s*<\|det\|>([\s\S]*?)<\|\/det\|>/g))add(m[1],m[2],"grounded");
  for(const m of raw.matchAll(/<\|det\|>([\s\S]*?)<\|\/det\|>\s*<\|ref\|>([\s\S]*?)<\|\/ref\|>/g))add(m[2],m[1],"grounded");

  if(!found.length){
    const matches=[...raw.matchAll(/<\|det\|>([\s\S]*?)<\|\/det\|>/g)];
    for(let i=0;i<matches.length;i++){
      const end=(matches[i].index||0)+matches[i][0].length;
      const next=i+1?(matches[i+1].index||raw.length):raw.length;
      const tail=raw.slice(end,next).split(/\n{2,}/)[0];
      add(tail,matches[i][1],"det");
    }
  }
  const unique=[];
  for(const f of found){
    if(unique.some(u=>textSimilar(u.text,f.text)&&overlapSmall(u.bbox,f.bbox)>.65))continue;
    unique.push(f);
  }
  return unique;
}
function filterNativeDuplicates(ocr,native){
  return ocr.filter(o=>{
    for(const n of native){
      const ov=overlapSmall(o.bbox,n.bbox);
      if(ov>.68)return false;
      if(ov>.28&&textSimilar(o.text,n.text))return false;
    }
    return true;
  });
}

async function createRuntime(gpu){
  const inst=new Wllama(WLLAMA_PATHS,{parallelDownloads:3,suppressNativeLog:true});
  inst.setCompat("default");
  await inst.loadModelFromUrl({url:MODEL.modelUrl,mmprojUrl:MODEL.mmprojUrl},{
    useCache:true,
    n_ctx:MODEL.context,
    n_gpu_layers:gpu?99999:0,
    n_threads:Math.max(1,Math.min(8,Math.floor((navigator.hardwareConcurrency||4)/2))),
    n_parallel:1,
    flash_attn:false,
    warmup:false,
    chat_template:"deepseek-ocr",
    jinja:true,
    progressCallback:({loaded,total})=>{
      if(total>0){
        const pct=Math.round(loaded/total*100);
        busy.textContent=`Unlimited-OCR 3B wird geladen · ${pct}%`;
        setStatus(`Unlimited-OCR 3B wird einmalig lokal geladen · ${pct}%`);
        setProgress(pct);
      }
    }
  });
  if(!inst.supportInputModality("image"))throw new Error("Unlimited-OCR Vision-Projektor konnte nicht aktiviert werden.");
  return inst;
}
async function ensureModel(){
  if(MOCK_OCR)return null;
  if(modelLoaded&&wllama)return wllama;
  if(modelPromise)return modelPromise;
  modelPromise=(async()=>{
    busy.classList.add("show");
    busy.textContent=`Unlimited-OCR 3B · ca. ${MODEL.approxGiB.toFixed(1)} GB einmalig`;
    const gpu=!!navigator.gpu;
    try{
      wllama=await createRuntime(gpu);
      modelGpu=gpu;
    }catch(err){
      if(!gpu)throw err;
      try{await wllama?.exit()}catch{}
      wllama=null;
      setStatus("WebGPU reicht nicht aus · Unlimited-OCR läuft auf CPU weiter …");
      wllama=await createRuntime(false);
      modelGpu=false;
    }
    modelLoaded=true;
    mEngine.textContent=`Unlimited-OCR 3B · ${modelGpu?"WebGPU":"CPU"}`;
    return wllama;
  })().finally(()=>{modelPromise=null});
  return modelPromise;
}
async function runUnlimited(imageBuffer){
  if(MOCK_OCR){
    if(MOCK_OCR_DELAY)await new Promise(r=>setTimeout(r,MOCK_OCR_DELAY));
    return "<|ref|>ALANTU EXPOSE<|/ref|><|det|>[[80,80,920,180]]<|/det|>\n<|ref|>Wohnung mit Seeblick in Konstanz<|/ref|><|det|>[[80,220,920,330]]<|/det|>";
  }
  const ai=await ensureModel();
  busy.textContent="Unlimited-OCR 3B erkennt Bildtext …";
  const response=await ai.createChatCompletion({
    messages:[{role:"user",content:[
      {type:"image",data:imageBuffer},
      {type:"text",text:"<|grounding|>OCR this image."}
    ]}],
    max_tokens:2600,
    temperature:0,
    top_p:1,
    repeat_penalty:1.0,
    stream:false
  });
  return response?.choices?.[0]?.message?.content||"";
}

async function convertPage(pageNo,token,onPreview=()=>{}){
  const page=await pdfDoc.getPage(pageNo);
  const base=page.getViewport({scale:1});
  const scale=Math.max(1.6,Math.min(3.6,RENDER_LONG_EDGE/Math.max(base.width,base.height)));
  const renderVp=page.getViewport({scale});
  const [textContent,opList]=await Promise.all([
    page.getTextContent({includeMarkedContent:true,disableNormalization:false}),
    page.getOperatorList()
  ]);
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(renderVp.width));canvas.height=Math.max(1,Math.round(renderVp.height));
  const ctx=canvas.getContext("2d",{alpha:false});ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:ctx,viewport:renderVp,background:"white"}).promise;
  if(token!==loadToken)throw new Error("cancelled");

  const pngBlob=await canvasToBlob(canvas,"image/png");
  const pngBytes=new Uint8Array(await blobToArrayBuffer(pngBlob));
  const previewUrl=URL.createObjectURL(pngBlob);

  // Store native PDF text in page coordinates, not rendered-pixel coordinates.
  const nativePx=nativeTextRuns(textContent,renderVp);
  const native=nativePx.map(r=>({...r,bbox:{
    x0:r.bbox.x0/scale,y0:r.bbox.y0/scale,x1:r.bbox.x1/scale,y1:r.bbox.y1/scale
  },fontSize:r.fontSize/scale}));

  const provisional={
    pageNo,width:base.width,height:base.height,pngBytes,previewUrl,native,ocr:[],rawOcr:"",
    usedAi:hasRasterImages(opList),bakedCount:1,processing:hasRasterImages(opList)
  };

  // Show the baked original immediately. Unlimited-OCR can take time to
  // download on first use, but the comparison UI must never look broken.
  onPreview(provisional);

  let ocr=[],rawOcr="";
  if(provisional.usedAi){
    const inputBlob=await canvasToBlob(canvas,"image/jpeg",.94);
    rawOcr=await runUnlimited(await blobToArrayBuffer(inputBlob));
    if(token!==loadToken)throw new Error("cancelled");
    ocr=filterNativeDuplicates(parseUnlimited(rawOcr,base.width,base.height),native);
  }
  canvas.width=1;canvas.height=1;

  provisional.ocr=ocr;
  provisional.rawOcr=rawOcr;
  provisional.processing=false;
  return provisional;
}

function allText(page){return [...page.native,...page.ocr]}
function updateMetrics(){
  const native=pages.reduce((n,p)=>n+p.native.length,0),imageText=pages.reduce((n,p)=>n+p.ocr.length,0);
  mPages.textContent=pages.length?String(pages.length):"—";
  mNative.textContent=pages.length?String(native):"—";
  mImageText.textContent=pages.length?String(imageText):"—";
  mBaked.textContent=pages.length?String(pages.length):"—";
  mVisual.textContent=pages.length?"100 % Originalbild":"—";
  if(!modelLoaded)mEngine.textContent="Unlimited-OCR 3B · lokal";
}
function makeBoxes(container,page){
  container.innerHTML="";
  if(!page||!showBoxes.checked)return;
  for(const r of page.ocr){
    const box=document.createElement("div");box.className="ocr-box";
    box.style.left=(r.bbox.x0/page.width*100)+"%";
    box.style.top=(r.bbox.y0/page.height*100)+"%";
    box.style.width=((r.bbox.x1-r.bbox.x0)/page.width*100)+"%";
    box.style.height=((r.bbox.y1-r.bbox.y0)/page.height*100)+"%";
    const label=document.createElement("span");label.textContent=r.text;box.appendChild(label);container.appendChild(box);
  }
}
function renderCompare(){
  const p=pages[currentPage];
  if(!p){
    empty.style.display="grid";
    sideGrid.hidden=true;overlayWrap.hidden=true;overlayStage.hidden=true;
    return;
  }
  empty.style.display="none";
  sideGrid.hidden=compareMode!=="side";
  overlayWrap.hidden=compareMode!=="overlay";
  overlayStage.hidden=compareMode!=="overlay";
  beforeImg.src=p.previewUrl;afterImg.src=p.previewUrl;overlayBefore.src=p.previewUrl;overlayAfter.src=p.previewUrl;
  makeBoxes(afterOverlay,p);makeBoxes(overlayBoxes,p);
  pageCounter.textContent=`${currentPage+1} / ${pages.length}`;
  prevBtn.disabled=currentPage<=0;nextBtn.disabled=currentPage>=pages.length-1;
  const opacity=Number(overlayOpacity.value)/100;
  overlayAfter.style.opacity=String(opacity);overlayValue.textContent=Math.round(opacity*100)+"%";
}
function setCompareMode(mode){
  compareMode=mode;
  sideBtn.classList.toggle("active",mode==="side");overlayBtn.classList.toggle("active",mode==="overlay");
  sideBefore.hidden=mode!=="side";sideAfter.hidden=mode!=="side";overlayTools.hidden=mode!=="overlay";
  renderCompare();
}

function xmlTextLayer(page,opacity="0"){
  const items=allText(page).map(r=>{
    const b=r.bbox,fs=Math.max(2,Math.min(b.y1-b.y0,18)),x=b.x0,y=b.y0+fs*.9,w=Math.max(1,b.x1-b.x0);
    return `<text data-kind="${r.kind}" x="${x.toFixed(3)}" y="${y.toFixed(3)}" font-family="Arial,Helvetica,sans-serif" font-size="${fs.toFixed(3)}" fill="#000" fill-opacity="${opacity}" textLength="${w.toFixed(3)}" lengthAdjust="spacingAndGlyphs">${escapeXml(r.text)}</text>`;
  }).join("");
  return `<g data-role="searchable-text">${items}</g>`;
}
function bytesToDataUrl(bytes){
  let bin="";const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)bin+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return "data:image/png;base64,"+btoa(bin);
}
function buildMergedSvg(){
  if(!pages.length)return "";
  const gap=24,maxW=Math.max(...pages.map(p=>p.width)),totalH=pages.reduce((n,p)=>n+p.height,0)+gap*(pages.length-1);
  let y=0,body="";
  for(const p of pages){
    const x=(maxW-p.width)/2;
    body+=`<svg x="${x}" y="${y}" width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}" preserveAspectRatio="none" data-page="${p.pageNo}"><image data-baked-original="1" x="0" y="0" width="${p.width}" height="${p.height}" href="${bytesToDataUrl(p.pngBytes)}"/>${xmlTextLayer(p,"0")}</svg>`;
    y+=p.height+gap;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${maxW}" height="${totalH}" viewBox="0 0 ${maxW} ${totalH}" data-alantu-merged="1" data-ocr-engine="Unlimited-OCR-3B-Q5">${body}</svg>`;
}
function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.rel="noopener";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function safePdfText(font,text){
  text=String(text||"");
  try{font.encodeText(text);return text}catch{}
  let out="";for(const ch of text){try{font.encodeText(ch);out+=ch}catch{out+=" "}}
  return normalizeText(out);
}
async function buildSearchablePdf(){
  if(!pages.length)return null;
  busy.classList.add("show");busy.textContent="Finales PDF wird gebaut …";setStatus("Finales PDF wird gebaut …");
  const out=await PDFDocument.create(),font=await out.embedFont(StandardFonts.Helvetica);
  for(let i=0;i<pages.length;i++){
    const p=pages[i];busy.textContent=`PDF-Seite ${i+1} / ${pages.length}`;setProgress((i/pages.length)*100);
    const img=await out.embedPng(p.pngBytes),page=out.addPage([p.width,p.height]);
    page.drawImage(img,{x:0,y:0,width:p.width,height:p.height});
    for(const r of allText(p)){
      const b=r.bbox,text=safePdfText(font,r.text);if(!text)continue;
      const h=Math.max(2,b.y1-b.y0),size=Math.max(2,Math.min(h*.82,24));
      const x=Math.max(0,b.x0),y=Math.max(0,p.height-b.y1);
      // Invisible PDF text: visual output remains the baked original, but text is searchable/selectable.
      page.drawText(text,{x,y,size,font,color:rgb(0,0,0),opacity:0,lineHeight:size});
    }
    if(i%2===1)await new Promise(requestAnimationFrame);
  }
  out.setTitle(sanitizeName(sourceName));
  out.setSubject("ALANTU searchable PDF · Unlimited-OCR 3B");
  out.setProducer("ALANTU Unlimited-OCR 3B");
  const bytes=await out.save({useObjectStreams:false});
  setProgress(100);setStatus("Finales PDF fertig · Originalbild + echter Textlayer.","ok");busy.classList.remove("show");setTimeout(()=>setProgress(0),900);
  return new Blob([bytes],{type:"application/pdf"});
}
async function downloadPdf(){
  downloadPdfBtn.disabled=true;
  try{const blob=await buildSearchablePdf();if(blob)downloadBlob(blob,sanitizeName(sourceName)+"-searchable.pdf")}
  catch(err){console.error(err);setStatus("PDF-Export fehlgeschlagen: "+err.message,"error");busy.classList.remove("show")}
  finally{downloadPdfBtn.disabled=false}
}
function downloadSvg(){
  try{const svg=buildMergedSvg();downloadBlob(new Blob([svg],{type:"image/svg+xml;charset=utf-8"}),sanitizeName(sourceName)+"-searchable.svg")}
  catch(err){console.error(err);setStatus("SVG-Export fehlgeschlagen: "+err.message,"error")}
}

async function clearDocument(){
  loadToken++;for(const p of pages)try{URL.revokeObjectURL(p.previewUrl)}catch{}
  pages=[];currentPage=0;beforeImg.removeAttribute("src");afterImg.removeAttribute("src");overlayBefore.removeAttribute("src");overlayAfter.removeAttribute("src");
  afterOverlay.innerHTML="";overlayBoxes.innerHTML="";downloadPdfBtn.disabled=true;downloadSvgBtn.disabled=true;prevBtn.disabled=true;nextBtn.disabled=true;
  sideGrid.hidden=true;overlayWrap.hidden=true;overlayStage.hidden=true;
  emptyTitle.textContent="PDF laden.";
  emptyText.textContent="Danach siehst du Original und Ergebnis direkt nebeneinander oder pixelgenau übereinander.";
  updateMetrics();setProgress(0);empty.style.display="grid";
  try{await pdfDoc?.destroy()}catch{}pdfDoc=null;
}
async function loadPdf(file){
  if(!file)return;
  if(file.type!=="application/pdf"&&!file.name.toLowerCase().endsWith(".pdf")){setStatus("Bitte eine PDF-Datei auswählen.","error");return}
  await clearDocument();const token=++loadToken;sourceName=file.name;fileBadge.textContent=file.name;busy.classList.add("show");setStatus("PDF wird gelesen …");setProgress(2);
  emptyTitle.textContent="Original wird vorbereitet …";
  emptyText.textContent="Sobald die erste Seite gerendert ist, erscheint sie sofort. Unlimited-OCR kann parallel noch laden.";
  empty.style.display="grid";
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());if(token!==loadToken)return;
    pdfDoc=await pdfjsLib.getDocument({data:bytes,fontExtraProperties:true}).promise;
    if(pdfDoc.numPages<1)throw new Error("PDF enthält keine Seiten.");if(pdfDoc.numPages>MAX_PAGES)throw new Error("Maximal "+MAX_PAGES+" Seiten.");
    for(let i=1;i<=pdfDoc.numPages;i++){
      if(token!==loadToken)throw new Error("cancelled");
      busy.textContent=`Seite ${i} / ${pdfDoc.numPages}`;
      setStatus(`Seite ${i} von ${pdfDoc.numPages}: Original backen + Bildtext erkennen …`);
      setProgress(4+(i-1)/pdfDoc.numPages*91);
      let provisionalAdded=false;
      const p=await convertPage(i,token,preview=>{
        if(token!==loadToken)return;
        pages.push(preview);provisionalAdded=true;updateMetrics();
        if(i===1){currentPage=0;renderCompare()}
      });
      if(!provisionalAdded)pages.push(p);
      updateMetrics();
      if(i===1){currentPage=0;renderCompare()}
      await new Promise(requestAnimationFrame);
    }
    setProgress(100);busy.classList.remove("show");
    setStatus(`${pages.length} Seiten fertig · visuell Original, zusätzlicher echter Textlayer.`,"ok");
    downloadPdfBtn.disabled=false;downloadSvgBtn.disabled=false;currentPage=0;renderCompare();setTimeout(()=>setProgress(0),900);
  }catch(err){
    busy.classList.remove("show");
    if(err?.message!=="cancelled"){console.error(err);setStatus(err?.message||"Konvertierung fehlgeschlagen.","error")}
  }
}

async function clearModelCache(){
  clearModelBtn.disabled=true;
  try{
    if(wllama){await wllama.exit();wllama=null}modelLoaded=false;modelPromise=null;
    for(const key of await caches.keys())await caches.delete(key);
    mEngine.textContent="Unlimited-OCR 3B · Cache leer";setStatus("Lokaler Unlimited-OCR-Cache gelöscht.","ok");
  }catch(err){setStatus("Cache konnte nicht vollständig gelöscht werden.","error")}
  finally{clearModelBtn.disabled=false}
}

pdfInput.addEventListener("change",()=>loadPdf(pdfInput.files?.[0]));
["dragenter","dragover"].forEach(t=>dropzone.addEventListener(t,e=>{e.preventDefault();dropzone.classList.add("drag")}));
["dragleave","drop"].forEach(t=>dropzone.addEventListener(t,e=>{e.preventDefault();dropzone.classList.remove("drag")}));
dropzone.addEventListener("drop",e=>{const f=e.dataTransfer?.files?.[0];if(f)loadPdf(f)});
prevBtn.addEventListener("click",()=>{if(currentPage>0){currentPage--;renderCompare()}});
nextBtn.addEventListener("click",()=>{if(currentPage<pages.length-1){currentPage++;renderCompare()}});
sideBtn.addEventListener("click",()=>setCompareMode("side"));overlayBtn.addEventListener("click",()=>setCompareMode("overlay"));
overlayOpacity.addEventListener("input",renderCompare);showBoxes.addEventListener("change",renderCompare);
downloadPdfBtn.addEventListener("click",downloadPdf);downloadSvgBtn.addEventListener("click",downloadSvg);clearModelBtn.addEventListener("click",clearModelCache);

mEngine.textContent="Unlimited-OCR 3B · lokal";updateMetrics();setCompareMode("side");
