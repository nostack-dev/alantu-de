export function createAlantuBookViewControls({
  THREE,
  stage,
  renderer,
  camera,
  root,
  getPageWidth,
  getPageHeight=()=>4.80,
  fitButton=null,
  onPinchStart=()=>{},
  minPixelRatio=2,
  maxPixelRatio=3,
  getPresentationMode=()=>"spread"
}){
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const pointers=new Map();

  let zoom=1;
  let fitScale=1;
  let pinch=null;
  let singleFocus=0;
  let singleFocusTarget=0;
  let lastViewStep=performance.now();
  let baseX=0;
  let focusTravelX=0;
  const spreadCameraPosition=camera.position.clone();
  const singleCameraZ=Math.max(6,Number(camera.position.z)||10.8);

  function isFullscreen(){
    return document.fullscreenElement===stage||
      document.webkitFullscreenElement===stage;
  }

  function pixelRatio(){
    const dpr=window.devicePixelRatio||1;
    const resolve=v=>typeof v==="function"?v():v;
    const min=Math.max(1,Number(resolve(minPixelRatio))||2);
    const max=Math.max(min,Number(resolve(maxPixelRatio))||3);
    return Math.min(Math.max(dpr,min),max);
  }

  function applyView(){
    const rect=stage.getBoundingClientRect();
    const w=Math.max(1,Math.round(rect.width));
    const h=Math.max(1,Math.round(rect.height));
    const single=getPresentationMode()==="single";

    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(w,h,false);

    camera.aspect=w/h;
    // Portrait reading is intentionally telephoto/front-on. This removes the
    // texture minification/skew that makes small PDF type look rasterised.
    camera.fov=single?24:(w<560&&!isFullscreen()?31:29);
    camera.updateProjectionMatrix();

    const pageW=Math.max(.1,Number(getPageWidth())||3.52);
    const pageH=Math.max(.1,Number(getPageHeight())||4.80);

    if(single){
      const pan=-focusTravelX*singleFocus;
      camera.position.set(pan,0,singleCameraZ);
      camera.lookAt(pan,0,0);
    }else{
      camera.position.copy(spreadCameraPosition);
      camera.lookAt(0,0,0);
    }

    const distance=Math.hypot(
      camera.position.y,
      camera.position.z
    );
    const viewH=2*distance*Math.tan(
      THREE.MathUtils.degToRad(camera.fov*.5)
    );
    const viewW=viewH*camera.aspect;

    // Landscape/desktop = physical two-page spread. Portrait mobile = one
    // readable sheet. Both keep the same 3D turn physics.
    const envelopeW=single?pageW+.34:pageW*2+.46;
    const envelopeH=pageH+.42;
    fitScale=clamp(
      Math.min(viewW/envelopeW,viewH/envelopeH)*(single ? .965 : .93),
      .42,
      single?1.52:1.28
    );

    const scale=fitScale*zoom;
    root.scale.setScalar(scale);

    // Exact reading plane on portrait. The page itself still bends in Z while
    // turning, so the animation keeps its physical depth.
    root.rotation.set(single?0:-.06,single?0:-.085,single?0:-.006);

    focusTravelX=single?pageW*scale:0;
    if(single){
      // Keep the proven portrait framing unchanged.
      baseX=0;
      root.position.set(baseX,.015,0);
      const pan=-focusTravelX*singleFocus;
      camera.position.x=pan;
      camera.lookAt(pan,0,0);
    }else{
      // The open spread's local visual centre is half a page left of the
      // hinge and slightly above the page stack in Z. Rotate that centre by
      // the same book tilt, then cancel its projected X exactly. This keeps
      // desktop/landscape centred at every aspect ratio and zoom level.
      const spreadCentre=new THREE.Vector3(-pageW*.5,0,.175);
      spreadCentre.applyEuler(root.rotation).multiplyScalar(scale);
      baseX=-spreadCentre.x;
      root.position.set(baseX,.015,0);
      camera.position.copy(spreadCameraPosition);
      camera.lookAt(0,0,0);
    }
  }

  function fit(){
    zoom=1;
    applyView();
  }

  function setZoom(value){
    zoom=clamp(value,.72,1.75);
    applyView();
  }

  function setSingleFocus(value,{immediate=false}={}){
    singleFocusTarget=clamp(Number(value)||0,0,1);
    if(immediate){
      singleFocus=singleFocusTarget;
      const pan=-focusTravelX*singleFocus;
      camera.position.x=pan;
      camera.lookAt(pan,0,0);
    }
  }

  function step(now=performance.now()){
    const dt=Math.max(.001,Math.min(.05,(now-lastViewStep)/1000));
    lastViewStep=now;
    if(getPresentationMode()!=="single"){
      singleFocus=singleFocusTarget=0;
      return;
    }
    const delta=singleFocusTarget-singleFocus;
    if(Math.abs(delta)<.0005){
      singleFocus=singleFocusTarget;
    }else{
      // Fast enough to track the page, slow enough to read as a camera move.
      const alpha=1-Math.exp(-11*dt);
      singleFocus+=delta*alpha;
    }
    const pan=-focusTravelX*singleFocus;
    camera.position.x=pan;
    camera.lookAt(pan,0,0);
  }

  function wheel(e){
    if(!stage.contains(e.target))return;
    e.preventDefault();
    const factor=Math.exp(-e.deltaY*.00135);
    setZoom(zoom*factor);
  }

  function distance(){
    const points=[...pointers.values()];
    if(points.length<2)return 0;
    return Math.hypot(
      points[0].x-points[1].x,
      points[0].y-points[1].y
    );
  }

  function pointerDown(e){
    if(e.pointerType!=="touch")return;
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});

    if(pointers.size===2){
      onPinchStart();
      pinch={
        distance:Math.max(1,distance()),
        zoom
      };
      stage.classList.add("is-view-pinching");
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function pointerMove(e){
    if(e.pointerType!=="touch"||!pointers.has(e.pointerId))return;
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});

    if(pinch&&pointers.size>=2){
      const ratio=distance()/pinch.distance;
      setZoom(pinch.zoom*ratio);
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function pointerEnd(e){
    if(e.pointerType!=="touch")return;
    const wasPinching=!!pinch;
    pointers.delete(e.pointerId);

    if(pointers.size<2){
      pinch=null;
      stage.classList.remove("is-view-pinching");
    }

    if(wasPinching){
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  stage.addEventListener("wheel",wheel,{passive:false});
  stage.addEventListener("pointerdown",pointerDown,true);
  stage.addEventListener("pointermove",pointerMove,true);
  stage.addEventListener("pointerup",pointerEnd,true);
  stage.addEventListener("pointercancel",pointerEnd,true);

  if(fitButton){
    fitButton.addEventListener("click",e=>{
      e.preventDefault();
      e.stopPropagation();
      fit();
    });
  }

  return {
    fit,
    resize:applyView,
    setZoom,
    setSingleFocus,
    step,
    get zoom(){return zoom},
    get fitScale(){return fitScale},
    get singleFocus(){return singleFocus}
  };
}


export function createAlantuFullscreenController({
  stage,
  button,
  onChange=()=>{}
}){
  let faux=false;
  let savedScrollY=0;
  let exitGesture=null;

  const nativeActive=()=>document.fullscreenElement===stage||
    document.webkitFullscreenElement===stage;
  const active=()=>nativeActive()||faux;

  function sync(){
    const isActive=active();
    if(button){
      button.setAttribute("aria-label",isActive?"Vollbild schließen":"Vollbild öffnen");
      button.title=isActive?"Vollbild schließen":"Vollbild";
    }
    onChange(isActive);
  }

  function enterFaux(){
    if(faux)return;
    faux=true;
    savedScrollY=window.scrollY||0;
    document.body.classList.add("alantu-faux-fullscreen");
    stage.classList.add("is-faux-fullscreen");
    sync();
  }

  function leaveFaux({restoreScroll=true}={}){
    if(!faux)return;
    faux=false;
    stage.classList.remove("is-faux-fullscreen");
    document.body.classList.remove("alantu-faux-fullscreen");
    if(restoreScroll)requestAnimationFrame(()=>window.scrollTo(0,savedScrollY));
    sync();
  }

  async function toggle(){
    if(nativeActive()){
      try{
        if(document.exitFullscreen)await document.exitFullscreen();
        else if(document.webkitExitFullscreen)document.webkitExitFullscreen();
      }catch{}
      return;
    }
    if(faux){
      leaveFaux();
      return;
    }

    const request=stage.requestFullscreen||stage.webkitRequestFullscreen;
    if(!request){
      enterFaux();
      return;
    }

    try{
      const result=request.call(stage,{navigationUI:"hide"});
      if(result&&typeof result.then==="function")await result;
      // iPhone/iOS may expose a method but still decline element fullscreen.
      setTimeout(()=>{
        if(!nativeActive()&&!faux)enterFaux();
        else sync();
      },220);
    }catch{
      enterFaux();
    }
  }

  function nativeChanged(){
    if(nativeActive()&&faux)leaveFaux({restoreScroll:false});
    sync();
  }

  function keydown(e){
    if(e.key==="Escape"&&faux)leaveFaux();
  }

  function gestureDown(e){
    if(!active()||e.pointerType!=="touch")return;
    exitGesture={id:e.pointerId,x:e.clientX,y:e.clientY};
  }
  function gestureUp(e){
    if(!exitGesture||exitGesture.id!==e.pointerId)return;
    const dx=e.clientX-exitGesture.x;
    const dy=e.clientY-exitGesture.y;
    exitGesture=null;
    if(dy>90&&Math.abs(dy)>Math.abs(dx)*1.5){
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }
  }
  function gestureCancel(){exitGesture=null;}

  button?.addEventListener("click",toggle);
  document.addEventListener("fullscreenchange",nativeChanged);
  document.addEventListener("webkitfullscreenchange",nativeChanged);
  window.addEventListener("keydown",keydown);
  stage.addEventListener("pointerdown",gestureDown,true);
  stage.addEventListener("pointerup",gestureUp,true);
  stage.addEventListener("pointercancel",gestureCancel,true);
  sync();

  return {
    toggle,
    isActive:active,
    sync,
    destroy(){
      button?.removeEventListener("click",toggle);
      document.removeEventListener("fullscreenchange",nativeChanged);
      document.removeEventListener("webkitfullscreenchange",nativeChanged);
      window.removeEventListener("keydown",keydown);
      stage.removeEventListener("pointerdown",gestureDown,true);
      stage.removeEventListener("pointerup",gestureUp,true);
      stage.removeEventListener("pointercancel",gestureCancel,true);
      leaveFaux({restoreScroll:false});
    }
  };
}
