const fs=require('fs');
function rw(path,fn){let s=fs.readFileSync(path,'utf8');const n=fn(s);if(n!==s)fs.writeFileSync(path,n)}
rw('alantu-unlimited-ocr.js',s=>{
  const marker='async function blobToArrayBuffer(blob){return blob.arrayBuffer()}\n';
  const insert=`
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function shortError(err){
  const msg=String(err?.message||err||"Load failed");
  if(/Load failed|Failed to fetch|NetworkError|fetch|aborted|cancelled|body/i.test(msg))return "Download abgebrochen oder Browser-Speicher zu knapp. Seite neu laden oder Desktop-Chrome nutzen.";
  return msg;
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
`;
  if(!s.includes('function fetchWithRetry('))s=s.replace(marker,marker+insert);
  s=s.replace('const resp=await fetch(url,{cache:"force-cache"});','const resp=await fetchWithRetry(url,{cache:"force-cache"},"Unlimited-OCR Sidecar");');
  s=s.replace('const ort=await import(ORT_URL);','const ort=await withHeartbeat("ONNX Runtime wird geladen",()=>import(ORT_URL),60000);');
  s=s.replace('visionSession=await ort.InferenceSession.create(MODEL.visionUrl,{\n      executionProviders:["webgpu"],\n      graphOptimizationLevel:"all"\n    });','visionSession=await withHeartbeat("Vision-Modell wird lokal geladen",()=>ort.InferenceSession.create(MODEL.visionUrl,{\n      executionProviders:["webgpu"],\n      graphOptimizationLevel:"all"\n    }),420000);');
  s=s.replace('const result=await session.run({pixel_values:new ort.Tensor("float32",pixels,[1,3,1024,1024])});','const result=await withHeartbeat("Bildtext wird erkannt",()=>session.run({pixel_values:new ort.Tensor("float32",pixels,[1,3,1024,1024])}),180000);');
  const old='    rawOcr=await runUnlimited(ocrCanvas);\n    ocrCanvas.width=1;ocrCanvas.height=1;\n    if(token!==loadToken)throw new Error("cancelled");\n    ocr=filterNativeDuplicates(parseUnlimited(rawOcr,base.width,base.height),native);';
  const neu='    try{\n      rawOcr=await runUnlimited(ocrCanvas);\n      if(token!==loadToken)throw new Error("cancelled");\n      ocr=filterNativeDuplicates(parseUnlimited(rawOcr,base.width,base.height),native);\n    }catch(err){\n      if(err?.message==="cancelled")throw err;\n      provisional.ocrError=shortError(err);\n      console.error(err);\n      setStatus("Bild-OCR fehlgeschlagen · PDF bleibt exportierbar.","error");\n    }finally{\n      ocrCanvas.width=1;ocrCanvas.height=1;\n    }';
  if(s.includes(old))s=s.replace(old,neu);
  s=s.replace('const pendingAi=pages.some(p=>p.processing);\n  const coverage=aiPages?Math.round(convertedImagePages/aiPages*100):null;','const pendingAi=pages.some(p=>p.processing);\n  const failedAi=pages.filter(p=>p.ocrError).length;\n  const coverage=aiPages?Math.round(convertedImagePages/aiPages*100):null;');
  s=s.replace('else if(aiPages)mImageTextPercent.textContent=`${coverage} % Bildseiten mit OCR · 100 % erkannter OCR-Text → echt · ${imageText} Blöcke / ${imageChars} Zeichen`;','else if(failedAi)mImageTextPercent.textContent=`OCR fehlgeschlagen auf ${failedAi}/${aiPages} Bildseiten · PDF exportierbar`;\n  else if(aiPages)mImageTextPercent.textContent=`${coverage} % Bildseiten mit OCR · 100 % erkannter OCR-Text → echt · ${imageText} Blöcke / ${imageChars} Zeichen`;');
  s=s.replace('if(!modelLoaded)mEngine.textContent=`${MODEL.name} · CPU/WASM`;','if(!modelLoaded)mEngine.textContent=MODEL.name;');
  s=s.replace('setStatus(`${pages.length} Seiten fertig · visuell Original, zusätzlicher echter Textlayer.`,"ok");','const failed=pages.filter(p=>p.ocrError).length;\n    setStatus(failed?`${pages.length} Seiten fertig · ${failed} Bildseiten ohne OCR · PDF exportierbar.`:`${pages.length} Seiten fertig · visuell Original, zusätzlicher echter Textlayer.`,failed?"error":"ok");');
  return s;
});
for(const f of ['pdf-convert-anchor.html','.github/workflows/pdf-convert-anchor-smoke.yml','.github/workflows/exposee-pages-rebuild.yml']){
  if(fs.existsSync(f))rw(f,s=>s.replaceAll('alantu-unlimited-ocr.js?v=browser-webgpu-3','alantu-unlimited-ocr.js?v=browser-webgpu-4'));
}
console.log('uocr stability patch applied');
