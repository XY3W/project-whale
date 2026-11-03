import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { enableMultiWeight } from "./character/multiWeight";
import { CHARACTER_MODEL } from "./character/assets";

/**
 * 坐/躺位姿实验页。
 *
 * 这套骨架是"扁平绑定"：每条骨骼都直接挂在 root.x 下，位置+旋转全部烘焙，
 * 没有腿的父子链。所以不能靠转一根骨头带动小腿——这里用一个小 FK 求解器：
 * 给定髋/膝/踝角度，算出膝、踝的新世界坐标，再把整段骨骼（含同段的 twist 骨）
 * 刚性搬过去。参数走 URL，方便截图对比。
 */

const q = new URLSearchParams(location.search);
const pose = q.get("pose") ?? "sit";
const view = q.get("view") ?? "side";
const num = (key: string, fallback: number) => {
  const raw = q.get(key);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const params = {
  hip: num("hip", pose === "lie" ? -4 : -72),
  knee: num("knee", pose === "lie" ? 8 : 68),
  ankle: num("ankle", pose === "lie" ? -4 : 6),
  drop: num("drop", pose === "lie" ? 0 : 0),
  lean: num("lean", pose === "lie" ? 90 : -6),
  seat: num("seat", 0.2),
  zoff: num("zoff", 0),
};

const DEG = Math.PI / 180;
const AXIS_X = new THREE.Vector3(1, 0, 0);

const app = document.getElementById("app")!;
const hud = document.getElementById("hud")!;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f16);

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.05, 50);
const setView = () => {
  const dist = num("dist", 2.6);
  const target = new THREE.Vector3(0, 0.42, 0.05);
  if (view === "front") camera.position.set(0.1, 0.62, dist);
  else if (view === "three") camera.position.set(dist * 0.72, 0.8, dist * 0.72);
  else if (view === "top") camera.position.set(dist * 0.6, 1.9, dist * 0.6);
  else camera.position.set(dist, 0.62, 0.08);
  camera.lookAt(target);
};
setView();

scene.add(new THREE.HemisphereLight(0xd8e4ff, 0x2b2338, 0.7));
const key = new THREE.DirectionalLight(0xfff0e2, 2.1);
key.position.set(2.4, 3.2, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -1.2; key.shadow.camera.right = 1.2;
key.shadow.camera.top = 1.2; key.shadow.camera.bottom = -1.2;
key.shadow.camera.near = 0.1; key.shadow.camera.far = 8;
scene.add(key);
const rim = new THREE.DirectionalLight(0x8ab4ff, 1.2);
rim.position.set(-1.6, 1.4, -1.8);
scene.add(rim);

// 地面参考：0.2m 一格
const grid = new THREE.GridHelper(2, 10, 0x3b5a86, 0x1c2b40);
scene.add(grid);

// 坐具参考：座面前沿在 +Z，座高 = params.seat
// 座面只画线框：实体盒子会挡住腿，看不出姿态细节
const seatBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(0.62, params.seat, 0.42)),
  new THREE.LineBasicMaterial({ color: 0x4a6fa5, transparent: true, opacity: 0.75 }),
);
seatBox.position.set(0, params.seat / 2, -0.1);
if (pose !== "lie") scene.add(seatBox);

const bedBox = new THREE.Mesh(
  new THREE.BoxGeometry(0.68, 0.12, 1.25),
  new THREE.MeshStandardMaterial({ color: 0x6b4a52, roughness: 0.9 }),
);
bedBox.position.set(0, 0.06, 0.28);
bedBox.receiveShadow = true;
if (pose === "lie") scene.add(bedBox);

type Rest = { pos: THREE.Vector3; quat: THREE.Quaternion };
const rest = new Map<string, Rest>();
const bones = new Map<string, THREE.Bone>();
/** GLTFLoader 会把骨骼名里的 "." 去掉（thigh_twist.l → thigh_twistl），两种写法都要认。 */
const boneOf = (name: string) => bones.get(name) ?? bones.get(name.replace(/\./g, ""));
const restOf = (name: string) => {
  const bone = boneOf(name);
  return bone ? rest.get(bone.name) : undefined;
};
const sides = ["l", "r"] as const;

const gltf = await new GLTFLoader().loadAsync(CHARACTER_MODEL);
const character = gltf.scene;
const skinned: THREE.SkinnedMesh[] = [];
character.traverse((obj) => {
  const mesh = obj as THREE.SkinnedMesh;
  if (mesh.isSkinnedMesh) skinned.push(mesh);
});
await enableMultiWeight(gltf, skinned);
character.traverse((obj) => {
  const bone = obj as THREE.Bone;
  if (bone.isBone) bones.set(bone.name, bone);
  const mesh = obj as THREE.Mesh;
  if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
});
scene.add(character);

// 先用 idle 第一帧当"自然站姿"，它比绑定 T-pose 更适合做基准
const idleClip = gltf.animations.find((clip) => clip.name.startsWith("idle_stand")) ?? gltf.animations[0];
if (idleClip) {
  const mixer = new THREE.AnimationMixer(character);
  const action = mixer.clipAction(idleClip);
  action.play();
  mixer.update(0);
  action.paused = true;
}
character.updateMatrixWorld(true);

for (const [name, bone] of bones) {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  bone.getWorldPosition(pos);
  bone.getWorldQuaternion(quat);
  rest.set(name, { pos, quat });
}

/** 直接写世界变换，自动换算回父级的局部值。 */
let poseWrites = 0;
const writeLog: string[] = [];
function setWorld(name: string, position: THREE.Vector3, quaternion: THREE.Quaternion) {
  poseWrites += 1;
  const bone = boneOf(name);
  if (writeLog.length < 6) writeLog.push(`${name} -> ${bone ? bone.name : "MISS"} parent=${bone?.parent?.name ?? "-"}`);
  if (!bone || !bone.parent) return;
  bone.parent.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(bone.parent.matrixWorld).invert();
  bone.position.copy(position.clone().applyMatrix4(inverse));
  const parentQuat = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(parentQuat);
  bone.quaternion.copy(parentQuat.invert().multiply(quaternion));
}

/** 把一段骨骼从 anchorRest 搬到 anchorNow，并整体旋转 R（段内骨骼刚性跟随）。 */
function applySegment(names: string[], anchorRest: THREE.Vector3, anchorNow: THREE.Vector3, R: THREE.Quaternion) {
  for (const name of names) {
    const base = restOf(name);
    if (!base) continue;
    const pos = base.pos.clone().sub(anchorRest).applyQuaternion(R).add(anchorNow);
    setWorld(name, pos, R.clone().multiply(base.quat));
  }
}

const metrics: Record<string, unknown> = {};

function poseLegs(hipDeg: number, kneeDeg: number, ankleDeg: number) {
  for (const side of sides) {
    const hipName = `thigh_twist.${side}`;
    const kneeName = `leg_stretch.${side}`;
    const ankleName = `foot.${side}`;
    const hipRest = restOf(hipName);
    const kneeRest = restOf(kneeName);
    const ankleRest = restOf(ankleName);
    if (!hipRest || !kneeRest || !ankleRest) continue;

    const hipPivot = hipRest.pos.clone();
    const R1 = new THREE.Quaternion().setFromAxisAngle(AXIS_X, hipDeg * DEG);
    const kneeNow = kneeRest.pos.clone().sub(hipPivot).applyQuaternion(R1).add(hipPivot);
    const R2 = R1.clone().multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, kneeDeg * DEG));
    const ankleNow = kneeNow.clone().add(ankleRest.pos.clone().sub(kneeRest.pos).applyQuaternion(R2));
    const R3 = R2.clone().multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, ankleDeg * DEG));

    applySegment([`thigh_twist.${side}`, `thigh_stretch.${side}`, `thigh_twist_2.${side}`], hipPivot, hipPivot, R1);
    applySegment([`leg_stretch.${side}`, `leg_twist.${side}`, `leg_twist_2.${side}`], kneeRest.pos, kneeNow, R2);
    applySegment([`foot.${side}`, `toes_01.${side}`], ankleRest.pos, ankleNow, R3);

    if (side === "l") {
      metrics.kneeY = +kneeNow.y.toFixed(3);
      metrics.ankleY = +ankleNow.y.toFixed(3);
      metrics.hipY = +hipPivot.y.toFixed(3);
    }
  }
}

if (pose !== "stand") poseLegs(params.hip, params.knee, params.ankle);

// 整体下沉 / 后仰 / 躺平：动骨架根节点，已经摆好的骨骼跟着一起转
const rootBone = boneOf("root.x");
if (rootBone) {
  const base = restOf("root.x");
  if (base) {
    if (Math.abs(params.lean) > 1e-3) {
      const R = new THREE.Quaternion().setFromAxisAngle(AXIS_X, params.lean * DEG);
      const parentQuat = new THREE.Quaternion();
      rootBone.parent?.getWorldQuaternion(parentQuat);
      const worldQ = R.clone().multiply(base.quat);
      rootBone.quaternion.copy(parentQuat.invert().multiply(worldQ));
    }
    const worldPos = base.pos.clone();
    worldPos.y -= params.drop;
    worldPos.z += params.zoff;
    setWorld("root.x", worldPos, rootBone.getWorldQuaternion(new THREE.Quaternion()));
  }
}

character.updateMatrixWorld(true);

// 量一下脚底和身体最高点，方便判断有没有悬空/穿模
const headPos = new THREE.Vector3();
boneOf("head.x")?.getWorldPosition(headPos);
const toePos = new THREE.Vector3();
boneOf("toes_01.l")?.getWorldPosition(toePos);
metrics.toeY = +toePos.y.toFixed(3);
metrics.headY = +headPos.y.toFixed(3);
const worldOf = (name: string) => {
  const bone = boneOf(name);
  if (!bone) return "-";
  const v = new THREE.Vector3();
  bone.getWorldPosition(v);
  return [v.x, v.y, v.z].map((n) => +n.toFixed(3)).join(",");
};
const kneeBone = boneOf("leg_stretch.l");
metrics.kneeLocal = kneeBone ? kneeBone.position.toArray().map((n) => +n.toFixed(3)).join(",") : "-";
metrics.kneeParent = kneeBone?.parent ? (kneeBone.parent as THREE.Object3D).name || (kneeBone.parent as THREE.Object3D).type : "none";
metrics.writes = poseWrites;
metrics.writeLog = writeLog;
metrics.rootPos = worldOf("root.x");
metrics.hipPos = worldOf("thigh_twist.l");
metrics.kneePos = worldOf("leg_stretch.l");
metrics.anklePos = worldOf("foot.l");
metrics.toePos = worldOf("toes_01.l");

hud.textContent = [
  `pose=${pose} view=${view}`,
  `hip=${params.hip}° knee=${params.knee}° ankle=${params.ankle}°`,
  `lean=${params.lean}° drop=${params.drop}m seat=${params.seat}m`,
  `hipY=${metrics.hipY ?? "-"} kneeY=${metrics.kneeY ?? "-"} ankleY=${metrics.ankleY ?? "-"}`,
  `toeY=${metrics.toeY} headY=${metrics.headY}`,
  `root=${metrics.rootPos} hip=${metrics.hipPos}`,
  `knee=${metrics.kneePos} ankle=${metrics.anklePos} toe=${metrics.toePos}`,
  `kneeLocal=${metrics.kneeLocal} kneeParent=${metrics.kneeParent}`,
  `bones=${bones.size}`,
].join("\n");

renderer.render(scene, camera);
const w = window as unknown as { __ready: boolean; __metrics: unknown };
w.__ready = true;
(window as unknown as {__boneNames:string[]}).__boneNames = [...bones.keys()];
w.__metrics = metrics;

renderer.setAnimationLoop(() => renderer.render(scene, camera));
