import Box3DFactory from "https://cdn.jsdelivr.net/npm/box3d-wasm@0.2.0/dist/box3d.mjs";

export const ALANTU_BOX3D_VERSION="0.2.0";
export const ALANTU_BOX3D_RUNTIME="028";
const b3=await Box3DFactory();

const PI=Math.PI;
const OPEN_ANGLE=PI*.985;
const AXIS_Y_QUAT={x:-Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2};

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const smoothstep=(a,b,x)=>{
  const t=clamp((x-a)/(b-a),0,1);
  return t*t*(3-2*t);
};
const quatY=a=>({x:0,y:Math.sin(a/2),z:0,w:Math.cos(a/2)});
const IDENTITY_Q={x:0,y:0,z:0,w:1};
const yawFromQuat=q=>Math.atan2(
  2*((q.w||0)*(q.y||0)+(q.x||0)*(q.z||0)),
  1-2*((q.y||0)*(q.y||0)+(q.z||0)*(q.z||0))
);

const CAT_PAGE=0x0001;
const CAT_COVER=0x0002;
const CAT_SPINE=0x0004;
const MASK_PAGE_AND_COVER=CAT_PAGE|CAT_COVER|CAT_SPINE;

function rotateVec(q,v){
  const x=v.x,y=v.y,z=v.z;
  const qx=q.x,qy=q.y,qz=q.z,qw=q.w;
  const ix= qw*x + qy*z - qz*y;
  const iy= qw*y + qz*x - qx*z;
  const iz= qw*z + qx*y - qy*x;
  const iw=-qx*x - qy*y - qz*z;
  return {
    x:ix*qw + iw*-qx + iy*-qz - iz*-qy,
    y:iy*qw + iw*-qy + iz*-qx - ix*-qz,
    z:iz*qw + iw*-qz + ix*-qy - iy*-qx
  };
}

function length3(v){
  return Math.hypot(v.x||0,v.y||0,v.z||0);
}

function disposeHandle(h){
  try{h?.delete?.()}catch{}
}

export function createAlantuBookPhysics({
  getLeaves,
  getPageWidth,
  getPageHeight=()=>4.80,
  getTotalLeaves,
  rightZ,
  leftZ,
  getCoverSetup,
  segments=20
}){
  let world=null;
  let leafModels=[];
  let coverBodies=null;
  let spineBody=null;
  let grab=null;
  let builtKey="";
  let lastStep=1/60;
  let accumulator=0;
  const FIXED_DT=1/60;
  const SUBSTEPS=8;

  function destroyWorld(){
    if(!world)return;
    endGrab();
    for(const leaf of leafModels){
      for(const j of leaf.joints)disposeHandle(j);
      for(const body of leaf.bodies)disposeHandle(body);
      disposeHandle(leaf.anchor);
    }
    leafModels=[];
    if(coverBodies){
      for(const model of [coverBodies.front,coverBodies.back]){
        for(const j of model.joints)disposeHandle(j);
        for(const body of model.bodies)disposeHandle(body);
        disposeHandle(model.anchor);
      }
      coverBodies=null;
    }
    disposeHandle(spineBody);
    spineBody=null;
    accumulator=0;
    try{world.destroy()}catch{}
    disposeHandle(world);
    world=null;
    builtKey="";
  }

  function createBox(body,opts){
    const shape=body.createBox(opts);
    disposeHandle(shape);
  }

  function localFrame(position){
    return {position,rotation:AXIS_Y_QUAT};
  }

  function sheetTransform(index,seg,flipped,W,H,sw){
    const angle=flipped?-OPEN_ANGLE:0;
    const hinge=-W/2;
    const distance=(seg+.5)*sw;
    const q=quatY(angle);
    const local={x:distance,y:0,z:0};
    const r=rotateVec(q,local);
    return {
      position:{
        x:hinge+r.x,
        y:r.y,
        z:(flipped?leftZ(index):rightZ(index))+r.z
      },
      rotation:q
    };
  }

  function createPhysicalSheet({
    name,
    width,
    height,
    thickness,
    segmentCount,
    hingeX,
    hingeZ,
    initialAngle,
    density,
    friction,
    linearDamping,
    angularDamping,
    gravityScale,
    rootHertz,
    rootTorque,
    bendHertz,
    bendLimit,
    categoryBits,
    maskBits,
    groupIndex
  }){
    const count=Math.max(2,segmentCount|0);
    const sw=width/count;
    const bodies=[];
    const joints=[];

    const anchor=world.createBody({
      type:"kinematic",
      position:{x:hingeX,y:0,z:hingeZ},
      rotation:IDENTITY_Q,
      enableSleep:false,
      name:`${name}-binding`
    });

    const q=quatY(initialAngle);
    for(let s=0;s<count;s++){
      const r=rotateVec(q,{x:(s+.5)*sw,y:0,z:0});
      const body=world.createBody({
        type:"dynamic",
        position:{x:hingeX+r.x,y:r.y,z:hingeZ+r.z},
        rotation:q,
        linearDamping,
        angularDamping,
        gravityScale,
        enableSleep:true,
        isAwake:true,
        allowFastRotation:false,
        name:`${name}-strip-${s}`
      });
      createBox(body,{
        halfExtents:{x:sw*.5,y:height*.5,z:thickness*.5},
        density,
        friction,
        restitution:0,
        enableContactEvents:false,
        filter:{
          categoryBits,
          maskBits,
          groupIndex
        }
      });
      bodies.push(body);
    }

    const rootJoint=world.createRevoluteJoint(anchor,bodies[0],{
      localFrameA:localFrame({x:0,y:0,z:0}),
      localFrameB:localFrame({x:-sw/2,y:0,z:0}),
      collideConnected:false,
      enableSpring:true,
      hertz:rootHertz,
      dampingRatio:1,
      targetAngle:initialAngle,
      enableLimit:true,
      lowerAngle:-PI*.995,
      upperAngle:.035,
      enableMotor:true,
      motorSpeed:0,
      maxMotorTorque:rootTorque
    });
    joints.push(rootJoint);

    for(let s=1;s<count;s++){
      const joint=world.createRevoluteJoint(bodies[s-1],bodies[s],{
        localFrameA:localFrame({x:sw/2,y:0,z:0}),
        localFrameB:localFrame({x:-sw/2,y:0,z:0}),
        collideConnected:false,
        enableSpring:true,
        hertz:bendHertz,
        dampingRatio:1,
        targetAngle:0,
        enableLimit:true,
        lowerAngle:-bendLimit,
        upperAngle:bendLimit
      });
      joints.push(joint);
    }

    return {
      name,
      width,
      height,
      thickness,
      segmentCount:count,
      sw,
      anchor,
      bodies,
      joints,
      rootJoint,
      rootHertz,
      rootTorque,
      bendHertz,
      bendLimit
    };
  }

  function createLeaf(index,flipped){
    const W=getPageWidth();
    const H=getPageHeight();
    const stackStep=Math.max(.003,Math.abs(rightZ(0)-rightZ(Math.min(1,getTotalLeaves()-1)))||.006);
    const thickness=clamp(stackStep*.55,.0025,.0065);
    const initialAngle=flipped?-OPEN_ANGLE:0;

    const model=createPhysicalSheet({
      name:`leaf-${index}`,
      width:W,
      height:H,
      thickness,
      segmentCount:segments,
      hingeX:-W/2,
      hingeZ:flipped?leftZ(index):rightZ(index),
      initialAngle,
      density:.082,
      friction:.22,
      linearDamping:2.0,
      angularDamping:4.2,
      gravityScale:1,
      rootHertz:13,
      rootTorque:140,
      bendHertz:26,
      bendLimit:.10,
      categoryBits:CAT_PAGE,
      maskBits:MASK_PAGE_AND_COVER,
      groupIndex:-(index+1)
    });

    return {
      ...model,
      index,
      target:flipped?1:0,
      commanded:flipped?1:0
    };
  }

  function buildCoverBodies(){
    const cover=getCoverSetup?.();
    if(!cover?.frontPivot||!cover?.endPivot||!cover?.frontCover||!cover?.backCover)return;

    const {
      coverWidth,coverHeight,coverThickness,hingeX,
      startOpenZ,startClosedZ,endOpenZ,endClosedZ
    }=cover;

    const coverSegments=10;
    const frontProgress=0;
    const backProgress=0;
    const frontZ=startOpenZ ?? cover.frontPivot.position.z ?? 0;
    const backZ=endOpenZ ?? cover.endPivot.position.z ?? 0;

    // Same physical sheet primitive as paper, but a real hardcover profile:
    // thick, heavy, extremely high bending stiffness and tiny flex limits.
    const front=createPhysicalSheet({
      name:"front-cover",
      width:coverWidth,
      height:coverHeight,
      thickness:coverThickness,
      segmentCount:coverSegments,
      hingeX,
      hingeZ:frontZ,
      initialAngle:-PI,
      density:1.9,
      friction:.82,
      linearDamping:2.8,
      angularDamping:5.2,
      gravityScale:.15,
      rootHertz:16,
      rootTorque:300,
      bendHertz:62,
      bendLimit:.012,
      categoryBits:CAT_COVER,
      maskBits:CAT_PAGE|CAT_SPINE,
      groupIndex:-1001
    });

    const back=createPhysicalSheet({
      name:"back-cover",
      width:coverWidth,
      height:coverHeight,
      thickness:coverThickness,
      segmentCount:coverSegments,
      hingeX,
      hingeZ:backZ,
      initialAngle:0,
      density:1.9,
      friction:.82,
      linearDamping:2.8,
      angularDamping:5.2,
      gravityScale:.15,
      rootHertz:16,
      rootTorque:300,
      bendHertz:62,
      bendLimit:.012,
      categoryBits:CAT_COVER,
      maskBits:CAT_PAGE|CAT_SPINE,
      groupIndex:-1002
    });

    coverBodies={
      front,
      back,
      frontProgress,
      backProgress,
      startOpenZ:frontZ,
      startClosedZ:startClosedZ ?? frontZ,
      endOpenZ:backZ,
      endClosedZ:endClosedZ ?? backZ,
      coverWidth
    };

    const spineGeom=cover.spine?.geometry?.parameters;
    const spineScale=cover.spine?.scale;
    const spineWidth=(spineGeom?.width||.12)*(spineScale?.x||1);
    const spineHeight=(spineGeom?.height||coverHeight)*(spineScale?.y||1);
    const spineDepth=(spineGeom?.depth||coverThickness*2)*(spineScale?.z||1);
    const spinePos=cover.spine?.position||{x:hingeX-.06,y:0,z:(frontZ+backZ)/2};

    spineBody=world.createBody({
      type:"static",
      position:{x:spinePos.x,y:spinePos.y,z:spinePos.z},
      rotation:IDENTITY_Q,
      name:"hardcover-spine"
    });
    createBox(spineBody,{
      halfExtents:{x:spineWidth/2,y:spineHeight/2,z:spineDepth/2},
      friction:.82,
      restitution:0,
      filter:{categoryBits:CAT_SPINE,maskBits:CAT_PAGE|CAT_COVER}
    });
  }

  function driveRevolute(joint,targetAngle,{
    dragging=false,
    rootHertz=13,
    rootTorque=140,
    cover=false
  }={}){
    let angle=0;
    try{angle=joint.getAngle()}catch{}
    const error=targetAngle-angle;

    joint.enableSpring(true);
    joint.setSpringHertz(dragging
      ? (cover?24:20)
      : rootHertz
    );
    joint.setSpringDampingRatio(1);
    joint.setTargetAngle(targetAngle);
    joint.enableMotor(true);
    joint.setMaxMotorTorque(dragging
      ? (cover?420:190)
      : rootTorque
    );
    joint.setMotorSpeed(Math.abs(error)<.006
      ? 0
      : clamp(error*(cover?13:15),-20,20)
    );
  }

  function setCoverTarget(side,progress,{dragging=false}={}){
    if(!coverBodies)return;
    const p=clamp(progress,0,1);
    const model=side==="start"?coverBodies.front:coverBodies.back;
    const targetAngle=side==="start"
      ? -PI*(1-p)
      : -PI*p;

    if(side==="start")coverBodies.frontProgress=p;
    else coverBodies.backProgress=p;

    driveRevolute(model.rootJoint,targetAngle,{
      dragging,
      cover:true,
      rootHertz:model.rootHertz,
      rootTorque:model.rootTorque
    });
    for(const body of model.bodies)body.setAwake(true);
  }

  function syncCoverAnchors(dt){
    if(!coverBodies)return;
    const cover=getCoverSetup?.();
    if(!cover)return;

    const fp=coverBodies.frontProgress;
    const bp=coverBodies.backProgress;
    const frontZ=lerp(coverBodies.startOpenZ,coverBodies.startClosedZ,smoothstep(0,1,fp));
    const backZ=lerp(coverBodies.endOpenZ,coverBodies.endClosedZ,smoothstep(0,1,bp));

    coverBodies.front.anchor.setTargetTransform({
      position:{x:cover.hingeX,y:0,z:frontZ},
      rotation:IDENTITY_Q
    },dt,true);
    coverBodies.back.anchor.setTargetTransform({
      position:{x:cover.hingeX,y:0,z:backZ},
      rotation:IDENTITY_Q
    },dt,true);
  }

  function syncCoverVisuals(){
    if(!coverBodies)return;
    const cover=getCoverSetup?.();
    if(!cover)return;

    for(const [model,pivot] of [
      [coverBodies.front,cover.frontPivot],
      [coverBodies.back,cover.endPivot]
    ]){
      const pos=model.anchor.getPosition();
      let angle=0;
      try{angle=model.rootJoint.getAngle()}catch{}
      pivot.position.set(pos.x,pos.y,pos.z);
      pivot.rotation.set(0,angle,0);
    }

    if(cover.spine&&spineBody){
      const pos=spineBody.getPosition();
      const q=spineBody.getRotation();
      cover.spine.position.set(pos.x,pos.y,pos.z);
      cover.spine.quaternion.set(q.x,q.y,q.z,q.w);
    }
  }

  function rebuild(flippedCount=0){
    destroyWorld();

    const count=getTotalLeaves();
    if(count<=0)return;

    const W=getPageWidth();
    const H=getPageHeight();
    builtKey=`${count}:${W.toFixed(4)}:${H.toFixed(4)}`;

    world=new b3.World({
      gravity:{x:0,y:0,z:-1.35},
      enableSleep:true,
      enableContinuous:true,
      contactHertz:90,
      contactDampingRatio:1
    });

    buildCoverBodies();

    for(let i=0;i<count;i++){
      leafModels.push(createLeaf(i,i<flippedCount));
    }

    // Seed every physical binding before the first rendered frame.
    syncLeafAnchors(FIXED_DT);
    syncCoverAnchors(FIXED_DT);
    for(let i=0;i<8;i++)world.step(1/120,SUBSTEPS);
    syncVisuals();
    syncCoverVisuals();
  }

  function ensureBuilt(flippedCount=0){
    const count=getTotalLeaves();
    const W=getPageWidth();
    const H=getPageHeight();
    const key=count>0?`${count}:${W.toFixed(4)}:${H.toFixed(4)}`:"";
    if(key!==builtKey)rebuild(flippedCount);
  }

  function setLeafTarget(index,progress,{dragging=false}={}){
    const leaf=leafModels[index];
    if(!leaf)return;
    const p=clamp(progress,0,1);
    leaf.commanded=p;
    leaf.target=p;
    const joint=leaf.rootJoint;
    const targetAngle=-OPEN_ANGLE*p;
    let angle=0;
    try{angle=joint.getAngle()}catch{}
    const error=targetAngle-angle;

    driveRevolute(joint,targetAngle,{
      dragging,
      cover:false,
      rootHertz:leaf.rootHertz,
      rootTorque:leaf.rootTorque
    });

    for(const body of leaf.bodies)body.setAwake(true);
  }

  function idealPointOnLeaf(index,u,progress){
    const W=getPageWidth();
    const p=clamp(progress,0,1);
    const angle=-OPEN_ANGLE*p;
    const z=lerp(rightZ(index),leftZ(index),smoothstep(.20,.92,p));
    const r=rotateVec(quatY(angle),{x:clamp(u,0,1)*W,y:0,z:0});
    return {x:-W/2+r.x,y:0,z:z+r.z};
  }

  function idealPointOnCover(side,u,progress){
    const cover=getCoverSetup?.();
    if(!coverBodies||!cover)return {x:0,y:0,z:0};
    const p=clamp(progress,0,1);
    const angle=side==="start"?-PI*(1-p):-PI*p;
    const z=side==="start"
      ? lerp(coverBodies.startOpenZ,coverBodies.startClosedZ,smoothstep(0,1,p))
      : lerp(coverBodies.endOpenZ,coverBodies.endClosedZ,smoothstep(0,1,p));
    const r=rotateVec(quatY(angle),{x:clamp(u,0,1)*cover.coverWidth,y:0,z:0});
    return {x:cover.hingeX+r.x,y:0,z:z+r.z};
  }

  function beginModelGrab(model,u,targetPoint,maxForce){
    endGrab();
    if(!model)return;

    const clampedU=clamp(u,.04,.99);
    const seg=clamp(Math.floor(clampedU*model.segmentCount),0,model.segmentCount-1);
    const body=model.bodies[seg];
    const localX=clampedU*model.width-(seg+.5)*model.sw;
    const actualPoint=body.getWorldPoint({x:localX,y:0,z:0});

    const driver=world.createBody({
      type:"kinematic",
      position:actualPoint,
      rotation:IDENTITY_Q,
      enableSleep:false,
      name:"sheet-grab-driver"
    });

    const joint=world.createMotorJoint(driver,body,{
      localFrameA:{position:{x:0,y:0,z:0},rotation:IDENTITY_Q},
      localFrameB:{position:{x:localX,y:0,z:0},rotation:IDENTITY_Q},
      collideConnected:false,
      linearVelocity:{x:0,y:0,z:0},
      maxVelocityForce:maxForce,
      angularVelocity:{x:0,y:0,z:0},
      maxVelocityTorque:0,
      linearHertz:28,
      linearDampingRatio:1,
      maxSpringForce:maxForce*1.6,
      angularHertz:0,
      angularDampingRatio:1,
      maxSpringTorque:0
    });

    grab={model,u:clampedU,driver,joint,targetPoint,maxForce};
    body.setAwake(true);
  }

  function moveGrab(target){
    if(!grab)return;
    grab.driver.setTargetTransform({
      position:target,
      rotation:IDENTITY_Q
    },FIXED_DT,true);
  }

  function beginGrab(index,u,progress){
    const leaf=leafModels[index];
    beginModelGrab(
      leaf,
      u,
      idealPointOnLeaf(index,u,progress),
      760
    );
  }

  function updateGrab(index,u,progress){
    if(!grab||grab.model!==leafModels[index]){
      beginGrab(index,u,progress);
    }
    moveGrab(idealPointOnLeaf(index,grab?.u??u,progress));
  }

  function beginCoverGrab(side,u,progress){
    if(!coverBodies)return;
    const model=side==="start"?coverBodies.front:coverBodies.back;
    beginModelGrab(
      model,
      u,
      idealPointOnCover(side,u,progress),
      1250
    );
  }

  function updateCoverGrab(side,u,progress){
    if(!coverBodies)return;
    const model=side==="start"?coverBodies.front:coverBodies.back;
    if(!grab||grab.model!==model){
      beginCoverGrab(side,u,progress);
    }
    moveGrab(idealPointOnCover(side,grab?.u??u,progress));
  }

  function endGrab(){
    if(!grab)return;
    disposeHandle(grab.joint);
    disposeHandle(grab.driver);
    grab=null;
  }

  function getLeafProgress(index){
    const leaf=leafModels[index];
    if(!leaf)return 0;
    let angle=0;
    try{angle=leaf.rootJoint.getAngle()}catch{}
    return clamp(-angle/OPEN_ANGLE,0,1);
  }

  function isLeafSettled(index,target){
    const leaf=leafModels[index];
    if(!leaf)return true;

    const p=getLeafProgress(index);

    // The logical page turn is complete when the physical hinge reaches its
    // landing angle. The flexible strip chain may still dissipate tiny
    // residual motion afterwards; Box3D keeps simulating that naturally.
    // Waiting for every paper segment to become nearly motionless can deadlock
    // the book state on invisible contact jitter.
    return Math.abs(p-target)<.012;
  }

  function edgePoint(body,localX){
    const p=body.getPosition();
    const q=body.getRotation();
    const r=rotateVec(q,{x:localX,y:0,z:0});
    return {x:p.x+r.x,y:p.y+r.y,z:p.z+r.z};
  }

  function syncLeafVisual(index){
    const leaf=leafModels[index];
    const pivot=getLeaves()[index];
    if(!leaf||!pivot?.userData?.geometry)return;

    const geometry=pivot.userData.geometry;
    const pos=geometry.attributes.position;
    const base=geometry.userData.basePosition;
    const W=getPageWidth();
    const sw=leaf.sw;

    const edges=new Array(segments+1);
    edges[0]=edgePoint(leaf.bodies[0],-sw/2);
    for(let s=1;s<segments;s++){
      const a=edgePoint(leaf.bodies[s-1],sw/2);
      const b=edgePoint(leaf.bodies[s],-sw/2);
      edges[s]={x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2};
    }
    edges[segments]=edgePoint(leaf.bodies[segments-1],sw/2);

    for(let i=0;i<pos.count;i++){
      const bx=base[i*3];
      const by=base[i*3+1];
      const col=clamp(Math.round((bx/W)*segments),0,segments);
      const edge=edges[col];
      pos.array[i*3]=edge.x;
      pos.array[i*3+1]=by+edge.y;
      pos.array[i*3+2]=edge.z;
    }
    pos.needsUpdate=true;
    geometry.computeVertexNormals();
    pivot.position.set(0,0,0);
    pivot.rotation.set(0,0,0);
  }

  function syncVisuals(){
    for(let i=0;i<leafModels.length;i++)syncLeafVisual(i);
  }

  function syncLeafAnchors(dt){
    const W=getPageWidth();
    for(const leaf of leafModels){
      const p=getLeafProgress(leaf.index);
      const z=lerp(rightZ(leaf.index),leftZ(leaf.index),smoothstep(.20,.92,p));
      leaf.anchor.setTargetTransform({
        position:{x:-W/2,y:0,z},
        rotation:IDENTITY_Q
      },dt,true);
    }
  }

  function step(dt){
    if(!world)return;
    accumulator+=clamp(dt,0,.05);

    let loops=0;
    while(accumulator>=FIXED_DT && loops<4){
      lastStep=FIXED_DT;
      syncLeafAnchors(FIXED_DT);
      syncCoverAnchors(FIXED_DT);
      world.step(FIXED_DT,SUBSTEPS);
      accumulator-=FIXED_DT;
      loops++;
    }

    syncVisuals();
    syncCoverVisuals();
  }

  function reset(flippedCount=0){
    rebuild(flippedCount);
    setCoverTarget("start",0);
    setCoverTarget("end",0);
    for(let i=0;i<3;i++){
      syncLeafAnchors(FIXED_DT);
      syncCoverAnchors(FIXED_DT);
      world?.step(FIXED_DT,SUBSTEPS);
    }
    syncVisuals();
    syncCoverVisuals();
  }

  function setAllLeafStates(flippedCount){
    const count=getTotalLeaves();
    ensureBuilt(flippedCount);
    for(let i=0;i<count;i++)setLeafTarget(i,i<flippedCount?1:0);
  }

  return {
    engine:"Box3D",
    engineVersion:ALANTU_BOX3D_VERSION,
    rebuild,
    reset,
    step,
    ensureBuilt,
    setLeafTarget,
    getLeafProgress,
    isLeafSettled,
    setAllLeafStates,
    syncVisuals,
    syncCoverVisuals,
    setCoverTarget,
    beginGrab,
    updateGrab,
    beginCoverGrab,
    updateCoverGrab,
    endGrab,
    destroy:destroyWorld
  };
}
