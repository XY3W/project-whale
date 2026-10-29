import {readFileSync,writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import ts from 'typescript';
registerHooks({resolve(s,c,next){try{return next(s,c)}catch(e){if(s.startsWith('.')&&!s.match(/\.[a-z]+$/i))return next(s+'.ts',c);throw e}},load(url,c,next){if(url.endsWith('.ts'))return{format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};return next(url,c)}});
const THREE=await import('three');
const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
const {BasinProp}=await import('./src/prop/BasinProp.ts');
const {LayeredMotionPlayer}=await import('./src/character/LayeredMotionPlayer.ts');
const {ActionExecutor}=await import('./src/behavior/ActionExecutor.ts');
const {planApproach,signedDeltaDeg}=await import('./src/prop/align.ts');
async function load(name){const raw=readFileSync('/Users/qiaonan/Documents/deepseek-harness/Project Whale/assets/minesweeper-v1/runtime/'+name);const n=raw.readUInt32LE(12);const g=JSON.parse(raw.subarray(20,20+n));
 // Geometry/animation test only: remove image-backed materials to avoid DOM image loading in Node.
 g.materials=(g.materials??[]).map(()=>({}));const j=Buffer.from(JSON.stringify(g));const pad=Buffer.alloc((4-j.length%4)%4,32);const bin=raw.subarray(20+n);const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(20+j.length+pad.length+bin.length,8);header.writeUInt32LE(j.length+pad.length,12);header.writeUInt32LE(0x4e4f534a,16);const b=Buffer.concat([header,j,pad,bin]);return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.length),'');}
async function sample(name,held){
 const g=await load('character_minesweeper.glb');const root=new THREE.Group();root.add(g.scene);const player=new LayeredMotionPlayer(root,g.animations);
 player.setHold('left_hand',g.animations.find(c=>c.name==='hold_basin'));player.setHold('right_hand',g.animations.find(c=>c.name==='hold_scoop'));
 player.setHoldEnabled('left_hand',held);player.setHoldEnabled('right_hand',held);
 const p=player.perform(name,[],()=>{},'full_except_left_arm');
 for(let i=0;i<86;i++){player.update(1/120);player.setHoldEnabled('left_hand',held&&(!player.performing||player.performanceEnding));player.setHoldEnabled('right_hand',held);}
 const bones={};root.traverse(o=>{if(o.isBone)bones[o.name]=o.quaternion.toArray()});player.cancelPerformance();for(let i=0;i<60;i++)player.update(1/120);await p;return bones;
}
const naked=await sample('dig',false),held=await sample('dig',true);
const differences=Object.keys(naked).map(name=>({name,degrees:new THREE.Quaternion(...naked[name]).angleTo(new THREE.Quaternion(...held[name]))*180/Math.PI})).filter(x=>x.degrees>.01).sort((a,b)=>b.degrees-a.degrees);
const g=await load('character_minesweeper.glb');const root=new THREE.Group();root.add(g.scene);const player=new LayeredMotionPlayer(root,g.animations);player.gesture('think');for(let i=0;i<2400;i++)player.update(1/60);
const report={digAtSeconds:86/120,heldVsAuthored:differences,thinkAfter40s:player.state.upper};console.log(JSON.stringify(report,null,2));writeFileSync('../layer-audit.json',JSON.stringify(report,null,2));
