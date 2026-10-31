import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Stage } from '../../src/core/Stage.ts';
import { enableMultiWeight } from '../../src/character/multiWeight.ts';
import { BlinkController } from '../../src/character/BlinkController.ts';
const $ = s => document.querySelector(s);
const dir = '/models/xiangqi-v1/';
window.addEventListener('unhandledrejection',e=>{$('#status').textContent='预览载入失败：'+String(e.reason);});
const stage = new Stage($('#view'));
stage.controls.minDistance = .5; stage.controls.maxDistance = 24;
stage.groundTop.visible=false;
stage.scene.background = new THREE.Color('#18212d');
stage.scene.traverse(o=>{if(o.isDirectionalLight&&o.castShadow){o.shadow.normalBias=.003;o.shadow.bias=-.0001;o.shadow.camera.left=-5.8;o.shadow.camera.right=5.8;o.shadow.camera.top=5.8;o.shadow.camera.bottom=-5.8;o.shadow.camera.updateProjectionMatrix();}});
const loader = new GLTFLoader();
const read = async name => { const r = await fetch(dir + name); if (!r.ok) throw Error(name + ': ' + r.status); return r.json(); };
const [gltf, pieces, board, ladle, basin, catalog, curves, layout] = await Promise.all([
  loader.loadAsync(dir + 'character_xiangqi.glb'), loader.loadAsync(dir + 'pieces.glb'),
  loader.loadAsync(dir + 'board.glb'), loader.loadAsync('/models/playful-v2/rice_scoop_straight_v3.glb'),
  loader.loadAsync('/models/playful-v2/steel_basin_v2.glb'), read('catalog.json'), read('prop_motion.json'), read('initial_layout.json'),
]);
const actor = new THREE.Group(); actor.add(gltf.scene); stage.scene.add(actor);
const skins=[];
gltf.scene.traverse(o => { if(o.isMesh) { o.frustumCulled=false; o.castShadow=true; o.receiveShadow=true; } if(o.isSkinnedMesh) skins.push(o); });
await enableMultiWeight(gltf, skins);
const blink = new BlinkController(gltf.scene);
const mixer = new THREE.AnimationMixer(gltf.scene);
const byName = new Map(gltf.animations.map(a=>[a.name,a]));
const normalize = n=>n.replace(/[^A-Za-z0-9_]/g,'');
const bones = new Map(); gltf.scene.traverse(o=>bones.set(normalize(o.name),o));
const waistTracks = new Set(byName.get('stow_scoop').tracks.map(t=>t.name));
const baseTracks = ['idle_stand.lower','idle_stand.upperBase','tail_idle'].flatMap(n=>byName.get(n).tracks).filter(t=>!waistTracks.has(t.name));
const waistBase = new THREE.AnimationClip('waist_base',4,baseTracks);
let currentAction=null, currentName='';
function pose(name,t) {
  if(name!==currentName) {
    mixer.stopAllAction();
    if(name==='stow_scoop'||name==='unstow_scoop') { const a=mixer.clipAction(waistBase); a.reset().play(); a.paused=true; a.time=0; }
    currentAction=mixer.clipAction(byName.get(name)); currentAction.reset().setLoop(THREE.LoopOnce,1).play(); currentAction.clampWhenFinished=true; currentAction.paused=true; currentName=name;
  }
  currentAction.time=Math.min(t,byName.get(name).duration); mixer.update(0); actor.updateMatrixWorld(true);
}
const templates=new Map(pieces.scene.children.map(o=>[o.name,o]));
function template(id){const ob=templates.get(id);if(!ob)throw Error('missing template '+id);const copy=ob.clone(true);copy.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});return copy;}
const carried=new THREE.Group();const royal=template('piece_red_0'),pawn=template('piece_black_6');carried.add(royal,pawn);stage.scene.add(carried);
const victim=template('piece_black_4'); stage.scene.add(victim);
const scoop=new THREE.Group();scoop.add(ladle.scene);stage.scene.add(scoop);
const hat=new THREE.Group();hat.add(basin.scene);stage.scene.add(hat);
const expandedFloor=new THREE.Mesh(new THREE.BoxGeometry(...[catalog.board.extentM[0],.1,catalog.board.extentM[1]]),new THREE.MeshStandardMaterial({color:0x182436,roughness:.9}));expandedFloor.position.y=-.052;stage.scene.add(expandedFloor);
board.scene.traverse(o=>{if(o.isMesh)o.receiveShadow=true;});board.scene.position.y=.001;stage.scene.add(board.scene);board.scene.visible=true;
const allPieces=new THREE.Group();stage.scene.add(allPieces);
for(const it of layout){const o=template(it.template);o.position.fromArray(it.position);o.rotation.y=it.rotationY;o.userData.pieceId=it.pieceId;allPieces.add(o);}allPieces.visible=false;
function sample(rows,t){if(t<=rows[0].time)return rows[0];if(t>=rows.at(-1).time)return rows.at(-1);let i=0;while(rows[i+1].time<t)i++;const a=rows[i],b=rows[i+1],u=(t-a.time)/(b.time-a.time);return{position:a.position.map((v,k)=>v+(b.position[k]-v)*u),quaternion:new THREE.Quaternion().fromArray(a.quaternion).slerp(new THREE.Quaternion().fromArray(b.quaternion),u).toArray()};}
function worldCurve(object,row){const m=new THREE.Matrix4().compose(new THREE.Vector3().fromArray(row.position),new THREE.Quaternion().fromArray(row.quaternion),new THREE.Vector3(1,1,1));m.premultiply(actor.matrixWorld);m.decompose(object.position,object.quaternion,object.scale);}
const duration=n=>catalog.actions.find(a=>a.id===n).duration;
let mode='demo',boardMode=false,playing=true,elapsed=0,manualName='chess_hold',manualTime=0;
const walking=[['chess_carry_start',.8],...Array.from({length:4},()=>['chess_carry_walk',1.6]),['chess_carry_stop',.8],...Array.from({length:4},()=>['chess_carry_adjust_08',.8]),['chess_carry_adjust_02',.8]];
const demos={demo:[['stow_scoop',1.4],['chess_pickup',1.8],...walking,['chess_place',1.8]],safe:[['chess_hold',.5],['chess_safe_setdown',1.6],['chess_recover',1.8],['chess_hold',.6]],capture:[['chess_capture_place',1.8]]};
const boardStartZ=layout.find(p=>p.pieceId==='black_soldier_3').position[2]-catalog.chessAttachment.standOffM;
function travel(n,t){const u=t/duration(n);if(n==='chess_carry_start')return .045*u*u;if(n==='chess_carry_stop')return .045*(2*u-u*u);if(n==='chess_carry_walk')return .1125*t;if(n.includes('_adjust_'))return Number(n.slice(-2))/100*(u*u*(3-2*u));return 0;}
function sequenceFrame(){let t=elapsed,dist=0;const seq=demos[mode];for(let i=0;i<seq.length;i++){const [n,d]=seq[i];if(t<=d||i===seq.length-1)return{n,t:Math.min(t,d),dist:dist+travel(n,Math.min(t,d)),finished:elapsed>=seq.reduce((s,a)=>s+a[1],0)};t-=d;dist+=travel(n,d);} }
function reset(next){mode=next;elapsed=0;playing=true;currentName='';$('#pause').textContent='暂停';}
$('#demo').onclick=()=>reset('demo');$('#safe').onclick=()=>{boardMode=false;reset('safe');};$('#capture').onclick=()=>{boardMode=false;reset('capture');};$('#pause').onclick=()=>{playing=!playing;$('#pause').textContent=playing?'暂停':'继续';};
for(const a of catalog.actions){const op=document.createElement('option');op.value=a.id;op.textContent=a.id;$('#clip').append(op);}$('#clip').value='chess_hold';
$('#clip').onchange=()=>{mode='manual';boardMode=false;manualName=$('#clip').value;manualTime=0;currentName='';playing=true;};
$('#time').oninput=()=>{mode='manual';boardMode=false;manualName=$('#clip').value;manualTime=Number($('#time').value)*duration(manualName);playing=false;};
let view='quarter',lastFollow=0;let recorder=null;
function camera(kind){lastFollow=0;view=kind;const target=kind==='board'?new THREE.Vector3(0,0,0):kind==='hands'?new THREE.Vector3(0,.48,.27):new THREE.Vector3(0,.58,.20);stage.controls.target.copy(target);const p={front:[0,.75,2.75],side:[2.75,.75,.05],back:[0,.75,-2.75],quarter:[1.9,.9,2.3],hands:[.75,.88,1.45],board:[8.75,16.25,15]}[kind];stage.camera.position.fromArray(p);stage.controls.update();}
$('#views').onclick=e=>{const k=e.target.dataset.view;if(!k)return;if(k==='board'){boardMode=true;reset('demo');}camera(k);};camera('quarter');
let caption='';
function frame(dt){if(mode==='manual'){if(playing)manualTime=(manualTime+dt)%duration(manualName);}else if(playing)elapsed+=dt;const f=mode==='manual'?{n:manualName,t:manualTime,dist:0}:sequenceFrame();const inBoard=boardMode&&mode==='demo';board.scene.visible=true;allPieces.visible=inBoard;royal.visible=!inBoard;pawn.visible=inBoard;actor.position.set(0,0,(inBoard?boardStartZ:0)+f.dist);actor.updateMatrixWorld(true);pose(f.n,f.t);
  const c=curves.clips[f.n];worldCurve(carried,sample(c.chess,f.t));worldCurve(scoop,sample(c.scoop,f.t));carried.visible=!['stow_scoop','unstow_scoop'].includes(f.n);victim.visible=f.n==='chess_capture_place'&&f.t<1.1;victim.position.set(0,0,catalog.chessAttachment.standOffM);victim.quaternion.identity();
  if(inBoard){for(const ob of allPieces.children)ob.visible=ob.userData.pieceId!=='black_soldier_3';if(!carried.visible){const p=allPieces.children.find(o=>o.userData.pieceId==='black_soldier_3');p.visible=true;}}
  hat.visible=$('#basin').checked;const hb=catalog.bindings.head;const hm=new THREE.Matrix4().multiplyMatrices(bones.get(normalize(hb.bone)).matrixWorld,new THREE.Matrix4().fromArray(hb.matrixColumnMajor));hm.decompose(hat.position,hat.quaternion,hat.scale);
  for(const mesh of skins){const i=mesh.morphTargetDictionary?.Basin_v2_Wear_Crown_Tuck;if(i!==undefined)mesh.morphTargetInfluences[i]=hat.visible?1:0;}
  if($('#blink').checked){blink.setManual(null);blink.update(dt);}else blink.setManual(0);
  if(f.finished)playing=false;
  const text=f.n+' · '+f.t.toFixed(2)+'s'+(f.n==='chess_capture_place'?' · 0.40s 送出 / 1.10s 等结算':'');if(caption!==text){$('#caption').textContent=text;caption=text;}$('#timelabel').textContent=text;if(mode==='manual')$('#time').value=String(f.t/duration(f.n));if(!inBoard&&view!=='board'){const delta=f.dist-lastFollow;stage.camera.position.z+=delta;stage.controls.target.z+=delta;lastFollow=f.dist;}if(f.finished&&recorder?.state==='recording')recorder.stop();stage.update();}
$('#status').textContent=`已载入：14 种棋面 / 32 枚棋子\n${catalog.actions.length} 段新动作 · 保留材质眨眼\n满盘演示：1.15 米格距与精准补步`;
let last=performance.now();stage.renderer.setAnimationLoop(()=>{const now=performance.now();frame(Math.min((now-last)/1000,.05));last=now;});
// Deterministic frame control for local capture/QA; no game or network commands.
window.assetPreview={catalog,actor,carried,scoop,mixer,renderAt(name,time,kind='quarter'){mode='manual';manualName=name;manualTime=time;playing=false;boardMode=false;currentName='';camera(kind);frame(0);},demoAt(time,kind='quarter',full=false){mode='demo';elapsed=time;playing=false;boardMode=full;currentName='';camera(kind);frame(0);},setMode(next,time,kind='quarter'){mode=next;elapsed=time;playing=false;boardMode=false;currentName='';camera(kind);frame(0);},canvas:stage.renderer.domElement};

function saveBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
$('#seconds').oninput=()=>{mode='manual';boardMode=false;manualName=$('#clip').value;manualTime=Math.max(0,Math.min(duration(manualName),Number($('#seconds').value)));playing=false;};
$('#png').onclick=()=>{stage.update();stage.renderer.domElement.toBlob(blob=>saveBlob(blob,`${manualName}-${view}.png`));};
$('#video').onclick=()=>{if(recorder?.state==='recording'){recorder.stop();return;}const chosen=mode==='manual'?'demo':mode;const full=boardMode&&chosen==='demo';camera(full?'board':'quarter');boardMode=full;reset(chosen);const chunks=[];const stream=stage.renderer.domElement.captureStream(24);const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:3500000});recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=()=>{saveBlob(new Blob(chunks,{type:mime}),`xiangqi-${chosen}${full?'-board':''}.webm`);for(const track of stream.getTracks())track.stop();$('#video').textContent='导出当前流程视频';};recorder.start();$('#video').textContent='正在录制 · 点击提前结束';};
