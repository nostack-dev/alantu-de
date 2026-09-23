import Box2DFactory from "https://cdn.jsdelivr.net/npm/box2d3-wasm@5.2.0/build/dist/es/entry.mjs";

export const ALANTU_BOX2D_RUNTIME="300";
export const ALANTU_BOX2D_VERSION="3.x-wasm";

const box2d=await Box2DFactory();

const {
  b2DefaultWorldDef,
  b2CreateWorld,
  b2DestroyWorld,
  b2World_Step,
  b2World_SetGravity,
  b2World_GetGravity,
  b2DefaultBodyDef,
  b2CreateBody,
  b2DestroyBody,
  b2BodyType,
  b2DefaultShapeDef,
  b2CreatePolygonShape,
  b2MakeBox,
  b2MakeRot,
  b2Body_GetPosition,
  b2Body_GetRotation,
  b2Body_GetLocalPoint,
  b2Body_GetWorldPoint,
  b2Body_GetMassData,
  b2Body_SetAwake,
  b2Body_SetTargetTransform,
  b2Rot_GetAngle,
  b2DefaultRevoluteJointDef,
  b2CreateRevoluteJoint,
  b2RevoluteJoint_GetAngle,
  b2RevoluteJoint_EnableSpring,
  b2RevoluteJoint_EnableMotor,
  b2RevoluteJoint_SetMotorSpeed,
  b2RevoluteJoint_SetMaxMotorTorque,
  b2DefaultMotorJointDef,
  b2CreateMotorJoint,
  b2DestroyJoint,
  b2Transform,
  b2Rot_identity,
  b2Vec2,
  b2Length
}=box2d;

const PI=Math.PI;
const TURN_ANGLE=PI*.985;
const FIXED_DT=1/60;
const SUBSTEPS=8;

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function dispose(x){
  try{x?.delete?.()}catch{}
}

function rotate2(angle,x,y){
  const c=Math.cos(angle),s=Math.sin(angle);
  return {x:c*x-s*y,y:s*x+c*y};
}

export function createAlantuBookPhysics({
  getLeaves,
  getPageWidth,
  getPageHeight=()=>4.80,
  getTotalLeaves,
  rightZ,
  leftZ,
  getCoverSetup,
  getGravityVector=()=>({x:0,z:-9.81}),
  segments=14
}){
  let worldId=null;
  let spineBody=null;
  let leaves=[];
  let covers=null;
  let grab=null;
  let accumulator=0;
  let builtKey="";

  function gravity2(){
    const g=getGravityVector?.()||{x:0,z:-9.81};
    let gx=Number(g.x)||0;
    let gy=Number(g.z)||0;
    const m=Math.hypot(gx,gy);
    if(m<1e-6)return {x:0,y:-9.81};
    const s=9.81/m;
    return {x:gx*s,y:gy*s};
  }

  function makeVec(x,y){
    return new b2Vec2(x,y);
  }

  function currentKey(){
    const count=getTotalLeaves();
    if(count<=0)return "";
    const c=getCoverSetup?.();
    return [
      count,
      getPageWidth().toFixed(4),
      getPageHeight().toFixed(4),
      Number(c?.coverWidth||0).toFixed(4),
      Number(c?.coverHeight||0).toFixed(4),
      Number(c?.coverThickness||0).toFixed(4)
    ].join(":");
  }

  function destroy(){
    grab=null;
    leaves=[];
    covers=null;
    spineBody=null;
    accumulator=0;
    builtKey="";
    if(worldId!==null){
      try{b2DestroyWorld(worldId)}catch{}
      worldId=null;
    }
  }

  function createBoxBody({
    type,
    x,
    y,
    angle=0,
    hx,
    hy,
    density,
    friction,
    linearDamping=0,
    angularDamping=0,
    gravityScale=1,
    groupIndex=0
  }){
    const bd=b2DefaultBodyDef();
    bd.type=type;
    bd.position.Set(x,y);
    const rot=b2MakeRot(angle);
    bd.rotation=rot;
    bd.linearDamping=linearDamping;
    bd.angularDamping=angularDamping;
    bd.gravityScale=gravityScale;
    const body=b2CreateBody(worldId,bd);

    const sd=b2DefaultShapeDef();
    sd.density=density;
    sd.material.friction=friction;
    sd.material.restitution=0;
    sd.filter.groupIndex=groupIndex;

    const poly=b2MakeBox(hx,hy);
    b2CreatePolygonShape(body,sd,poly);

    dispose(poly);
    dispose(sd);
    dispose(rot);
    dispose(bd);
    return body;
  }

  function buildSpine(){
    const c=getCoverSetup?.();
    if(!c)throw new Error("ALANTU Box2D requires cover geometry");

    const geom=c.spine?.geometry?.parameters||{};
    const scale=c.spine?.scale||{x:1,z:1};
    const width=Math.max(.08,(geom.width||.12)*(scale.x||1));
    const depth=Math.max(
      Number(c.coverThickness||.16)*2,
      (geom.depth||.34)*(scale.z||1)
    );
    const p=c.spine?.position||{
      x:c.hingeX-.06,
      z:(rightZ(0)+leftZ(0))*.5
    };

    spineBody=createBoxBody({
      type:b2BodyType.b2_staticBody,
      x:p.x,
      y:p.z,
      hx:width/2,
      hy:depth/2,
      density:0,
      friction:.8
    });
  }

  function createSheet({
    name,
    width,
    height,
    thickness,
    count,
    hingeX,
    z0,
    z1,
    initialProgress,
    density,
    friction,
    linearDamping,
    angularDamping,
    gravityScale,
    rootTorque,
    bendHertz,
    bendLimit,
    groupIndex
  }){
    const n=Math.max(1,count|0);
    const sw=width/n;
    const hingeZ=(z0+z1)*.5;
    const rootOffset=(z1-z0)*.5;
    const initialAngle=TURN_ANGLE*clamp(initialProgress,0,1);
    const bodies=[];
    const joints=[];

    for(let i=0;i<n;i++){
      const localX=(i+.5)*sw;
      const localY=-rootOffset;
      const r=rotate2(initialAngle,localX,localY);

      bodies.push(createBoxBody({
        type:b2BodyType.b2_dynamicBody,
        x:hingeX+r.x,
        y:hingeZ+r.y,
        angle:initialAngle,
        hx:sw*.5,
        hy:Math.max(thickness,.006)*.5,
        density,
        friction,
        linearDamping,
        angularDamping,
        gravityScale,
        groupIndex
      }));
    }

    const worldHinge=makeVec(hingeX,hingeZ);
    const spineLocal=b2Body_GetLocalPoint(spineBody,worldHinge);

    const rootDef=b2DefaultRevoluteJointDef();
    rootDef.base.bodyIdA=spineBody;
    rootDef.base.bodyIdB=bodies[0];
    rootDef.base.localFrameA.p.Copy(spineLocal);
    rootDef.base.localFrameB.p.Set(-sw/2,rootOffset);
    rootDef.enableLimit=true;
    rootDef.lowerAngle=-.02;
    rootDef.upperAngle=TURN_ANGLE;
    rootDef.enableSpring=false;
    rootDef.enableMotor=true;
    rootDef.motorSpeed=0;
    rootDef.maxMotorTorque=rootTorque;

    const rootJoint=b2CreateRevoluteJoint(worldId,rootDef);
    joints.push(rootJoint);

    dispose(rootDef);
    dispose(spineLocal);
    dispose(worldHinge);

    for(let i=1;i<n;i++){
      const jd=b2DefaultRevoluteJointDef();
      jd.base.bodyIdA=bodies[i-1];
      jd.base.bodyIdB=bodies[i];
      jd.base.localFrameA.p.Set(sw/2,0);
      jd.base.localFrameB.p.Set(-sw/2,0);
      jd.enableSpring=true;
      jd.targetAngle=0;
      jd.hertz=bendHertz;
      jd.dampingRatio=1;
      jd.enableLimit=true;
      jd.lowerAngle=-bendLimit;
      jd.upperAngle=bendLimit;
      jd.enableMotor=false;
      joints.push(b2CreateRevoluteJoint(worldId,jd));
      dispose(jd);
    }

    return {
      name,
      width,
      height,
      thickness,
      count:n,
      sw,
      hingeX,
      hingeZ,
      rootOffset,
      bodies,
      joints,
      rootJoint,
      rootTorque,
      commanded:clamp(initialProgress,0,1)
    };
  }

  function createLeaf(index,flipped){
    const total=Math.max(1,getTotalLeaves());
    const next=Math.min(index+1,total-1);
    const stackStep=Math.max(.003,Math.abs(rightZ(index)-rightZ(next))||.006);

    const model=createSheet({
      name:"leaf-"+index,
      width:getPageWidth(),
      height:getPageHeight(),
      thickness:clamp(stackStep*.52,.0025,.006),
      count:segments,
      hingeX:-getPageWidth()/2,
      z0:rightZ(index),
      z1:leftZ(index),
      initialProgress:flipped?1:0,
      density:.085,
      friction:.34,
      linearDamping:1.4,
      angularDamping:2.8,
      gravityScale:1,
      rootTorque:120,
      bendHertz:30,
      bendLimit:.075,
      groupIndex:-(index+1)
    });
    model.index=index;
    return model;
  }

  function createCovers(){
    const c=getCoverSetup?.();
    if(!c)return;

    // A hardcover board is physically a single rigid sheet in the same hinge model.
    const front=createSheet({
      name:"front-cover",
      width:c.coverWidth,
      height:c.coverHeight,
      thickness:c.coverThickness,
      count:1,
      hingeX:c.hingeX,
      z0:c.startClosedZ,
      z1:c.startOpenZ,
      initialProgress:1,
      density:1.8,
      friction:.8,
      linearDamping:1.8,
      angularDamping:3.5,
      gravityScale:1,
      rootTorque:260,
      bendHertz:0,
      bendLimit:0,
      groupIndex:-1001
    });

    const back=createSheet({
      name:"back-cover",
      width:c.coverWidth,
      height:c.coverHeight,
      thickness:c.coverThickness,
      count:1,
      hingeX:c.hingeX,
      z0:c.endOpenZ,
      z1:c.endClosedZ,
      initialProgress:0,
      density:1.8,
      friction:.8,
      linearDamping:1.8,
      angularDamping:3.5,
      gravityScale:1,
      rootTorque:260,
      bendHertz:0,
      bendLimit:0,
      groupIndex:-1002
    });

    covers={front,back};
  }

  function rebuild(flippedCount=0){
    destroy();
    if(getTotalLeaves()<=0)return false;

    builtKey=currentKey();

    const wd=b2DefaultWorldDef();
    const g=gravity2();
    wd.gravity.Set(g.x,g.y);
    wd.enableSleep=true;
    wd.enableContinuous=true;
    worldId=b2CreateWorld(wd);
    dispose(wd);

    buildSpine();
    createCovers();

    for(let i=0;i<getTotalLeaves();i++){
      leaves.push(createLeaf(i,i<flippedCount));
    }

    for(let i=0;i<8;i++)b2World_Step(worldId,1/120,8);
    syncVisuals();
    syncCoverVisuals();
    return true;
  }

  function ensureBuilt(flippedCount=0){
    const key=currentKey();
    if(!key)return false;
    if(worldId===null||key!==builtKey)return rebuild(flippedCount);
    return true;
  }

  function angleOf(model){
    return clamp(b2RevoluteJoint_GetAngle(model.rootJoint),-.02,TURN_ANGLE);
  }

  function drive(model,target,{dragging=false,cover=false}={}){
    if(!model)return;
    for(const body of model.bodies)b2Body_SetAwake(body,true);

    if(dragging){
      b2RevoluteJoint_EnableSpring(model.rootJoint,false);
      b2RevoluteJoint_EnableMotor(model.rootJoint,false);
      return;
    }

    const error=target-angleOf(model);
    b2RevoluteJoint_EnableSpring(model.rootJoint,false);
    b2RevoluteJoint_EnableMotor(model.rootJoint,true);
    b2RevoluteJoint_SetMaxMotorTorque(
      model.rootJoint,
      cover?Math.max(260,model.rootTorque):model.rootTorque
    );
    b2RevoluteJoint_SetMotorSpeed(
      model.rootJoint,
      Math.abs(error)<.004?0:clamp(error*(cover?12:15),-16,16)
    );
  }

  function setLeafTarget(index,progress,{dragging=false}={}){
    const model=leaves[index];
    if(!model)return;
    model.commanded=clamp(progress,0,1);
    drive(model,TURN_ANGLE*model.commanded,{dragging});
  }

  function setAllLeafStates(flippedCount){
    for(let i=0;i<leaves.length;i++)setLeafTarget(i,i<flippedCount?1:0);
  }

  function getLeafProgress(index){
    const model=leaves[index];
    if(!model)return 0;
    return clamp(angleOf(model)/TURN_ANGLE,0,1);
  }

  function isLeafSettled(index,target){
    return Math.abs(getLeafProgress(index)-clamp(target,0,1))<.01;
  }

  function setCoverTarget(side,progress,{dragging=false}={}){
    if(!covers)return;
    const p=clamp(progress,0,1);
    const model=side==="start"?covers.front:covers.back;
    model.commanded=p;
    const target=side==="start"?TURN_ANGLE*(1-p):TURN_ANGLE*p;
    drive(model,target,{dragging,cover:true});
  }

  function getCoverProgress(side){
    if(!covers)return 0;
    const model=side==="start"?covers.front:covers.back;
    const p=clamp(angleOf(model)/TURN_ANGLE,0,1);
    return side==="start"?1-p:p;
  }

  function beginModelGrab(model){
    endGrab();
    if(!model||worldId===null)return;

    // Always grab the outer edge: maximum lever arm from the spine.
    const body=model.bodies[model.bodies.length-1];
    const local=makeVec(model.sw*.495,0);
    const point=b2Body_GetWorldPoint(body,local);

    const bd=b2DefaultBodyDef();
    bd.type=b2BodyType.b2_kinematicBody;
    bd.position.Copy(point);
    bd.enableSleep=false;
    const mouseBody=b2CreateBody(worldId,bd);

    const jd=b2DefaultMotorJointDef();
    jd.base.bodyIdA=mouseBody;
    jd.base.bodyIdB=body;
    jd.base.localFrameB.p.Copy(local);
    jd.linearHertz=7.5;
    jd.linearDampingRatio=1.0;

    const massData=b2Body_GetMassData(body);
    const g=b2Length(b2World_GetGravity(worldId));
    const mg=massData.mass*g;
    jd.maxSpringForce=100*mg;
    if(massData.mass>0){
      const lever=Math.sqrt(massData.rotationalInertia/massData.mass);
      jd.maxVelocityTorque=.25*lever*mg;
    }

    const mouseJoint=b2CreateMotorJoint(worldId,jd);
    b2Body_SetAwake(body,true);

    grab={
      model,
      mouseBody,
      mouseJoint,
      target:{x:point.x,y:point.y}
    };

    dispose(massData);
    dispose(jd);
    dispose(bd);
    dispose(point);
    dispose(local);
  }

  function beginGrab(index){
    beginModelGrab(leaves[index]);
  }

  function beginCoverGrab(side){
    if(!covers)return;
    beginModelGrab(side==="start"?covers.front:covers.back);
  }

  function setGrabTarget(target){
    if(!grab||!target)return;
    const x=Number(target.x);
    const y=Number(target.z);
    if(!Number.isFinite(x)||!Number.isFinite(y))return;
    grab.target={x,y};
  }

  function updateMouseBody(){
    if(!grab)return;
    const xf=new b2Transform();
    xf.p.Set(grab.target.x,grab.target.y);
    xf.q=b2Rot_identity;
    b2Body_SetTargetTransform(grab.mouseBody,xf,FIXED_DT);
    dispose(xf);
  }

  function endGrab(){
    if(!grab)return;
    try{b2DestroyJoint(grab.mouseJoint,true)}catch{}
    try{b2DestroyBody(grab.mouseBody)}catch{}
    grab=null;
  }

  function bodyPose(body){
    const p=b2Body_GetPosition(body);
    const q=b2Body_GetRotation(body);
    const angle=b2Rot_GetAngle(q);
    const out={x:p.x,z:p.y,angle};
    dispose(p);
    dispose(q);
    return out;
  }

  function edge(pose,localX){
    return {
      x:pose.x+Math.cos(pose.angle)*localX,
      z:pose.z+Math.sin(pose.angle)*localX
    };
  }

  function syncLeafVisual(index){
    const model=leaves[index];
    const pivot=getLeaves()[index];
    const geometry=pivot?.userData?.geometry;
    if(!model||!geometry)return;

    const pos=geometry.attributes.position;
    const base=geometry.userData.basePosition;
    const edges=new Array(model.count+1);

    const poses=model.bodies.map(bodyPose);
    edges[0]=edge(poses[0],-model.sw/2);
    for(let i=1;i<model.count;i++){
      const a=edge(poses[i-1],model.sw/2);
      const b=edge(poses[i],-model.sw/2);
      edges[i]={x:(a.x+b.x)*.5,z:(a.z+b.z)*.5};
    }
    edges[model.count]=edge(poses[model.count-1],model.sw/2);

    for(let i=0;i<pos.count;i++){
      const bx=base[i*3];
      const by=base[i*3+1];
      const f=clamp((bx/model.width)*model.count,0,model.count);
      const s=Math.min(model.count-1,Math.floor(f));
      const t=(s===model.count-1&&f===model.count)?1:f-s;
      const a=edges[s],b=edges[s+1];
      pos.array[i*3]=a.x+(b.x-a.x)*t;
      pos.array[i*3+1]=by;
      pos.array[i*3+2]=a.z+(b.z-a.z)*t;
    }

    pos.needsUpdate=true;
    geometry.computeVertexNormals();
    pivot.position.set(0,0,0);
    pivot.rotation.set(0,0,0);
  }

  function syncVisuals(){
    for(let i=0;i<leaves.length;i++)syncLeafVisual(i);
  }

  function syncCover(model,pivot){
    if(!model||!pivot)return;
    const pose=bodyPose(model.bodies[0]);
    const c=Math.cos(pose.angle),s=Math.sin(pose.angle);
    pivot.position.set(
      pose.x-c*model.width/2,
      0,
      pose.z-s*model.width/2
    );
    pivot.rotation.set(0,-pose.angle,0);
  }

  function syncCoverVisuals(){
    if(!covers)return;
    const c=getCoverSetup?.();
    if(!c)return;
    syncCover(covers.front,c.frontPivot);
    syncCover(covers.back,c.endPivot);
  }

  function step(dt){
    if(worldId===null)return;
    accumulator+=clamp(dt,0,.05);

    let loops=0;
    while(accumulator>=FIXED_DT&&loops<4){
      const g=gravity2();
      const gv=makeVec(g.x,g.y);
      b2World_SetGravity(worldId,gv);
      dispose(gv);

      updateMouseBody();
      b2World_Step(worldId,FIXED_DT,SUBSTEPS);
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
    engine:"Box2D",
    engineVersion:ALANTU_BOX2D_VERSION,
    runtime:ALANTU_BOX2D_RUNTIME,
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
    destroy
  };
}
