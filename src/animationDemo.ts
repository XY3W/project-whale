import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { enableMultiWeight } from './character/multiWeight';
import { LayeredMotionPlayer } from './character/LayeredMotionPlayer';

async function boot() {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#e8edf6');
  const camera = new THREE.PerspectiveCamera(32, innerWidth/innerHeight, .01, 30); camera.position.set(1.15, .9, 3.2); camera.setViewOffset(innerWidth,innerHeight,-110,0,innerWidth,innerHeight);
  const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.toneMapping = THREE.NoToneMapping; document.body.appendChild(renderer.domElement);
  const orbit = new OrbitControls(camera, renderer.domElement); orbit.target.set(0,.52,0); orbit.enableDamping = true; orbit.minDistance = 1; orbit.maxDistance = 5;
  scene.add(new THREE.HemisphereLight(0xeef3ff,0x7b8095,1.5));
  const key = new THREE.DirectionalLight(0xffffff,2.1);key.position.set(-2,3,4);key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-2;key.shadow.camera.right=2;key.shadow.camera.top=2;key.shadow.camera.bottom=-2;key.shadow.normalBias=.003;scene.add(key);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20,20), new THREE.MeshStandardMaterial({color:0xe8edf6,roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.y=-.001;ground.receiveShadow=true;scene.add(ground);
  const gltf = await new GLTFLoader().loadAsync('/models/animation-v9/character_v9.glb'); const meshes: THREE.SkinnedMesh[]=[];
  gltf.scene.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh)meshes.push(o as THREE.SkinnedMesh);if((o as THREE.Mesh).isMesh){o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;}});
  await enableMultiWeight(gltf,meshes); scene.add(gltf.scene);
  const player = new LayeredMotionPlayer(gltf.scene,gltf.animations); let observing = true; let moving = false; let travel=0; let paused=false;
  const buttons = document.querySelector('#buttons')!;
  const status = document.querySelector('#status')!;
  const add=(label:string,fn:()=>void)=>{const b=document.createElement('button');b.textContent=label;b.onclick=fn;buttons.appendChild(b);};
  add('待机',()=>{player.setWalking(false);player.clearGesture();});
  add('原地慢走',()=>{moving=false;player.setWalking(true);});
  add('向前走',()=>{observing=false;moving=true;travel=0;player.setWalking(true);});
  for(const [label,id] of [['挥手','greet'],['注意','notice'],['点头','nod'],['看左边','look_left'],['看右边','look_right'],['思考','think']])add(label,()=>player.gesture(id));
  add('轻摆尾',()=>player.setTail(false));add('大摆尾',()=>player.setTail(true));
  add('走路＋挥手＋摆尾',()=>{moving=false;player.setWalking(true);player.gesture('greet');player.setTail(true);});
  add('恢复互动',()=>{observing=false;});
  add('暂停 / 继续',()=>{paused=!paused;});
  const view=(p:THREE.Vector3)=>{observing=true;camera.position.copy(p).add(gltf.scene.position);orbit.target.set(gltf.scene.position.x,.52,gltf.scene.position.z);orbit.update();};
  add('正面',()=>view(new THREE.Vector3(0,.65,3)));add('侧面',()=>view(new THREE.Vector3(3,.65,0)));add('背面',()=>view(new THREE.Vector3(0,.65,-3)));
  orbit.addEventListener('start',()=>{observing=true;player.setWalking(false);});
  addEventListener('keydown',e=>{if(e.key==='Escape' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement))observing=false;});
  const clock=new THREE.Clock();renderer.setAnimationLoop(()=>{
    const elapsed=Math.min(clock.getDelta(),.05);const dt=paused?0:elapsed;player.update(dt);
    if(moving){gltf.scene.position.z+=player.movementDelta;travel+=player.movementDelta;if(travel>=.22)player.setWalking(false);if(player.state.base==='idle_stand')moving=false;}
    status.textContent=`${observing?'观察模式':'互动模式'} · 不自动转身\n${({idle_stand:'待机',walk_start:'起步',walk:'慢走',walk_stop:'收步'})[player.state.base]}${paused?'（暂停）':''} / ${player.state.upper??'基础上身'} / ${player.state.tail==='tail_idle'?'轻摆尾':'大摆尾'}`;
    orbit.update();renderer.render(scene,camera);
  });
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.setViewOffset(innerWidth,innerHeight,-110,0,innerWidth,innerHeight);camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
}
boot().catch(e=>{document.querySelector('#error')!.textContent=String(e);console.error(e);});
