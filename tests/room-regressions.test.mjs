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
  const stop=src.slice(src.indexOf('  const stopMotion='),src.indexOf('  const basinBridge:'));
  const taskStart=src.indexOf('    onTaskState:');
  const task=src.slice(taskStart,src.indexOf('    onError:',taskStart));
  const support=`let destination=null,postTurn=null,phase='idle',taskActive=false;
    const chat={setThinking(){},endReasoning(){}},setLlmThinking=()=>{},snapshot=()=>({});
    const signals=[];const client={ready(id){signals.push('ready:'+id)},acknowledgeStop(id){signals.push('stopped:'+id)}};`;
  const code=ts.transpileModule(block+`\nlet motionOwner='none',motionEpoch=0,currentExecutor=null;\n`+
    `const waitBodySettled=async()=>{await waitForProgress(()=>!furnitureTween&&(furniturePose.activeName!==null||furniturePose.currentWeight===0));return true;};\n`+
    `function makeExecutor(){const ex={cancel(){},async run(plan){const steps=[];for(const step of plan.steps){const r=await furnitureBridge.perform(step,'s');steps.push({action:step.action,status:r.ok?'succeeded':'failed'});}return {steps}}};currentExecutor=ex;return ex;}\n`+ensure+run+
    support+stop+`const handlers={${task}};\nreturn {stop:stopMotion,task:handlers.onTaskState,signals,bridge:furnitureBridge,leave:leaveFurniture,ensure:ensureStanding,run:runOwned,state:()=>({persistentAction,furnitureTween}),tick(dt){${tween} furniturePose.currentWeight=furniturePose.targetWeight;}};`,
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const root=new THREE.Group();const use=furnitureById('sofa').use;root.position.set(use.x,0,use.z);
  const pose={activeName:null,activeFurniture:null,currentWeight:0,targetWeight:0,
    sitOn(id,name,_height,options){this.activeFurniture=id;this.activeName=name;this.targetWeight=1;if(options?.instant)this.currentWeight=1;},
    standUp(){this.activeName=null;this.activeFurniture=null;this.targetWeight=0;}};
  let f;
  const wait=async check=>{for(let i=0;!check();i++){assert.ok(i<100,'transition did not settle');await new Promise(r=>setTimeout(r,0));f.tick(1/60);}};
  const make=new Function('THREE','root','furniturePose','scenes','basin','scoop','furnitureById','FURNITURE_USE_RANGE_M','waitForProgress','bridgeEpoch','player','needsStanding',code);
  f=make(THREE,root,pose,{active:'room',transitioning:false,furniture:[{id:'sofa'},{id:'bed'}]}, {state:'resting',cancel(){}}, {state:'resting',cancel(){}},furnitureById,1.2,wait,1,{clearGesture(){},setWalking(){},haltMovement(){},setTail(){},cancelPerformance(){}},needsStanding);
  return {...f,root,pose};
}

test('起身即使从未坐下，也不残留持续动作',async()=>{
  assert.equal(needsStanding([{action:'parallel',items:[{action:'move_to'},{action:'tail'}]}]),true);
  assert.equal(needsStanding([{action:'throw'}]),true);
  assert.equal(needsStanding([{action:'use_furniture'}]),false);
  const f=furnitureFixture();
  await f.run('plan',{steps:[{action:'use_furniture',furniture_id:'none'}]});
  assert.equal(f.state().persistentAction,null);
  await f.run('plan',{steps:[{action:'use_furniture',furniture_id:'sofa'}]});
  assert.equal(f.state().persistentAction,'use_furniture');assert.equal(f.pose.currentWeight,1);
  await f.run('plan',{steps:[{action:'use_furniture',furniture_id:'none'}]});
  assert.equal(f.state().persistentAction,null);assert.equal(f.state().furnitureTween,null);
  assert.equal(f.root.position.z,furnitureById('sofa').use.z);
  await f.bridge.perform({furniture_id:'sofa'},'s');
  await f.ensure();
  assert.equal(f.pose.currentWeight,0,'同一计划后续移动也必须等起身结束');
  assert.equal(f.root.position.z,furnitureById('sofa').use.z);
});

test('打断坐下后不会被旧补间拉回座面，重复起身也不截断退出过渡',async()=>{
  const f=furnitureFixture();
  const entering=f.bridge.perform({furniture_id:'sofa'},'s',{isCancelled:()=>f.pose.activeName===null});
  f.tick(.1);f.leave();f.leave();
  await entering;for(let i=0;i<60;i++)f.tick(1/60);
  assert.equal(f.root.position.z,furnitureById('sofa').use.z);assert.equal(f.state().furnitureTween,null);
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
 assert.equal(navigationPath(from,{x:furnitureById('sofa').position[0],z:furnitureById('sofa').position[1]},room.obstacles,3.7),null);
 for(const spec of ['sofa','bed'].map(furnitureById))assert.ok(navigationPath(from,spec.use,room.obstacles,3.7),spec.id+' use point must be reachable');
 assert.deepEqual(recoverPosition(from,room.obstacles,[]),from,'valid saved positions are unchanged');
 const safe=recoverPosition(furnitureById('sofa').rest,room.obstacles,['sofa','bed'].map(furnitureById).map(s=>s.use));
 assert.equal(safe.x,furnitureById('sofa').use.x);assert.equal(safe.z,furnitureById('sofa').use.z);
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

test('稳定坐躺跨过一分钟仍保持；停止、思考与新任务握手不强制起身',async()=>{
 for(const id of ['sofa','bed']){
  const f=furnitureFixture(),spec=furnitureById(id);f.root.position.set(spec.use.x,0,spec.use.z);
  await f.run('plan',{steps:[{action:'use_furniture',furniture_id:id}]});
  const rest=f.root.position.clone();f.tick(600);
  for(const phase of ['stopping','thinking','executing','checking','idle'])f.task(phase,'new-chat');
  await new Promise(r=>setTimeout(r,0));
  assert.ok(f.signals.includes('ready:new-chat'));assert.ok(f.signals.includes('stopped:new-chat'));
  assert.equal(f.pose.activeName,spec.interact);assert.equal(f.state().persistentAction,'use_furniture');
  assert.ok(f.root.position.distanceTo(rest)<1e-6);
  await f.ensure();assert.equal(f.pose.activeName,null);assert.equal(f.pose.currentWeight,0);
  assert.equal(f.root.position.z,spec.use.z);
 }
});

test('停止正在进入的坐姿仍安全退出，不保留半坐状态',async()=>{
 const f=furnitureFixture();const entering=f.bridge.perform({furniture_id:'sofa'},'s');
 f.tick(.1);f.stop();await entering;for(let i=0;i<60;i++)f.tick(1/60);
 assert.equal(f.pose.activeName,null);assert.equal(f.state().persistentAction,null);
 assert.equal(f.state().furnitureTween,null);
});
