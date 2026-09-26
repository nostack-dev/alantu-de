import { createGemmaEngine } from "./vendor/unlimited-ocr-browser-engine.js";
import { PDFDocument, StandardFonts, rgb } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

const pdfjsLib=window.pdfjsLib;
if(!pdfjsLib)throw new Error("PDF.js fehlt.");
pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js";

const MODEL={
  name:"Unlimited-OCR 3B · browser-native WebGPU",
  decoderUrl:"https://huggingface.co/sahilchachra/Unlimited-OCR-GGUF/resolve/main/Unlimited-OCR-Q4_K_M.gguf",
  visionUrl:"https://huggingface.co/naklitechie/Unlimited-OCR-DeepEncoder-ONNX/resolve/main/deepencoder_fp32.onnx",
  extrasUrl:"https://huggingface.co/naklitechie/Unlimited-OCR-DeepEncoder-ONNX/resolve/main/deepencoder_extras.npz",
  approxGiB:3.55,
  context:2048
};
const ORT_URL="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.webgpu.min.mjs";
const ENGINE_REF="NakliTechie/gemma4-webgpu@0ca5e3a";
const BOS=0,EOS=1,HIDDEN=1280,GRID=16;
const PROMPT_IDS=[34030,76466,16]; // exact "document parsing." ids from the reference browser implementation
const MAX_PAGES=60;
const RENDER_LONG_EDGE=2200;
// Unlimited-OCR's DeepEncoder base path is a 1024×1024 vision input.
// Feeding the full 2200px preview into wllama WebGPU made ggml dispatch
// >65,535 workgroups and hard-aborted the WASM runtime on real browsers.
const OCR_LONG_EDGE=1024;
const QUERY=new URLSearchParams(location.search);
const MOCK_OCR=QUERY.get("mockOcr")==="1";
const FORCE_FALLBACK_OCR=QUERY.get("forceFallbackOcr")==="1";
const MOCK_OCR_DELAY=Math.max(0,Number(QUERY.get("mockOcrDelay"))||0);

const $=id=>document.getElementById(id);
const pdfInput=$("pdfInput"),dropzone=$("dropzone"),statusEl=$("status"),progressBar=$("progressBar"),fileBadge=$("fileBadge");
const mPages=$("mPages"),mNative=$("mNative"),mImageText=$("mImageText"),mImageTextPercent=$("mImageTextPercent"),mBaked=$("mBaked"),mEngine=$("mEngine"),mVisual=$("mVisual");
const downloadPdfBtn=$("downloadPdfBtn"),downloadSvgBtn=$("downloadSvgBtn"),clearModelBtn=$("clearModelBtn");
const prevBtn=$("prevBtn"),nextBtn=$("nextBtn"),pageCounter=$("pageCounter");
const sideBtn=$("sideBtn"),overlayBtn=$("overlayBtn"),overlayTools=$("overlayTools"),overlayOpacity=$("overlayOpacity"),overlayValue=$("overlayValue"),showBoxes=$("showBoxes");
const compare=$("compare"),beforeImg=$("beforeImg"),afterImg=$("afterImg"),beforeOverlay=$("beforeOverlay"),afterOverlay=$("afterOverlay");
const sideBefore=$("sideBefore"),sideAfter=$("sideAfter"),sideGrid=$("sideGrid"),overlayWrap=$("overlayWrap"),overlayStage=$("overlayStage"),overlayBefore=$("overlayBefore"),overlayAfter=$("overlayAfter"),overlayBoxes=$("overlayBoxes"),afterVectorSvg=$("afterVectorSvg"),overlayVectorSvg=$("overlayVectorSvg");
const busy=$("busy"),empty=$("empty"),emptyTitle=$("emptyTitle"),emptyText=$("emptyText");

let pdfDoc=null,sourceName="exposee",pages=[],currentPage=0,loadToken=0;
let decoderEngine=null,decoderPromise=null,visionSession=null,visionPromise=null,visionExtras=null,extrasPromise=null,modelLoaded=false;
let primaryOcrDisabledReason="";
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
function clampByte(v){return Math.max(0,Math.min(255,Math.round(v)))}
function rgbHex(r,g,b){return "#"+[r,g,b].map(v=>clampByte(v).toString(16).padStart(2,"0")).join("")}
function colorDistance(a,b){const dr=a[0]-b[0],dg=a[1]-b[1],db=a[2]-b[2];return Math.sqrt(dr*dr+dg*dg+db*db)}
function sampleTextStyle(ctx,rect){
  const x0=Math.max(0,Math.floor(rect.x0)),y0=Math.max(0,Math.floor(rect.y0)),x1=Math.min(ctx.canvas.width,Math.ceil(rect.x1)),y1=Math.min(ctx.canvas.height,Math.ceil(rect.y1));
  const w=Math.max(1,x1-x0),h=Math.max(1,y1-y0),img=ctx.getImageData(x0,y0,w,h),d=img.data;
  const border=[];
  for(let x=0;x<w;x++){for(const y of [0,h-1]){const i=(y*w+x)*4;border.push([d[i],d[i+1],d[i+2]])}}
  for(let y=1;y<h-1;y++){for(const x of [0,w-1]){const i=(y*w+x)*4;border.push([d[i],d[i+1],d[i+2]])}}
  const bg=[0,1,2].map(c=>border.length?border.reduce((n,p)=>n+p[c],0)/border.length:255);
  const candidates=[];
  const step=Math.max(1,Math.floor(Math.min(w,h)/40));
  for(let y=0;y<h;y+=step)for(let x=0;x<w;x+=step){const i=(y*w+x)*4,p=[d[i],d[i+1],d[i+2]],dist=colorDistance(p,bg);if(dist>55)candidates.push({p,dist})}
  candidates.sort((a,b)=>b.dist-a.dist);
  const top=candidates.slice(0,Math.max(1,Math.min(120,Math.ceil(candidates.length*.18))));
  const fg=[0,1,2].map(c=>top.length?top.reduce((n,q)=>n+q.p[c],0)/top.length:(bg[0]+bg[1]+bg[2])/3>128?20:235);
  return {fill:rgbHex(...fg),rgb:fg.map(v=>clampByte(v)/255),background:bg};
}
function inpaintTextRect(ctx,rect,style){
  const W=ctx.canvas.width,H=ctx.canvas.height;
  const x0=Math.max(1,Math.floor(rect.x0)-1),y0=Math.max(1,Math.floor(rect.y0)-1),x1=Math.min(W-2,Math.ceil(rect.x1)+1),y1=Math.min(H-2,Math.ceil(rect.y1)+1);
  const w=x1-x0+1,h=y1-y0+1;if(w<2||h<2)return 0;
  const patch=ctx.getImageData(x0-1,y0-1,w+2,h+2),pd=patch.data,pw=w+2,out=ctx.createImageData(w,h),od=out.data;
  const bg=style?.background||[255,255,255],fg=(style?.rgb||[0,0,0]).map(v=>v*255);
  const pix=(x,y,c)=>pd[((y+1)*pw+(x+1))*4+c];
  let removed=0;
  for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
    const tx=w<=1?0:xx/(w-1),ty=h<=1?0:yy/(h-1),oi=(yy*w+xx)*4;
    const original=[pix(xx,yy,0),pix(xx,yy,1),pix(xx,yy,2)];
    const dBg=colorDistance(original,bg),dFg=colorDistance(original,fg);
    // Only erase pixels that look like the inferred glyph color. Keeping
    // background-like pixels is the "diff bake": artwork inside the OCR box
    // survives instead of blanking the whole rectangle.
    const isGlyph=dBg>18 && dFg+10<dBg;
    for(let c=0;c<3;c++){
      if(isGlyph){
        const top=pix(xx,-1,c),bottom=pix(xx,h,c),left=pix(-1,yy,c),right=pix(w,yy,c);
        const vertical=top*(1-ty)+bottom*ty,horizontal=left*(1-tx)+right*tx;
        od[oi+c]=clampByte((vertical+horizontal)/2);
      }else od[oi+c]=original[c];
    }
    if(isGlyph)removed++;
    od[oi+3]=255;
  }
  ctx.putImageData(out,x0,y0);
  return removed;
}
async function makeVectorizedRaster(sourceCanvas,ocr,pageW,pageH){
  const c=document.createElement("canvas");c.width=sourceCanvas.width;c.height=sourceCanvas.height;
  const ctx=c.getContext("2d",{alpha:false});ctx.drawImage(sourceCanvas,0,0);
  const sx=c.width/pageW,sy=c.height/pageH;
  for(const r of ocr){
    const px={x0:r.bbox.x0*sx,y0:r.bbox.y0*sy,x1:r.bbox.x1*sx,y1:r.bbox.y1*sy};
    r.vectorStyle=sampleTextStyle(ctx,px);
    r.vectorPixelsRemoved=inpaintTextRect(ctx,px,r.vectorStyle);
  }
  const blob=await canvasToBlob(c,"image/png");
  const bytes=new Uint8Array(await blobToArrayBuffer(blob));
  const url=URL.createObjectURL(blob);
  c.width=1;c.height=1;
  return {bytes,url};
}
function vectorTextSvg(page){
  return page.ocr.map(r=>{
    const b=r.bbox,h=Math.max(2,b.y1-b.y0),fs=Math.max(2,h*.82),x=b.x0,y=b.y0+fs*.9,w=Math.max(1,b.x1-b.x0),fill=r.vectorStyle?.fill||"#111111";
    return `<text data-kind="image-text-vector" x="${x.toFixed(3)}" y="${y.toFixed(3)}" font-family="Arial,Helvetica,sans-serif" font-size="${fs.toFixed(3)}" fill="${fill}" textLength="${w.toFixed(3)}" lengthAdjust="spacingAndGlyphs">${escapeXml(r.text)}</text>`;
  }).join("");
}


function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function shortError(err){
  return String(err?.message||err||"Unbekannter OCR-Fehler").replace(/\s+/g," ").trim();
}
function classifyOcrFailure(err){
  const raw=shortError(err),m=raw.toLowerCase();
  let code="RUNTIME";
  if(/lokale 3b-ocr nicht gestartet|bottleneck:|preflight/.test(m))code="PREFLIGHT";
  else if(/webgpu|gpu|adapter|device lost|storagebuffer|texture/.test(m))code="WEBGPU";
  else if(/out of memory|memory access|allocation|alloc_graph|quota|speicher/.test(m))code="MEMORY";
  else if(/timeout|timed out/.test(m))code="TIMEOUT";
  else if(/failed to fetch|networkerror|download|http \d|load failed|fetch/.test(m))code="NETWORK";
  else if(/decoder|vision|onnx|modell/.test(m))code="MODEL";
  return {code,raw:raw.slice(0,600)};
}
function recordCascade(stage,state,detail={}){
  window.__alantuUocrDebug=window.__alantuUocrDebug||{};
  const log=window.__alantuUocrDebug.cascade||(window.__alantuUocrDebug.cascade=[]);
  log.push({at:new Date().toISOString(),stage,state,...detail});
  if(log.length>80)log.splice(0,log.length-80);
}
let heartbeatTimer=null;
function startHeartbeat(label){
  const start=Date.now();
  clearInterval(heartbeatTimer);
  busy.classList.add("show");
  heartbeatTimer=setInterval(()=>{
    const sec=Math.max(1,Math.round((Date.now()-start)/1000));
    busy.textContent=label+" · "+sec+"s";
    setStatus(label+" · läuft seit "+sec+"s");
  },1000);
  return ()=>{clearInterval(heartbeatTimer);heartbeatTimer=null};
}
async function withHeartbeat(label,fn,timeoutMs=300000){
  const stop=startHeartbeat(label);let timer;
  try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+": Timeout nach "+Math.round(timeoutMs/1000)+"s")),timeoutMs)})])}
  catch(err){throw new Error(label+": "+shortError(err))}
  finally{clearTimeout(timer);stop()}
}
async function fetchWithRetry(url,opts={},label="Datei"){
  let last;
  for(let i=1;i<=3;i++){
    try{setStatus(label+" laden · Versuch "+i+"/3");const resp=await fetch(url,{...opts,cache:opts.cache||"force-cache"});if(resp.ok)return resp;last=new Error("HTTP "+resp.status)}catch(err){last=err}
    await sleep(800*i);
  }
  throw new Error(label+": "+shortError(last));
}


const LOCAL_OCR_NEEDS={workingSetGiB:5.2,physicalRamGiB:8,texture:1024,bufferMiB:256,storageBufferMiB:256};
let localOcrPreflightPromise=null;
function gib(v){return Math.round(v/1024/1024/1024*10)/10}
function mib(v){return Math.round(v/1024/1024)}
function isIOSLike(){const ua=navigator.userAgent||"";return /iP(hone|ad|od)/.test(ua)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1)}
function isMobileLike(){return isIOSLike()||/Android|Mobile/i.test(navigator.userAgent||"")}
async function diagnoseLocalOcrBottleneck(){
  const reasons=[],facts=[];
  const ua=navigator.userAgent||"";
  facts.push("Browser: "+ua.slice(0,140));
  facts.push("3B-Pfad: GGUF-Decoder wird per HTTP Range direkt in GPU-Buffers gestreamt; Browser-Storage ist kein Hard-Gate. Arbeitsmenge grob >"+LOCAL_OCR_NEEDS.workingSetGiB+"GB inklusive Vision-Encoder und Laufzeitpuffern.");
  if(isIOSLike())reasons.push("Bottleneck: WebKit stellt keinen verlässlichen RAM-/GPU-Speicherbudgetwert für diesen Tab bereit; bei >"+LOCAL_OCR_NEEDS.workingSetGiB+"GB benötigter Arbeitsmenge kann der 3B-Pfad daher nicht sicher reserviert werden. Automatischer lokaler Fallback statt riskantem Tab-Absturz.");
  if(!navigator.gpu)reasons.push("Bottleneck: WebGPU fehlt in diesem Browser. Der Vision-Encoder/Decoder kann lokal nicht gestartet werden.");
  if(navigator.deviceMemory){
    facts.push("Gemeldeter RAM-Bucket: "+navigator.deviceMemory+"GB");
    if(navigator.deviceMemory<LOCAL_OCR_NEEDS.physicalRamGiB)reasons.push("Bottleneck: gemeldeter RAM-Bucket "+navigator.deviceMemory+"GB < benötigte Desktop-Reserve ca. "+LOCAL_OCR_NEEDS.physicalRamGiB+"GB.");
  }else if(isMobileLike()){
    facts.push("RAM-Bucket wird vom mobilen Browser nicht offengelegt; genau das verhindert zuverlässige lokale 3B-Planung.");
  }
  try{
    if(navigator.storage?.estimate){
      const st=await navigator.storage.estimate();
      const free=Math.max(0,(st.quota||0)-(st.usage||0));
      facts.push("Browser-Storage frei: "+gib(free)+"GB von "+gib(st.quota||0)+"GB Quote (Diagnose בלבד; kein 3B-Gate, weil der Decoder per HTTP Range streamt).");
    }
  }catch(e){facts.push("Storage-Estimate nicht verfügbar: "+shortError(e))}
  if(navigator.gpu){
    try{
      const adapter=await navigator.gpu.requestAdapter();
      if(!adapter)reasons.push("Bottleneck: WebGPU-Adapter konnte nicht reserviert werden.");
      else{
        const l=adapter.limits||{};
        facts.push("WebGPU limits: texture2D="+(l.maxTextureDimension2D||"?")+", storageBuffer="+(l.maxStorageBufferBindingSize?mib(l.maxStorageBufferBindingSize)+"MB":"?")+", buffer="+(l.maxBufferSize?mib(l.maxBufferSize)+"MB":"?"));
        const info=adapter.info||{};if(info.vendor||info.architecture||info.device)facts.push("WebGPU Adapter: "+[info.vendor,info.architecture,info.device].filter(Boolean).join(" / "));
        if(l.maxTextureDimension2D&&l.maxTextureDimension2D<LOCAL_OCR_NEEDS.texture)reasons.push("Bottleneck: maxTextureDimension2D "+l.maxTextureDimension2D+" < "+LOCAL_OCR_NEEDS.texture+".");
        if(l.maxBufferSize&&l.maxBufferSize<LOCAL_OCR_NEEDS.bufferMiB*1024*1024)reasons.push("Bottleneck: maxBufferSize "+mib(l.maxBufferSize)+"MB < "+LOCAL_OCR_NEEDS.bufferMiB+"MB.");
        if(l.maxStorageBufferBindingSize&&l.maxStorageBufferBindingSize<LOCAL_OCR_NEEDS.storageBufferMiB*1024*1024)reasons.push("Bottleneck: maxStorageBufferBindingSize "+mib(l.maxStorageBufferBindingSize)+"MB < "+LOCAL_OCR_NEEDS.storageBufferMiB+"MB.");
      }
    }catch(e){reasons.push("Bottleneck: WebGPU-Probe fehlgeschlagen: "+shortError(e))}
  }
  const ok=!reasons.length;
  const report={ok,reasons,facts,workingSetGiB:LOCAL_OCR_NEEDS.workingSetGiB,decoderTransport:"HTTP Range → GPU buffers",checkedAt:new Date().toISOString()};
  window.__alantuOcrDiagnostics=report;
  window.__alantuUocrDebug=window.__alantuUocrDebug||{};
  window.__alantuUocrDebug.preflight=report;
  return report;
}
async function requireLocalOcrCapability(){
  if(MOCK_OCR)return;
  if(!localOcrPreflightPromise)localOcrPreflightPromise=diagnoseLocalOcrBottleneck();
  const d=await localOcrPreflightPromise;
  if(!d.ok){
    const msg="Lokale 3B-OCR nicht gestartet. "+d.reasons.join(" ")+" Fakten: "+d.facts.join(" | ");
    mEngine.textContent="Lokale 3B-OCR nicht möglich";
    setStatus(msg,"error");
    throw new Error(msg);
  }
  mEngine.textContent="Unlimited-OCR 3B · lokaler Preflight ok";
}

// Tiny local NPZ reader for Unlimited-OCR's image_newline / view_seperator
// sidecar. This removes the last runtime dependency on esm.sh.
function parseNpyPayload(payload,key){
  if(payload.length<10||payload[0]!==0x93||payload[1]!==0x4e||payload[2]!==0x55||payload[3]!==0x4d||payload[4]!==0x50||payload[5]!==0x59)
    throw new Error(`NPZ: ${key} ist keine NPY-Datei.`);
  const dv=new DataView(payload.buffer,payload.byteOffset,payload.byteLength),major=payload[6];
  let headerLen,dataOff;
  if(major===1){headerLen=dv.getUint16(8,true);dataOff=10+headerLen}
  else if(major===2||major===3){headerLen=dv.getUint32(8,true);dataOff=12+headerLen}
  else throw new Error(`NPZ: NPY-Version ${major} wird nicht unterstützt.`);
  const hdrStart=major===1?10:12;
  const hdr=new TextDecoder("ascii").decode(payload.subarray(hdrStart,hdrStart+headerLen));
  const descr=hdr.match(/'descr'\s*:\s*'([^']+)'/)?.[1];
  const shapeRaw=hdr.match(/'shape'\s*:\s*\(([^)]*)\)/)?.[1]||"";
  const shape=shapeRaw.split(",").map(x=>x.trim()).filter(Boolean).map(Number);
  const numel=shape.length?shape.reduce((a,b)=>a*b,1):1;
  const bytes=payload.subarray(dataOff);
  const copy=new ArrayBuffer(bytes.byteLength);new Uint8Array(copy).set(bytes);
  if(descr==="<f4")return new Float32Array(copy,0,numel);
  throw new Error(`NPZ: ${key} hat nicht unterstützten Typ ${descr}.`);
}
function parseNpz(buf){
  const view=new DataView(buf),bytes=new Uint8Array(buf),out={},td=new TextDecoder("ascii");
  let off=0;
  while(off+4<=buf.byteLength){
    const sig=view.getUint32(off,true);
    if(sig===0x02014b50)break;
    if(sig!==0x04034b50)throw new Error(`NPZ: ungültiger ZIP-Block bei ${off}.`);
    const flag=view.getUint16(off+6,true),method=view.getUint16(off+8,true);
    let comp=view.getUint32(off+18,true),uncomp=view.getUint32(off+22,true);
    const nameLen=view.getUint16(off+26,true),extraLen=view.getUint16(off+28,true);
    if(method!==0)throw new Error("NPZ: komprimierte Sidecar-Datei wird nicht unterstützt.");
    if(flag&0x0008)throw new Error("NPZ: Data-Descriptor wird nicht unterstützt.");
    const name=td.decode(bytes.subarray(off+30,off+30+nameLen));
    if(comp===0xffffffff||uncomp===0xffffffff){
      let e=off+30+nameLen,end=e+extraLen,found=false;
      while(e+4<=end){
        const tag=view.getUint16(e,true),sz=view.getUint16(e+2,true);
        if(tag===1){
          let z=e+4;
          if(uncomp===0xffffffff){uncomp=Number(view.getBigUint64(z,true));z+=8}
          if(comp===0xffffffff){comp=Number(view.getBigUint64(z,true));z+=8}
          found=true;break;
        }
        e+=4+sz;
      }
      if(!found)throw new Error("NPZ: ZIP64-Größe fehlt.");
    }
    const start=off+30+nameLen+extraLen,end=start+comp;
    if(name.endsWith(".npy"))out[name.slice(0,-4)]=parseNpyPayload(bytes.subarray(start,end),name);
    off=end;
  }
  return out;
}
async function loadReferenceTensors(url){
  const resp=await fetchWithRetry(url,{cache:"force-cache"},"Unlimited-OCR Sidecar");
  if(!resp.ok)throw new Error(`Unlimited-OCR Sidecar konnte nicht geladen werden: HTTP ${resp.status}`);
  return {tensors:parseNpz(await resp.arrayBuffer())};
}

function makeOcrCanvas(source){
  // Browser reference DeepEncoder contract: EXACT [1,3,1024,1024].
  // We stretch only the inference copy; the baked original remains untouched.
  // Grounding coordinates (0..999) are mapped back to the original PDF page,
  // so visual placement is still in original coordinates.
  const out=document.createElement("canvas");
  out.width=OCR_LONG_EDGE;out.height=OCR_LONG_EDGE;
  const ctx=out.getContext("2d",{alpha:false});
  ctx.fillStyle="#fff";ctx.fillRect(0,0,out.width,out.height);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
  ctx.drawImage(source,0,0,out.width,out.height);
  window.__alantuUocrDebug=window.__alantuUocrDebug||{};
  window.__alantuUocrDebug.lastOcrInput={
    width:out.width,height:out.height,longEdge:OCR_LONG_EDGE,
    sourceWidth:source.width,sourceHeight:source.height,
    contract:"DeepEncoder ONNX [1,3,1024,1024]"
  };
  return out;
}

function preprocessOcrCanvas(canvas){
  const ctx=canvas.getContext("2d",{alpha:false});
  const {data}=ctx.getImageData(0,0,1024,1024);
  const plane=1024*1024,out=new Float32Array(3*plane);
  for(let i=0;i<plane;i++){
    out[i]=(data[i*4]/255-.5)/.5;
    out[plane+i]=(data[i*4+1]/255-.5)/.5;
    out[2*plane+i]=(data[i*4+2]/255-.5)/.5;
  }
  return out;
}

function spliceVision(patches,newline,seperator){
  if(patches.length!==256*HIDDEN)throw new Error("Unlimited-OCR DeepEncoder lieferte unerwartete Vision-Embeddings.");
  const rows=GRID*(GRID+1)+1,out=new Float32Array(rows*HIDDEN);
  let o=0;
  for(let r=0;r<GRID;r++){
    out.set(patches.subarray(r*GRID*HIDDEN,(r+1)*GRID*HIDDEN),o);o+=GRID*HIDDEN;
    out.set(newline,o);o+=HIDDEN;
  }
  out.set(seperator,o);
  return out;
}



const FALLBACK_TESSERACT_URL="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const FALLBACK_LONG_EDGE=1600;
let tesseractLoadPromise=null,fallbackWorkerPromise=null,fallbackWorker=null,fallbackWorkerStarts=0,fallbackOcrCalls=0;
function loadScriptOnce(src,globalName){
  if(window[globalName])return Promise.resolve(window[globalName]);
  return new Promise((resolve,reject)=>{
    const existing=[...document.scripts].find(s=>s.src===src);
    if(existing){
      if(window[globalName])return resolve(window[globalName]);
      existing.addEventListener("load",()=>resolve(window[globalName]),{once:true});
      existing.addEventListener("error",()=>reject(new Error(globalName+" konnte nicht geladen werden.")),{once:true});
      return;
    }
    const el=document.createElement("script");el.src=src;el.async=true;
    el.onload=()=>window[globalName]?resolve(window[globalName]):reject(new Error(globalName+" ist nach dem Laden nicht verfügbar."));
    el.onerror=()=>reject(new Error(globalName+" Download fehlgeschlagen."));
    document.head.appendChild(el);
  });
}
async function loadSmallOcr(){
  if(!tesseractLoadPromise)tesseractLoadPromise=withHeartbeat("Fallback-OCR Runtime wird geladen",()=>loadScriptOnce(FALLBACK_TESSERACT_URL,"Tesseract"),90000).catch(err=>{tesseractLoadPromise=null;throw err});
  return tesseractLoadPromise;
}
function makeFallbackOcrCanvas(source,enhance=false){
  const long=Math.max(source.width,source.height)||1,scale=Math.min(1,FALLBACK_LONG_EDGE/long);
  const c=document.createElement("canvas");
  c.width=Math.max(1,Math.round(source.width*scale));c.height=Math.max(1,Math.round(source.height*scale));
  const x=c.getContext("2d",{alpha:false});x.fillStyle="#fff";x.fillRect(0,0,c.width,c.height);x.imageSmoothingEnabled=true;x.imageSmoothingQuality="high";x.drawImage(source,0,0,c.width,c.height);
  if(enhance){
    const im=x.getImageData(0,0,c.width,c.height),d=im.data;
    for(let i=0;i<d.length;i+=4){const g=.299*d[i]+.587*d[i+1]+.114*d[i+2],v=clampByte((g-128)*1.35+128);d[i]=d[i+1]=d[i+2]=v}
    x.putImageData(im,0,0);
  }
  return c;
}
async function resetFallbackWorker(){
  const w=fallbackWorker;fallbackWorker=null;fallbackWorkerPromise=null;
  if(w)try{await w.terminate()}catch{}
}
async function getFallbackWorker(){
  const T=await loadSmallOcr();
  if(fallbackWorker)return fallbackWorker;
  if(fallbackWorkerPromise)return fallbackWorkerPromise;
  fallbackWorkerPromise=withHeartbeat("Fallback-OCR Worker startet",async()=>{
    const worker=await T.createWorker("deu+eng",1,{logger:m=>{
      if(!m?.status)return;
      const pct=Number.isFinite(m.progress)?Math.round(m.progress*100):0;
      busy.textContent=pct?`Fallback-OCR · ${m.status} · ${pct}%`:`Fallback-OCR · ${m.status}`;
      setStatus(pct?`Fallback-OCR · ${m.status} · ${pct}%`:`Fallback-OCR · ${m.status}`);
      if(pct)setProgress(pct);
    }});
    fallbackWorker=worker;fallbackWorkerStarts++;recordCascade("fallback-worker","ready",{starts:fallbackWorkerStarts});
    return worker;
  },120000).catch(async err=>{await resetFallbackWorker();throw err}).finally(()=>{fallbackWorkerPromise=null});
  return fallbackWorkerPromise;
}
function tesseractItems(data,pageW,pageH,canvasW,canvasH){
  const items=[];const add=(text,bbox,confidence=100)=>{
    text=normalizeText(text);if(!text||!bbox)return;if(Number.isFinite(confidence)&&confidence<30)return;
    const b={x0:bbox.x0/canvasW*pageW,y0:bbox.y0/canvasH*pageH,x1:bbox.x1/canvasW*pageW,y1:bbox.y1/canvasH*pageH};
    if(area(b)<1)return;items.push({text,bbox:b,type:"fallback",kind:"image-text",confidence});
  };
  for(const w of data?.words||[])add(w.text,w.bbox,w.confidence);
  if(!items.length)for(const l of data?.lines||[])add(l.text,l.bbox,l.confidence);
  return items;
}
async function runSmallFallbackOcr(sourceCanvas,pageW,pageH,reason){
  const T=await loadSmallOcr(),worker=await getFallbackWorker(),failure=classifyOcrFailure(reason);
  setStatus(`3B-OCR nicht nutzbar (${failure.code}) · Fallback-OCR läuft …`,"error");busy.classList.add("show");fallbackOcrCalls++;
  let pass=1,c=makeFallbackOcrCanvas(sourceCanvas,false);
  try{
    if(worker.setParameters&&T.PSM)await worker.setParameters({tessedit_pageseg_mode:T.PSM.AUTO});
    let result=await withHeartbeat("Fallback-OCR erkennt Text",()=>worker.recognize(c),180000);
    let items=tesseractItems(result?.data,pageW,pageH,c.width,c.height);
    if(!items.length){
      c.width=1;c.height=1;pass=2;c=makeFallbackOcrCanvas(sourceCanvas,true);
      if(worker.setParameters&&T.PSM)await worker.setParameters({tessedit_pageseg_mode:T.PSM.SPARSE_TEXT});
      setStatus("Fallback-OCR Pass 1 ohne Text · Kontrast-/Sparse-Pass 2 läuft …");
      result=await withHeartbeat("Fallback-OCR Pass 2 erkennt Text",()=>worker.recognize(c),180000);
      items=tesseractItems(result?.data,pageW,pageH,c.width,c.height);
    }
    window.__alantuUocrDebug=window.__alantuUocrDebug||{};
    window.__alantuUocrDebug.fallback={engine:"tesseract.js 5.1.1",items:items.length,reason:failure.raw,reasonCode:failure.code,width:c.width,height:c.height,pass,workerStarts:fallbackWorkerStarts,calls:fallbackOcrCalls};
    recordCascade("fallback","done",{items:items.length,pass,reasonCode:failure.code});
    mEngine.textContent=`Fallback-OCR · Tesseract.js · ${failure.code}`;return items;
  }catch(err){recordCascade("fallback","failed",{error:shortError(err)});await resetFallbackWorker();throw err}
  finally{c.width=1;c.height=1}
}
async function releasePrimaryOcrResources(reason=""){
  try{decoderEngine?.dispose?.()}catch{}
  try{await visionSession?.release?.()}catch{}
  decoderEngine=null;decoderPromise=null;visionSession=null;visionPromise=null;modelLoaded=false;
  recordCascade("3b","released",{reason:shortError(reason)});
}

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
      const next=(i+1<matches.length)?(matches[i+1].index||raw.length):raw.length;
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

async function ensureVision(){
  if(MOCK_OCR)return null;
  if(visionSession)return visionSession;
  if(visionPromise)return visionPromise;
  visionPromise=(async()=>{
    if(!navigator.gpu)throw new Error("Unlimited-OCR 3B benötigt für die lokale Browser-Inferenz WebGPU. Bitte aktuelles Chrome/Edge mit WebGPU verwenden.");
    busy.classList.add("show");
    busy.textContent="Unlimited-OCR DeepEncoder wird geladen · 1,6 GB …";
    setStatus("Vision-Modell wird lokal geladen …");
    const ort=await withHeartbeat("ONNX Runtime wird geladen",()=>import(ORT_URL),60000);
    ort.env.wasm.wasmPaths="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";
    visionSession=await withHeartbeat("Vision-Modell wird lokal geladen",()=>ort.InferenceSession.create(MODEL.visionUrl,{
      executionProviders:["webgpu"],
      graphOptimizationLevel:"all"
    }),420000);
    window.__alantuUocrOrt=ort;
    return visionSession;
  })().finally(()=>{visionPromise=null});
  return visionPromise;
}

async function ensureExtras(){
  if(visionExtras)return visionExtras;
  if(extrasPromise)return extrasPromise;
  extrasPromise=(async()=>{
    const {tensors}=await loadReferenceTensors(MODEL.extrasUrl);
    const newline=tensors.image_newline,seperator=tensors.view_seperator;
    if(!(newline instanceof Float32Array)||newline.length!==HIDDEN)throw new Error("Unlimited-OCR image_newline Sidecar ist ungültig.");
    if(!(seperator instanceof Float32Array)||seperator.length!==HIDDEN)throw new Error("Unlimited-OCR view_seperator Sidecar ist ungültig.");
    visionExtras={newline,seperator};return visionExtras;
  })().finally(()=>{extrasPromise=null});
  return extrasPromise;
}

async function ensureDecoder(){
  if(MOCK_OCR)return null;
  if(decoderEngine)return decoderEngine;
  if(decoderPromise)return decoderPromise;
  decoderPromise=(async()=>{
    if(!navigator.gpu)throw new Error("Unlimited-OCR 3B benötigt WebGPU.");
    busy.classList.add("show");
    setStatus("Unlimited-OCR Decoder wird lokal geladen …");
    decoderEngine=await createGemmaEngine({
      model:MODEL.decoderUrl,
      weightQuant:"q4k",
      contextLength:MODEL.context,
      onProgress:p=>{
        const pct=p.total?Math.round(p.loaded/p.total*100):0;
        busy.textContent=p.total?`Unlimited-OCR Decoder · ${pct}%`:(p.status||"Unlimited-OCR Decoder …");
        if(p.total){setStatus(`Unlimited-OCR Decoder wird geladen · ${pct}%`);setProgress(pct)}
      }
    });
    modelLoaded=true;
    mEngine.textContent="Unlimited-OCR 3B · WebGPU native";
    return decoderEngine;
  })().finally(()=>{decoderPromise=null});
  return decoderPromise;
}

async function runUnlimited(ocrCanvas){
  if(MOCK_OCR){
    if(MOCK_OCR_DELAY)await new Promise(r=>setTimeout(r,MOCK_OCR_DELAY));
    return "<|det|>text [[80,80,920,180]]<|/det|>ALANTU EXPOSE\n<|det|>text [[80,220,920,330]]<|/det|>Wohnung mit Seeblick in Konstanz";
  }

  if(FORCE_FALLBACK_OCR)throw new Error("3B-OCR absichtlich übersprungen (Fallback-Test).");
  if(primaryOcrDisabledReason)throw new Error("3B-OCR nach vorherigem Fehler für dieses Dokument deaktiviert: "+primaryOcrDisabledReason);
  await requireLocalOcrCapability();
  const [session,extras]=await Promise.all([ensureVision(),ensureExtras()]);
  busy.textContent="Unlimited-OCR 3B · Vision-Encoding …";
  const ort=window.__alantuUocrOrt;
  const pixels=preprocessOcrCanvas(ocrCanvas);
  const tVision=performance.now();
  const result=await withHeartbeat("Bildtext wird erkannt",()=>session.run({pixel_values:new ort.Tensor("float32",pixels,[1,3,1024,1024])}),180000);
  const patches=result.vision_embeds?.data;
  if(!(patches instanceof Float32Array))throw new Error("Unlimited-OCR DeepEncoder lieferte keine vision_embeds.");
  const visionSeq=spliceVision(patches,extras.newline,extras.seperator);
  const visionMs=Math.round(performance.now()-tVision);

  const eng=await ensureDecoder();
  busy.textContent="Unlimited-OCR 3B · Text wird dekodiert …";
  eng.resetKVForCapture();
  await eng.prefillForCapture([BOS],0);
  await eng.prefillEmbedsForCapture(visionSeq,1);
  const textStart=1+visionSeq.length/HIDDEN;
  await eng.prefillForCapture(PROMPT_IDS.slice(0,-1),textStart);

  let tok=PROMPT_IDS[PROMPT_IDS.length-1],pos=textStart+PROMPT_IDS.length-1;
  const ids=[],maxTokens=1200,t0=performance.now();
  for(let i=0;i<maxTokens;i++){
    const logits=await eng.captureHidden(tok,pos,{kind:"logits"});
    let best=0;
    for(let j=1;j<logits.length;j++)if(logits[j]>logits[best])best=j;
    if(best===EOS)break;
    // The last prompt token is part of the permanent reference prefix.
    // Engage Unlimited-OCR's 128-token R-SWA ring immediately afterwards,
    // exactly where generation begins.
    if(i===0&&typeof eng.beginRingDecode==="function")eng.beginRingDecode(pos+1);
    ids.push(best);tok=best;pos++;
    if(i%16===0)busy.textContent=`Unlimited-OCR 3B · ${i} Tokens …`;
  }
  const text=eng.decodeTokens(ids);
  window.__alantuUocrDebug=window.__alantuUocrDebug||{};
  window.__alantuUocrDebug.runtime={
    engine:ENGINE_REF,backend:"WebGPU native",visionMs,
    decodedTokens:ids.length,decodeMs:Math.round(performance.now()-t0),
    model:MODEL.name
  };
  return text;
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
    // Keep the 2200px raster for visual fidelity, but feed the model only its
    // official 1024px base vision resolution. This matches the model's documented base input and bounds browser memory
    // without reducing the final PDF/preview resolution.
    const ocrCanvas=makeOcrCanvas(canvas);
    try{
      rawOcr=await runUnlimited(ocrCanvas);
      if(token!==loadToken)throw new Error("cancelled");
      const parsed=parseUnlimited(rawOcr,base.width,base.height);
      if(!parsed.length)throw new Error("3B-OCR lieferte keinen verwertbaren positionierten Bildtext.");
      ocr=filterNativeDuplicates(parsed,native);recordCascade("3b","done",{page:pageNo,items:ocr.length});
    }catch(err){
      if(err?.message==="cancelled")throw err;
      const primaryFailure=classifyOcrFailure(err),primaryError=primaryFailure.raw;
      provisional.ocrPrimaryError=primaryError;provisional.ocrPrimaryCode=primaryFailure.code;provisional.ocrFallbackAttempted=true;
      primaryOcrDisabledReason=primaryError;console.warn("3B-OCR → Fallback-OCR",primaryFailure.code,primaryError);
      await releasePrimaryOcrResources(primaryError);
      try{
        const fallback=await runSmallFallbackOcr(canvas,base.width,base.height,primaryError);
        if(token!==loadToken)throw new Error("cancelled");
        ocr=filterNativeDuplicates(fallback,native);provisional.ocrFallback=true;provisional.ocrNoText=ocr.length===0;
        setStatus(ocr.length?"Fallback-OCR fertig · Bildtext wird als sichtbarer Vektortext gesetzt.":"Fallback-OCR fertig · auf dieser Bildseite wurde kein Text gefunden.",ocr.length?"ok":"");
      }catch(fallbackErr){
        if(fallbackErr?.message==="cancelled")throw fallbackErr;
        provisional.ocrError=primaryError+" | Fallback: "+shortError(fallbackErr);console.error(fallbackErr);
        setStatus("3B- und Fallback-OCR fehlgeschlagen · Diagnose ist gespeichert.","error");
      }
    }finally{ocrCanvas.width=1;ocrCanvas.height=1}

  }
  provisional.ocr=ocr;
  provisional.rawOcr=rawOcr;
  if(ocr.length){
    const vectorized=await makeVectorizedRaster(canvas,ocr,base.width,base.height);
    provisional.vectorPngBytes=vectorized.bytes;
    provisional.vectorRasterUrl=vectorized.url;
  }else{
    provisional.vectorPngBytes=pngBytes;
    provisional.vectorRasterUrl=previewUrl;
  }
  provisional.processing=false;
  canvas.width=1;canvas.height=1;
  return provisional;
}

function allText(page){return [...page.native,...page.ocr]}
function updateMetrics(){
  const native=pages.reduce((n,p)=>n+p.native.length,0);
  const imageText=pages.reduce((n,p)=>n+p.ocr.length,0);
  const imageChars=pages.reduce((n,p)=>n+p.ocr.reduce((m,r)=>m+normalizeText(r.text).replace(/\s/g,"").length,0),0);
  const vectorPixels=pages.reduce((n,p)=>n+p.ocr.reduce((m,r)=>m+(r.vectorPixelsRemoved||0),0),0);
  const aiPages=pages.filter(p=>p.usedAi).length;
  const convertedImagePages=pages.filter(p=>p.usedAi&&p.ocr.length>0).length;
  const pendingAi=pages.some(p=>p.processing);
  const fallbackAttempted=pages.filter(p=>p.ocrFallbackAttempted).length;
  const fallbackAi=pages.filter(p=>p.ocrFallback&&p.ocr.length>0).length;
  const noTextAi=pages.filter(p=>p.ocrNoText&&!p.ocrError).length;
  const failedAi=pages.filter(p=>p.ocrError&&!p.ocr.length).length;
  const coverage=aiPages?Math.round(convertedImagePages/aiPages*100):null;
  mPages.textContent=pages.length?String(pages.length):"—";
  mNative.textContent=pages.length?String(native):"—";
  mImageText.textContent=pages.length?String(imageText):"—";
  if(!pages.length)mImageTextPercent.textContent="—";
  else if(pendingAi)mImageTextPercent.textContent="läuft …";
  else if(failedAi)mImageTextPercent.textContent=`${coverage||0} % Bildseiten mit OCR · ${failedAi}/${aiPages} nach 3B + Fallback ohne Textlayer`;
  else if(fallbackAttempted)mImageTextPercent.textContent=`${coverage||0} % Bildseiten mit OCR · Fallback: ${fallbackAi} erfolgreich / ${noTextAi} ohne Text · ${imageText} Blöcke / ${imageChars} Zeichen → Vektor · ${vectorPixels.toLocaleString("de-DE")} Rasterpixel ersetzt`;
  else if(aiPages)mImageTextPercent.textContent=`${coverage} % Bildseiten mit OCR · 3B-OCR · ${imageText} Blöcke / ${imageChars} Zeichen → Vektor · ${vectorPixels.toLocaleString("de-DE")} Rasterpixel ersetzt`;
  else mImageTextPercent.textContent="— · keine Rasterbilder";
  mBaked.textContent=pages.length?String(pages.length):"—";
  mVisual.textContent=pages.length?(imageText?"Raster-Diff + Vektortext":"Original / kein OCR-Text"):"—";
  if(fallbackAttempted){
    const codes=[...new Set(pages.filter(p=>p.ocrFallbackAttempted).map(p=>p.ocrPrimaryCode).filter(Boolean))];
    mEngine.textContent=(modelLoaded?"3B → ":"")+"Fallback-OCR · Tesseract.js"+(codes.length?" · "+codes.join("/"):"");
  }else if(!modelLoaded)mEngine.textContent=MODEL.name;
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
function renderVectorSvgLayer(svg,page){
  if(!svg)return;
  while(svg.firstChild)svg.removeChild(svg.firstChild);
  if(!page)return;
  svg.setAttribute("viewBox",`0 0 ${page.width} ${page.height}`);
  svg.setAttribute("preserveAspectRatio","none");
  svg.dataset.role="visible-vector-text";
  for(const r of page.ocr){
    const b=r.bbox,h=Math.max(2,b.y1-b.y0),fs=Math.max(2,h*.82),w=Math.max(1,b.x1-b.x0);
    const text=document.createElementNS("http://www.w3.org/2000/svg","text");
    text.setAttribute("data-kind","image-text-vector");
    text.setAttribute("x",b.x0.toFixed(3));text.setAttribute("y",(b.y0+fs*.9).toFixed(3));
    text.setAttribute("font-family","Arial,Helvetica,sans-serif");text.setAttribute("font-size",fs.toFixed(3));
    text.setAttribute("fill",r.vectorStyle?.fill||"#111111");
    text.setAttribute("textLength",w.toFixed(3));text.setAttribute("lengthAdjust","spacingAndGlyphs");
    text.textContent=r.text;svg.appendChild(text);
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
  beforeImg.src=p.previewUrl;afterImg.src=p.vectorRasterUrl||p.previewUrl;overlayBefore.src=p.previewUrl;overlayAfter.src=p.vectorRasterUrl||p.previewUrl;
  renderVectorSvgLayer(afterVectorSvg,p);renderVectorSvgLayer(overlayVectorSvg,p);
  makeBoxes(afterOverlay,p);makeBoxes(overlayBoxes,p);
  pageCounter.textContent=`${currentPage+1} / ${pages.length}`;
  prevBtn.disabled=currentPage<=0;nextBtn.disabled=currentPage>=pages.length-1;
  const opacity=Number(overlayOpacity.value)/100;
  overlayAfter.style.opacity=String(opacity);if(overlayVectorSvg)overlayVectorSvg.style.opacity=String(opacity);overlayValue.textContent=Math.round(opacity*100)+"%";
}
function setCompareMode(mode){
  compareMode=mode;
  sideBtn.classList.toggle("active",mode==="side");overlayBtn.classList.toggle("active",mode==="overlay");
  sideBefore.hidden=mode!=="side";sideAfter.hidden=mode!=="side";overlayTools.hidden=mode!=="overlay";
  renderCompare();
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
    const bg=bytesToDataUrl(p.vectorPngBytes||p.pngBytes);
    body+=`<svg x="${x}" y="${y}" width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}" preserveAspectRatio="none" data-page="${p.pageNo}"><image data-baked-diff="1" x="0" y="0" width="${p.width}" height="${p.height}" href="${bg}"/><g data-role="visible-vector-text">${vectorTextSvg(p)}</g></svg>`;
    y+=p.height+gap;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${maxW}" height="${totalH}" viewBox="0 0 ${maxW} ${totalH}" data-alantu-merged="1" data-output="hybrid-vector-pdf">${body}</svg>`;
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
async function buildVectorPdf(){
  if(!pages.length)return null;
  busy.classList.add("show");busy.textContent="Hybrid-Vector-PDF wird gebaut …";setStatus("Hybrid-Vector-PDF wird gebaut …");
  const out=await PDFDocument.create(),font=await out.embedFont(StandardFonts.Helvetica);
  for(let i=0;i<pages.length;i++){
    const p=pages[i];busy.textContent=`PDF-Seite ${i+1} / ${pages.length}`;setProgress((i/pages.length)*100);
    const img=await out.embedPng(p.vectorPngBytes||p.pngBytes),page=out.addPage([p.width,p.height]);
    page.drawImage(img,{x:0,y:0,width:p.width,height:p.height});
    for(const r of p.ocr){
      const b=r.bbox,text=safePdfText(font,r.text);if(!text)continue;
      const boxW=Math.max(2,b.x1-b.x0),boxH=Math.max(2,b.y1-b.y0);
      const widthAt1=Math.max(.01,font.widthOfTextAtSize(text,1));
      const size=Math.max(2,Math.min(boxH*.82,boxW/widthAt1));
      const x=Math.max(0,b.x0),y=Math.max(0,p.height-b.y1+(boxH-size)*.45);
      const col=r.vectorStyle?.rgb||[.07,.07,.07];
      page.drawText(text,{x,y,size,font,color:rgb(col[0],col[1],col[2]),lineHeight:size});
    }
    if(i%2===1)await new Promise(requestAnimationFrame);
  }
  out.setTitle(sanitizeName(sourceName));
  out.setSubject("ALANTU hybrid vector PDF · image text converted to visible PDF text");
  out.setProducer("ALANTU OCR → vector text");
  const bytes=await out.save({useObjectStreams:false});
  setProgress(100);setStatus("Hybrid-Vector-PDF fertig · erkannter Bildtext ist sichtbarer PDF-Text.","ok");busy.classList.remove("show");setTimeout(()=>setProgress(0),900);
  return new Blob([bytes],{type:"application/pdf"});
}
async function downloadPdf(){
  downloadPdfBtn.disabled=true;
  try{const blob=await buildVectorPdf();if(blob)downloadBlob(blob,sanitizeName(sourceName)+"-vectorized.pdf")}
  catch(err){console.error(err);setStatus("PDF-Export fehlgeschlagen: "+err.message,"error");busy.classList.remove("show")}
  finally{downloadPdfBtn.disabled=false}
}
function downloadSvg(){
  try{const svg=buildMergedSvg();downloadBlob(new Blob([svg],{type:"image/svg+xml;charset=utf-8"}),sanitizeName(sourceName)+"-vectorized.svg")}
  catch(err){console.error(err);setStatus("SVG-Export fehlgeschlagen: "+err.message,"error")}
}

async function clearDocument(){
  loadToken++;for(const p of pages){try{if(p.vectorRasterUrl&&p.vectorRasterUrl!==p.previewUrl)URL.revokeObjectURL(p.vectorRasterUrl)}catch{};try{URL.revokeObjectURL(p.previewUrl)}catch{}}
  pages=[];currentPage=0;beforeImg.removeAttribute("src");afterImg.removeAttribute("src");overlayBefore.removeAttribute("src");overlayAfter.removeAttribute("src");
  afterOverlay.innerHTML="";overlayBoxes.innerHTML="";if(afterVectorSvg)afterVectorSvg.innerHTML="";if(overlayVectorSvg)overlayVectorSvg.innerHTML="";downloadPdfBtn.disabled=true;downloadSvgBtn.disabled=true;prevBtn.disabled=true;nextBtn.disabled=true;
  sideGrid.hidden=true;overlayWrap.hidden=true;overlayStage.hidden=true;
  emptyTitle.textContent="PDF laden.";
  emptyText.textContent="Danach siehst du Original und Ergebnis direkt nebeneinander oder pixelgenau übereinander.";
  updateMetrics();setProgress(0);empty.style.display="grid";
  try{await pdfDoc?.destroy()}catch{}pdfDoc=null;
}
async function loadPdf(file){
  if(!file)return;
  if(file.type!=="application/pdf"&&!file.name.toLowerCase().endsWith(".pdf")){setStatus("Bitte eine PDF-Datei auswählen.","error");return}
  await clearDocument();primaryOcrDisabledReason="";const token=++loadToken;sourceName=file.name;fileBadge.textContent=file.name;busy.classList.add("show");setStatus("PDF wird gelesen …");setProgress(2);
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
    const aiPages=pages.filter(p=>p.usedAi).length;
    const addedOcr=pages.reduce((n,p)=>n+p.ocr.length,0);
    const failed=pages.filter(p=>p.ocrError&&!p.ocr.length).length;
    const fallback=pages.filter(p=>p.ocrFallback&&p.ocr.length).length;
    const noText=pages.filter(p=>p.ocrNoText&&!p.ocrError).length;
    const noImprovement=aiPages>0&&addedOcr===0;
    const firstFailure=pages.find(p=>p.ocrError&&!p.ocr.length);
    const failureHint=firstFailure?" · "+shortError(firstFailure.ocrError).slice(0,220):"";
    setStatus(
      noImprovement?`Kein OCR-Text erzeugt · ${failed} technische Fehler / ${noText} Seiten ohne erkannten Text. Export gesperrt, weil kein Vektor-Mehrwert entstanden ist.${failureHint}`:
      failed?`${pages.length} Seiten fertig · ${fallback} Bildseiten via Fallback vektorisiert · ${failed}/${aiPages} Bildseiten nach kompletter Kaskade ohne Textlayer.${failureHint}`:
      fallback?`${pages.length} Seiten fertig · Fallback-OCR auf ${fallback} Bildseiten${noText?`, ${noText} ohne gefundenen Text`:""}.`:
      `${pages.length} Seiten fertig · Raster-Diff + sichtbarer Vektortext erzeugt.`,
      (noImprovement||failed)?"error":"ok"
    );
    downloadPdfBtn.disabled=noImprovement;downloadSvgBtn.disabled=noImprovement;currentPage=0;renderCompare();setTimeout(()=>setProgress(0),900);
  }catch(err){
    busy.classList.remove("show");
    if(err?.message!=="cancelled"){console.error(err);setStatus(err?.message||"Konvertierung fehlgeschlagen.","error")}
  }
}

async function clearModelCache(){
  clearModelBtn.disabled=true;
  try{
    try{decoderEngine?.dispose?.()}catch{}
    try{await visionSession?.release?.()}catch{}
    decoderEngine=null;decoderPromise=null;visionSession=null;visionPromise=null;visionExtras=null;extrasPromise=null;modelLoaded=false;primaryOcrDisabledReason="";
    await resetFallbackWorker();
    tesseractLoadPromise=null;localOcrPreflightPromise=null;
    for(const key of await caches.keys())await caches.delete(key);
    mEngine.textContent="Unlimited-OCR 3B · Runtime neu";
    setStatus("Lokale Unlimited-OCR Runtime wurde zurückgesetzt.","ok");
  }catch(err){setStatus("Runtime konnte nicht vollständig zurückgesetzt werden.","error")}
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

mEngine.textContent="Unlimited-OCR 3B · WebGPU native";updateMetrics();setCompareMode("side");
