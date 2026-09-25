import { Wllama } from "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.5.1/esm/index.js";
import WasmFromCDN from "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.5.1/esm/wasm-from-cdn.js";

const pdfjsLib=window.pdfjsLib;
if(!pdfjsLib)throw new Error("PDF.js fehlt.");
pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js";

const MODEL={
  name:"Unlimited-OCR 3B · Q5_K_S",
  modelUrl:"https://huggingface.co/sahilchachra/Unlimited-OCR-GGUF/resolve/main/Unlimited-OCR-Q5_K_S.gguf?download=true",
  mmprojUrl:"https://huggingface.co/sahilchachra/Unlimited-OCR-GGUF/resolve/main/mmproj-Unlimited-OCR-F16.gguf?download=true",
  approxGiB:2.71,
  context:8192
};
const MAX_PAGES=60;
const RENDER_LONG_EDGE=2200;
const MOCK_OCR=new URLSearchParams(location.search).get("mockOcr")==="1";

const $=id=>document.getElementById(id);
const input=$("pdfInput"),dropzone=$("dropzone"),statusEl=$("status"),progressBar=$("progressBar");
const fileBadge=$("fileBadge"),mPages=$("mPages"),mVectorText=$("mVectorText"),mBaked=$("mBaked"),mComplete=$("mComplete"),mEngine=$("mEngine");
const downloadMergedBtn=$("downloadMergedBtn"),downloadPageBtn=$("downloadPageBtn"),clearModelBtn=$("clearModelBtn");
const prevBtn=$("prevBtn"),nextBtn=$("nextBtn"),pageCounter=$("pageCounter"),zoomOutBtn=$("zoomOutBtn"),zoomInBtn=$("zoomInBtn"),zoomLabel=$("zoomLabel");
const viewport=$("viewport"),previewWrap=$("previewWrap"),previewPage=$("previewPage"),empty=$("empty"),busy=$("busy");

let pdfDoc=null,sourceName="exposee",convertedPages=[],currentPageIndex=0,previewScale=0,loadToken=0;
let wllama=null,modelPromise=null,modelLoaded=false,modelOnGpu=false;

function setStatus(text,kind=""){statusEl.className="status"+(kind?" "+kind:"");statusEl.lastElementChild.textContent=text}
function setProgress(v){progressBar.style.width=Math.max(0,Math.min(100,v||0))+"%"}
function escapeXml(v){return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}
function normalizeText(v){return String(v??"").replace(/\s+/g," ").trim()}
function sanitizeName(n){return (n||"exposee").replace(/\.pdf$/i,"").replace(/[\\/:*?"<>|]+/g,"-").replace(/\s+/g," ").trim()||"exposee"}
function median(a){if(!a.length)return 255;const s=[...a].sort((x,y)=>x-y),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2}
function textColorCss(rgb){return `rgb(${rgb.map(v=>Math.max(0,Math.min(255,Math.round(v)))).join(" ")})`}

function sampleBorderStats(data,w,h,b){
  const x0=Math.max(0,Math.floor(b.x0)-3),y0=Math.max(0,Math.floor(b.y0)-3),x1=Math.min(w-1,Math.ceil(b.x1)+3),y1=Math.min(h-1,Math.ceil(b.y1)+3);
  const rs=[],gs=[],bs=[],push=(x,y)=>{const i=(y*w+x)*4;rs.push(data[i]);gs.push(data[i+1]);bs.push(data[i+2])};
  for(let x=x0;x<=x1;x++)for(let k=0;k<2;k++){if(y0+k<h)push(x,y0+k);if(y1-k>=0)push(x,y1-k)}
  for(let y=y0;y<=y1;y++)for(let k=0;k<2;k++){if(x0+k<w)push(x0+k,y);if(x1-k>=0)push(x1-k,y)}
  const bg=[median(rs),median(gs),median(bs)];let variance=0,count=0;
  for(let i=0;i<rs.length;i++){const dr=rs[i]-bg[0],dg=gs[i]-bg[1],db=bs[i]-bg[2];variance+=(dr*dr+dg*dg+db*db)/3;count++}
  return {bg,variance:count?variance/count:0};
}
function inpaintTextPixels(img,w,h,bbox){
  const x0=Math.max(0,Math.floor(bbox.x0)-1),y0=Math.max(0,Math.floor(bbox.y0)-1),x1=Math.min(w-1,Math.ceil(bbox.x1)+1),y1=Math.min(h-1,Math.ceil(bbox.y1)+1);
  if(x1<=x0||y1<=y0)return [20,20,20];
  const {bg,variance}=sampleBorderStats(img.data,w,h,{x0,y0,x1,y1});
  const rw=x1-x0+1,rh=y1-y0+1,mask=new Uint8Array(rw*rh),dists=[];
  const threshold=Math.max(34,Math.min(96,30+Math.sqrt(variance)*1.45));
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    const i=(y*w+x)*4,dr=img.data[i]-bg[0],dg=img.data[i+1]-bg[1],db=img.data[i+2]-bg[2],d=Math.sqrt(dr*dr+dg*dg+db*db);
    dists.push({r:img.data[i],g:img.data[i+1],b:img.data[i+2],d});
    if(d>threshold)mask[(y-y0)*rw+(x-x0)]=1;
  }
  const grown=mask.slice();
  for(let y=0;y<rh;y++)for(let x=0;x<rw;x++)if(mask[y*rw+x])for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
    const nx=x+ox,ny=y+oy;if(nx>=0&&ny>=0&&nx<rw&&ny<rh)grown[ny*rw+nx]=1;
  }
  const fg=dists.filter(p=>p.d>threshold).sort((a,b)=>b.d-a.d).slice(0,Math.max(1,Math.ceil(dists.length*.24)));
  const color=fg.length?[median(fg.map(p=>p.r)),median(fg.map(p=>p.g)),median(fg.map(p=>p.b))]:[20,20,20];
  const src=new Uint8ClampedArray(img.data);
  const masked=(x,y)=>x>=x0&&y>=y0&&x<=x1&&y<=y1&&grown[(y-y0)*rw+(x-x0)]===1;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(masked(x,y)){
    let rr=0,gg=0,bb=0,n=0;
    for(let radius=1;radius<=7&&n<5;radius++)for(let oy=-radius;oy<=radius;oy++)for(let ox=-radius;ox<=radius;ox++){
      if(Math.abs(ox)!==radius&&Math.abs(oy)!==radius)continue;
      const nx=x+ox,ny=y+oy;if(nx<0||ny<0||nx>=w||ny>=h||masked(nx,ny))continue;
      const j=(ny*w+nx)*4;rr+=src[j];gg+=src[j+1];bb+=src[j+2];n++;
    }
    const i=(y*w+x)*4;img.data[i]=n?rr/n:bg[0];img.data[i+1]=n?gg/n:bg[1];img.data[i+2]=n?bb/n:bg[2];img.data[i+3]=255;
  }
  return color;
}

async function canvasToArrayBuffer(canvas,type="image/jpeg",quality=.93){
  const blob=await new Promise((res,rej)=>canvas.toBlob(b=>b?res(b):rej(new Error("Bild konnte nicht erzeugt werden.")),type,quality));
  return blob.arrayBuffer();
}
async function canvasDataUrl(canvas){return canvas.toDataURL("image/png")}

function nativeRuns(textContent,renderViewport,scale,img){
  const runs=[];
  for(const item of textContent.items||[]){
    if(typeof item?.str!=="string"||!item.str.trim())continue;
    const tx=pdfjsLib.Util.transform(renderViewport.transform,item.transform);
    const fontPx=Math.max(1,Math.hypot(tx[2],tx[3]));
    const angle=Math.atan2(tx[1],tx[0]);
    const widthPx=Math.max(1,Math.abs((item.width||item.str.length*fontPx*.5)*scale));
    const left=tx[4],top=tx[5]-fontPx;
    const bbox={x0:left-1,y0:top-1,x1:left+widthPx+1,y1:top+fontPx+2};
    const color=inpaintTextPixels(img,renderViewport.width|0,renderViewport.height|0,bbox);
    runs.push({
      text:item.str,x:left/scale,y:(top+fontPx*.82)/scale,w:widthPx/scale,h:fontPx/scale,
      angle,color,fontFamily:textContent.styles?.[item.fontName]?.fontFamily||"Arial,Helvetica,sans-serif"
    });
  }
  return runs;
}
function hasRasterImages(opList){
  const O=pdfjsLib.OPS;
  const imageOps=new Set([O.paintImageXObject,O.paintJpegXObject,O.paintInlineImageXObject,O.paintImageMaskXObject]);
  return opList.fnArray.some(fn=>imageOps.has(fn));
}

async function newRuntime(gpu){
  const inst=new Wllama(WasmFromCDN,{parallelDownloads:3,suppressNativeLog:true});
  inst.setCompat("default");
  await inst.loadModelFromUrl({url:MODEL.modelUrl,mmprojUrl:MODEL.mmprojUrl},{
    useCache:true,
    n_ctx:MODEL.context,
    n_gpu_layers:gpu?99999:0,
    n_threads:Math.max(1,Math.min(8,Math.floor((navigator.hardwareConcurrency||4)/2))),
    n_parallel:1,
    flash_attn:false,
    warmup:false,
    jinja:false,
    chat_template:"deepseek-ocr",
    progressCallback:({loaded,total})=>{
      if(total>0){
        const pct=Math.round(loaded/total*100);
        setStatus(`Unlimited-OCR wird lokal geladen · ${pct}%`);
        setProgress(pct);
        busy.textContent=`AI-Modell ${pct}% · wird danach im Browser-Cache wiederverwendet`;
      }
    }
  });
  if(!inst.supportInputModality("image"))throw new Error("Unlimited-OCR wurde geladen, aber der Vision-Projektor ist nicht aktiv.");
  return inst;
}
async function ensureModel(){
  if(MOCK_OCR)return null;
  if(modelLoaded&&wllama)return wllama;
  if(modelPromise)return modelPromise;
  modelPromise=(async()=>{
    busy.classList.add("show");
    busy.textContent=`Unlimited-OCR 3B wird einmalig geladen (~${MODEL.approxGiB.toFixed(1)} GB)`;
    const tryGpu=!!navigator.gpu;
    try{
      wllama=await newRuntime(tryGpu);
      modelOnGpu=tryGpu;
    }catch(first){
      if(!tryGpu)throw first;
      try{await wllama?.exit()}catch{}
      setStatus("WebGPU-Speicher reicht nicht · CPU-Fallback wird geladen …");
      wllama=await newRuntime(false);
      modelOnGpu=false;
    }
    modelLoaded=true;
    mEngine.textContent=MODEL.name+(modelOnGpu?" · WebGPU":" · CPU");
    return wllama;
  })().finally(()=>{modelPromise=null});
  return modelPromise;
}

function parseUnlimited(raw){
  raw=String(raw||"");
  const blocks=[];
  const marker=/<\|det\|>\s*([^<\n]*?)\s*(\[\[?[\d\s,.-]+\]?\])?\s*<\|\/det\|>/g;
  const hits=[...raw.matchAll(marker)];
  for(let i=0;i<hits.length;i++){
    const m=hits[i],start=(m.index||0)+m[0].length,end=i+1<hits.length?(hits[i+1].index||raw.length):raw.length;
    const head=(m[1]||"text").trim(),coordText=m[2]||"",content=raw.slice(start,end).replace(/<\|[^>]+\|>/g,"").trim();
    const nums=(coordText.match(/-?\d+(?:\.\d+)?/g)||[]).map(Number);
    if(nums.length>=4&&content&&head.toLowerCase()!=="image"){
      blocks.push({type:head||"text",bbox:{x0:nums[0],y0:nums[1],x1:nums[2],y1:nums[3]},text:content});
    }
  }
  const ds=/<\|ref\|>(.*?)<\|\/ref\|>\s*<\|det\|>(\[\[[\s\S]*?\]\])<\|\/det\|>/g;
  for(const m of raw.matchAll(ds)){
    const nums=(m[2].match(/-?\d+(?:\.\d+)?/g)||[]).map(Number),text=normalizeText(m[1]);
    if(nums.length>=4&&text&&!blocks.some(b=>normalizeText(b.text)===text))blocks.push({type:"text",bbox:{x0:nums[0],y0:nums[1],x1:nums[2],y1:nums[3]},text});
  }
  return blocks.filter(b=>[b.bbox.x0,b.bbox.y0,b.bbox.x1,b.bbox.y1].every(Number.isFinite));
}
async function runUnlimited(imageBuffer){
  if(MOCK_OCR){
    return "<|det|>text [80,80,920,180]<|/det|>ALANTU EXPOSE\n<|det|>text [80,220,920,330]<|/det|>Wohnung mit Seeblick in Konstanz";
  }
  const ai=await ensureModel();
  busy.textContent="Unlimited-OCR 3B erkennt Bildtext …";
  const response=await ai.createChatCompletion({
    messages:[{role:"user",content:[{type:"image",data:imageBuffer},{type:"text",text:"document parsing."}]}],
    temperature:0,
    top_p:1,
    max_tokens:4096,
    stream:false,
    dry_multiplier:.8,
    dry_base:1.75,
    dry_allowed_length:35,
    dry_penalty_last_n:128
  });
  return response?.choices?.[0]?.message?.content||"";
}

function blockToSvg(block,pageW,pageH,rasterW,rasterH,color){
  const x=block.bbox.x0/999*pageW,y=block.bbox.y0/999*pageH,w=Math.max(1,(block.bbox.x1-block.bbox.x0)/999*pageW),h=Math.max(1,(block.bbox.y1-block.bbox.y0)/999*pageH);
  let lines=String(block.text||"").replace(/\|\s*[-:]+\s*/g," ").split(/\r?\n/).map(normalizeText).filter(Boolean);
  if(!lines.length)return "";
  if(lines.length===1&&lines[0].length>90){
    const words=lines[0].split(" "),out=[];let line="";
    for(const word of words){const cand=(line+" "+word).trim();if(cand.length>70&&line){out.push(line);line=word}else line=cand}if(line)out.push(line);lines=out;
  }
  const fs=Math.max(2,Math.min(h*.78,h/Math.max(1,lines.length)*.86));
  const fill=textColorCss(color);
  const tspans=lines.map((line,i)=>`<tspan x="${x.toFixed(3)}" y="${(y+fs*(i+1)).toFixed(3)}" textLength="${w.toFixed(3)}" lengthAdjust="spacingAndGlyphs">${escapeXml(line)}</tspan>`).join("");
  return `<text data-unlimited-ocr="1" data-block="${escapeXml(block.type)}" font-family="Arial,Helvetica,sans-serif" font-size="${fs.toFixed(3)}" fill="${fill}" text-rendering="geometricPrecision">${tspans}</text>`;
}
function nativeToSvg(run){
  const fill=textColorCss(run.color),deg=run.angle*180/Math.PI;
  if(Math.abs(deg)<.5)return `<text data-native-text="1" x="${run.x.toFixed(3)}" y="${run.y.toFixed(3)}" font-family="${escapeXml(run.fontFamily)}" font-size="${Math.max(1,run.h).toFixed(3)}" fill="${fill}" textLength="${Math.max(1,run.w).toFixed(3)}" lengthAdjust="spacingAndGlyphs">${escapeXml(run.text)}</text>`;
  return `<text data-native-text="1" x="0" y="0" transform="translate(${run.x.toFixed(3)} ${run.y.toFixed(3)}) rotate(${deg.toFixed(4)})" font-family="${escapeXml(run.fontFamily)}" font-size="${Math.max(1,run.h).toFixed(3)}" fill="${fill}" textLength="${Math.max(1,run.w).toFixed(3)}" lengthAdjust="spacingAndGlyphs">${escapeXml(run.text)}</text>`;
}

async function convertPage(pageNo,token){
  const page=await pdfDoc.getPage(pageNo),base=page.getViewport({scale:1});
  const scale=Math.max(1.5,Math.min(3.6,RENDER_LONG_EDGE/Math.max(base.width,base.height))),renderVp=page.getViewport({scale});
  const [textContent,opList]=await Promise.all([page.getTextContent({includeMarkedContent:true,disableNormalization:false}),page.getOperatorList()]);
  const canvas=document.createElement("canvas");canvas.width=Math.round(renderVp.width);canvas.height=Math.round(renderVp.height);
  const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:true});ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:ctx,viewport:renderVp,background:"white"}).promise;
  if(token!==loadToken)throw new Error("cancelled");
  const img=ctx.getImageData(0,0,canvas.width,canvas.height);
  const native=nativeRuns(textContent,renderVp,scale,img);
  ctx.putImageData(img,0,0);

  const nativeChars=native.reduce((n,r)=>n+normalizeText(r.text).replace(/\s/g,"").length,0);
  const shouldAi=hasRasterImages(opList)||nativeChars<12;
  let raw="",blocks=[];
  if(shouldAi){
    const aiInput=await canvasToArrayBuffer(canvas,"image/jpeg",.94);
    raw=await runUnlimited(aiInput);
    blocks=parseUnlimited(raw);
    const diff=ctx.getImageData(0,0,canvas.width,canvas.height);
    for(const b of blocks){
      const bbox={x0:b.bbox.x0/999*canvas.width,y0:b.bbox.y0/999*canvas.height,x1:b.bbox.x1/999*canvas.width,y1:b.bbox.y1/999*canvas.height};
      b.color=inpaintTextPixels(diff,canvas.width,canvas.height,bbox);
    }
    ctx.putImageData(diff,0,0);
  }
  const residual=await canvasDataUrl(canvas);canvas.width=1;canvas.height=1;
  const nativeSvg=native.map(nativeToSvg).join("");
  const aiSvg=blocks.map(b=>blockToSvg(b,base.width,base.height,renderVp.width,renderVp.height,b.color||[20,20,20])).join("");
  const metadata=escapeXml(JSON.stringify({engine:shouldAi?MODEL.name:"PDF native",rawOcr:raw,blocks:blocks.length,nativeRuns:native.length}));
  const svgString=`<svg xmlns="http://www.w3.org/2000/svg" width="${base.width}" height="${base.height}" viewBox="0 0 ${base.width} ${base.height}" preserveAspectRatio="none" data-page="${pageNo}" data-mode="hybrid-unlimited"><metadata>${metadata}</metadata><image data-baked-diff="1" x="0" y="0" width="${base.width}" height="${base.height}" href="${residual}"/><g data-role="native-svg-text" text-rendering="geometricPrecision">${nativeSvg}</g><g data-role="unlimited-ocr-svg-text" text-rendering="geometricPrecision">${aiSvg}</g></svg>`;
  return {pageNo,width:base.width,height:base.height,mode:"hybrid-unlimited",svgString,vectorRuns:native.length+blocks.length,bakedCount:1,ocrBlocks:blocks.length,usedAi:shouldAi};
}

function updateSummary(){
  const vectorRuns=convertedPages.reduce((n,p)=>n+p.vectorRuns,0),baked=convertedPages.reduce((n,p)=>n+p.bakedCount,0),aiPages=convertedPages.filter(p=>p.usedAi).length;
  mPages.textContent=convertedPages.length?String(convertedPages.length):"—";
  mVectorText.textContent=convertedPages.length?String(vectorRuns):"—";
  mBaked.textContent=convertedPages.length?String(baked):"—";
  mComplete.textContent=convertedPages.length?"100 % vollständig":"—";
  if(!modelLoaded)mEngine.textContent=aiPages?MODEL.name+" · wird geladen":"PDF + "+MODEL.name;
}
function fitScaleFor(page){if(!page)return 1;return Math.min(1,Math.max(200,viewport.clientWidth-112)/page.width,Math.max(260,viewport.clientHeight-112)/page.height)}
function renderPreview(){
  const p=convertedPages[currentPageIndex];previewPage.innerHTML="";
  if(!p){pageCounter.textContent="— / —";return}
  const doc=new DOMParser().parseFromString(p.svgString,"image/svg+xml"),svg=doc.documentElement;svg.removeAttribute("width");svg.removeAttribute("height");svg.style.width=p.width+"px";svg.style.height=p.height+"px";
  previewPage.appendChild(document.importNode(svg,true));if(previewScale<=0)previewScale=fitScaleFor(p);
  previewPage.style.width=p.width+"px";previewPage.style.height=p.height+"px";previewPage.style.transform=`scale(${previewScale})`;
  previewWrap.style.minWidth=Math.ceil(p.width*previewScale+112)+"px";previewWrap.style.minHeight=Math.ceil(p.height*previewScale+112)+"px";
  pageCounter.textContent=`${currentPageIndex+1} / ${convertedPages.length}`;zoomLabel.textContent=Math.abs(previewScale-fitScaleFor(p))<.001?"Fit":Math.round(previewScale*100)+"%";
  prevBtn.disabled=currentPageIndex<=0;nextBtn.disabled=currentPageIndex>=convertedPages.length-1;downloadPageBtn.disabled=false;empty.style.display="none";
}
function setPreviewScale(n){const p=convertedPages[currentPageIndex];if(!p)return;previewScale=Math.max(.2,Math.min(8,n));renderPreview()}
function prefixSvgIds(svg,prefix){
  const map=new Map();svg.querySelectorAll("[id]").forEach(el=>{const old=el.id,n=prefix+old;map.set(old,n);el.id=n});
  if(!map.size)return;
  for(const el of svg.querySelectorAll("*"))for(const a of ["href","xlink:href","clip-path","mask","filter","fill","stroke","style"]){
    const v=el.getAttribute(a);if(!v)continue;let next=v;for(const [old,n] of map){next=next.replaceAll(`url(#${old})`,`url(#${n})`);if(next===`#${old}`)next=`#${n}`}if(next!==v)el.setAttribute(a,next);
  }
}
function buildMergedSvg(){
  if(!convertedPages.length)return "";
  const gap=24,maxW=Math.max(...convertedPages.map(p=>p.width)),totalH=convertedPages.reduce((n,p)=>n+p.height,0)+gap*(convertedPages.length-1);let y=0,body="";
  for(const p of convertedPages){const d=new DOMParser().parseFromString(p.svgString,"image/svg+xml"),svg=d.documentElement;prefixSvgIds(svg,`m-p${p.pageNo}-`);const x=(maxW-p.width)/2;body+=`<svg x="${x}" y="${y}" width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}" preserveAspectRatio="none" data-merged-page="${p.pageNo}">${svg.innerHTML}</svg>`;y+=p.height+gap}
  const meta=escapeXml(JSON.stringify({source:sourceName,engine:MODEL.name,pages:convertedPages.length,vectorRuns:convertedPages.reduce((n,p)=>n+p.vectorRuns,0)}));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${maxW}" height="${totalH}" viewBox="0 0 ${maxW} ${totalH}" data-alantu-merged="1" data-ocr-engine="unlimited-ocr-3b"><metadata>${meta}</metadata>${body}</svg>`;
}
function downloadBlob(text,name){const blob=new Blob([text],{type:"image/svg+xml;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.rel="noopener";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
function downloadMerged(){const svg=buildMergedSvg();if(svg)downloadBlob(svg,sanitizeName(sourceName)+"-alantu.svg")}
function downloadCurrentPage(){const p=convertedPages[currentPageIndex];if(p)downloadBlob('<?xml version="1.0" encoding="UTF-8"?>\n'+p.svgString,`${sanitizeName(sourceName)}-seite-${String(p.pageNo).padStart(2,"0")}.svg`)}

async function resetDocument(){
  loadToken++;convertedPages=[];currentPageIndex=0;previewScale=0;previewPage.innerHTML="";downloadMergedBtn.disabled=true;downloadPageBtn.disabled=true;prevBtn.disabled=true;nextBtn.disabled=true;setProgress(0);updateSummary();empty.style.display="grid";
  try{await pdfDoc?.destroy()}catch{}pdfDoc=null;
}
async function loadPdf(file){
  if(!file)return;if(file.type!=="application/pdf"&&!file.name.toLowerCase().endsWith(".pdf")){setStatus("Bitte eine PDF-Datei auswählen.","error");return}
  await resetDocument();const token=++loadToken;sourceName=file.name;fileBadge.textContent=file.name;busy.classList.add("show");setStatus("PDF wird gelesen …");setProgress(2);
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());if(token!==loadToken)return;
    pdfDoc=await pdfjsLib.getDocument({data:bytes,fontExtraProperties:true}).promise;if(pdfDoc.numPages<1)throw new Error("PDF enthält keine Seiten.");if(pdfDoc.numPages>MAX_PAGES)throw new Error("Maximal "+MAX_PAGES+" Seiten.");
    for(let i=1;i<=pdfDoc.numPages;i++){
      if(token!==loadToken)throw new Error("cancelled");setStatus(`Seite ${i} von ${pdfDoc.numPages} · Text → SVG · Bildtext → Unlimited-OCR`);setProgress(4+(i-1)/pdfDoc.numPages*90);busy.textContent=`Seite ${i} / ${pdfDoc.numPages}`;
      const p=await convertPage(i,token);convertedPages.push(p);updateSummary();if(i===1){currentPageIndex=0;previewScale=0;renderPreview()}await new Promise(requestAnimationFrame);
    }
    setProgress(100);setStatus(`${convertedPages.length} Seiten fertig · SVG-Text + gebackener Diff.`,"ok");downloadMergedBtn.disabled=false;downloadPageBtn.disabled=false;currentPageIndex=0;previewScale=0;renderPreview();setTimeout(()=>setProgress(0),900);
  }catch(err){if(err?.message!=="cancelled"){console.error(err);setStatus(err?.message||"Konvertierung fehlgeschlagen.","error")}}
  finally{if(token===loadToken){busy.classList.remove("show");busy.textContent="Konvertiere …"}}
}

async function clearModelCache(){
  clearModelBtn.disabled=true;
  try{if(wllama){await wllama.exit();wllama=null}modelLoaded=false;modelPromise=null;for(const k of await caches.keys())await caches.delete(k);mEngine.textContent="Cache geleert";setStatus("Lokaler AI-Modell-Cache wurde gelöscht.","ok")}
  catch(err){setStatus("Cache konnte nicht vollständig gelöscht werden.","error")}
  finally{clearModelBtn.disabled=false}
}

input.addEventListener("change",()=>loadPdf(input.files?.[0]));
["dragenter","dragover"].forEach(t=>dropzone.addEventListener(t,e=>{e.preventDefault();dropzone.classList.add("drag")}));
["dragleave","drop"].forEach(t=>dropzone.addEventListener(t,e=>{e.preventDefault();dropzone.classList.remove("drag")}));
dropzone.addEventListener("drop",e=>{const f=e.dataTransfer?.files?.[0];if(f)loadPdf(f)});
prevBtn.addEventListener("click",()=>{if(currentPageIndex>0){currentPageIndex--;previewScale=0;renderPreview()}});
nextBtn.addEventListener("click",()=>{if(currentPageIndex<convertedPages.length-1){currentPageIndex++;previewScale=0;renderPreview()}});
zoomOutBtn.addEventListener("click",()=>setPreviewScale((previewScale||fitScaleFor(convertedPages[currentPageIndex]))/1.25));
zoomInBtn.addEventListener("click",()=>setPreviewScale((previewScale||fitScaleFor(convertedPages[currentPageIndex]))*1.25));
zoomLabel.addEventListener("click",()=>{previewScale=0;renderPreview()});
downloadMergedBtn.addEventListener("click",downloadMerged);downloadPageBtn.addEventListener("click",downloadCurrentPage);clearModelBtn.addEventListener("click",clearModelCache);
window.addEventListener("resize",()=>{if(convertedPages.length&&previewScale<=fitScaleFor(convertedPages[currentPageIndex])+.001){previewScale=0;renderPreview()}});
mEngine.textContent=MODEL.name+" · lokal";updateSummary();prevBtn.disabled=true;nextBtn.disabled=true;
