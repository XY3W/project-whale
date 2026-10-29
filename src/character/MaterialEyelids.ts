import * as THREE from 'three';

// Accepted material eyelids: render on the original eye surface without moving face vertices.
// _EYEPART: 0 = original surface, 1 = native eye rim, 2 = retired upper/lower helper sheets.
const maskGLSL = `
uniform float materialBlinkLeft;
uniform float materialBlinkRight;
uniform float materialBlinkSmooth;
varying vec3 vMaterialBlinkPosition;
varying float vMaterialEyePart;
float eyeCover(vec3 p, float amount) {
  float u=(abs(p.x)-0.098)/0.088;
  float arc=sqrt(max(0.0,1.0-u*u));
  float region=(1.0-smoothstep(0.94,1.07,u*u+pow((p.y-0.593)/0.080,2.0)))*smoothstep(-0.08,-0.015,p.z);
  float top=0.593+0.045*arc;
  float bottom=0.593-0.065*arc;
  float meeting=0.593-0.022*arc;
  float upper=mix(top,meeting,amount);
  float lower=mix(bottom,meeting,amount);
  float cover=max(smoothstep(upper-0.0006,upper+0.0006,p.y),1.0-smoothstep(lower-0.0006,lower+0.0006,p.y));
  return region*cover*smoothstep(0.0,0.04,amount)*(1.0-smoothstep(0.648,0.652,p.y))*smoothstep(0.028,0.050,abs(p.x));
}
float eyeLine(vec3 p, float amount) {
  float u=(abs(p.x)-0.098)/0.088;
  float arc=sqrt(max(0.0,1.0-u*u));
  float edge=mix(0.593+0.045*arc,0.593-0.022*arc,amount);
  return (1.0-smoothstep(0.00075,0.00135,abs(p.y-edge)))*(1.0-smoothstep(0.88,1.0,abs(u)))*smoothstep(-0.08,-0.015,p.z)*smoothstep(0.02,0.18,amount);
}

`;

const animeLashGLSL = `
uniform float materialBlinkLashes;
float edgeCross(vec2 a,vec2 b){return a.x*b.y-a.y*b.x;}
float lashTriangle(vec2 p,vec2 a,vec2 b,vec2 c){
  float signDir=sign(edgeCross(b-a,c-a));
  float d=max(max(-signDir*edgeCross(b-a,p-a)/length(b-a),-signDir*edgeCross(c-b,p-b)/length(c-b)),-signDir*edgeCross(a-c,p-c)/length(a-c));
  float aa=max(fwidth(d)*0.75,0.00012);
  return 1.0-smoothstep(-aa,aa,d);
}
float upperLashY(float x,float amount){
  float u=(x-0.098)/0.088;float arc=sqrt(max(0.0,1.0-u*u));
  return mix(0.593+0.045*arc,0.593-0.022*arc,amount);
}
float animeLashes(vec3 p,float amount){
  float x=abs(p.x);float u=(x-0.098)/0.088;
  float edge=upperLashY(x,amount);
  float radius=(0.0011+0.0016*smoothstep(-0.1,0.9,u))*(1.0-0.4*amount);
  float dist=abs(p.y-edge);float aa=max(fwidth(dist),0.00015);
  float line=(1.0-smoothstep(radius-aa,radius+aa,dist))*(1.0-smoothstep(0.9,1.03,abs(u)))*smoothstep(0.015,0.10,amount);
  vec2 q=vec2(x,p.y);float fan=1.0-0.65*amount;
  float a=lashTriangle(q,vec2(0.120,upperLashY(0.120,amount)-0.001),vec2(0.132,upperLashY(0.132,amount)-0.001),vec2(0.134,upperLashY(0.132,amount)+0.011*fan));
  float b=lashTriangle(q,vec2(0.136,upperLashY(0.136,amount)-0.001),vec2(0.147,upperLashY(0.147,amount)-0.001),vec2(0.154,upperLashY(0.147,amount)+0.010*fan));
  float c=lashTriangle(q,vec2(0.151,upperLashY(0.151,amount)-0.001),vec2(0.162,upperLashY(0.162,amount)-0.001),vec2(0.175,upperLashY(0.162,amount)+0.006*fan));
  float lower=mix(0.593-0.061*sqrt(max(0.0,1.0-pow((0.151-0.098)/0.088,2.0))),0.593-0.022*sqrt(max(0.0,1.0-pow((0.151-0.098)/0.088,2.0))),amount);
  float tick=lashTriangle(q,vec2(0.146,lower+0.0007),vec2(0.153,lower-0.0007),vec2(0.158,lower-0.003*(1.0-0.7*amount)))*(1.0-0.5*amount);
  return max(max(line,a),max(max(b,c),tick))*smoothstep(-0.08,-0.015,p.z);
}
`;

export class MaterialEyelids {
  readonly lashes={value:1};
  readonly left={value:0}; readonly right={value:0}; readonly smoothing={value:1};
  constructor(meshes: THREE.SkinnedMesh[]){
    let found=false;
    for(const mesh of meshes){
      const originals=Array.isArray(mesh.material)?mesh.material:[mesh.material];
      const replacements=originals.map(original=>{
        if(!mesh.geometry.getAttribute('_eyepart'))return original;
        found=true;
        const part=mesh.geometry.getAttribute('_eyepart');if(!part)throw new Error('Missing eye part data');mesh.geometry.setAttribute('eyePart',part);
        const mat=original.clone() as THREE.MeshStandardMaterial;
        const previous=original.onBeforeCompile;
        const previousKey=original.customProgramCacheKey();
        mat.onBeforeCompile=(shader,renderer)=>{
          previous.call(original,shader,renderer);
          shader.uniforms.materialBlinkLeft=this.left;
          shader.uniforms.materialBlinkRight=this.right;
          shader.uniforms.materialBlinkSmooth=this.smoothing;
          shader.uniforms.materialBlinkLashes=this.lashes;
          shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float eyePart;\n'+maskGLSL)
            .replace('#include <begin_vertex>',`#include <begin_vertex>
vMaterialBlinkPosition=position;
vMaterialEyePart=eyePart;`)
            .replace('#include <beginnormal_vertex>',`#include <beginnormal_vertex>
              float bAmount=position.x>0.0?materialBlinkLeft:materialBlinkRight;
              float bCover=eyeCover(position,bAmount)*materialBlinkSmooth;
              vec3 skinNormal=normalize(vec3(position.x*2.5,(position.y-0.64)*0.7,1.0));
              objectNormal=normalize(mix(objectNormal,skinNormal,bCover));
`);
          shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+maskGLSL+'\n'+animeLashGLSL)
            .replace('#include <map_fragment>',`#include <map_fragment>
              float bAmount=vMaterialBlinkPosition.x>0.0?materialBlinkLeft:materialBlinkRight;
              float bCover=eyeCover(vMaterialBlinkPosition,bAmount);
              if(vMaterialEyePart>1.5 || (vMaterialEyePart>0.5 && bCover>0.002))discard;
              vec2 skinUV=vMaterialBlinkPosition.x>0.0?vec2(0.30184367,0.39606887):vec2(0.30232048,0.41483361);
              vec3 skinColor=texture2D(map,skinUV).rgb;
              diffuseColor.rgb=mix(diffuseColor.rgb,skinColor,bCover);
              float bLine=max(eyeLine(vMaterialBlinkPosition,bAmount),animeLashes(vMaterialBlinkPosition,bAmount)*materialBlinkLashes)*smoothstep(0.035,0.055,abs(vMaterialBlinkPosition.x));
              diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.018,0.008,0.012),bLine);`);
          // Retain a little shadow, but suppress the original recessed-eye shadow on painted lids.
          const lights=THREE.ShaderChunk.lights_fragment_begin.replace(/directLight.color \*= ([^;]+);/g,
            'directLight.color *= mix(($1),1.0,bCover*materialBlinkSmooth*0.9);');
          shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',lights);
        };
        mat.customProgramCacheKey=()=>previousKey+'-anime-eyes-material-only-restored-v1';
        mat.needsUpdate=true;
        return mat;
      });
      mesh.material=Array.isArray(mesh.material)?replacements:replacements[0];
      if(mesh.geometry.getAttribute('eyePart')){
        for(const depth of [mesh.customDepthMaterial,mesh.customDistanceMaterial]){
          if(!depth)continue;
          const previous=depth.onBeforeCompile;const key=depth.customProgramCacheKey();
          depth.onBeforeCompile=(shader,renderer)=>{
            previous.call(depth,shader,renderer);
            shader.uniforms.materialBlinkLeft=this.left;shader.uniforms.materialBlinkRight=this.right;shader.uniforms.materialBlinkLashes=this.lashes;
            shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float eyePart;\n'+maskGLSL)
              .replace('#include <begin_vertex>',`#include <begin_vertex>
vMaterialBlinkPosition=position;vMaterialEyePart=eyePart;`);
            shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+maskGLSL)
              .replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
                float bAmount=vMaterialBlinkPosition.x>0.0?materialBlinkLeft:materialBlinkRight;
                if(vMaterialEyePart>1.5 || (vMaterialEyePart>0.5 && eyeCover(vMaterialBlinkPosition,bAmount)>0.002))discard;`);
          };
          depth.customProgramCacheKey=()=>key+'-anime-eye-material-only-shadow-v1';depth.needsUpdate=true;
        }
      }
    }
    if(!found)throw new Error('Original character material not found');
  }
  setClosure(left:number,right:number){
    this.left.value=THREE.MathUtils.clamp(left,0,1);
    this.right.value=THREE.MathUtils.clamp(right,0,1);
  }
}
