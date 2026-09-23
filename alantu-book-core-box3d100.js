import { createAlantuBookPhysics } from "./alantu-book-physics-box3d100.js";

export function sanitizeAlantuCoverTitle(value,fallback="ALANTU Exposé"){
  const cleaned=String(value??"")
    .replace(/\\n/g," ")
    .replace(/[\r\n\t]+/g," ")
    .replace(/\.pdf$/i,"")
    .replace(/[_-]+/g," ")
    .replace(/\s+/g," ")
    .trim();

  return cleaned||fallback;
}

export function createAlantuCoverCanvas({
  title,
  brand="ALANTU",
  subtitle="Exposé",
  width=1200,
  height=1600
}={}){
  const canvas=document.createElement("canvas");
  canvas.width=width;
  canvas.height=height;
  const ctx=canvas.getContext("2d",{alpha:false});

  ctx.fillStyle="#171713";
  ctx.fillRect(0,0,width,height);

  const pad=Math.round(width*.105);
  const usable=width-pad*2;
  const safeTitle=sanitizeAlantuCoverTitle(title);

  ctx.textBaseline="alphabetic";

  // Brand: small, quiet, spaced.
  ctx.fillStyle="#b89a63";
  ctx.font=`600 ${Math.round(width*.036)}px Arial, sans-serif`;
  ctx.fillText(brand.toUpperCase(),pad,Math.round(height*.11));

  // Minimal champagne rule.
  ctx.fillRect(pad,Math.round(height*.145),Math.round(width*.075),Math.max(2,Math.round(width*.003)));

  // Title: centered vertically, premium serif, max 3 lines.
  let fontSize=Math.round(width*.092);
  let lines=[];
  const words=safeTitle.split(" ");

  function layout(){
    lines=[];
    let line="";
    for(const word of words){
      const test=line?line+" "+word:word;
      if(ctx.measureText(test).width>usable&&line){
        lines.push(line);
        line=word;
      }else{
        line=test;
      }
    }
    if(line)lines.push(line);
  }

  do{
    ctx.font=`400 ${fontSize}px Georgia, 'Times New Roman', serif`;
    layout();
    if(lines.length<=3)break;
    fontSize-=4;
  }while(fontSize>44);

  if(lines.length>3){
    lines=lines.slice(0,3);
    let last=lines[2];
    while(last.length>1&&ctx.measureText(last+"…").width>usable){
      last=last.slice(0,-1);
    }
    lines[2]=last.trimEnd()+"…";
  }

  const lineHeight=Math.round(fontSize*1.14);
  const blockHeight=(lines.length-1)*lineHeight;
  let y=Math.round(height*.56-blockHeight/2);

  ctx.fillStyle="#f4f0e8";
  ctx.font=`400 ${fontSize}px Georgia, 'Times New Roman', serif`;
  for(const line of lines){
    ctx.fillText(line,pad,y);
    y+=lineHeight;
  }

  ctx.fillStyle="#d9d0c2";
  ctx.font=`400 ${Math.round(width*.031)}px Arial, sans-serif`;
  ctx.fillText(subtitle,pad,Math.round(height*.79));

  return canvas;
}

export function configureAlantuPageTexture(texture,{
  renderer,
  linearFilter,
  colorSpace
}){
  texture.colorSpace=colorSpace;
  texture.anisotropy=renderer.capabilities.getMaxAnisotropy();

  // Document text must stay on the full-resolution base level.
  // Mipmaps are great for generic 3D surfaces, but on a slightly tilted
  // PDF page they can select a much softer level and make small type muddy.
  texture.minFilter=linearFilter;
  texture.magFilter=linearFilter;
  texture.generateMipmaps=false;
  texture.needsUpdate=true;
  return texture;
}

export function computeAlantuLeafStackStep(totalLeaves,{
  preferredStep=.018,
  maxSpread=.054
}={}){
  const count=Math.max(1,Number(totalLeaves)||1);
  if(count<=1)return preferredStep;

  // Keep the proven 3-leaf main geometry unchanged, but prevent larger
  // documents from becoming cartoonishly thick just because they contain
  // more leaves. The whole paper stack may spread by at most maxSpread.
  return Math.min(preferredStep,maxSpread/(count-1));
}

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
    getPageHeight=()=>4.80,
    getTotalLeaves,
    rightZ,
    leftZ,
    getCoverSetup=()=>null,
    setStartCoverProgress=()=>{},
    setEndCoverProgress=()=>{},
    prefersReduced=false,
    onStateChange=()=>{},
    nextButton=null,
    prevButton=null,
    nextTap=null,
    prevTap=null,
    ignorePointerSelector=".stage-control,.circle",
    resolveGrabU=()=>null
  } = options;

  let currentLeaf=0;
  let desiredPosition=0; // -1=start closed, 0..N=open leaf states, N+1=end closed
  let closedSide=null;   // null | "start" | "end"
  let activeTurn=null;
  let activeBoundary=null;
  let dragState=null;
  let lastMotionTime=performance.now();
  let suppressTapUntil=0;

  const physics=createAlantuBookPhysics({
    getLeaves,
    getPageWidth,
    getPageHeight,
    getTotalLeaves,
    rightZ,
    leftZ,
    getCoverSetup
  });
  stage.dataset.physics=`box3d-${physics.engineVersion||"active"}`;

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const smoothstep=(a,b,x)=>{
    const t=clamp((x-a)/(b-a),0,1);
    return t*t*(3-2*t);
  };

  function grabUFor({clientX,clientY,type,index=null,side=null,direction=1}){
    const resolved=Number(resolveGrabU({clientX,clientY,type,index,side}));
    if(Number.isFinite(resolved))return clamp(resolved,.04,.99);

    const rect=stage.getBoundingClientRect();
    if(type==="cover"){
      return clamp((clientX-rect.left)/Math.max(1,rect.width),.04,.99);
    }

    const visualHingeX=rect.left+rect.width*.48;
    const visualPageWidth=Math.max(1,rect.width*.42);
    return direction<0
      ? clamp((clientX-visualHingeX)/visualPageWidth,.04,.99)
      : clamp((visualHingeX-clientX)/visualPageWidth,.04,.99);
  }

  function engageLeafGrab(index,progress,clientX,clientY,direction){
    const u=grabUFor({
      clientX,clientY,type:"leaf",index,direction
    });
    dragState.grabU=u;
    physics.ensureBuilt(currentLeaf);
    physics.beginGrab(index,u,progress);
  }

  function engageCoverGrab(side,progress,clientX,clientY){
    const u=grabUFor({
      clientX,clientY,type:"cover",side
    });
    dragState.grabU=u;
    physics.ensureBuilt(currentLeaf);
    physics.beginCoverGrab(side,u,progress);
  }

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

  function deformLeaf(index,progress,{dragging=false}={}){
    physics.ensureBuilt(currentLeaf);
    physics.setLeafTarget(index,clamp(progress,0,1),{dragging});
  }

  function setLeafState(index,flipped){
    deformLeaf(index,flipped?1:0);
  }

  function normalize(){
    physics.ensureBuilt(currentLeaf);
    physics.setAllLeafStates(currentLeaf);
    physics.syncVisuals();
  }

  function setBoundaryVisual(side,progress){
    const p=clamp(progress,0,1);
    physics.ensureBuilt(currentLeaf);
    physics.setCoverTarget(side,p,{
      dragging:!!dragState&&dragState.mode==="boundary"
    });
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

    if(activeBoundary){
      const previous=activeBoundary.progress;
      const physicalTarget=dragState?.mode==="boundary"
        ? activeBoundary.progress
        : activeBoundary.target;

      physics.setCoverTarget(
        activeBoundary.side,
        physicalTarget,
        {dragging:!!dragState}
      );

      if(dragState?.mode==="boundary"){
        physics.updateCoverGrab(
          activeBoundary.side,
          dragState.grabU??.75,
          activeBoundary.progress
        );
      }

      physics.step(dt);
      activeBoundary.progress=physics.getCoverProgress(activeBoundary.side);
      activeBoundary.velocity=
        (activeBoundary.progress-previous)/Math.max(dt,.001);

      const hingeAtTarget=
        Math.abs(activeBoundary.progress-activeBoundary.target)<.008;

      if(!dragState&&hingeAtTarget){
        activeBoundary.settledFrames=
          (activeBoundary.settledFrames||0)+1;
      }else{
        activeBoundary.settledFrames=0;
      }

      if(!dragState&&activeBoundary.settledFrames>=4){
        const finished=activeBoundary;
        finished.progress=finished.target;

        if(finished.target===1)closedSide=finished.side;
        else closedSide=null;

        activeBoundary=null;
        ensureTurn();
      }

      notify();
      return;
    }

    if(activeTurn){
      const previous=activeTurn.progress;
      const physicalTarget=dragState?.mode==="leaf"
        ? activeTurn.progress
        : activeTurn.target;
      physics.setLeafTarget(activeTurn.index,physicalTarget,{dragging:!!dragState});
      if(dragState?.mode==="leaf"){
        physics.updateGrab(activeTurn.index,dragState.grabU??.75,activeTurn.progress);
      }
      physics.step(dt);
      activeTurn.progress=physics.getLeafProgress(activeTurn.index);
      activeTurn.velocity=(activeTurn.progress-previous)/Math.max(dt,.001);

      const hingeAtTarget=Math.abs(activeTurn.progress-activeTurn.target)<.008;

      // Commit navigation from the actual Box3D hinge angle only.
      // Flexible strip contacts may keep tiny residual velocities after the
      // page has physically reached the stack; they must not deadlock paging.
      if(!dragState&&hingeAtTarget){
        activeTurn.settledFrames=(activeTurn.settledFrames||0)+1;
      }else{
        activeTurn.settledFrames=0;
      }

      // Logical page state follows the physical hinge. Internal Box3D strip
      // contacts may continue to damp for a few frames after the page has
      // visibly landed; they must not block navigation to the next leaf.
      if(!dragState&&activeTurn.settledFrames>=4){
        const finished=activeTurn;
        activeTurn.progress=finished.target;

        if(finished.target===1&&finished.index===currentLeaf){
          currentLeaf++;
        }else if(finished.target===0&&finished.index===currentLeaf-1){
          currentLeaf--;
        }

        activeTurn=null;
        ensureTurn();
      }

      notify();
      return;
    }

    physics.step(dt);
  }

  function next(){
    const totalLeaves=getTotalLeaves();
    if(totalLeaves<=0||activeTurn||activeBoundary||dragState)return;
    desiredPosition=Math.min(totalLeaves+1,currentLeaf+1);
    ensureTurn();
    notify();
  }

  function prev(){
    const totalLeaves=getTotalLeaves();
    if(totalLeaves<=0||activeTurn||activeBoundary||dragState)return;
    desiredPosition=Math.max(-1,currentLeaf-1);
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
    stage.classList.remove("is-book-dragging");
    lastMotionTime=performance.now();
    physics.reset(currentLeaf);
    physics.setCoverTarget("start",0);
    physics.setCoverTarget("end",0);
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
      grabU:null,
      moved:false
    };

    // Direct-manipulation feedback: while the user physically holds the
    // draggable book surface, hide the pointer and let the view highlight
    // the rendered book itself.
    stage.classList.add("is-book-dragging");

    if(dragState.mode==="leaf"&&dragState.index!=null){
      engageLeafGrab(
        dragState.index,
        dragState.startProgress,
        e.clientX,e.clientY,
        dragState.startProgress===0?-1:1
      );
    }else if(dragState.mode==="boundary"&&dragState.side){
      engageCoverGrab(
        dragState.side,
        dragState.startProgress,
        e.clientX,e.clientY
      );
    }

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
        engageCoverGrab("start",1,dragState.startX,dragState.startY);
      }else if(closedSide==="end"&&dx>0){
        dragState.mode="boundary";
        dragState.side="end";
        dragState.startProgress=1;
        activeBoundary={side:"end",progress:1,velocity:0,target:1};
        engageCoverGrab("end",1,dragState.startX,dragState.startY);
      }else if(!closedSide&&currentLeaf===0&&dx>0){
        dragState.mode="boundary";
        dragState.side="start";
        dragState.startProgress=0;
        activeBoundary={side:"start",progress:0,velocity:0,target:0};
        engageCoverGrab("start",0,dragState.startX,dragState.startY);
      }else if(!closedSide&&currentLeaf===totalLeaves&&dx<0){
        dragState.mode="boundary";
        dragState.side="end";
        dragState.startProgress=0;
        activeBoundary={side:"end",progress:0,velocity:0,target:0};
        engageCoverGrab("end",0,dragState.startX,dragState.startY);
      }else if(!closedSide){
        const index=dx<0?currentLeaf:currentLeaf-1;
        if(index<0||index>=totalLeaves)return;
        dragState.mode="leaf";
        dragState.index=index;
        dragState.startProgress=dx<0?0:1;
        activeTurn={index,progress:dragState.startProgress,velocity:0,target:dragState.startProgress};
        engageLeafGrab(
          index,
          dragState.startProgress,
          dragState.startX,
          dragState.startY,
          dx<0?-1:1
        );
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
      physics.updateCoverGrab(
        dragState.side,
        dragState.grabU??.75,
        progress
      );
    }else{
      const progress=clamp(dragState.startProgress-dx/distance,0,1);
      const velocity=-deltaX/distance/dt;

      dragState.velocity=velocity;
      activeTurn.progress=progress;
      activeTurn.velocity=velocity;
      deformLeaf(activeTurn.index,progress,{dragging:true});
      physics.updateGrab(activeTurn.index,dragState.grabU??.75,progress);
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

    if(dragState.mode==="leaf"||dragState.mode==="boundary")physics.endGrab();
    if(dragState.moved)suppressTapUntil=performance.now()+260;
    dragState=null;
    stage.classList.remove("is-book-dragging");
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
    state,
    physics,
    physicsEngine:"Box3D"
  };
}
