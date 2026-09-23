import Box3DFactory from "https://cdn.jsdelivr.net/npm/box3d-wasm@0.2.0/dist/box3d.mjs";

export const ALANTU_BOX3D_VERSION="0.2.0";
export const ALANTU_BOX3D_RUNTIME="200";

const b3=await Box3DFactory();

const PI=Math.PI;
const TURN_ANGLE=PI*.985;
const AXIS_Y_QUAT={x:-Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2};
const IDENTITY_Q={x:0,y:0,z:0,w:1};

const CAT_PAGE=0x0001;
const CAT_COVER=0x0002;
const CAT_SPINE=0x0004;

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

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

function quatY(angle){
  const h=angle*.5;
  return {x:0,y:Math.sin(h),z:0,w:Math.cos(h)};
}

function safeDelete(handle){
  try{handle?.delete?.()}catch{}
}

export function createAlantuBookPhysics({
  getLeaves,
  getPageWidth,
  getPageHeight=()=>4.80,
  getTotalLeaves,
  rightZ,
  leftZ,
  getCoverSetup,
  segments=12
}){
  let world=null;
  let spineBody=null;
  let leafModels=[];
  let coverModels=null;
  let grab=null;
  let builtKey="";
  let accumulator=0;

  const FIXED_DT=1/60;
  const SUBSTEPS=8;

  function localFrame(position){
    return {position,rotation:AXIS_Y_QUAT};
  }

  function createBox(body,options){
    const shape=body.createBox(options);
    safeDelete(shape);
  }

  function destroyWorld(){
    grab=null;
    leafModels=[];
    coverModels=null;
    spineBody=null;
    builtKey="";
    accumulator=0;

    if(world){
      try{world.destroy()}catch{}
      safeDelete(world);
      world=null;
    }
  }

  function currentKey(){
    const count=getTotalLeaves();
    if(count<=0)return "";
    const cover=getCoverSetup?.();
    const W=getPageWidth();
    const H=getPageHeight();
    const cw=cover?.coverWidth||0;
    const ch=cover?.coverHeight||0;
    const ct=cover?.coverThickness||0;
    return [
      count,W.toFixed(4),H.toFixed(4),
      cw.toFixed(4),ch.toFixed(4),ct.toFixed(4)
    ].join(":");
  }

  function buildSpine(){
    const cover=getCoverSetup?.();
    if(!cover)throw new Error("ALANTU Box3D requires cover geometry");

    const geom=cover.spine?.geometry?.parameters||{};
    const scale=cover.spine?.scale||{x:1,y:1,z:1};

    const width=Math.max(.08,(geom.width||.12)*(scale.x||1));
    const height=Math.max(.2,(geom.height||cover.coverHeight||5)*(scale.y||1));
    const depth=Math.max(
      cover.coverThickness*2,
      (geom.depth||.34)*(scale.z||1)
    );

    const pos=cover.spine?.position||{
      x:cover.hingeX-.06,
      y:0,
      z:(rightZ(0)+leftZ(0))*.5
    };

    spineBody=world.createBody({
      type:"static",
      position:{x:pos.x,y:pos.y,z:pos.z},
      rotation:IDENTITY_Q,
      name:"alantu-spine"
    });

    createBox(spineBody,{
      halfExtents:{x:width/2,y:height/2,z:depth/2},
      friction:.78,
      restitution:0,
      filter:{
        categoryBits:CAT_SPINE,
        maskBits:CAT_PAGE|CAT_COVER
      }
    });
  }

  function createPhysicalSheet({
    name,
    width,
    height,
    thickness,
    segmentCount,
    hingeX,
    zAtAngle0,
    zAtAngleTurn,
    initialProgress,
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
    const count=Math.max(1,segmentCount|0);
    const sw=width/count;

    // One fixed physical hinge on the static spine. The sheet/cover center
    // changes stack height by rotating an offset attachment around that hinge.
    // No kinematic binding body and no per-frame hinge translation.
    const hingeZ=(zAtAngle0+zAtAngleTurn)*.5;
    const rootLocalZ=(zAtAngleTurn-zAtAngle0)*.5;
    const initialAngle=-TURN_ANGLE*clamp(initialProgress,0,1);
    const q=quatY(initialAngle);

    const bodies=[];
    const joints=[];

    for(let s=0;s<count;s++){
      const localCenter={
        x:(s+.5)*sw,
        y:0,
        z:-rootLocalZ
      };
      const r=rotateVec(q,localCenter);

      const body=world.createBody({
        type:"dynamic",
        position:{
          x:hingeX+r.x,
          y:r.y,
          z:hingeZ+r.z
        },
        rotation:q,
        linearDamping,
        angularDamping,
        gravityScale,
        enableSleep:true,
        isAwake:true,
        isBullet:true,
        allowFastRotation:false,
        motionLocks:{
          linearY:true,
          angularX:true,
          angularZ:true
        },
        name:`${name}-segment-${s}`
      });

      createBox(body,{
        halfExtents:{
          x:sw*.5,
          y:height*.5,
          z:Math.max(thickness,.008)*.5
        },
        density,
        friction,
        restitution:0,
        filter:{
          categoryBits,
          maskBits,
          groupIndex
        }
      });

      bodies.push(body);
    }

    const worldHinge={x:hingeX,y:0,z:hingeZ};
    const spineLocal=spineBody.getLocalPoint(worldHinge);

    const rootJoint=world.createRevoluteJoint(spineBody,bodies[0],{
      localFrameA:localFrame(spineLocal),
      localFrameB:localFrame({
        x:-sw/2,
        y:0,
        z:rootLocalZ
      }),
      collideConnected:false,
      enableSpring:true,
      hertz:rootHertz,
      dampingRatio:1,
      targetAngle:initialAngle,
      enableLimit:true,
      lowerAngle:-TURN_ANGLE,
      upperAngle:.02,
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
      hingeX,
      hingeZ,
      rootLocalZ,
      bodies,
      joints,
      rootJoint,
      rootHertz,
      rootTorque,
      bendHertz,
      bendLimit,
      commanded:clamp(initialProgress,0,1)
    };
  }

  function createLeaf(index,flipped){
    const W=getPageWidth();
    const H=getPageHeight();
    const total=Math.max(1,getTotalLeaves());
    const next=Math.min(index+1,total-1);
    const stackStep=Math.max(
      .003,
      Math.abs(rightZ(index)-rightZ(next))||.006
    );

    return {
      index,
      ...createPhysicalSheet({
        name:`leaf-${index}`,
        width:W,
        height:H,
        thickness:clamp(stackStep*.50,.0022,.006),
        segmentCount:segments,
        hingeX:-W/2,
        zAtAngle0:rightZ(index),
        zAtAngleTurn:leftZ(index),
        initialProgress:flipped?1:0,
        density:.075,
        friction:.30,
        linearDamping:2.1,
        angularDamping:4.8,
        gravityScale:1,
        rootHertz:15,
        rootTorque:150,
        bendHertz:38,
        bendLimit:.055,
        categoryBits:CAT_PAGE,
        maskBits:CAT_PAGE|CAT_COVER|CAT_SPINE,
        groupIndex:-(index+1)
      })
    };
  }

  function createCovers(){
    const cover=getCoverSetup?.();
    if(!cover)return;

    // Same sheet primitive as paper. A hardcover is simply the rigid end of
    // the same model: one thick segment, higher mass, stronger hinge.
    const front=createPhysicalSheet({
      name:"front-cover",
      width:cover.coverWidth,
      height:cover.coverHeight,
      thickness:cover.coverThickness,
      segmentCount:1,
      hingeX:cover.hingeX,
      zAtAngle0:cover.startClosedZ,
      zAtAngleTurn:cover.startOpenZ,
      initialProgress:1,
      density:1.9,
      friction:.80,
      linearDamping:2.6,
      angularDamping:5.4,
      gravityScale:.18,
      rootHertz:18,
      rootTorque:520,
      bendHertz:0,
      bendLimit:0,
      categoryBits:CAT_COVER,
      maskBits:CAT_PAGE|CAT_SPINE,
      groupIndex:-1001
    });

    const back=createPhysicalSheet({
      name:"back-cover",
      width:cover.coverWidth,
      height:cover.coverHeight,
      thickness:cover.coverThickness,
      segmentCount:1,
      hingeX:cover.hingeX,
      zAtAngle0:cover.endOpenZ,
      zAtAngleTurn:cover.endClosedZ,
      initialProgress:0,
      density:1.9,
      friction:.80,
      linearDamping:2.6,
      angularDamping:5.4,
      gravityScale:.18,
      rootHertz:18,
      rootTorque:520,
      bendHertz:0,
      bendLimit:0,
      categoryBits:CAT_COVER,
      maskBits:CAT_PAGE|CAT_SPINE,
      groupIndex:-1002
    });

    coverModels={front,back};
  }

  function rebuild(flippedCount=0){
    destroyWorld();

    const count=getTotalLeaves();
    if(count<=0)return false;

    builtKey=currentKey();

    world=new b3.World({
      gravity:{x:0,y:0,z:-4.5},
      enableSleep:true,
      enableContinuous:true,
      contactHertz:80,
      contactDampingRatio:1,
      maximumLinearSpeed:8
    });

    buildSpine();
    createCovers();

    for(let i=0;i<count;i++){
      leafModels.push(createLeaf(i,i<flippedCount));
    }

    // Establish contacts without moving any hinge or teleporting any book part.
    for(let i=0;i<10;i++)world.step(1/120,SUBSTEPS);
    syncVisuals();
    syncCoverVisuals();
    return true;
  }

  function ensureBuilt(flippedCount=0){
    const key=currentKey();
    if(!key)return false;
    if(!world||key!==builtKey)return rebuild(flippedCount);
    return true;
  }

  function driveRoot(model,targetAngle,{dragging=false,cover=false}={}){
    const joint=model?.rootJoint;
    if(!joint)return;

    for(const body of model.bodies)body.setAwake(true);

    // During a grab the MotorJoint at the actual touch point is the ONLY
    // external drive. The revolute joint remains a hard hinge constraint,
    // but its spring/motor are disabled so two solvers cannot fight.
    if(dragging){
      joint.enableSpring(false);
      joint.enableMotor(false);
      return;
    }

    let angle=0;
    try{angle=joint.getAngle()}catch{}
    const error=targetAngle-angle;

    joint.enableSpring(true);
    joint.setSpringHertz(model.rootHertz);
    joint.setSpringDampingRatio(1);
    joint.setTargetAngle(targetAngle);
    joint.enableMotor(true);
    joint.setMaxMotorTorque(model.rootTorque);
    joint.setMotorSpeed(
      Math.abs(error)<.004
        ? 0
        : clamp(error*(cover?12:14),-16,16)
    );
  }

  function setLeafTarget(index,progress,{dragging=false}={}){
    const leaf=leafModels[index];
    if(!leaf)return;
    const p=clamp(progress,0,1);
    leaf.commanded=p;
    driveRoot(leaf,-TURN_ANGLE*p,{dragging,cover:false});
  }

  function setAllLeafStates(flippedCount){
    for(let i=0;i<leafModels.length;i++){
      setLeafTarget(i,i<flippedCount?1:0);
    }
  }

  function getLeafProgress(index){
    const leaf=leafModels[index];
    if(!leaf)return 0;
    let angle=0;
    try{angle=leaf.rootJoint.getAngle()}catch{}
    return clamp(-angle/TURN_ANGLE,0,1);
  }

  function isLeafSettled(index,target){
    return Math.abs(getLeafProgress(index)-clamp(target,0,1))<.010;
  }

  function setCoverTarget(side,progress,{dragging=false}={}){
    if(!coverModels)return;
    const p=clamp(progress,0,1);
    const model=side==="start"?coverModels.front:coverModels.back;
    model.commanded=p;

    const angle=side==="start"
      ? -TURN_ANGLE*(1-p)
      : -TURN_ANGLE*p;

    driveRoot(model,angle,{dragging,cover:true});
  }

  function getCoverProgress(side){
    if(!coverModels)return 0;
    const model=side==="start"?coverModels.front:coverModels.back;
    let angle=0;
    try{angle=model.rootJoint.getAngle()}catch{}

    return side==="start"
      ? clamp(1+angle/TURN_ANGLE,0,1)
      : clamp(-angle/TURN_ANGLE,0,1);
  }

  function modelPoint(model,u,angle){
    const local={
      x:clamp(u,0,1)*model.width,
      y:0,
      z:-model.rootLocalZ
    };
    const r=rotateVec(quatY(angle),local);
    return {
      x:model.hingeX+r.x,
      y:r.y,
      z:model.hingeZ+r.z
    };
  }

  function beginModelGrab(model,u,{maxForce=220,maxSpeed=4}={}){
    endGrab();
    if(!model||!world)return;

    const clampedU=clamp(u,.04,.99);
    const segmentIndex=clamp(
      Math.floor(clampedU*model.segmentCount),
      0,
      model.segmentCount-1
    );
    const body=model.bodies[segmentIndex];
    const localX=
      clampedU*model.width-(segmentIndex+.5)*model.sw;
    const actualPoint=body.getWorldPoint({x:localX,y:0,z:0});

    const driver=world.createBody({
      type:"kinematic",
      position:actualPoint,
      rotation:IDENTITY_Q,
      linearVelocity:{x:0,y:0,z:0},
      enableSleep:false,
      name:"alantu-grab-driver"
    });

    const joint=world.createMotorJoint(driver,body,{
      localFrameA:{
        position:{x:0,y:0,z:0},
        rotation:IDENTITY_Q
      },
      localFrameB:{
        position:{x:localX,y:0,z:0},
        rotation:IDENTITY_Q
      },
      collideConnected:false,
      linearVelocity:{x:0,y:0,z:0},
      maxVelocityForce:maxForce,
      angularVelocity:{x:0,y:0,z:0},
      maxVelocityTorque:0,
      linearHertz:22,
      linearDampingRatio:1,
      maxSpringForce:maxForce,
      angularHertz:0,
      angularDampingRatio:1,
      maxSpringTorque:0
    });

    grab={
      model,
      u:clampedU,
      driver,
      joint,
      target:{...actualPoint},
      maxSpeed
    };
    body.setAwake(true);
  }

  function setGrabTarget(target){
    if(!grab||!target)return;
    const x=Number(target.x),y=Number(target.y),z=Number(target.z);
    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z))return;
    grab.target={x,y,z};
  }

  function advanceGrabDriver(){
    if(!grab?.target)return;

    const p=grab.driver.getPosition();
    const dx=grab.target.x-p.x;
    const dy=grab.target.y-p.y;
    const dz=grab.target.z-p.z;
    const distance=Math.hypot(dx,dy,dz);

    if(distance<.0005){
      grab.driver.setLinearVelocity({x:0,y:0,z:0});
      return;
    }

    // Crucial: never teleport the kinematic mouse body. A capped velocity
    // lets CCD/contact constraints solve before the dragged sheet can cross
    // another sheet, and prevents the joint chain from being pulled apart.
    const speed=Math.min(grab.maxSpeed,distance/FIXED_DT);
    const scale=speed/distance;
    grab.driver.setLinearVelocity({
      x:dx*scale,
      y:dy*scale,
      z:dz*scale
    });
  }

  function beginGrab(index,u){
    const model=leafModels[index];
    if(!model)return;
    beginModelGrab(model,u,{maxForce:220,maxSpeed:4});
  }

  function beginCoverGrab(side,u){
    if(!coverModels)return;
    const model=side==="start"?coverModels.front:coverModels.back;
    beginModelGrab(model,u,{maxForce:650,maxSpeed:3});
  }

  function endGrab(){
    if(!grab)return;
    try{grab.driver.setLinearVelocity({x:0,y:0,z:0})}catch{}
    safeDelete(grab.joint);
    safeDelete(grab.driver);
    grab=null;
  }

  function edgePoint(body,localX){
    return body.getWorldPoint({x:localX,y:0,z:0});
  }

  function syncLeafVisual(index){
    const model=leafModels[index];
    const pivot=getLeaves()[index];
    if(!model||!pivot?.userData?.geometry)return;

    const geometry=pivot.userData.geometry;
    const pos=geometry.attributes.position;
    const base=geometry.userData.basePosition;
    const W=model.width;
    const count=model.segmentCount;
    const sw=model.sw;

    const edges=new Array(count+1);
    edges[0]=edgePoint(model.bodies[0],-sw/2);

    for(let s=1;s<count;s++){
      const a=edgePoint(model.bodies[s-1],sw/2);
      const b=edgePoint(model.bodies[s],-sw/2);
      edges[s]={
        x:(a.x+b.x)*.5,
        y:(a.y+b.y)*.5,
        z:(a.z+b.z)*.5
      };
    }

    edges[count]=edgePoint(model.bodies[count-1],sw/2);

    for(let i=0;i<pos.count;i++){
      const bx=base[i*3];
      const by=base[i*3+1];
      const f=clamp((bx/W)*count,0,count);
      const s=Math.min(count-1,Math.floor(f));
      const t=s===count-1&&f===count?1:f-s;
      const a=edges[s];
      const b=edges[s+1];

      pos.array[i*3]=a.x+(b.x-a.x)*t;
      pos.array[i*3+1]=by+(a.y+(b.y-a.y)*t);
      pos.array[i*3+2]=a.z+(b.z-a.z)*t;
    }

    pos.needsUpdate=true;
    geometry.computeVertexNormals();
    pivot.position.set(0,0,0);
    pivot.rotation.set(0,0,0);
  }

  function syncVisuals(){
    for(let i=0;i<leafModels.length;i++)syncLeafVisual(i);
  }

  function syncCoverVisual(model,pivot){
    if(!model||!pivot)return;
    const body=model.bodies[0];
    const p=body.getPosition();
    const q=body.getRotation();
    const r=rotateVec(q,{x:model.width/2,y:0,z:0});

    pivot.position.set(
      p.x-r.x,
      p.y-r.y,
      p.z-r.z
    );
    pivot.quaternion.set(q.x,q.y,q.z,q.w);
  }

  function syncCoverVisuals(){
    if(!coverModels)return;
    const cover=getCoverSetup?.();
    if(!cover)return;

    syncCoverVisual(coverModels.front,cover.frontPivot);
    syncCoverVisual(coverModels.back,cover.endPivot);

    if(cover.spine&&spineBody){
      const p=spineBody.getPosition();
      const q=spineBody.getRotation();
      cover.spine.position.set(p.x,p.y,p.z);
      cover.spine.quaternion.set(q.x,q.y,q.z,q.w);
    }
  }

  function step(dt){
    if(!world)return;

    accumulator+=clamp(dt,0,.05);
    let loops=0;

    while(accumulator>=FIXED_DT&&loops<4){
      advanceGrabDriver();
      world.step(FIXED_DT,12);
      accumulator-=FIXED_DT;
      loops++;
    }

    syncVisuals();
    syncCoverVisuals();
  }

  function reset(flippedCount=0){
    rebuild(flippedCount);
  }

  return {
    enabled:true,
    engine:"Box3D",
    engineVersion:ALANTU_BOX3D_VERSION,
    runtime:ALANTU_BOX3D_RUNTIME,
    rebuild,
    ensureBuilt,
    reset,
    step,
    setLeafTarget,
    setAllLeafStates,
    getLeafProgress,
    isLeafSettled,
    setCoverTarget,
    getCoverProgress,
    beginGrab,
    beginCoverGrab,
    setGrabTarget,
    endGrab,
    syncVisuals,
    syncCoverVisuals,
    destroy:destroyWorld
  };
}
