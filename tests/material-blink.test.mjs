import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {BlinkController} from '../src/character/BlinkController.ts';
import {LayeredMotionPlayer} from '../src/character/LayeredMotionPlayer.ts';
import {enableMultiWeight} from '../src/character/multiWeight.ts';
import {CHARACTER_MODEL} from '../src/character/assets.ts';
function load(file){const raw=fs.readFileSync(file),n=raw.readUInt32LE(12);return {raw,g:JSON.parse(raw.subarray(20,20+n)),binary:raw.subarray(28+n)}}
const base=load('public/models/playful-v2/character_playful.glb');
const current=load('public'+CHARACTER_MODEL);
function attribute(name){const p=current.g.meshes[0].primitives[0],a=current.g.accessors[p.attributes[name]],v=current.g.bufferViews[a.bufferView],channels=a.type==='VEC3'?3:1;return new Float32Array(current.binary.buffer,current.binary.byteOffset+(v.byteOffset??0)+(a.byteOffset??0),a.count*channels)}
async function scene(){
 const g=structuredClone(current.g);g.materials=g.materials.map(m=>({name:m.name}));
 const j=Buffer.from(JSON.stringify(g)),pad=Buffer.alloc((4-j.length%4)%4,32),header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);const bin=current.raw.subarray(20+current.raw.readUInt32LE(12));header.writeUInt32LE(20+j.length+pad.length+bin.length,8);header.writeUInt32LE(j.length+pad.length,12);header.writeUInt32LE(0x4e4f534a,16);const raw=Buffer.concat([header,j,pad,bin]);
 const gltf=await new GLTFLoader().parseAsync(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.length),'');const meshes=[];gltf.scene.traverse(m=>{if(m.isSkinnedMesh)meshes.push(m)});await enableMultiWeight(gltf,meshes);return {gltf,meshes,face:meshes.find(m=>m.geometry.getAttribute('_eyepart'))};
}
function shaderFor(material){const shader={vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader,uniforms:{}};material.onBeforeCompile(shader,{});return shader}
test('material asset keeps all source geometry, materials, skin and 45 authored animations',()=>{
 assert.ok(current.binary.subarray(0,base.binary.length).equals(base.binary));assert.ok(base.g.animations.every((a) => current.g.animations.some((b) => JSON.stringify(b) === JSON.stringify(a))),'旧 45 段必须原样保留');assert.equal(current.g.animations.length,61,'新副本 = 旧 45 段 + 16 段象棋动作');assert.deepEqual(current.g.skins,base.g.skins);assert.deepEqual(current.g.materials,base.g.materials);const meshes=structuredClone(current.g.meshes);delete meshes[0].primitives[0].attributes._EYEPART;assert.deepEqual(meshes,base.g.meshes);assert.equal(current.g.meshes.length,base.g.meshes.length);assert.ok(!('_EYECLOSE'in current.g.meshes[0].primitives[0].attributes));
});
test('all six retired helpers are tagged, including the two lower sheets exposed below the ears',()=>{
 const p=attribute('POSITION'),tag=attribute('_EYEPART');let helpers=0,lowerLeft=0,lowerRight=0;
 for(let i=0;i<tag.length;i++)if(tag[i]===2){helpers++;if(Math.abs(p[i*3+1]-.53)<.0003){if(p[i*3]>0)lowerLeft++;else lowerRight++}}
 assert.equal(helpers,1356);assert.equal(lowerLeft,290);assert.equal(lowerRight,290);assert.ok(tag.every(v=>v===0||v===1||v===2));
});
test('material blink uses the shared scheduler, remains independent of body animation and keeps vertex arrays intact',async()=>{
 const {gltf,face}=await scene();const position=face.geometry.getAttribute('position').array.slice(),normal=face.geometry.getAttribute('normal').array.slice();const player=new LayeredMotionPlayer(gltf.scene,gltf.animations),blink=player.blink;assert.equal(blink.mode,'material');assert.ok(blink.available);const shader=shaderFor(face.material);
 assert.equal(shader.uniforms.materialBlinkLeft.value,0);assert.equal(shader.uniforms.materialBlinkRight.value,0);
 blink.setManual(1,0);player.gesture('nod');player.update(.1);assert.equal(shader.uniforms.materialBlinkLeft.value,1);assert.equal(shader.uniforms.materialBlinkRight.value,0);
 blink.setManual(null);blink.trigger();player.update(.1);assert.equal(shader.uniforms.materialBlinkLeft.value,1);assert.equal(shader.uniforms.materialBlinkRight.value,1);player.update(.2);assert.equal(shader.uniforms.materialBlinkLeft.value,0);assert.equal(shader.uniforms.materialBlinkRight.value,0);
 blink.enabled=false;blink.update(.1);assert.equal(shader.uniforms.materialBlinkLeft.value,0);assert.deepEqual(face.geometry.getAttribute('position').array,position);assert.deepEqual(face.geometry.getAttribute('normal').array,normal);
});
test('material and shadow patches retain full-weight skinning and hide helper sheets without geometry displacement',async()=>{
 const {gltf,face}=await scene();new BlinkController(gltf.scene);const shader=shaderFor(face.material);
 assert.match(shader.vertexShader,/skinIndex1/);assert.match(shader.vertexShader,/skinned \/= max/);assert.doesNotMatch(shader.vertexShader,/eyeClosure|materialBlinkSurface|transformed\.z\s*\+=/);assert.match(shader.fragmentShader,/vMaterialEyePart>1\.5/);
 for(const material of [face.customDepthMaterial,face.customDistanceMaterial]){const s=shaderFor(material);assert.match(s.vertexShader,/skinIndex1/);assert.match(s.fragmentShader,/vMaterialEyePart>1\.5/);assert.doesNotMatch(s.vertexShader,/eyeClosure|transformed\.z\s*\+=/)}
});
