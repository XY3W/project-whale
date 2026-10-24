import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/**
 * 临时验证页：加载 v7 临时 GLB，套用 Blender 参考姿态。
 * 只用于 P0 加载/坐标/姿态回读验证，不接主应用。
 */

const params = new URLSearchParams(location.search);
const modelUrl = params.get("model") ?? "/models/dev/v7-provisional/character_v7_tmp.glb";
const poseUrl = params.get("pose") ?? "/models/dev/v7-provisional/pose-reference.json";
const WEIGHT_SETS = Math.max(1, Math.min(4, Number(params.get("w") ?? 4) / 4));

const hud = document.getElementById("hud")!;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d13);

const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 60);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;   // 验证时固定机位，避免阻尼造成帧间偏移
controls.target.set(0, 0.6, 0);

scene.add(new THREE.HemisphereLight(0xd8e4ff, 0x2b2338, 0.9));
const key = new THREE.DirectionalLight(0xfff0e2, 2.4);
key.position.set(1.9, 3.4, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -2; key.shadow.camera.right = 2;
key.shadow.camera.top = 2.4; key.shadow.camera.bottom = -0.6;
key.shadow.camera.near = 0.5; key.shadow.camera.far = 9;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);
const rim = new THREE.DirectionalLight(0x8ab4ff, 1.8);
rim.position.set(-2.4, 1.9, -2.7);
scene.add(rim);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture;
scene.environmentIntensity = 0.3;

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(4.2, 96),
  new THREE.MeshStandardMaterial({ color: 0x141a27, roughness: 0.95, transparent: true, opacity: 0.85 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const norm = (n: string) => n.replace(/[^A-Za-z0-9_]/g, "");

// Blender(Z-up) → glTF(Y-up)
const R = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const Rinv = R.clone().invert();

function mat4(flat: number[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  m.set(flat[0], flat[1], flat[2], flat[3],
        flat[4], flat[5], flat[6], flat[7],
        flat[8], flat[9], flat[10], flat[11],
        flat[12], flat[13], flat[14], flat[15]);
  return m;
}

const loader = new GLTFLoader();
const [gltf, poseData] = await Promise.all([
  loader.loadAsync(modelUrl),
  fetch(poseUrl).then((r) => r.json()),
]);

const root = gltf.scene;
scene.add(root);

const meshes: THREE.SkinnedMesh[] = [];
root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (m.isMesh) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(m as THREE.SkinnedMesh);
  }
});

// ---- 可选：多权重蒙皮（JOINTS_1..3 / WEIGHTS_1..3）----
function buildSkinningBody(sets: number): string {
  let glsl = `#ifdef USE_SKINNING
  vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
  vec4 skinned = vec4( 0.0 );
  skinned += boneMatX * skinVertex * skinWeight.x;
  skinned += boneMatY * skinVertex * skinWeight.y;
  skinned += boneMatZ * skinVertex * skinWeight.z;
  skinned += boneMatW * skinVertex * skinWeight.w;
`;
  for (let i = 1; i < sets; i++) {
    glsl += `  skinned += getBoneMatrix( skinIndex${i}.x ) * skinVertex * skinWeight${i}.x;
  skinned += getBoneMatrix( skinIndex${i}.y ) * skinVertex * skinWeight${i}.y;
  skinned += getBoneMatrix( skinIndex${i}.z ) * skinVertex * skinWeight${i}.z;
  skinned += getBoneMatrix( skinIndex${i}.w ) * skinVertex * skinWeight${i}.w;
`;
  }
  glsl += `  // three 原生不做权重归一化；截断多权重集后必须除以总和，否则顶点被拉向原点
  float wsum = dot( skinWeight, vec4( 1.0 ) )`;
  for (let i = 1; i < sets; i++) glsl += ` + dot( skinWeight${i}, vec4( 1.0 ) )`;
  glsl += `;
  skinned /= max( wsum, 1e-5 );
  transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`;
  return glsl;
}

function buildNormalBody(sets: number): string {
  let glsl = `#ifdef USE_SKINNING
  mat4 skinMatrix = mat4( 0.0 );
  skinMatrix += skinWeight.x * boneMatX;
  skinMatrix += skinWeight.y * boneMatY;
  skinMatrix += skinWeight.z * boneMatZ;
  skinMatrix += skinWeight.w * boneMatW;
`;
  for (let i = 1; i < sets; i++) {
    glsl += `  skinMatrix += skinWeight${i}.x * getBoneMatrix( skinIndex${i}.x );
  skinMatrix += skinWeight${i}.y * getBoneMatrix( skinIndex${i}.y );
  skinMatrix += skinWeight${i}.z * getBoneMatrix( skinIndex${i}.z );
  skinMatrix += skinWeight${i}.w * getBoneMatrix( skinIndex${i}.w );
`;
  }
  glsl += `  float wsum = dot( skinWeight, vec4( 1.0 ) )`;
  for (let i = 1; i < sets; i++) glsl += ` + dot( skinWeight${i}, vec4( 1.0 ) )`;
  glsl += `;
  skinMatrix /= max( wsum, 1e-5 );
  skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
  objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
  #ifdef USE_TANGENT
    objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
  #endif
#endif`;
  return glsl;
}

function patchSkinning(mat: THREE.Material, sets: number) {
  const m = mat as THREE.MeshStandardMaterial;
  m.onBeforeCompile = (shader) => {
    let decl = "";
    for (let i = 1; i < sets; i++) {
      decl += `attribute vec4 skinIndex${i};\nattribute vec4 skinWeight${i};\n`;
    }
    (window as unknown as Record<string, number>).__skinCompiled = ((window as unknown as Record<string, number>).__skinCompiled ?? 0) + 1;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + decl)
      .replace("#include <skinning_vertex>", buildSkinningBody(sets))
      .replace("#include <skinnormal_vertex>", buildNormalBody(sets));
  };
  m.customProgramCacheKey = () => `skin-sets-${sets}`;
  m.needsUpdate = true;
}

// GLTFLoader 会把第一组权重归一化；追加其他组之前必须先恢复原始值，
// 否则组间比例被破坏（0.8/0.2 → 0.833/0.167）。
async function restoreFirstSetWeights(mesh: THREE.SkinnedMesh) {
  const parser = (gltf as unknown as { parser?: any }).parser;
  const assoc = parser?.associations?.get(mesh);
  if (!parser || assoc?.meshes === undefined) return;
  const prim = parser.json.meshes[assoc.meshes].primitives[assoc.primitives];
  const idx = prim?.attributes?.WEIGHTS_0;
  if (idx === undefined) return;
  const raw = await parser.getDependency("accessor", idx);
  if (raw) mesh.geometry.setAttribute("skinWeight", raw);
}

try {
console.log('MW start', WEIGHT_SETS);
for (const mesh of meshes) {
  console.log('MW mesh', mesh.name);
  if (WEIGHT_SETS === 1) break;
  const g = mesh.geometry;
  let ok = true;
  for (let i = 1; i < WEIGHT_SETS; i++) {
    const ji = g.getAttribute(`joints_${i}`) ?? g.getAttribute(`JOINTS_${i}`);
    const wi = g.getAttribute(`weights_${i}`) ?? g.getAttribute(`WEIGHTS_${i}`);
    if (!ji || !wi) { ok = false; break; }
    g.setAttribute(`skinIndex${i}`, new THREE.BufferAttribute(Float32Array.from(ji.array as ArrayLike<number>), 4));
    g.setAttribute(`skinWeight${i}`, new THREE.BufferAttribute(Float32Array.from(wi.array as ArrayLike<number>), 4));
  }
  if (!ok) { console.warn(`mesh ${mesh.name}: 缺少第 2 组及以后的权重，保持 4 权重`); continue; }

  await restoreFirstSetWeights(mesh);
  console.log('MW restored', mesh.name);

  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mats.forEach((m) => patchSkinning(m, WEIGHT_SETS));

  // 阴影/距离材质也要用同一套蒙皮扩展
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patchSkinning(depth, WEIGHT_SETS);
  mesh.customDepthMaterial = depth;
  const distance = new THREE.MeshDistanceMaterial();
  patchSkinning(distance, WEIGHT_SETS);
  mesh.customDistanceMaterial = distance;
  mesh.castShadow = true;
  console.log('MW patched', mesh.name);
}
} catch (err) {
  console.error('MULTIWEIGHT-ERROR', err instanceof Error ? err.message : String(err));
}

// 用“相对静止姿态的增量”套用 Blender 姿态：
// glTF 导出器可能对每根骨做轴向转换，直接换算臂空间矩阵会错位。
// delta = pose * rest^-1（臂空间），映射到 glTF 世界空间后叠加到该骨的静止世界矩阵。
root.updateMatrixWorld(true);
const restWorld = new Map<string, THREE.Matrix4>();
root.traverse((o) => {
  if ((o as THREE.Bone).isBone) restWorld.set(o.name, o.matrixWorld.clone());
});

const poseG = new Map<string, THREE.Matrix4>();
for (const [name, info] of Object.entries(poseData.bones as Record<string, { rest: number[]; pose: number[] }>)) {
  const key = norm(name);
  const restB = mat4(info.rest);
  const poseB = mat4(info.pose);
  const deltaB = new THREE.Matrix4().multiplyMatrices(poseB, restB.clone().invert());
  const deltaG = new THREE.Matrix4().multiplyMatrices(R, deltaB).multiply(Rinv);
  const w = restWorld.get(key);
  if (w) poseG.set(key, new THREE.Matrix4().multiplyMatrices(deltaG, w));
}

const I = new THREE.Matrix4();
let applied = 0;
root.traverse((o) => {
  if (!(o as THREE.Bone).isBone) return;
  const g = poseG.get(o.name);
  if (!g) return;
  // 关键：局部变换必须相对父骨的【当前姿态】，不是静止姿态。
  // 用静止父矩阵会把父级旋转算两遍（手臂会整条塌进去）。
  const parentWorld = o.parent && (o.parent as THREE.Bone).isBone
    ? poseG.get(o.parent.name) ?? o.parent.matrixWorld
    : o.parent ? o.parent.matrixWorld : I;
  const local = new THREE.Matrix4().multiplyMatrices(parentWorld.clone().invert(), g);
  local.decompose(o.position, o.quaternion, o.scale);
  applied++;
});

root.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(root);
const size = box.getSize(new THREE.Vector3());
const center = box.getCenter(new THREE.Vector3());
controls.target.copy(center);
camera.position.set(center.x, center.y + 0.35, center.z + size.y * 2.6);
controls.update();

hud.textContent = [
  `weights ${WEIGHT_SETS * 4}`,
  `model  ${modelUrl.split("/").pop()}`,
  `meshes ${meshes.length}`,
  `bones  ${applied} / ${Object.keys(poseData.bones).length}`,
  `size   ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`,
  `tris   ${meshes.reduce((s, m) => s + (m.geometry.index ? m.geometry.index.count : 0) / 3, 0).toLocaleString()}`,
].join("\n");

const resize = () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
};
addEventListener("resize", resize);
resize();


// ---- CPU 蒙皮对比：以 16 权重（全量）为参考，量 4 / 8 权重的截断误差 ----
// 这里只比较 GLB 内部数据，验证的是权重数据与蒙皮数学，不经过像素。
function runWeightDiag() {
  const out: Record<string, unknown> = {};
  for (const mesh of meshes) {
    const g = mesh.geometry;
    if (!(g.getAttribute("weights_1") ?? g.getAttribute("skinWeight1"))) { out[mesh.name] = "no-extra-sets"; continue; }
    const pos = g.getAttribute("position");
    const si: THREE.BufferAttribute[] = [g.getAttribute("skinIndex") as THREE.BufferAttribute];
    const sw: THREE.BufferAttribute[] = [g.getAttribute("skinWeight") as THREE.BufferAttribute];
    for (let i = 1; i < 4; i++) {
      // 优先用 GLB 原始属性（joints_i / weights_i），不依赖 lab 是否给 shader 挂了别名
      const a = (g.getAttribute(`joints_${i}`) ?? g.getAttribute(`skinIndex${i}`)) as THREE.BufferAttribute | null;
      const b = (g.getAttribute(`weights_${i}`) ?? g.getAttribute(`skinWeight${i}`)) as THREE.BufferAttribute | null;
      if (a && b) { si.push(a); sw.push(b); }
    }
    const bones = mesh.skeleton.boneMatrices;
    const bind = mesh.bindMatrix;
    const bindInv = mesh.bindMatrixInverse;
    const count = pos.count;
    const step = params.get("diagfull") === "1" ? 1 : Math.max(1, Math.floor(count / 4000));
    const modes = [4, 8, 16];
    const results: Record<number, Float32Array> = {};
    const v = new THREE.Vector3();
    const acc = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const m = new THREE.Matrix4();
    for (const mode of modes) {
      const res = new Float32Array(count * 3);
      const sets = Math.min(si.length, mode / 4);
      for (let i = 0; i < count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(bind);
        acc.set(0, 0, 0);
        let wsum = 0;
        for (let s = 0; s < sets; s++) {
          for (let k = 0; k < 4; k++) {
            const w = sw[s].getComponent(i, k);
            if (w === 0) continue;
            const bi = si[s].getComponent(i, k);
            m.fromArray(bones, bi * 16);
            tmp.copy(v).applyMatrix4(m).multiplyScalar(w);
            acc.add(tmp);
            wsum += w;
          }
        }
        if (wsum > 0) acc.multiplyScalar(1 / wsum);
        acc.applyMatrix4(bindInv);
        res[i * 3] = acc.x; res[i * 3 + 1] = acc.y; res[i * 3 + 2] = acc.z;
      }
      results[mode] = res;
    }
    const ref = results[16];
    const stats: Record<string, unknown> = {};
    for (const mode of [4, 8]) {
      const cur = results[mode];
      let max = 0, sum2 = 0, n = 0, over1 = 0;
      let worst = -1;
      for (let i = 0; i < count; i += step) {
        const dx = cur[i * 3] - ref[i * 3];
        const dy = cur[i * 3 + 1] - ref[i * 3 + 1];
        const dz = cur[i * 3 + 2] - ref[i * 3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > max) { max = d; worst = i; }
        sum2 += d * d; n++;
        if (d > 0.001) over1++;
      }
      stats[`top${mode}`] = {
        max_mm: +(max * 1000).toFixed(4),
        rms_mm: +(Math.sqrt(sum2 / n) * 1000).toFixed(5),
        over_1mm: over1,
        sampled: n,
        worst_vertex: worst,
      };
    }
    out[mesh.name] = stats;
  }
  return out;
}
if (params.get("diag") === "1") {
  root.updateMatrixWorld(true);
  for (const m of meshes) m.skeleton.update();
  (window as unknown as Record<string, unknown>).__diag = runWeightDiag();
  console.log("DIAG " + JSON.stringify((window as unknown as Record<string, unknown>).__diag));
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  controls.update(dt);
  renderer.render(scene, camera);
});

(window as unknown as Record<string, unknown>).lab = { scene, camera, controls, meshes, applied, size, center };
