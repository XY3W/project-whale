import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { buildRoom, ROOM_DEF } from '../src/scene/room.ts';
import { PLAYGROUND_DEF } from '../src/scene/playground.ts';
import { SceneManager } from '../src/scene/SceneManager.ts';
import { furnitureById } from '../shared/room-furniture.mjs';
import { navigationPath,segmentBlocked,expandObstacle,recoverPosition } from '../src/scene/navigation.ts';
import { BasinPhysics,stepPropWorld,setPropObstacles } from '../src/prop/basinPhysics.ts';
import { needsStanding } from '../src/behavior/roamGate.ts';

function furnitureFixture() {
  const src=fs.readFileSync('src/main.ts','utf8');
  const block=src.slice(src.indexOf('  let furnitureTween:'),src.indexOf('  syncSceneButtons ='));
  const tweenStart=src.indexOf('    if (furnitureTween) {',src.indexOf('  const advanceScene'));
  const tween=src.slice(tweenStart,src.indexOf('    scenes.update(dt)',tweenStart));
  const run=src.slice(src.indexOf('  const runOwned ='),src.indexOf('  client.on({',src.indexOf('  const runOwned =')));
  const ensure=src.slice(src.indexOf('  const ensureStanding ='),src.indexOf('  const loco:'));
  const code=ts.transpileModule(block+`\nlet motionOwner='none',motionEpoch=0,currentExecutor=null;\n`+
    `const waitBodySettled=async()=>{await waitForProgress(()=>!furnitureTween&&furniturePose.currentWeight===0);return true;};\n`+
    `function makeExecutor(){const ex={cancel(){},async run(plan){const steps=[];for(const step of plan.steps){const r=await furnitureBridge.perform(step,'s');steps.push({action:step.action,status:r.ok?'succeeded':'failed'});}return {steps}}};currentExecutor=ex;return ex;}\n`+ensure+run+
    `\nreturn {bridge:furnitureBridge,leave:leaveFurniture,ensure:ensureStanding,run:runOwned,state:()=>({persistentAction,furnitureRestUntil,furnitureTween}),tick(dt){${tween} furniturePose.currentWeight=furniturePose.targetWeight;}};`,
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const root=new THREE.Group();root.position.set(-1.7,0,-2.55);
  const pose={activeName:null,activeFurniture:null,currentWeight:0,targetWeight:0,
    sitOn(id,name,_height,options){this.activeFurniture=id;this.activeName=name;this.targetWeight=1;if(options?.instant)this.currentWeight=1;},
    standUp(){this.activeName=null;this.activeFurniture=null;this.targetWeight=0;}};
  let f;
  const wait=async check=>{for(let i=0;!check();i++){assert.ok(i<100,'transition did not settle');await new Promise(r=>setTimeout(r,0));f.tick(1/60);}};
  const make=new Function('THREE','root','furniturePose','scenes','basin','scoop','furnitureById','FURNITURE_USE_RANGE_M','FURNITURE_REST_MS','waitForProgress','bridgeEpoch','player','needsStanding',code);
  f=make(THREE,root,pose,{active:'room',transitioning:false,furniture:[{id:'sofa'},{id:'bed'}]}, {state:'resting'}, {state:'resting'},furnitureById,1.2,60000,wait,1,{clearGesture(){},setWalking(){}},needsStanding);
  return {...f,root,pose};
}

test('起身即使从未坐下，也不残留持续动作和休息计时',async()=>{
  assert.equal(needsStanding([{action:'parallel',items:[{action:'move_to'},{action:'tail'}]}]),true);
  assert.equal(needsStanding([{action:'throw'}]),true);
  assert.equal(needsStanding([{action:'use_furniture'}]),false);
  const f=furnitureFixture();
  await f.run('plan',{steps:[{action:'use_furniture',furniture_id:'none'}]});
  assert.equal(f.state().persistentAction,null);assert.equal(f.state().furnitureRestUntil,0);
  await f.run('plan',{steps:[{action:'use_furniture',furniture_id:'sofa'}]});
  assert.equal(f.state().persistentAction,'use_furniture');assert.equal(f.pose.currentWeight,1);
  await f.run('plan',{steps:[{action:'use_furniture',furniture_id:'none'}]});
  assert.equal(f.state().persistentAction,null);assert.equal(f.state().furnitureTween,null);
  assert.equal(f.state().furnitureRestUntil,0);assert.equal(f.root.position.z,-2.55);
  await f.bridge.perform({furniture_id:'sofa'},'s');
  await f.ensure();
  assert.equal(f.pose.currentWeight,0,'同一计划后续移动也必须等起身结束');
  assert.equal(f.root.position.z,-2.55);
});

test('打断坐下后不会被旧补间拉回座面，重复起身也不截断退出过渡',async()=>{
  const f=furnitureFixture();
  const entering=f.bridge.perform({furniture_id:'sofa'},'s',{isCancelled:()=>f.pose.activeName===null});
  f.tick(.1);f.leave();f.leave();
  await entering;for(let i=0;i<60;i++)f.tick(1/60);
  assert.equal(f.root.position.z,-2.55);assert.equal(f.state().furnitureTween,null);
  assert.equal(f.state().persistentAction,null);
});

test('首次恢复房间不调用传送钩子，不改变已恢复角色/道具位置',()=>{
  const stage={controls:{enabled:true},mount(){},setActiveHalf(){},applyCameraPreset(){},setRoomCamera(){}};
  let teleports=0;
  const manager=new SceneManager(stage,{root:new THREE.Group()},buildRoom(),{playground:PLAYGROUND_DEF,room:ROOM_DEF},{onSwap(){teleports++;}});
  assert.equal(manager.initialize('room'),true);assert.equal(manager.active,'room');assert.equal(manager.transitioning,false);assert.equal(teleports,0);
  assert.equal(manager.initialize('room'),false);assert.equal(manager.transitionTo('playground'),true);
});

test('家具路径绕行且各线段安全；家具内部目标拒绝，场地不受影响',()=>{
 const room=buildRoom(),from={x:0,z:1.6},to={x:0,z:-3.5};
 const obstacle={minX:-.5,maxX:.5,minZ:-1,maxZ:0};
 const path=navigationPath(from,to,[obstacle],3.7);assert.ok(path.length>1);
 let previous=from;for(const next of path){assert.equal(segmentBlocked(previous,next,[expandObstacle(obstacle,.18)]),false);previous=next;}
 assert.equal(navigationPath(from,{x:-1.7,z:-3.1},room.obstacles,3.7),null);
 for(const spec of ['sofa','bed'].map(furnitureById))assert.ok(navigationPath(from,spec.use,room.obstacles,3.7),spec.id+' use point must be reachable');
 assert.deepEqual(recoverPosition(from,room.obstacles,[]),from,'valid saved positions are unchanged');
 const safe=recoverPosition({x:-1.7,z:-2.95},room.obstacles,['sofa','bed'].map(furnitureById).map(s=>s.use));
 assert.equal(safe.x,-1.7);assert.equal(safe.z,-2.55);
 assert.equal(segmentBlocked({x:-2,z:-.5},{x:2,z:-.5},[obstacle]),true,'large step must not tunnel');
 assert.equal(navigationPath(from,to,[],3.7).length,1);
});

test('物品落在家具表面，切回场地后旧家具碰撞体移除',async()=>{
 const hull=new Float32Array([-.05,-.05,-.05,.05,.05,.05,-.05,.05,.05,.05,-.05,-.05]);
 const p=await BasinPhysics.create(hull,4,'box','rice_scoop');
 const start=y=>p.launch({position:new THREE.Vector3(0,y,0),quaternion:new THREE.Quaternion(),velocity:new THREE.Vector3(),angularVelocity:new THREE.Vector3()});
 setPropObstacles([{x:0,y:.2,z:0,hx:.5,hy:.2,hz:.5}]);start(1);
 let result;for(let i=0;i<600;i++){stepPropWorld(1/120);result=p.step(1/120);}
 assert.ok(result.pose.position.y>.43,'prop must rest above table');assert.equal(result.resting,true);
 p.stop();setPropObstacles([]);start(.5);
 for(let i=0;i<600;i++){stepPropWorld(1/120);result=p.step(1/120);}
 assert.ok(result.pose.position.y<.1,'old collider must not remain in playground');p.stop();
});

test('家具退出后常量动画轨道也恢复，位姿覆盖不逐帧累积',async()=>{
 const {FurniturePose}=await import('../src/character/FurniturePose.ts');
 const root=new THREE.Group(),bone=new THREE.Bone();bone.name='rootx';bone.position.y=.34;root.add(bone);
 const clip=new THREE.AnimationClip('idle',2,[new THREE.VectorKeyframeTrack('rootx.position',[0,2],[0,.34,0,0,.34,0]),new THREE.QuaternionKeyframeTrack('rootx.quaternion',[0,2],[0,0,0,1,0,0,0,1])]);
 const mixer=new THREE.AnimationMixer(root);mixer.clipAction(clip).play();mixer.update(0);
 const pose=new FurniturePose(root);pose.capture();pose.sitOn('sofa','sit',.2);
 const tick=()=>{pose.beforeUpdate();mixer.update(1/60);pose.update(1/60);};
 for(let i=0;i<60;i++)tick();pose.standUp();for(let i=0;i<60;i++)tick();
 assert.ok(Math.abs(bone.position.y-.34)<1e-6);assert.ok(bone.quaternion.angleTo(new THREE.Quaternion())<1e-6);
});
