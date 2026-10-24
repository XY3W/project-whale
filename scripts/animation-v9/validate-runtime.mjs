import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import * as THREE from 'three';
const output='public/models/animation-v9';
const source=fs.readFileSync('src/character/LayeredMotionPlayer.ts','utf8');
const built=path.resolve('scripts/animation-v9/player.generated.mjs');
fs.writeFileSync(built,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
const {LayeredMotionPlayer}=await import('file://'+built);
const raw=fs.readFileSync(output+'/character_v9.glb');const jlen=raw.readUInt32LE(12);const g=JSON.parse(raw.subarray(20,20+jlen));const binary=raw.subarray(28+jlen);
function accessor(i){const a=g.accessors[i],b=g.bufferViews[a.bufferView],size={5121:1,5123:2,5125:4,5126:4}[a.componentType],n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[a.type];const out=[];for(let k=0;k<a.count;k++)for(let c=0;c<n;c++){const off=(b.byteOffset??0)+(a.byteOffset??0)+k*(b.byteStride??n*size)+c*size;let v=a.componentType===5126?binary.readFloatLE(off):a.componentType===5123?binary.readUInt16LE(off):a.componentType===5125?binary.readUInt32LE(off):binary.readUInt8(off);if(a.normalized)v/=a.componentType===5123?65535:255;out.push(v);}return out;}
function create(){const root=new THREE.Group();const nodes=g.nodes.map(n=>{const o=new THREE.Object3D();o.name=n.name??'';if(n.matrix)new THREE.Matrix4().fromArray(n.matrix).decompose(o.position,o.quaternion,o.scale);else{o.position.fromArray(n.translation??[0,0,0]);o.quaternion.fromArray(n.rotation??[0,0,0,1]);o.scale.fromArray(n.scale??[1,1,1]);}return o;});g.nodes.forEach((n,i)=>{for(const c of n.children??[])nodes[i].add(nodes[c]);});for(const i of g.scenes[g.scene??0].nodes)root.add(nodes[i]);const clips=g.animations.map(a=>new THREE.AnimationClip(a.name,-1,a.channels.map(ch=>{const s=a.samplers[ch.sampler],key={translation:'position',rotation:'quaternion',scale:'scale'}[ch.target.path];const Type=key==='quaternion'?THREE.QuaternionKeyframeTrack:THREE.VectorKeyframeTrack;return new Type(nodes[ch.target.node].uuid+'.'+key,accessor(s.input),accessor(s.output),THREE.InterpolateLinear);})));return{root,nodes,player:new LayeredMotionPlayer(root,clips)};}
const tracks=JSON.parse(fs.readFileSync(output+'/tracks.json'));const set=n=>new Set(tracks[n].map(t=>t.node+'.'+t.property));const same=(a,b)=>assert.deepEqual([...set(a)].sort(),[...set(b)].sort());same('idle_stand.upperBase','greet');same('walk.upperBase','greet');same('tail_idle','tail_swish');for(const a of set('walk.lower'))assert(!set('greet').has(a)&&!set('tail_idle').has(a));
const sample=create();sample.player.setWalking(true);sample.player.gesture('greet');sample.player.setTail(true);
let maxQuaternionError=0;
for(let i=0;i<360;i++){sample.player.update(1/60);sample.root.updateMatrixWorld(true);for(const o of sample.nodes){assert(o.matrixWorld.elements.every(Number.isFinite));maxQuaternionError=Math.max(maxQuaternionError,Math.abs(o.quaternion.length()-1));}if(i===90)assert.equal(sample.player.state.upper,'greet');if(i===240){assert.equal(sample.player.state.upper,null);assert(sample.player.state.walkWeight>.999);}}
// Changing upper must not perturb any lower bone world matrix (including root and feet).
const base=create(),combo=create();base.player.setWalking(true);combo.player.setWalking(true);combo.player.gesture('greet');combo.player.setTail(true);const lowerNames=new Set(tracks['walk.lower'].map(t=>t.node));let lowerError=0;
for(let i=0;i<240;i++){base.player.update(1/60);combo.player.update(1/60);base.root.updateMatrixWorld(true);combo.root.updateMatrixWorld(true);for(let j=0;j<g.nodes.length;j++)if(lowerNames.has(g.nodes[j].name))for(let k=0;k<16;k++)lowerError=Math.max(lowerError,Math.abs(base.nodes[j].matrixWorld.elements[k]-combo.nodes[j].matrixWorld.elements[k]));}
assert(lowerError<1e-6);assert(maxQuaternionError<1e-5);
combo.player.gesture('think');for(let i=0;i<60;i++)combo.player.update(1/60);combo.player.gesture('nod');for(let i=0;i<20;i++)combo.player.update(1/60);assert.equal(combo.player.state.upper,'nod');combo.player.clearGesture();combo.player.setWalking(false);for(let i=0;i<180;i++)combo.player.update(1/60);assert.equal(combo.player.state.upper,null);assert.equal(combo.player.state.walkWeight,0);
// Sample raw glTF skinning under blends: all weight groups, no shader approximation.
const primitives=[];g.nodes.forEach((n,ni)=>{if(n.mesh===undefined||n.skin===undefined)return;const skin=g.skins[n.skin],inverse=accessor(skin.inverseBindMatrices);for(const p of g.meshes[n.mesh].primitives){const positions=accessor(p.attributes.POSITION);const groups=[];for(let s=0;p.attributes['WEIGHTS_'+s]!==undefined;s++)groups.push({j:accessor(p.attributes['JOINTS_'+s]),w:accessor(p.attributes['WEIGHTS_'+s])});primitives.push({ni,skin,inverse,positions,groups,indices:accessor(p.indices)});}});
const q=create();const bow=[];for(const [pi,p]of primitives.entries()){for(let i=0;i<p.positions.length/3;i++){const [x,y,z]=p.positions.slice(i*3,i*3+3);if(Math.abs(x)<.073&&z>.043&&y>.414&&y<.49)bow.push([pi,i]);}}
function point(p,i,nodes){let v=new THREE.Vector3().fromArray(p.positions,i*3),out=new THREE.Vector3(),sum=0;for(const group of p.groups)for(let c=0;c<4;c++){const k=i*4+c,w=group.w[k];if(!w)continue;const joint=group.j[k],mat=new THREE.Matrix4().multiplyMatrices(nodes[p.skin.joints[joint]].matrixWorld,new THREE.Matrix4().fromArray(p.inverse,joint*16));out.addScaledVector(v.clone().applyMatrix4(mat),w);sum+=w;}return out.multiplyScalar(1/sum);}
q.player.update(0);q.root.updateMatrixWorld(true);const bowSets=primitives.map(()=>new Set());for(const [pi,i]of bow)bowSets[pi].add(i);const bowEdges=[];
primitives.forEach((p,pi)=>{const set=bowSets[pi];for(let k=0;k<p.indices.length;k+=3)for(const [a,b]of [[0,1],[1,2],[2,0]]){const i=p.indices[k+a],j=p.indices[k+b];if(set.has(i)&&set.has(j)){const length=point(p,i,q.nodes).distanceTo(point(p,j,q.nodes));if(length>1e-5)bowEdges.push({pi,i,j,length});}}});
let maxBow=1,minBow=1; q.player.setWalking(true);q.player.gesture('greet');q.player.setTail(true);
for(let f=0;f<90;f++){q.player.update(1/30);q.root.updateMatrixWorld(true);if(f%5!==0)continue;for(const e of bowEdges){const ratio=point(primitives[e.pi],e.i,q.nodes).distanceTo(point(primitives[e.pi],e.j,q.nodes))/e.length;maxBow=Math.max(maxBow,ratio);minBow=Math.min(minBow,ratio);}}
const report={clipCount:g.animations.length,semanticActions:10,internalTransitions:2,trackPartitionPassed:true,upperRestoresWalking:true,interruptPassed:true,maxQuaternionError,lowerWorldMatrixError:lowerError,comboBowEdgeRatio:[minBow,maxBow],comboBowEdgeCount:bowEdges.length};
fs.writeFileSync(output+'/runtime-validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
assert(bowEdges.length>0);assert(maxBow<1.05&&minBow>.95);

// Authored start/stop and cyclic support must cancel world translation at all released speeds.
const footReports=[];
for(const speed of [.75,1,1.25]){
 const scene=create();scene.player.speed=speed;scene.player.setWalking(true);let travel=0;const previous={};let maxSlip=0;let supportSamples=0;
 for(let i=0;i<900;i++){
  if(i===300)scene.player.setWalking(false);
  const beforeBase=scene.player.state.base;scene.player.update(1/120);travel+=scene.player.movementDelta;scene.root.updateMatrixWorld(true);
  const baseName=scene.player.state.base,t=scene.player.baseTime;
  let side=baseName==='walk_start'?'r':baseName==='walk_stop'?'l':baseName==='walk'?(t<.8?'l':'r'):null;
  if(side){const node=scene.nodes.find(n=>n.name==='foot.'+side);const pos=node.getWorldPosition(new THREE.Vector3());pos.z+=travel;const prev=previous[side];if(prev&&prev.base===baseName&&beforeBase===baseName&&t> .02 && (baseName!=='walk'||Math.abs(t-.8)>.02)){maxSlip=Math.max(maxSlip,pos.distanceTo(prev.pos));supportSamples++;}previous[side]={pos,base:baseName};}else{delete previous.l;delete previous.r;}
 }
 assert.equal(scene.player.state.base,'idle_stand');assert(supportSamples>100);assert(maxSlip<.0002,`support slip ${speed}: ${maxSlip}`);footReports.push({speed,maxSupportStepSlipM:maxSlip,supportSamples});
}
report.footSupportAcrossStartWalkStop=footReports;fs.writeFileSync(output+'/runtime-validation.json',JSON.stringify(report,null,2));console.log('SUPPORT',footReports);
