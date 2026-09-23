import Box3DFactory from "https://cdn.jsdelivr.net/npm/box3d-wasm@0.2.0/dist/box3d.mjs";

export const ALANTU_BOX3D_VERSION="0.2.0";
const b3=await Box3DFactory();

const PI=Math.PI;
const OPEN_ANGLE=PI*.985;
const AXIS_Y_QUAT={x:-Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2};

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const quatY=a=>({x:0,y:Math.sin(a/2),z:0,w:Math.cos(a/2)});

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
  let anchor=null;
  let leafModels=[];
  let coverBodies=null;
  let spineBody=null;
  let builtKey="";
  let lastStep=1/60;

  function destroyWorld(){
    if(!world)return;
    for(const leaf of leafModels){
      for(const j of leaf.joints)disposeHandle(j);
      for(const body of leaf.bodies)disposeHandle(body);
    }
    leafModels=[];
    if(coverBodies){
      disposeHandle(coverBodies.front);
      disposeHandle(coverBodies.back);
      coverBodies=null;
    }
    disposeHandle(spineBody);
    spineBody=null;
    disposeHandle(anchor);
    anchor=null;
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

  function createLeaf(index,flipped){
    const W=getPageWidth();
    const H=getPageHeight();
    const sw=W/segments;
    const stackStep=Math.max(.003,Math.abs(rightZ(0)-rightZ(Math.min(1,getTotalLeaves()-1)))||.006);
    const thickness=clamp(stackStep*.55,.0025,.0065);
    const bodies=[];
    const joints=[];

    for(let s=0;s<segments;s++){
      const xf=sheetTransform(index,s,flipped,W,H,sw);
      const body=world.createBody({
        type:"dynamic",
        position:xf.position,
        rotation:xf.rotation,
        linearDamping:2.2,
        angularDamping:3.8,
        gravityScale:1,
        enableSleep:true,
        isAwake:true,
        allowFastRotation:false,
        name:`leaf-${index}-strip-${s}`
      });
      createBox(body,{
        halfExtents:{x:sw*.5,y:H*.5,z:thickness*.5},
        density:.32,
        friction:.42,
        restitution:0,
        enableContactEvents:false
      });
      bodies.push(body);
    }

    const rootTarget=flipped?-OPEN_ANGLE:0;
    const root=world.createRevoluteJoint(anchor,bodies[0],{
      localFrameA:localFrame({x:-W/2,y:0,z:flipped?leftZ(index):rightZ(index)}),
      localFrameB:localFrame({x:-sw/2,y:0,z:0}),
      collideConnected:false,
      enableSpring:true,
      hertz:8.5,
      dampingRatio:1.0,
      targetAngle:rootTarget,
      enableLimit:true,
      lowerAngle:-PI*.99,
      upperAngle:.035,
      enableMotor:true,
      motorSpeed:0,
      maxMotorTorque:18
    });
    joints.push(root);

    for(let s=1;s<segments;s++){
      const joint=world.createRevoluteJoint(bodies[s-1],bodies[s],{
        localFrameA:localFrame({x:sw/2,y:0,z:0}),
        localFrameB:localFrame({x:-sw/2,y:0,z:0}),
        collideConnected:false,
        enableSpring:true,
        hertz:18,
        dampingRatio:1.05,
        targetAngle:0,
        enableLimit:true,
        lowerAngle:-.42,
        upperAngle:.42
      });
      joints.push(joint);
    }

    return {
      index,
      bodies,
      joints,
      rootJoint:root,
      target:flipped?1:0,
      commanded:flipped?1:0,
      thickness,
      sw
    };
  }

  function coverCenter(pivot,mesh){
    const a=pivot.rotation.y||0;
    const ox=mesh.position.x||0;
    const oz=mesh.position.z||0;
    const c=Math.cos(a),s=Math.sin(a);
    return {
      position:{
        x:pivot.position.x+c*ox+s*oz,
        y:pivot.position.y+(mesh.position.y||0),
        z:pivot.position.z-s*ox+c*oz
      },
      rotation:quatY(a)
    };
  }

  function buildCoverBodies(){
    const cover=getCoverSetup?.();
    if(!cover?.frontPivot||!cover?.endPivot||!cover?.frontCover||!cover?.backCover)return;

    const {coverWidth,coverHeight,coverThickness,hingeX}=cover;
    const fxf=coverCenter(cover.frontPivot,cover.frontCover);
    const bxf=coverCenter(cover.endPivot,cover.backCover);

    const front=world.createBody({
      type:"kinematic",
      position:fxf.position,
      rotation:fxf.rotation,
      enableSleep:false,
      name:"front-hardcover"
    });
    createBox(front,{
      halfExtents:{x:coverWidth/2,y:coverHeight/2,z:coverThickness/2},
      friction:.86,
      restitution:0
    });

    const back=world.createBody({
      type:"kinematic",
      position:bxf.position,
      rotation:bxf.rotation,
      enableSleep:false,
      name:"back-hardcover"
    });
    createBox(back,{
      halfExtents:{x:coverWidth/2,y:coverHeight/2,z:coverThickness/2},
      friction:.86,
      restitution:0
    });

    coverBodies={front,back};

    const spineDepth=Math.max(
      coverThickness*2,
      Math.abs(rightZ(Math.max(0,getTotalLeaves()-1))-leftZ(Math.max(0,getTotalLeaves()-1)))+coverThickness*1.35
    );
    const spineZ=(rightZ(0)+rightZ(Math.max(0,getTotalLeaves()-1)))/2;
    spineBody=world.createBody({
      type:"static",
      position:{x:hingeX-.065,y:0,z:spineZ},
      name:"spine-collider"
    });
    createBox(spineBody,{
      halfExtents:{x:.055,y:coverHeight*.49,z:spineDepth*.5},
      friction:.82,
      restitution:0
    });
  }

  function syncCoverBodies(dt=lastStep){
    if(!coverBodies)return;
    const cover=getCoverSetup?.();
    if(!cover?.frontPivot||!cover?.endPivot)return;

    const fxf=coverCenter(cover.frontPivot,cover.frontCover);
    const bxf=coverCenter(cover.endPivot,cover.backCover);
    try{
      coverBodies.front.setTargetTransform(fxf,Math.max(1/240,dt),true);
      coverBodies.back.setTargetTransform(bxf,Math.max(1/240,dt),true);
    }catch{
      coverBodies.front.setTransform(fxf.position,fxf.rotation);
      coverBodies.back.setTransform(bxf.position,bxf.rotation);
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
      gravity:{x:0,y:0,z:-5.2},
      enableSleep:true,
      enableContinuous:true,
      contactHertz:90,
      contactDampingRatio:1
    });

    anchor=world.createBody({type:"static",position:{x:0,y:0,z:0},name:"book-binding"});
    buildCoverBodies();

    for(let i=0;i<count;i++){
      leafModels.push(createLeaf(i,i<flippedCount));
    }

    syncCoverBodies(1/60);
    for(let i=0;i<8;i++)world.step(1/120,8);
    syncVisuals();
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

    joint.enableSpring(true);
    joint.setSpringHertz(dragging?20:8.5);
    joint.setSpringDampingRatio(dragging ? .92 : 1.0);
    joint.setTargetAngle(targetAngle);

    // A page does not turn without an external force. This motor is that
    // force (mouse/finger or automated turn), capped so collisions remain
    // authoritative instead of being teleported through other geometry.
    joint.enableMotor(true);
    joint.setMaxMotorTorque(dragging?34:22);
    joint.setMotorSpeed(Math.abs(error)<.012?0:clamp(error*8,-14,14));

    for(const body of leaf.bodies)body.setAwake(true);
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
    if(Math.abs(p-target)>.018)return false;
    let maxSpeed=0;
    for(const body of leaf.bodies){
      try{maxSpeed=Math.max(maxSpeed,length3(body.getAngularVelocity()),length3(body.getLinearVelocity()))}catch{}
    }
    return maxSpeed<.22;
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

  function step(dt){
    if(!world)return;
    const safeDt=clamp(dt,1/240,1/30);
    lastStep=safeDt;
    syncCoverBodies(safeDt);
    world.step(safeDt,8);
    syncVisuals();
  }

  function reset(flippedCount=0){
    rebuild(flippedCount);
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
    syncCoverBodies,
    destroy:destroyWorld
  };
}
