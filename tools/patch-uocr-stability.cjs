const fs=require('fs');
function rw(path,fn){let s=fs.readFileSync(path,'utf8');const n=fn(s);if(n!==s)fs.writeFileSync(path,n)}

rw('alantu-unlimited-ocr.js',s=>{
  // Stable load/diagnostic helpers already exist on current runtime. Add them when absent.
  const marker='async function blobToArrayBuffer(blob){return blob.arrayBuffer()}\n';
  const helpers=String.raw`
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function shortError(err){
  const msg=String(err?.message||err||"Load failed");
  if(/Load failed|Failed to fetch|NetworkError|fetch|aborted|cancelled|body/i.test(msg))return "Download abgebrochen oder Browser-Speicher zu knapp. Seite neu laden oder Desktop-Chrome nutzen.";
  return msg;
}
let heartbeatTimer=null;
function startHeartbeat(label){
  const start=Date.now();clearInterval(heartbeatTimer);busy.classList.add("show");
  heartbeatTimer=setInterval(()=>{const sec=Math.max(1,Math.round((Date.now()-start)/1000));busy.textContent=label+" · "+sec+"s";setStatus(label+" · läuft seit "+sec+"s")},1000);
  return ()=>{clearInterval(heartbeatTimer);heartbeatTimer=null};
}
async function withHeartbeat(label,fn,timeoutMs=300000){
  const stop=startHeartbeat(label);let timer;
  try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+": Timeout nach "+Math.round(timeoutMs/1000)+"s")),timeoutMs)})])}
  catch(err){throw new Error(label+": "+shortError(err))}
  finally{clearTimeout(timer);stop()}
}
async function fetchWithRetry(url,opts={},label="Datei"){
  let last;for(let i=1;i<=3;i++){try{setStatus(label+" laden · Versuch "+i+"/3");const resp=await fetch(url,{...opts,cache:opts.cache||"force-cache"});if(resp.ok)return resp;last=new Error("HTTP "+resp.status)}catch(err){last=err}await sleep(800*i)}
  throw new Error(label+": "+shortError(last));
}
`;
  if(!s.includes('function fetchWithRetry('))s=s.replace(marker,marker+helpers);
  s=s.replace('const resp=await fetch(url,{cache:"force-cache"});','const resp=await fetchWithRetry(url,{cache:"force-cache"},"Unlimited-OCR Sidecar");');
  s=s.replace('const ort=await import(ORT_URL);','const ort=await withHeartbeat("ONNX Runtime wird geladen",()=>import(ORT_URL),60000);');
  s=s.replace('visionSession=await ort.InferenceSession.create(MODEL.visionUrl,{\n      executionProviders:["webgpu"],\n      graphOptimizationLevel:"all"\n    });','visionSession=await withHeartbeat("Vision-Modell wird lokal geladen",()=>ort.InferenceSession.create(MODEL.visionUrl,{\n      executionProviders:["webgpu"],\n      graphOptimizationLevel:"all"\n    }),420000);');
  s=s.replace('const result=await session.run({pixel_values:new ort.Tensor("float32",pixels,[1,3,1024,1024])});','const result=await withHeartbeat("Bildtext wird erkannt",()=>session.run({pixel_values:new ort.Tensor("float32",pixels,[1,3,1024,1024])}),180000);');

  const diag=String.raw`
const LOCAL_OCR_NEEDS={cacheGiB:5.5,physicalRamGiB:8,texture:1024,storageBufferMiB:256};
let localOcrPreflightPromise=null;
function gib(v){return Math.round(v/1024/1024/1024*10)/10}
function mib(v){return Math.round(v/1024/1024)}
function isIOSLike(){const ua=navigator.userAgent||"";return /iP(hone|ad|od)/.test(ua)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1)}
function isMobileLike(){return isIOSLike()||/Android|Mobile/i.test(navigator.userAgent||"")}
async function diagnoseLocalOcrBottleneck(){
  const reasons=[],facts=[];const ua=navigator.userAgent||"";
  facts.push("Browser: "+ua.slice(0,140));
  facts.push("Lokaler 3B-OCR-Load braucht grob Decoder 3.5GB + Vision 1.6GB + Tensoren/Canvas/Cache, also Desktop-Klasse.");
  if(isIOSLike())reasons.push("Bottleneck: iOS/WebKit-Tab-Speicher/Cache. iPhone/iPad-Browser können diesen lokalen 3B-OCR-Stack nicht stabil halten; Modell-Download/ONNX/WebGPU endet typischerweise in Load failed oder Tab-Kill.");
  if(!navigator.gpu)reasons.push("Bottleneck: WebGPU fehlt in diesem Browser. Der Vision-Encoder/Decoder kann lokal nicht gestartet werden.");
  if(navigator.deviceMemory){facts.push("Gemeldeter RAM-Bucket: "+navigator.deviceMemory+"GB");if(navigator.deviceMemory<LOCAL_OCR_NEEDS.physicalRamGiB)reasons.push("Bottleneck: gemeldeter RAM-Bucket "+navigator.deviceMemory+"GB < benötigte Desktop-Reserve ca. "+LOCAL_OCR_NEEDS.physicalRamGiB+"GB.")}else if(isMobileLike())facts.push("RAM-Bucket wird vom mobilen Browser nicht offengelegt; genau das verhindert zuverlässige lokale 3B-Planung.");
  try{if(navigator.storage?.estimate){const st=await navigator.storage.estimate();const free=Math.max(0,(st.quota||0)-(st.usage||0));facts.push("Browser-Storage frei: "+gib(free)+"GB von "+gib(st.quota||0)+"GB Quote");if(st.quota&&free<LOCAL_OCR_NEEDS.cacheGiB*1024**3)reasons.push("Bottleneck: Browser-Cache frei "+gib(free)+"GB < benötigte Modell-/Runtime-Reserve ca. "+LOCAL_OCR_NEEDS.cacheGiB+"GB.")}}catch(e){facts.push("Storage-Estimate nicht verfügbar: "+shortError(e))}
  if(navigator.gpu){try{const adapter=await navigator.gpu.requestAdapter();if(!adapter)reasons.push("Bottleneck: WebGPU-Adapter konnte nicht reserviert werden.");else{const l=adapter.limits||{};facts.push("WebGPU limits: texture2D="+(l.maxTextureDimension2D||"?")+", storageBuffer="+(l.maxStorageBufferBindingSize?mib(l.maxStorageBufferBindingSize)+"MB":"?")+", buffer="+(l.maxBufferSize?mib(l.maxBufferSize)+"MB":"?"));if(l.maxTextureDimension2D&&l.maxTextureDimension2D<LOCAL_OCR_NEEDS.texture)reasons.push("Bottleneck: maxTextureDimension2D "+l.maxTextureDimension2D+" < "+LOCAL_OCR_NEEDS.texture+".");if(l.maxStorageBufferBindingSize&&l.maxStorageBufferBindingSize<LOCAL_OCR_NEEDS.storageBufferMiB*1024*1024)reasons.push("Bottleneck: maxStorageBufferBindingSize "+mib(l.maxStorageBufferBindingSize)+"MB < "+LOCAL_OCR_NEEDS.storageBufferMiB+"MB.")}}catch(e){reasons.push("Bottleneck: WebGPU-Probe fehlgeschlagen: "+shortError(e))}}
  const ok=!reasons.length,report={ok,reasons,facts,checkedAt:new Date().toISOString()};window.__alantuOcrDiagnostics=report;window.__alantuUocrDebug=window.__alantuUocrDebug||{};window.__alantuUocrDebug.preflight=report;return report;
}
async function requireLocalOcrCapability(){
  if(MOCK_OCR)return;if(!localOcrPreflightPromise)localOcrPreflightPromise=diagnoseLocalOcrBottleneck();const d=await localOcrPreflightPromise;
  if(!d.ok){const msg="Lokale 3B-OCR nicht gestartet. "+d.reasons.join(" ")+" Fakten: "+d.facts.join(" | ");mEngine.textContent="Lokale 3B-OCR nicht möglich";setStatus(msg,"error");throw new Error(msg)}
  mEngine.textContent="Unlimited-OCR 3B · lokaler Preflight ok";
}
`;
  if(!s.includes('function diagnoseLocalOcrBottleneck('))s=s.replace('// Tiny local NPZ reader',diag+'\n// Tiny local NPZ reader');

  const cascade=String.raw`
const FALLBACK_TESSERACT_URL="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
let tesseractLoadPromise=null;
function loadScriptOnce(src,globalName){
  if(window[globalName])return Promise.resolve(window[globalName]);
  return new Promise((resolve,reject)=>{const existing=[...document.scripts].find(s=>s.src===src);if(existing){existing.addEventListener("load",()=>resolve(window[globalName]));existing.addEventListener("error",()=>reject(new Error(globalName+" konnte nicht geladen werden.")));return}const el=document.createElement("script");el.src=src;el.async=true;el.onload=()=>window[globalName]?resolve(window[globalName]):reject(new Error(globalName+" ist nach dem Laden nicht verfügbar."));el.onerror=()=>reject(new Error(globalName+" Download fehlgeschlagen."));document.head.appendChild(el)})
}
async function loadSmallOcr(){if(!tesseractLoadPromise)tesseractLoadPromise=withHeartbeat("Fallback-OCR wird geladen",()=>loadScriptOnce(FALLBACK_TESSERACT_URL,"Tesseract"),90000);return tesseractLoadPromise}
function tesseractItems(data,pageW,pageH,canvasW,canvasH){
  const items=[];const add=(text,bbox,confidence=100)=>{text=normalizeText(text);if(!text||!bbox)return;if(Number.isFinite(confidence)&&confidence<30)return;const b={x0:bbox.x0/canvasW*pageW,y0:bbox.y0/canvasH*pageH,x1:bbox.x1/canvasW*pageW,y1:bbox.y1/canvasH*pageH};if(area(b)<1)return;items.push({text,bbox:b,type:"fallback",kind:"image-text",confidence})};
  for(const w of data?.words||[])add(w.text,w.bbox,w.confidence);if(!items.length)for(const l of data?.lines||[])add(l.text,l.bbox,l.confidence);return items;
}
async function runSmallFallbackOcr(ocrCanvas,pageW,pageH,reason){
  const T=await loadSmallOcr();setStatus("3B-OCR nicht möglich · kleines Fallback-OCR läuft …","error");busy.classList.add("show");
  const worker=await withHeartbeat("Fallback-OCR Worker startet",()=>T.createWorker("deu+eng",1,{logger:m=>{if(m?.status){const pct=Number.isFinite(m.progress)?Math.round(m.progress*100):0;busy.textContent=pct?"Fallback-OCR · "+m.status+" · "+pct+"%":"Fallback-OCR · "+m.status;setStatus(pct?"Fallback-OCR · "+m.status+" · "+pct+"%":"Fallback-OCR · "+m.status);if(pct)setProgress(pct)}}}),120000);
  try{if(worker.setParameters&&T.PSM)await worker.setParameters({tessedit_pageseg_mode:T.PSM.AUTO});const result=await withHeartbeat("Fallback-OCR erkennt Text",()=>worker.recognize(ocrCanvas),180000);const items=tesseractItems(result?.data,pageW,pageH,ocrCanvas.width,ocrCanvas.height);window.__alantuUocrDebug=window.__alantuUocrDebug||{};window.__alantuUocrDebug.fallback={engine:"tesseract.js",items:items.length,reason:String(reason||"")};mEngine.textContent="Fallback-OCR · Tesseract.js";return items}finally{try{await worker.terminate()}catch{}}
}
`;
  if(!s.includes('function runSmallFallbackOcr('))s=s.replace('function hasRasterImages(opList){',cascade+'\nfunction hasRasterImages(opList){');

  const oldBlock='    try{\n      rawOcr=await runUnlimited(ocrCanvas);\n      if(token!==loadToken)throw new Error("cancelled");\n      ocr=filterNativeDuplicates(parseUnlimited(rawOcr,base.width,base.height),native);\n    }catch(err){\n      if(err?.message==="cancelled")throw err;\n      provisional.ocrError=shortError(err);\n      console.error(err);\n      setStatus("Bild-OCR fehlgeschlagen · PDF bleibt exportierbar.","error");\n    }finally{\n      ocrCanvas.width=1;ocrCanvas.height=1;\n    }';
  const newBlock='    try{\n      rawOcr=await runUnlimited(ocrCanvas);\n      if(token!==loadToken)throw new Error("cancelled");\n      ocr=filterNativeDuplicates(parseUnlimited(rawOcr,base.width,base.height),native);\n    }catch(err){\n      if(err?.message==="cancelled")throw err;\n      const primaryError=shortError(err);\n      provisional.ocrPrimaryError=primaryError;\n      console.error(err);\n      try{\n        const fallback=await runSmallFallbackOcr(ocrCanvas,base.width,base.height,primaryError);\n        if(token!==loadToken)throw new Error("cancelled");\n        ocr=filterNativeDuplicates(fallback,native);\n        provisional.ocrFallback=true;\n        setStatus(ocr.length?"Fallback-OCR fertig · echter Textlayer erzeugt.":"Fallback-OCR lief, hat aber keinen Text erkannt.",ocr.length?"ok":"error");\n      }catch(fallbackErr){\n        if(fallbackErr?.message==="cancelled")throw fallbackErr;\n        provisional.ocrError=primaryError+" | Fallback: "+shortError(fallbackErr);\n        console.error(fallbackErr);\n        setStatus("Bild-OCR fehlgeschlagen · kein Textlayer für diese Bildseite.","error");\n      }\n    }finally{\n      ocrCanvas.width=1;ocrCanvas.height=1;\n    }';
  if(s.includes(oldBlock))s=s.replace(oldBlock,newBlock);
  if(!s.includes('await requireLocalOcrCapability();'))s=s.replace('  const [session,extras]=await Promise.all([ensureVision(),ensureExtras()]);','  await requireLocalOcrCapability();\n  const [session,extras]=await Promise.all([ensureVision(),ensureExtras()]);');
  if(!s.includes('const fallbackAi=pages.filter(p=>p.ocrFallback&&p.ocr.length>0).length;')){
    s=s.replace('const pendingAi=pages.some(p=>p.processing);\n  const failedAi=pages.filter(p=>p.ocrError).length;\n  const coverage=aiPages?Math.round(convertedImagePages/aiPages*100):null;','const pendingAi=pages.some(p=>p.processing);\n  const fallbackAi=pages.filter(p=>p.ocrFallback&&p.ocr.length>0).length;\n  const failedAi=pages.filter(p=>p.ocrError&&!p.ocr.length).length;\n  const coverage=aiPages?Math.round(convertedImagePages/aiPages*100):null;');
  }
  s=s.replace('else if(failedAi)mImageTextPercent.textContent=`OCR fehlgeschlagen auf ${failedAi}/${aiPages} Bildseiten · PDF exportierbar`;\n  else if(aiPages)mImageTextPercent.textContent=`${coverage} % Bildseiten mit OCR · 100 % erkannter OCR-Text → echt · ${imageText} Blöcke / ${imageChars} Zeichen`;','else if(failedAi)mImageTextPercent.textContent=`OCR fehlgeschlagen auf ${failedAi}/${aiPages} Bildseiten · kein Bildtextlayer`;\n  else if(fallbackAi)mImageTextPercent.textContent=`${coverage} % Bildseiten mit OCR · Fallback-OCR auf ${fallbackAi}/${aiPages} · ${imageText} Blöcke / ${imageChars} Zeichen`;\n  else if(aiPages)mImageTextPercent.textContent=`${coverage} % Bildseiten mit OCR · 3B-OCR · ${imageText} Blöcke / ${imageChars} Zeichen`;');
  s=s.replace('const failed=pages.filter(p=>p.ocrError).length;\n    setStatus(failed?`${pages.length} Seiten fertig · ${failed} Bildseiten ohne OCR · PDF exportierbar.`:`${pages.length} Seiten fertig · visuell Original, zusätzlicher echter Textlayer.`,failed?"error":"ok");','const failed=pages.filter(p=>p.ocrError&&!p.ocr.length).length;\n    const fallback=pages.filter(p=>p.ocrFallback&&p.ocr.length).length;\n    setStatus(failed?`${pages.length} Seiten fertig · ${failed} Bildseiten ohne OCR.`:(fallback?`${pages.length} Seiten fertig · Fallback-OCR auf ${fallback} Bildseiten.`:`${pages.length} Seiten fertig · visuell Original, zusätzlicher echter Textlayer.`),failed?"error":"ok");');
  return s;
});

for(const f of ['pdf-convert-anchor.html','.github/workflows/pdf-convert-anchor-smoke.yml','.github/workflows/exposee-pages-rebuild.yml']){
  if(fs.existsSync(f))rw(f,s=>s.replaceAll('browser-webgpu-3','browser-webgpu-6').replaceAll('browser-webgpu-4','browser-webgpu-6').replaceAll('browser-webgpu-5','browser-webgpu-6'));
}
console.log('uocr cascade patch applied');