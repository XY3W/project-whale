import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {BasinPhysics,stepPropWorld,onPropImpact} from '../src/prop/basinPhysics.ts';
const hull=new Float32Array([-0.15,-0.05,-0.15,.15,.05,.15,-.15,.05,.15,.15,-.05,-.15]);
test('共享物理：盆可撞场景勺，法向入射速度触发一次音效事件',async()=>{
 const impacts=[];onPropImpact(e=>impacts.push(e));
 const basin=await BasinPhysics.create(hull,4,'cylinder','basin');const scoop=await BasinPhysics.create(hull,4,'box','rice_scoop');
 scoop.syncStatic({position:new THREE.Vector3(.8,.08,0),quaternion:new THREE.Quaternion()});
 basin.launch({position:new THREE.Vector3(0,.1,0),quaternion:new THREE.Quaternion(),velocity:new THREE.Vector3(4,0,0),angularVelocity:new THREE.Vector3()});
 for(let i=0;i<120;i++){stepPropWorld(1/120);basin.step(1/120);}
 assert.ok(impacts.some(e=>e.pair.includes('rice_scoop')&&e.normalSpeed>.2),JSON.stringify(impacts));
 assert.ok(impacts.every(e=>e.normalSpeed>=.18));assert.equal(new Set(impacts.map(e=>e.id)).size,impacts.length);
 basin.stop();scoop.syncStatic(null);
});
