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
  width=1800,
  height=2400
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
  mipmapFilter=null,
  colorSpace,
  generateMipmaps=!!mipmapFilter
}){
  // PDF/canvas artwork is display-referred color data. Mark it explicitly as
  // sRGB and let the renderer convert it once to the sRGB output framebuffer.
  texture.colorSpace=colorSpace;

  // Oblique document pages are a classic anisotropic minification case.
  // Use the GPU maximum: this is precisely what reduces blur along the
  // compressed texture axis when the page is tilted in 3D.
  texture.anisotropy=Math.max(1,renderer.capabilities.getMaxAnisotropy());

  texture.magFilter=linearFilter;
  texture.minFilter=mipmapFilter||linearFilter;
  texture.generateMipmaps=!!generateMipmaps;
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
  let settlingTurns=[];
  let activeBoundary=null;
  let dragState=null;
  let lastMotionTime=performance.now();
  let suppressTapUntil=0;

  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const smoothstep=(a,b,x)=>{
    const t=clamp((x-a)/(b-a),0,1);
    return t*t*(3-2*t);
  };
  const fract=v=>v-Math.floor(v);
  const smoothMax=(a,b,k=.003)=>{
    const m=Math.max(a,b);
    return m+Math.log1p(Math.exp(-Math.abs(a-b)/k))*k;
  };
  function paperCharacter(index){
    const a=fract(Math.sin((index+1)*12.9898)*43758.5453);
    const b=fract(Math.sin((index+1)*78.233)*24634.6345);
    return {
      rigidity:.96+a*.08,
      response:.95+b*.10
    };
  }

  function state(){
    const totalLeaves=getTotalLeaves();
    return {
      currentLeaf,
      desiredLeaf:clamp(desiredPosition,0,totalLeaves),
      desiredPosition,
      closedSide,
      activeTurn:activeTurn?{...activeTurn}:null,
      activeTurns:[
        ...(activeTurn?[{...activeTurn}]:[]),
        ...settlingTurns.map(turn=>({...turn}))
      ],
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

  function deformLeaf(index,progress,velocity=0){
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
    const v=clamp(velocity,-3.2,3.2);
    const endpoint=p<=.00001?0:p>=.99999?1:null;

    // Resting sheets are immutable. Avoid rebuilding all 62 vertices and
    // normals every time another sheet begins/finishes a turn.
    if(endpoint!==null&&pivot.userData.staticProgress===endpoint)return;
    if(endpoint===null)pivot.userData.staticProgress=null;

    const paper=paperCharacter(index);

    // Same hard physical bounds for every sheet:
    // fixed segment lengths, fixed spine, angle in [0, PI].
    // Only the response inside those bounds varies slightly per sheet.
    const theta=Math.PI*p;
    const arch=Math.sin(Math.PI*p);
    const passiveLag=clamp(.32/paper.rigidity,.29,.35)*arch;
    const edgeLead=clamp(.045*v*paper.response,-.13,.13)*arch;
    const spineBlend=smoothstep(.18,.86,p);
    const spineZ=rightZ(index)+(leftZ(index)-rightZ(index))*spineBlend;

    // Reuse the small curve buffers; avoiding per-frame allocations keeps
    // Safari/WebKit's GC out of the animation hot path.
    const curveX=pivot.userData.curveX||(pivot.userData.curveX=new Float32Array(segments+1));
    const curveZ=pivot.userData.curveZ||(pivot.userData.curveZ=new Float32Array(segments+1));
    curveX[0]=0;
    curveZ[0]=spineZ;

    for(let j=1;j<=segments;j++){
      const u=(j-.5)/segments;
      const bound=smoothstep(.05,.23,u);
      const middle=Math.sin(Math.PI*u)*bound;
      const freeEdge=smoothstep(.52,.98,u);

      const localAngle=clamp(
        theta-passiveLag*middle+edgeLead*freeEdge,
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
      const f=u*segments;
      const seg=Math.min(segments-1,Math.floor(f));
      const t=(seg===segments-1&&f===segments)?1:f-seg;

      let x=curveX[seg]+(curveX[seg+1]-curveX[seg])*t;
      let z=curveZ[seg]+(curveZ[seg+1]-curveZ[seg])*t;

      // Smooth contact-inspired floor instead of a hard max kink.
      if(x<0){
        const landing=smoothstep(.70,.985,p);
        const floor=leftStackTop+safety*(1-landing);
        z=smoothMax(z,floor,.0025);
      }else{
        const leaving=smoothstep(.015,.30,p);
        const floor=rightStackTop-safety*leaving;
        z=smoothMax(z,floor,.0025);
      }

      pos.array[i*3]=x;
      pos.array[i*3+1]=by;
      pos.array[i*3+2]=z;
    }

    pos.needsUpdate=true;

    // Keep the active sheet visually identical to the proven turn model:
    // normals follow every display frame. Static resting sheets are still
    // skipped above, so this does not impose an FPS cap.
    geometry.computeVertexNormals();

    if(endpoint!==null)pivot.userData.staticProgress=endpoint;
    pivot.rotation.set(0,0,0);
    pivot.position.set(-PAGE_W/2,0,0);
  }

  function setLeafState(index,flipped){
    deformLeaf(index,flipped?1:0);
  }

  function isTurnMoving(index){
    return activeTurn?.index===index||
      settlingTurns.some(turn=>turn.index===index);
  }

  function normalizeInactive(){
    const totalLeaves=getTotalLeaves();
    for(let i=0;i<totalLeaves;i++){
      if(!isTurnMoving(i))setLeafState(i,i<currentLeaf);
    }
  }

  function normalize(){
    settlingTurns=[];
    const totalLeaves=getTotalLeaves();
    for(let i=0;i<totalLeaves;i++)setLeafState(i,i<currentLeaf);
  }

  function takeSettlingTurn(index){
    const i=settlingTurns.findIndex(turn=>turn.index===index);
    if(i<0)return null;
    return settlingTurns.splice(i,1)[0];
  }

  function settleTurn(turn){
    const i=settlingTurns.findIndex(item=>item.index===turn.index);
    if(i>=0)settlingTurns.splice(i,1);
    settlingTurns.push(turn);
  }

  function autoTurn(direction){
    const totalLeaves=getTotalLeaves();

    if(direction>0){
      if(currentLeaf>=totalLeaves)return false;
      const index=currentLeaf;
      const turn=takeSettlingTurn(index)||{
        index,
        progress:0,
        velocity:0,
        target:1
      };
      turn.target=1;
      turn.velocity=Math.max(turn.velocity,.34);
      currentLeaf=index+1;
      desiredPosition=currentLeaf;
      settleTurn(turn);
      normalizeInactive();
      return true;
    }

    if(currentLeaf<=0)return false;
    const index=currentLeaf-1;
    const turn=takeSettlingTurn(index)||{
      index,
      progress:1,
      velocity:0,
      target:0
    };
    turn.target=0;
    turn.velocity=Math.min(turn.velocity,-.34);
    currentLeaf=index;
    desiredPosition=currentLeaf;
    settleTurn(turn);
    normalizeInactive();
    return true;
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
    if(totalLeaves<=0)return;

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

    if(dragState)return;

    if(desiredPosition<0&&currentLeaf===0){
      beginBoundary("start",1,0);
    }else if(desiredPosition>totalLeaves&&currentLeaf===totalLeaves){
      beginBoundary("end",1,0);
    }else if(desiredPosition>currentLeaf){
      autoTurn(1);
    }else if(desiredPosition<currentLeaf){
      autoTurn(-1);
    }

    notify();
  }

  function springStep(item,dt){
    const stiffness=prefersReduced?1100:220;
    const damping=prefersReduced?90:29;
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
    return Math.abs(item.target-item.progress)<.0012&&Math.abs(item.velocity)<.035;
  }

  function pushSwipeSample(x,t){
    if(!dragState)return;
    dragState.samples.push({x,t});
    const cutoff=t-110;
    while(dragState.samples.length>2&&dragState.samples[0].t<cutoff){
      dragState.samples.shift();
    }
  }

  function recentSwipeVelocity(progressDirection){
    const samples=dragState?.samples||[];
    if(samples.length<2)return dragState?.velocity||0;

    const last=samples[samples.length-1];
    let first=samples[0];
    for(let i=samples.length-2;i>=0;i--){
      if(last.t-samples[i].t>=45){
        first=samples[i];
        break;
      }
    }

    const dt=Math.max(.016,(last.t-first.t)/1000);
    const distance=Math.max(160,stage.clientWidth*.56);
    return progressDirection*(last.x-first.x)/distance/dt;
  }

  function releaseTarget(progress,startProgress,velocity,cancelled){
    if(cancelled)return startProgress>=.5?1:0;

    const displacement=progress-startProgress;
    const decisiveFlick=Math.abs(velocity)>=.55&&
      (Math.abs(displacement)<.025||Math.sign(velocity)===Math.sign(displacement));

    if(decisiveFlick)return velocity>0?1:0;

    const projected=clamp(progress+velocity*.16,0,1);
    return startProgress<.5
      ? (projected>=.30?1:0)
      : (projected<=.70?0:1);
  }

  function step(now){
    const dt=Math.max(.001,Math.min(.033,(now-lastMotionTime)/1000));
    lastMotionTime=now;

    ensureTurn();

    const draggingBoundary=dragState?.mode==="boundary";
    if(activeBoundary&&!draggingBoundary){
      springStep(activeBoundary,dt);
      setBoundaryVisual(activeBoundary.side,activeBoundary.progress);

      if(settled(activeBoundary)){
        const finished=activeBoundary;
        finished.progress=finished.target;
        setBoundaryVisual(finished.side,finished.target);

        if(finished.target===1)closedSide=finished.side;
        else closedSide=null;

        activeBoundary=null;
      }
    }

    const done=[];
    for(const turn of settlingTurns){
      springStep(turn,dt);
      deformLeaf(turn.index,turn.progress,turn.velocity);

      if(settled(turn)){
        turn.progress=turn.target;
        deformLeaf(turn.index,turn.target,0);
        done.push(turn.index);
      }
    }

    if(done.length){
      settlingTurns=settlingTurns.filter(turn=>!done.includes(turn.index));
      normalizeInactive();
    }

    // A directly-held page is rendered by pointerMove and must never be
    // advanced by the spring while the user owns it.
    if(activeTurn&&dragState?.mode!=="leaf"){
      springStep(activeTurn,dt);
      deformLeaf(activeTurn.index,activeTurn.progress,activeTurn.velocity);
    }

    ensureTurn();

    if(
      activeBoundary||
      settlingTurns.length||
      activeTurn||
      dragState||
      desiredPosition!==currentLeaf
    ){
      notify();
    }
  }

  function next(){
    const totalLeaves=getTotalLeaves();
    if(totalLeaves<=0)return;

    if(closedSide==="start"||activeBoundary?.side==="start"){
      desiredPosition=0;
      ensureTurn();
    }else if(currentLeaf<totalLeaves){
      autoTurn(1);
    }else{
      desiredPosition=totalLeaves+1;
      ensureTurn();
    }

    notify();
  }

  function prev(){
    const totalLeaves=getTotalLeaves();
    if(totalLeaves<=0)return;

    if(closedSide==="end"||activeBoundary?.side==="end"){
      desiredPosition=totalLeaves;
      ensureTurn();
    }else if(currentLeaf>0){
      autoTurn(-1);
    }else{
      desiredPosition=-1;
      ensureTurn();
    }

    notify();
  }

  function reset(leaf=0){
    const totalLeaves=getTotalLeaves();
    currentLeaf=clamp(leaf,0,totalLeaves);
    desiredPosition=currentLeaf;
    closedSide=null;
    activeTurn=null;
    settlingTurns=[];
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
    if(e.pointerType==="mouse"&&e.button!==0)return;
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
      mode:activeBoundary?"boundary":null,
      side:activeBoundary?.side??null,
      index:null,
      startProgress:activeBoundary?.progress??null,
      velocity:activeBoundary?.velocity??0,
      samples:[{x:e.clientX,t:now}],
      moved:false
    };

    // Direct-manipulation feedback: while the user physically holds the
    // draggable book surface, hide the pointer and let the view highlight
    // the rendered book itself.
    stage.classList.add("is-book-dragging");

    if(stage.setPointerCapture)stage.setPointerCapture(e.pointerId);
  }

  function pointerMove(e){
    if(!dragState||dragState.id!==e.pointerId)return;

    const totalLeaves=getTotalLeaves();
    const dx=e.clientX-dragState.startX;
    const dy=e.clientY-dragState.startY;

    if(dragState.mode===null){
      if(Math.abs(dx)<.8)return;
      if(Math.abs(dy)>4&&Math.abs(dx)<Math.abs(dy)*.38)return;

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

        activeTurn=takeSettlingTurn(index)||{
          index,
          progress:dx<0?0:1,
          velocity:0,
          target:dx<0?0:1
        };

        // User immediately owns the sheet at its current visual position.
        activeTurn.target=activeTurn.progress;
        activeTurn.velocity=0;
        dragState.mode="leaf";
        dragState.index=index;
        dragState.startProgress=activeTurn.progress;
      }else{
        return;
      }
    }

    const distance=Math.max(160,stage.clientWidth*.56);
    const now=performance.now();
    const dt=Math.max(.008,(now-dragState.lastTime)/1000);
    const deltaX=e.clientX-dragState.lastX;
    pushSwipeSample(e.clientX,now);

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
      deformLeaf(activeTurn.index,progress,velocity);
    }

    dragState.lastX=e.clientX;
    dragState.lastTime=now;
    dragState.moved=dragState.moved||Math.abs(dx)>2;
    notify();

    if(dragState.moved)e.preventDefault();
  }

  function releaseDrag(cancelled=false){
    if(!dragState)return;

    const totalLeaves=getTotalLeaves();

    if(dragState.mode==="boundary"&&activeBoundary){
      const direction=activeBoundary.side==="start"?1:-1;
      const velocity=cancelled?0:recentSwipeVelocity(direction);
      const target=releaseTarget(
        activeBoundary.progress,
        dragState.startProgress,
        velocity,
        cancelled
      );
      activeBoundary.target=target;
      activeBoundary.velocity=cancelled?0:clamp(velocity,-3.5,3.5);

      if(activeBoundary.side==="start"){
        desiredPosition=target===1?-1:0;
      }else{
        desiredPosition=target===1?totalLeaves+1:totalLeaves;
      }

      if(target===0)closedSide=null;
    }else if(dragState.mode==="leaf"&&activeTurn){
      const velocity=cancelled?0:recentSwipeVelocity(-1);
      const target=releaseTarget(
        activeTurn.progress,
        dragState.startProgress,
        velocity,
        cancelled
      );

      activeTurn.target=target;
      activeTurn.velocity=cancelled?0:clamp(velocity,-3.5,3.5);

      // Commit the logical page immediately. The same sheet can continue
      // settling visually while the next page is already draggable.
      if(target===1&&currentLeaf===activeTurn.index){
        currentLeaf=activeTurn.index+1;
      }else if(target===0&&currentLeaf===activeTurn.index+1){
        currentLeaf=activeTurn.index;
      }

      desiredPosition=currentLeaf;
      settleTurn(activeTurn);
      activeTurn=null;
      normalizeInactive();
    }

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

  stage.addEventListener("contextmenu",e=>e.preventDefault());
  stage.addEventListener("pointerdown",pointerDown);
  stage.addEventListener("pointermove",pointerMove);
  stage.addEventListener("pointerup",pointerUp);
  stage.addEventListener("pointercancel",pointerCancel);

  if(prevButton)prevButton.addEventListener("click",prev);
  if(nextButton)nextButton.addEventListener("click",next);
  if(prevTap)prevTap.addEventListener("click",()=>{if(performance.now()>=suppressTapUntil)prev()});
  if(nextTap)nextTap.addEventListener("click",()=>{if(performance.now()>=suppressTapUntil)next()});

  notify();

  function cancelDrag(){
    if(dragState)releaseDrag(true);
  }

  return {
    next,
    prev,
    step,
    reset,
    normalize,
    deformLeaf,
    shownLeaf,
    state,
    cancelDrag
  };
}
