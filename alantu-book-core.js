export function computeAlantuBookSupportZ({
  totalLeaves,
  rightZ,
  pageBlockThickness,
  coverThickness=0,
  gap=.008,
  coverGap=.008
}){
  const count=Math.max(1,Number(totalLeaves)||1);
  const deepestLeafZ=rightZ(count-1);

  // BoxGeometry is centered on Z. Its FRONT face must sit behind the
  // deepest real leaf, otherwise it can occlude real pages in deep books.
  const pageBlockCenterZ=
    deepestLeafZ-gap-pageBlockThickness/2;

  const pageBlockBackZ=
    pageBlockCenterZ-pageBlockThickness/2;

  const backCoverCenterZ=coverThickness>0
    ? pageBlockBackZ-coverGap-coverThickness/2
    : pageBlockBackZ-coverGap;

  return {
    deepestLeafZ,
    pageBlockCenterZ,
    backCoverCenterZ
  };
}

// ALANTU shared book interaction + page physics core.
// One source of truth for demo and PDF exposé viewer.

export function createAlantuBookCore(options){
  const {
    stage,
    getLeaves,
    getPageWidth,
    getTotalLeaves,
    rightZ,
    leftZ,
    setStartCoverProgress=()=>{},
    setEndCoverProgress=()=>{},
    prefersReduced=false,
    onStateChange=()=>{},
    nextButton=null,
    prevButton=null,
    nextTap=null,
    prevTap=null,
    ignorePointerSelector=".stage-control,.circle"
  } = options;

  let currentLeaf=0;
  let desiredPosition=0; // -1=start closed, 0..N=open leaf states, N+1=end closed
  let closedSide=null;   // null | "start" | "end"
  let activeTurn=null;
  let activeBoundary=null;
  let dragState=null;
  let lastMotionTime=performance.now();
  let suppressTapUntil=0;

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const smoothstep=(a,b,x)=>{
    const t=clamp((x-a)/(b-a),0,1);
    return t*t*(3-2*t);
  };

  function state(){
    const totalLeaves=getTotalLeaves();
    return {
      currentLeaf,
      desiredLeaf:clamp(desiredPosition,0,totalLeaves),
      desiredPosition,
      closedSide,
      activeTurn:activeTurn?{...activeTurn}:null,
      activeBoundary:activeBoundary?{...activeBoundary}:null,
      dragging:!!dragState,
      totalLeaves
    };
  }

  function notify(){
    const totalLeaves=getTotalLeaves();
    const hardStart=closedSide==="start"&&!activeBoundary&&desiredPosition<=-1;
    const hardEnd=closedSide==="end"&&!activeBoundary&&desiredPosition>=totalLeaves+1;

    if(prevButton)prevButton.disabled=hardStart;
    if(prevTap)prevTap.disabled=hardStart;
    if(nextButton)nextButton.disabled=hardEnd;
    if(nextTap)nextTap.disabled=hardEnd;

    onStateChange(state());
  }

  function deformLeaf(index,progress){
    const leaves=getLeaves();
    const pivot=leaves[index];
    if(!pivot)return;

    const PAGE_W=getPageWidth();
    const geometry=pivot.userData.geometry;
    const pos=geometry.attributes.position;
    const base=geometry.userData.basePosition;
    const segments=30;
    const ds=PAGE_W/segments;
    const p=clamp(progress,0,1);

    const theta=Math.PI*p;
    const lag=.58*Math.sin(Math.PI*p);
    const spineBlend=smoothstep(.35,.92,p);
    const spineZ=rightZ(index)+(leftZ(index)-rightZ(index))*spineBlend;

    const curveX=new Float32Array(segments+1);
    const curveZ=new Float32Array(segments+1);
    curveX[0]=0;
    curveZ[0]=spineZ;

    for(let j=1;j<=segments;j++){
      const u=(j-.5)/segments;
      const localAngle=clamp(theta-lag*Math.sin(Math.PI*u),0,Math.PI);
      curveX[j]=curveX[j-1]+ds*Math.cos(localAngle);
      curveZ[j]=curveZ[j-1]+ds*Math.sin(localAngle);
    }

    const leftStackTop=index>0?leftZ(index-1):rightZ(0)-.01;
    const rightStackTop=rightZ(index);
    const safety=.007;

    for(let i=0;i<pos.count;i++){
      const bx=base[i*3];
      const by=base[i*3+1];
      const u=clamp(bx/PAGE_W,0,1);
      const seg=clamp(Math.round(u*segments),0,segments);

      let x=curveX[seg];
      let z=curveZ[seg];

      if(x<0){
        const landing=smoothstep(.72,1,p);
        z=Math.max(z,leftStackTop+safety*(1-landing));
      }else{
        const leaving=smoothstep(0,.28,p);
        z=Math.max(z,rightStackTop-safety*leaving);
      }

      pos.array[i*3]=x;
      pos.array[i*3+1]=by;
      pos.array[i*3+2]=z;
    }

    pos.needsUpdate=true;
    geometry.computeVertexNormals();
    pivot.rotation.set(0,0,0);
    pivot.position.set(-PAGE_W/2,0,0);
  }

  function setLeafState(index,flipped){
    deformLeaf(index,flipped?1:0);
  }

  function normalize(){
    const totalLeaves=getTotalLeaves();
    for(let i=0;i<totalLeaves;i++)setLeafState(i,i<currentLeaf);
  }

  function setBoundaryVisual(side,progress){
    const p=clamp(progress,0,1);
    if(side==="start")setStartCoverProgress(p);
    else setEndCoverProgress(p);
  }

  function beginBoundary(side,target,progress){
    const totalLeaves=getTotalLeaves();
    if(activeBoundary&&activeBoundary.side===side){
      activeBoundary.target=target;
      return;
    }
    activeBoundary={
      side,
      progress:progress ?? (closedSide===side?1:0),
      velocity:0,
      target
    };
    if(target===0)closedSide=null;
    desiredPosition=side==="start"
      ? (target===1?-1:0)
      : (target===1?totalLeaves+1:totalLeaves);
  }

  function ensureTurn(){
    const totalLeaves=getTotalLeaves();
    if(dragState||totalLeaves<=0)return;

    if(activeBoundary){
      if(activeBoundary.side==="start"){
        activeBoundary.target=desiredPosition<0?1:0;
      }else{
        activeBoundary.target=desiredPosition>totalLeaves?1:0;
      }
      return;
    }

    if(closedSide==="start"){
      if(desiredPosition>=0)beginBoundary("start",0,1);
      return;
    }
    if(closedSide==="end"){
      if(desiredPosition<=totalLeaves)beginBoundary("end",0,1);
      return;
    }

    if(activeTurn){
      if(activeTurn.index===currentLeaf){
        activeTurn.target=desiredPosition>currentLeaf?1:0;
      }else if(activeTurn.index===currentLeaf-1){
        activeTurn.target=desiredPosition<currentLeaf?0:1;
      }
      return;
    }

    if(desiredPosition<0&&currentLeaf===0){
      beginBoundary("start",1,0);
    }else if(desiredPosition>totalLeaves&&currentLeaf===totalLeaves){
      beginBoundary("end",1,0);
    }else if(desiredPosition>currentLeaf){
      activeTurn={index:currentLeaf,progress:0,velocity:0,target:1};
    }else if(desiredPosition<currentLeaf){
      activeTurn={index:currentLeaf-1,progress:1,velocity:0,target:0};
    }

    notify();
  }

  function springStep(item,dt){
    const stiffness=prefersReduced?900:120;
    const damping=prefersReduced?80:18;
    const error=item.target-item.progress;

    item.velocity+=(error*stiffness-item.velocity*damping)*dt;
    item.progress+=item.velocity*dt;

    if(item.progress<=0){
      item.progress=0;
      if(item.velocity<0)item.velocity*=.18;
    }else if(item.progress>=1){
      item.progress=1;
      if(item.velocity>0)item.velocity*=.18;
    }
  }

  function settled(item){
    return Math.abs(item.target-item.progress)<.0015&&Math.abs(item.velocity)<.045;
  }

  function step(now){
    const dt=Math.max(.001,Math.min(.033,(now-lastMotionTime)/1000));
    lastMotionTime=now;

    ensureTurn();
    if(dragState)return;

    if(activeBoundary){
      springStep(activeBoundary,dt);
      setBoundaryVisual(activeBoundary.side,activeBoundary.progress);

      if(settled(activeBoundary)){
        const finished=activeBoundary;
        finished.progress=finished.target;
        setBoundaryVisual(finished.side,finished.target);

        if(finished.target===1)closedSide=finished.side;
        else closedSide=null;

        activeBoundary=null;
        ensureTurn();
      }

      notify();
      return;
    }

    if(!activeTurn)return;

    springStep(activeTurn,dt);
    deformLeaf(activeTurn.index,activeTurn.progress);

    if(settled(activeTurn)){
      const finished=activeTurn;
      deformLeaf(finished.index,finished.target);

      if(finished.target===1&&finished.index===currentLeaf){
        currentLeaf++;
      }else if(finished.target===0&&finished.index===currentLeaf-1){
        currentLeaf--;
      }

      activeTurn=null;
      normalize();
      ensureTurn();
    }

    notify();
  }

  function next(){
    const totalLeaves=getTotalLeaves();
    if(totalLeaves<=0)return;
    desiredPosition=Math.min(totalLeaves+1,desiredPosition+1);
    ensureTurn();
    notify();
  }

  function prev(){
    const totalLeaves=getTotalLeaves();
    if(totalLeaves<=0)return;
    desiredPosition=Math.max(-1,desiredPosition-1);
    ensureTurn();
    notify();
  }

  function reset(leaf=0){
    const totalLeaves=getTotalLeaves();
    currentLeaf=clamp(leaf,0,totalLeaves);
    desiredPosition=currentLeaf;
    closedSide=null;
    activeTurn=null;
    activeBoundary=null;
    dragState=null;
    lastMotionTime=performance.now();
    setStartCoverProgress(0);
    setEndCoverProgress(0);
    normalize();
    notify();
  }

  function shownLeaf(){
    return activeTurn
      ? (activeTurn.progress>=.5?activeTurn.index+1:activeTurn.index)
      : currentLeaf;
  }

  function pointerDown(e){
    if(getTotalLeaves()<=0)return;
    if(ignorePointerSelector&&e.target.closest?.(ignorePointerSelector))return;

    const totalLeaves=getTotalLeaves();
    const now=performance.now();

    desiredPosition=closedSide==="start"
      ? -1
      : closedSide==="end"
        ? totalLeaves+1
        : currentLeaf;

    dragState={
      id:e.pointerId,
      startX:e.clientX,
      startY:e.clientY,
      lastX:e.clientX,
      lastTime:now,
      mode:activeBoundary?"boundary":activeTurn?"leaf":null,
      side:activeBoundary?.side??null,
      index:activeTurn?.index??null,
      startProgress:activeBoundary?.progress??activeTurn?.progress??null,
      velocity:activeBoundary?.velocity??activeTurn?.velocity??0,
      moved:false
    };

    if(stage.setPointerCapture)stage.setPointerCapture(e.pointerId);
  }

  function pointerMove(e){
    if(!dragState||dragState.id!==e.pointerId)return;

    const totalLeaves=getTotalLeaves();
    const dx=e.clientX-dragState.startX;
    const dy=e.clientY-dragState.startY;

    if(dragState.mode===null){
      if(Math.abs(dx)<6||Math.abs(dx)<Math.abs(dy)*1.05)return;

      if(closedSide==="start"&&dx<0){
        dragState.mode="boundary";
        dragState.side="start";
        dragState.startProgress=1;
        activeBoundary={side:"start",progress:1,velocity:0,target:1};
      }else if(closedSide==="end"&&dx>0){
        dragState.mode="boundary";
        dragState.side="end";
        dragState.startProgress=1;
        activeBoundary={side:"end",progress:1,velocity:0,target:1};
      }else if(!closedSide&&currentLeaf===0&&dx>0){
        dragState.mode="boundary";
        dragState.side="start";
        dragState.startProgress=0;
        activeBoundary={side:"start",progress:0,velocity:0,target:0};
      }else if(!closedSide&&currentLeaf===totalLeaves&&dx<0){
        dragState.mode="boundary";
        dragState.side="end";
        dragState.startProgress=0;
        activeBoundary={side:"end",progress:0,velocity:0,target:0};
      }else if(!closedSide){
        const index=dx<0?currentLeaf:currentLeaf-1;
        if(index<0||index>=totalLeaves)return;
        dragState.mode="leaf";
        dragState.index=index;
        dragState.startProgress=dx<0?0:1;
        activeTurn={index,progress:dragState.startProgress,velocity:0,target:dragState.startProgress};
      }else{
        return;
      }
    }

    const distance=Math.max(160,stage.clientWidth*.56);
    const now=performance.now();
    const dt=Math.max(.008,(now-dragState.lastTime)/1000);
    const deltaX=e.clientX-dragState.lastX;

    if(dragState.mode==="boundary"){
      const dir=dragState.side==="start"?1:-1;
      const progress=clamp(dragState.startProgress+dir*dx/distance,0,1);
      const velocity=dir*deltaX/distance/dt;

      dragState.velocity=velocity;
      activeBoundary.progress=progress;
      activeBoundary.velocity=velocity;
      setBoundaryVisual(dragState.side,progress);
    }else{
      const progress=clamp(dragState.startProgress-dx/distance,0,1);
      const velocity=-deltaX/distance/dt;

      dragState.velocity=velocity;
      activeTurn.progress=progress;
      activeTurn.velocity=velocity;
      deformLeaf(activeTurn.index,progress);
    }

    dragState.lastX=e.clientX;
    dragState.lastTime=now;
    dragState.moved=dragState.moved||Math.abs(dx)>8;
    notify();

    if(dragState.moved)e.preventDefault();
  }

  function releaseDrag(cancelled=false){
    if(!dragState)return;

    const totalLeaves=getTotalLeaves();

    if(dragState.mode==="boundary"&&activeBoundary){
      const projected=activeBoundary.progress+(cancelled?0:dragState.velocity*.12);
      const target=projected>=.5?1:0;
      activeBoundary.target=target;
      activeBoundary.velocity=cancelled?0:dragState.velocity;

      if(activeBoundary.side==="start"){
        desiredPosition=target===1?-1:0;
      }else{
        desiredPosition=target===1?totalLeaves+1:totalLeaves;
      }

      if(target===0)closedSide=null;
    }else if(dragState.mode==="leaf"&&activeTurn){
      const projected=activeTurn.progress+(cancelled?0:dragState.velocity*.12);
      const target=projected>=.5?1:0;
      activeTurn.target=target;
      activeTurn.velocity=cancelled?0:dragState.velocity;
      desiredPosition=target?activeTurn.index+1:activeTurn.index;
    }

    if(dragState.moved)suppressTapUntil=performance.now()+260;
    dragState=null;
    ensureTurn();
    notify();
  }

  function pointerUp(e){
    if(!dragState||dragState.id!==e.pointerId)return;
    releaseDrag(false);
  }

  function pointerCancel(){
    releaseDrag(true);
  }

  stage.addEventListener("pointerdown",pointerDown);
  stage.addEventListener("pointermove",pointerMove);
  stage.addEventListener("pointerup",pointerUp);
  stage.addEventListener("pointercancel",pointerCancel);

  if(prevButton)prevButton.addEventListener("click",prev);
  if(nextButton)nextButton.addEventListener("click",next);
  if(prevTap)prevTap.addEventListener("click",()=>{if(performance.now()>=suppressTapUntil)prev()});
  if(nextTap)nextTap.addEventListener("click",()=>{if(performance.now()>=suppressTapUntil)next()});

  notify();

  return {
    next,
    prev,
    step,
    reset,
    normalize,
    deformLeaf,
    shownLeaf,
    state
  };
}
