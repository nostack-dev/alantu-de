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
  maxPixelRatio=3
}){
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const pointers=new Map();

  let zoom=1;
  let fitScale=1;
  let pinch=null;

  function isFullscreen(){
    return document.fullscreenElement===stage||
      document.webkitFullscreenElement===stage;
  }

  function pixelRatio(){
    const dpr=window.devicePixelRatio||1;
    const min=Math.max(1,Number(minPixelRatio)||2);
    const max=Math.max(min,Number(maxPixelRatio)||3);
    return Math.min(Math.max(dpr,min),max);
  }

  function applyView(){
    const rect=stage.getBoundingClientRect();
    const w=Math.max(1,Math.round(rect.width));
    const h=Math.max(1,Math.round(rect.height));

    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(w,h,false);

    camera.aspect=w/h;
    camera.fov=w<560&&!isFullscreen()?31:29;
    camera.updateProjectionMatrix();

    const pageW=Math.max(.1,Number(getPageWidth())||3.52);
    const pageH=Math.max(.1,Number(getPageHeight())||4.80);
    const distance=Math.hypot(
      camera.position.x,
      camera.position.y,
      camera.position.z
    );
    const viewH=2*distance*Math.tan(
      THREE.MathUtils.degToRad(camera.fov*.5)
    );
    const viewW=viewH*camera.aspect;

    // Maximum physical turn envelope: one page on each side of the spine,
    // plus the hardcover overhang. This is stable throughout the turn.
    const envelopeW=pageW*2+.46;
    const envelopeH=pageH+.50;
    fitScale=clamp(
      Math.min(viewW/envelopeW,viewH/envelopeH)*.93,
      .42,
      1.28
    );

    const scale=fitScale*zoom;
    root.scale.setScalar(scale);

    // The full two-sided envelope is centered at -pageW/2 in book-local
    // coordinates. This offset keeps it optically centered at every zoom.
    root.position.set(pageW*.5*scale,.015,0);

    // Small architectural tilt: enough depth cue without sacrificing text.
    root.rotation.set(-.075,-.105,-.008);
  }

  function fit(){
    zoom=1;
    applyView();
  }

  function setZoom(value){
    zoom=clamp(value,.72,1.75);
    applyView();
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
    get zoom(){return zoom},
    get fitScale(){return fitScale}
  };
}
