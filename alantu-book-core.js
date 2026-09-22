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
    prefersReduced=false,
    onStateChange=()=>{},
    nextButton=null,
    prevButton=null,
    nextTap=null,
    prevTap=null,
    ignorePointerSelector=".stage-control,.circle"
  } = options;

  let currentLeaf=0;
  let desiredLeaf=0;
  let activeTurn=null;
  let dragState=null;
  let lastMotionTime=performance.now();
  let suppressTapUntil=0;

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const smoothstep=(a,b,x)=>{
    const t=clamp((x-a)/(b-a),0,1);
    return t*t*(3-2*t);
  };

  function state(){
    return {
      currentLeaf,
      desiredLeaf,
      activeTurn: activeTurn ? {...activeTurn} : null,
      dragging:!!dragState,
      totalLeaves:getTotalLeaves()
    };
  }

  function notify(){
    const totalLeaves=getTotalLeaves();
    const hardStart=currentLeaf===0&&!activeTurn&&desiredLeaf===0;
    const hardEnd=currentLeaf===totalLeaves&&!activeTurn&&desiredLeaf===totalLeaves;

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

    // Inextensible strip: equal-length segments bend around the spine.
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
      const localAngle=clamp(
        theta-lag*Math.sin(Math.PI*u),
        0,
        Math.PI
      );
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

      // Collision constraints: the moving sheet can touch a settled stack,
      // but it cannot geometrically pass through it.
      if(x<0){
        const landing=smoothstep(.72,1,p);
        const floor=leftStackTop+safety*(1-landing);
        z=Math.max(z,floor);
      }else{
        const leaving=smoothstep(0,.28,p);
        const floor=rightStackTop-safety*leaving;
        z=Math.max(z,floor);
      }

      pos.array[i*3]=x;
      pos.array[i*3+1]=by;
      pos.array[i*3+2]=z;
    }

    pos.needsUpdate=true;
    geometry.computeVertexNormals();

    // Geometry owns the motion; the pivot remains fixed at the spine.
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

  function ensureTurn(){
    const totalLeaves=getTotalLeaves();
    if(dragState||totalLeaves<=0)return;

    if(activeTurn){
      if(activeTurn.index===currentLeaf){
        activeTurn.target=desiredLeaf>currentLeaf?1:0;
      }else if(activeTurn.index===currentLeaf-1){
        activeTurn.target=desiredLeaf<currentLeaf?0:1;
      }
      return;
    }

    if(desiredLeaf>currentLeaf){
      activeTurn={index:currentLeaf,progress:0,velocity:0,target:1};
    }else if(desiredLeaf<currentLeaf){
      activeTurn={index:currentLeaf-1,progress:1,velocity:0,target:0};
    }

    notify();
  }

  function step(now){
    const dt=Math.max(.001,Math.min(.033,(now-lastMotionTime)/1000));
    lastMotionTime=now;

    ensureTurn();
    if(!activeTurn||dragState)return;

    const stiffness=prefersReduced?900:120;
    const damping=prefersReduced?80:18;
    const error=activeTurn.target-activeTurn.progress;

    activeTurn.velocity+=(error*stiffness-activeTurn.velocity*damping)*dt;
    activeTurn.progress+=activeTurn.velocity*dt;

    if(activeTurn.progress<=0){
      activeTurn.progress=0;
      if(activeTurn.velocity<0)activeTurn.velocity*=.18;
    }else if(activeTurn.progress>=1){
      activeTurn.progress=1;
      if(activeTurn.velocity>0)activeTurn.velocity*=.18;
    }

    deformLeaf(activeTurn.index,activeTurn.progress);

    if(Math.abs(activeTurn.target-activeTurn.progress)<.0015&&Math.abs(activeTurn.velocity)<.045){
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
    desiredLeaf=Math.min(totalLeaves,desiredLeaf+1);
    ensureTurn();
    notify();
  }

  function prev(){
    if(getTotalLeaves()<=0)return;
    desiredLeaf=Math.max(0,desiredLeaf-1);
    ensureTurn();
    notify();
  }

  function reset(leaf=0){
    const totalLeaves=getTotalLeaves();
    currentLeaf=clamp(leaf,0,totalLeaves);
    desiredLeaf=currentLeaf;
    activeTurn=null;
    dragState=null;
    lastMotionTime=performance.now();
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

    const now=performance.now();
    desiredLeaf=currentLeaf;

    dragState={
      id:e.pointerId,
      startX:e.clientX,
      startY:e.clientY,
      lastX:e.clientX,
      lastTime:now,
      index:activeTurn?.index??null,
      startProgress:activeTurn?.progress??null,
      velocity:activeTurn?.velocity??0,
      moved:false
    };

    if(stage.setPointerCapture)stage.setPointerCapture(e.pointerId);
  }

  function pointerMove(e){
    if(!dragState||dragState.id!==e.pointerId)return;

    const dx=e.clientX-dragState.startX;
    const dy=e.clientY-dragState.startY;

    if(dragState.index===null){
      if(Math.abs(dx)<6||Math.abs(dx)<Math.abs(dy)*1.05)return;

      const index=dx<0?currentLeaf:currentLeaf-1;
      const totalLeaves=getTotalLeaves();
      if(index<0||index>=totalLeaves)return;

      dragState.index=index;
      dragState.startProgress=dx<0?0:1;
      activeTurn={
        index,
        progress:dragState.startProgress,
        velocity:0,
        target:dragState.startProgress
      };
    }

    const distance=Math.max(160,stage.clientWidth*.56);
    const progress=clamp(dragState.startProgress-dx/distance,0,1);
    const now=performance.now();
    const dt=Math.max(.008,(now-dragState.lastTime)/1000);
    const velocity=-(e.clientX-dragState.lastX)/distance/dt;

    dragState.velocity=velocity;
    dragState.lastX=e.clientX;
    dragState.lastTime=now;
    dragState.moved=dragState.moved||Math.abs(dx)>8;

    activeTurn.progress=progress;
    activeTurn.velocity=velocity;
    deformLeaf(activeTurn.index,progress);
    notify();

    if(dragState.moved)e.preventDefault();
  }

  function releaseDrag(cancelled=false){
    if(!dragState)return;

    if(activeTurn&&dragState.index!==null){
      const projected=activeTurn.progress+(cancelled?0:dragState.velocity*.12);
      const target=projected>=.5?1:0;
      activeTurn.target=target;
      activeTurn.velocity=cancelled?0:dragState.velocity;
      desiredLeaf=target?activeTurn.index+1:activeTurn.index;
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
