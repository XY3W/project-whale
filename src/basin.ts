import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Stage } from "./core/Stage";
import { enableMultiWeight } from "./character/multiWeight";

const norm = (n: string) => n.replace(/[^A-Za-z0-9_]/g, "");
const BASE = "/models/basin-v2";

interface Event { time: number; type: string }
interface ActionMeta { id: string; duration: number; events?: Event[] }
interface Catalog {
  bindings: { hand: { bone: string; matrixColumnMajor: number[] }; head: { bone: string; matrixColumnMajor: number[] } };
  pickupReference: { position: number[]; quaternion: number[] };
  wearMorph: string;
  actions: ActionMeta[];
}

const statusEl = document.getElementById("status")!;
const buttonsEl = document.getElementById("buttons")!;

async function boot() {
  const stage = new Stage(document.getElementById("app")!);
  const loader = new GLTFLoader();
  const [catalog, charGltf, basinGltf] = await Promise.all([
    fetch(`${BASE}/catalog.json`).then((r) => r.json()) as Promise<Catalog>,
    loader.loadAsync(`${BASE}/character_basin_actions.glb`),
    loader.loadAsync(`${BASE}/steel_basin_v2.glb`),
  ]);

  const root = new THREE.Group();
  root.add(charGltf.scene);
  stage.scene.add(root);
  stage.setRoomCamera();

  const meshes: THREE.SkinnedMesh[] = [];
  charGltf.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; if (m.isSkinnedMesh) meshes.push(m); }
  });
  await enableMultiWeight(charGltf as never, meshes);

  // 形态键：头顶收拢
  let tuck: THREE.Mesh | null = null;
  charGltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    const dict = (m as THREE.Mesh).morphTargetDictionary;
    if (dict && dict[catalog.wearMorph] !== undefined) tuck = m;
  });
  const setTuck = (v: number) => {
    if (!tuck) return;
    const idx = tuck.morphTargetDictionary![catalog.wearMorph]!;
    tuck.morphTargetInfluences![idx] = v;
  };

  const bones = new Map<string, THREE.Bone>();
  charGltf.scene.traverse((o) => { if ((o as THREE.Bone).isBone) bones.set(norm(o.name), o as THREE.Bone); });

  const basin = new THREE.Group();
  basin.add(basinGltf.scene);
  basin.matrixAutoUpdate = false;
  stage.scene.add(basin);

  const rest = new THREE.Matrix4().compose(
    new THREE.Vector3(...(catalog.pickupReference.position as [number, number, number])),
    new THREE.Quaternion(...(catalog.pickupReference.quaternion as [number, number, number, number])),
    new THREE.Vector3(1, 1, 1),
  );
  const attach = {
    hand: new THREE.Matrix4().fromArray(catalog.bindings.hand.matrixColumnMajor),
    head: new THREE.Matrix4().fromArray(catalog.bindings.head.matrixColumnMajor),
  };
  const handBone = bones.get(norm(catalog.bindings.hand.bone));
  const headBone = bones.get(norm(catalog.bindings.head.bone));

  const setRest = () => { basin.matrix.copy(rest); basin.matrixWorldNeedsUpdate = true; };
  const attachTo = (bone: THREE.Bone | undefined, m: THREE.Matrix4) => {
    if (!bone) return;
    bone.updateWorldMatrix(true, false);
    basin.matrix.copy(bone.matrixWorld).multiply(m);
    basin.matrixWorldNeedsUpdate = true;
  };

  const mixer = new THREE.AnimationMixer(root);
  const clips = new Map(charGltf.animations.map((c) => [c.name, c]));
  let current: THREE.AnimationAction | null = null;
  let events: Event[] = [];
  let prevTime = 0;

  const fire = (type: string) => {
    if (type === "grasp") attachTo(handBone, attach.hand);
    if (type === "hand_release_to_transfer") { /* 曲线驱动阶段，暂按挂手处理 */ }
    if (type === "head_attach") { attachTo(headBone, attach.head); setTuck(1); }
    if (type === "head_release_to_transfer") { /* 转移中 */ }
    if (type === "hand_catch") attachTo(handBone, attach.hand);
    if (type === "release") setRest();
  };

  const play = (id: string) => {
    const clip = clips.get(id);
    if (!clip) return;
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    current = action;
    prevTime = 0;
    events = (catalog.actions.find((a) => a.id === id)?.events ?? []) as Event[];
    statusEl.textContent = `播放 ${id}（${clip.duration.toFixed(2)}s，${events.length} 个事件）`;
  };

  setRest();
  for (const a of catalog.actions) {
    const b = document.createElement("button");
    b.textContent = a.id;
    b.onclick = () => play(a.id);
    buttonsEl.appendChild(b);
  }

  const clock = new THREE.Clock();
  stage.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    mixer.update(dt);
    if (current) {
      const t = current.time;
      for (const e of events) {
        if (prevTime < e.time && e.time <= t) fire(e.type);
      }
      prevTime = t;
    }
    stage.update();
  });

  statusEl.textContent = `✅ ${charGltf.animations.length} 段动画 · ${bones.size} 骨 · ${meshes.length} 网格 · 形态键 ${tuck ? "有" : "无"}`;
  (window as unknown as Record<string, unknown>).sandbox = { stage, root, basin, play, setTuck };
}

boot().catch((err) => { statusEl.textContent = `加载失败：${err}`; console.error(err); });
