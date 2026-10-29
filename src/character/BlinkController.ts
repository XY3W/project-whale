import * as THREE from 'three';
import { MaterialEyelids } from './MaterialEyelids.ts';

/** Eyelid poses have four fitted samples so they follow the curved eye without clipping it. */
export function blinkWeights(value: number): number[] {
  const v = THREE.MathUtils.clamp(value, 0, 1) * 4;
  return [1,2,3,4].map(sample => Math.max(0, 1 - Math.abs(v - sample)));
}

const smooth = (v:number) => v*v*(3-2*v);
/** Fast closing, a brief complete closure, then a softer reopening (260 ms total). */
export function blinkAmount(time: number): number {
  if (time <= 0 || time >= .26) return 0;
  if (time < .085) return smooth(time/.085);
  if (time < .12) return 1;
  return 1-smooth((time-.12)/.14);
}

export class BlinkController {
  private readonly targets: {mesh:THREE.Mesh;side:'Left'|'Right';indices:number[]}[]=[];
  private readonly material:MaterialEyelids|null;
  private wait = 2;
  private elapsed:number|null=null;
  private manual:{left:number;right:number}|null=null;
  private doubleBlink=false;
  enabled=true;
  private readonly random:()=>number;
  constructor(root:THREE.Object3D, random:()=>number=Math.random) {
    this.random=random;
    const materialMeshes:THREE.SkinnedMesh[]=[];
    root.traverse(object=>{
      const mesh=object as THREE.Mesh;
      if((mesh as THREE.SkinnedMesh).isSkinnedMesh&&mesh.geometry?.getAttribute('_eyepart'))materialMeshes.push(mesh as THREE.SkinnedMesh);
      if(!mesh.isMesh||!mesh.name.startsWith('Blink_')||!mesh.morphTargetDictionary)return;
      const side=mesh.name.includes('_Left_')?'Left':'Right';
      const indices=[25,50,75,100].map(n=>mesh.morphTargetDictionary![`Blink${side}_${n}`]);
      if(indices.every(Number.isInteger))this.targets.push({mesh,side,indices});
    });
    this.material=materialMeshes.length?new MaterialEyelids(materialMeshes):null;
    this.wait=this.nextInterval();this.apply(0,0);
  }
  get available(){return !!this.material||this.targets.length>0;}
  get mode(){return this.material?'material':this.targets.length?'morph':'none';}
  private nextInterval(){return 2.8+this.random()*3.6;}
  setManual(left:number|null,right=left){
    this.manual=left===null?null:{left:THREE.MathUtils.clamp(left,0,1),right:THREE.MathUtils.clamp(right??left,0,1)};
    this.elapsed=null;this.wait=this.nextInterval();this.apply(this.manual?.left??0,this.manual?.right??0);
  }
  trigger(){this.manual=null;this.elapsed=0;this.doubleBlink=false;}
  private apply(left:number,right:number){
    this.material?.setClosure(left,right);
    for(const target of this.targets){const weights=blinkWeights(target.side==='Left'?left:right);for(let i=0;i<4;i++)target.mesh.morphTargetInfluences![target.indices[i]]=weights[i];}
  }
  update(dt:number){
    if(this.manual){this.apply(this.manual.left,this.manual.right);return;}
    if(!this.enabled){this.apply(0,0);return;}
    let remaining=Math.max(0,Math.min(dt,.5));
    while(remaining>0){
      if(this.elapsed===null){const step=Math.min(remaining,this.wait);this.wait-=step;remaining-=step;if(this.wait>1e-8)break;this.elapsed=0;}
      const step=Math.min(remaining,.26-this.elapsed!);this.elapsed!+=step;remaining-=step;
      if(this.elapsed!>=.26-1e-8){this.elapsed=null;const again=!this.doubleBlink&&this.random()<.12;this.wait=again?.16:this.nextInterval();this.doubleBlink=again;}
    }
    const value=this.elapsed===null?0:blinkAmount(this.elapsed);this.apply(value,value);
  }
}
