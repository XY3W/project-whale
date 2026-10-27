import test from 'node:test';
import * as THREE from 'three';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {LayeredMotionPlayer} from '../src/character/LayeredMotionPlayer.ts';
globalThis.self??=globalThis;
globalThis.ProgressEvent??=class extends Event {constructor(type,opts={}){super(type);Object.assign(this,opts);}};
const buf=readFileSync(new URL('../public/models/playful-v2/character_playful.glb',import.meta.url));
const jsonLength=buf.readUInt32LE(12);const j=JSON.parse(buf.subarray(20,20+jsonLength).toString());
const binOffset=20+jsonLength+8;const binLength=buf.readUInt32LE(binOffset-8);
j.buffers[0].uri='data:application/octet-stream;base64,'+buf.subarray(binOffset,binOffset+binLength).toString('base64');
// Same authored bone channels, avoiding browser-only texture decoding in a Node regression.
for(const n of j.nodes){delete n.mesh;delete n.skin;}
j.meshes=[];j.skins=[];j.images=[];j.textures=[];j.materials=[];
for(const a of j.animations)a.channels=a.channels.filter(c=>c.target.path!=='weights');
async function player(){const gltf=await new GLTFLoader().parseAsync(JSON.stringify(j),'');return new LayeredMotionPlayer(gltf.scene,gltf.animations);}
test('真实45片段资产：1/10/32连敲无漏击重击，时刻为0.94+0.6i',async()=>{
 for(const count of [1,10,32]){const p=await player(),hits=[];const pending=p.performKnocks(count,index=>hits.push({index,time:p.performanceTime}));
  for(let i=0;i<1000&&p.performing;i++)p.update(.073);
  assert.equal(await pending,true);assert.equal(hits.length,count);for(let i=0;i<count;i++){assert.equal(hits[i].index,i+1);assert.ok(Math.abs(hits[i].time-(.94+.6*i))<.0001);}
 }
});
test('大帧跨越事件且第2下取消，后面30下不能提交',async()=>{const p=await player();const hits=[];const pending=p.performKnocks(32,i=>{hits.push(i);if(i===2)p.cancelPerformance();});p.update(10);for(let i=0;i<20&&p.performing;i++)p.update(.05);assert.equal(await pending,false);assert.deepEqual(hits,[1,2]);});
test('think为有界单次，会退出上身层',async()=>{const p=await player();p.gesture('think');for(let i=0;i<1000&&p.state.upper;i++)p.update(.05);assert.equal(p.state.upper,null);});

test('dig接触偏移实测：小幅后移站位可让勺头落在占用格',async()=>{
 const p=await player(),catalog=JSON.parse(readFileSync(new URL('../public/models/playful-v2/catalog.json',import.meta.url),'utf8'));let tip;
 const binding=catalog.bindings[catalog.props.rice_scoop.binding];
 const promise=p.perform('dig',[{time:.72,type:'dig_contact'}],()=>{p.root.updateMatrixWorld(true);const bone=p.root.getObjectByName(binding.bone.replace(/[^A-Za-z0-9_]/g,''));const m=new THREE.Matrix4().multiplyMatrices(bone.matrixWorld,new THREE.Matrix4().fromArray(binding.matrixColumnMajor));tip=new THREE.Vector3(...catalog.props.rice_scoop.collisionProxies.at(-1).center).applyMatrix4(m);},'full_except_left_arm');
 for(let i=0;i<100&&p.performing;i++)p.update(.05);await promise;
 assert.ok(Math.abs(tip.x-(-.23349058477014467))<1e-5&&Math.abs(tip.z-.30985648067934773)<1e-5);
 assert.ok(Math.abs(tip.x)<=.25&&Math.abs(tip.z-.08)<=.25);
});
