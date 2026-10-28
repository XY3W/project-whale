import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Stage} from './core/Stage';
import {enableMultiWeight} from './character/multiWeight';
import {LayeredMotionPlayer} from './character/LayeredMotionPlayer';
async function boot(){
 const stage=new Stage(document.getElementById('app')!);const status=document.getElementById('status')!;
 const gltf=await new GLTFLoader().loadAsync('/models/blink-v1/character_blink_v1.glb');
 const meshes:THREE.SkinnedMesh[]=[];gltf.scene.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh)return;m.frustumCulled=false;m.castShadow=!m.name.startsWith('Blink_');m.receiveShadow=true;if((m as THREE.SkinnedMesh).isSkinnedMesh)meshes.push(m as THREE.SkinnedMesh)});
 await enableMultiWeight(gltf,meshes);stage.scene.add(gltf.scene);const player=new LayeredMotionPlayer(gltf.scene,gltf.animations);stage.controls.minDistance=.4;stage.controls.maxDistance=4;stage.controls.target.set(0,.69,0);stage.camera.position.set(0,.69,1.25);stage.camera.lookAt(stage.controls.target);
 const controls=document.getElementById('controls')!;
 function button(label:string,action:()=>void){const b=document.createElement('button');b.textContent=label;b.onclick=()=>{action();status.textContent=label};controls.append(b)}
 button('自然眨眼',()=>player.blink.setManual(null));button('眨一次',()=>player.blink.trigger());button('睁眼',()=>player.blink.setManual(0));button('半闭',()=>player.blink.setManual(.5));button('闭眼',()=>player.blink.setManual(1));button('左眼',()=>player.blink.setManual(1,0));button('右眼',()=>player.blink.setManual(0,1));button('点头',()=>player.gesture('nod'));button('摇头',()=>player.gesture('look_left'));
 status.textContent=player.blink.available?'已载入 · 可拖动检查侧面，滚动缩放；默认自然眨眼':'眨眼资产缺失';const clock=new THREE.Clock();stage.renderer.setAnimationLoop(()=>{player.update(Math.min(clock.getDelta(),.05));stage.update()});
}
void boot().catch(e=>{document.getElementById('status')!.textContent=String(e);console.error(e)});
