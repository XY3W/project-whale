import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Stage } from "./core/Stage";
import { enableMultiWeight } from "./character/multiWeight";
import { LayeredMotionPlayer } from "./character/LayeredMotionPlayer";
import { BasinProp, type ThrowSpec } from "./prop/BasinProp";
import { loadBasinAssets, type BasinAssets } from "./prop/catalog";

const norm = (n: string) => n.replace(/[^A-Za-z0-9_]/g, "");
const BASE = "/models/basin-v2";

const statusEl = document.getElementById("status")!;
const buttonsEl = document.getElementById("buttons")!;

async function boot() {
  const stage = new Stage(document.getElementById("app")!);
  const loader = new GLTFLoader();
  const [assets, charGltf, basinGltf] = await Promise.all([
    loadBasinAssets(BASE),
    loader.loadAsync(`${BASE}/character_basin_actions.glb`),
    loader.loadAsync(`${BASE}/steel_basin_v2.glb`),
  ]);
  const { catalog } = assets as BasinAssets;

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

  let tuck: THREE.Mesh | null = null;
  charGltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    const dict = m.morphTargetDictionary;
    if (dict && dict[catalog.wearMorph] !== undefined) tuck = m;
  });
  const setTuck = (v: number) => {
    if (!tuck) return;
    const idx = tuck.morphTargetDictionary![catalog.wearMorph]!;
    tuck.morphTargetInfluences![idx] = v;
  };

  const bones = new Map<string, THREE.Bone>();
  charGltf.scene.traverse((o) => { if ((o as THREE.Bone).isBone) bones.set(norm(o.name), o as THREE.Bone); });

  const player = new LayeredMotionPlayer(root, charGltf.animations);
  const holdClip = charGltf.animations.find((c) => c.name === "hold_basin") ?? null;
  if (holdClip) player.setHoldClip(holdClip);

  const basin = await BasinProp.create({
    catalog,
    propMotion: assets.propMotion,
    charRoot: root,
    scene: basinGltf.scene,
    bones,
    setMorph: setTuck,
    parent: stage.scene,
  });

  const fired: string[] = [];
  const log: string[] = [];
  const note = (line: string) => { log.push(line); console.log(`[sandbox] ${line}`); };

  const play = async (id: string, spec?: ThrowSpec) => {
    if (!basin.begin(id, spec)) {
      note(`跳过 ${id}：当前状态 ${basin.state}`);
      statusEl.textContent = `不能开始 ${id}（当前 ${basin.state}）`;
      return false;
    }
    const events = (catalog.actions.find((a) => a.id === id)?.events ?? []).map((e) => ({ time: e.time, type: e.type }));
    const started = performance.now();
    const ok = await player.perform(id, events, (type) => {
      fired.push(`${id}:${type}`);
      note(`${id} 事件 ${type} @ ${(player.performanceTime).toFixed(3)}s`);
      basin.handleEvent(type);
    });
    basin.finish(ok);
    note(`${id} 结束 ok=${ok} state=${basin.state} ${Math.round(performance.now() - started)}ms`);
    statusEl.textContent = `✅ ${id}（${basin.state}）`;
    return ok;
  };

  const reset = () => {
    const pose = BasinProp.toWorld(root, catalog.pickupReference.position, catalog.pickupReference.quaternion);
    basin.placeAt(pose);
    basin.state = "resting";
    setTuck(0);
    fired.length = 0;
    statusEl.textContent = "已复位";
  };
  const resetCenter = () => {
    basin.resetToCenter();
    setTuck(0);
    fired.length = 0;
    statusEl.textContent = "盆已放回场地中心";
  };

  const buttons: Array<[string, () => void]> = [
    ["pickup", () => void play("pickup_basin")],
    ["wear", () => void play("wear_basin")],
    ["unwear", () => void play("unwear_basin")],
    ["throw", () => void play("throw_basin", { directionDeg: 0, speed: 3.2, spin: 180 })],
    ["reset", reset],
    ["center", resetCenter],
  ];
  for (const [label, fn] of buttons) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = fn;
    buttonsEl.appendChild(b);
  }

  const clock = new THREE.Clock();
  let frames = 0;
  stage.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    player.update(dt);
    root.updateMatrixWorld(true);
    basin.update(dt, player.performanceTime);
    player.setHoldEnabled(basin.mode === "hand" && (!player.performing || player.performanceEnding));
    stage.update();
    frames++;
  });

  statusEl.textContent = `✅ ${charGltf.animations.length} 段动画 · ${bones.size} 骨 · ${meshes.length} 网格 · 形态键 ${tuck ? "有" : "无"}`;
  (window as unknown as Record<string, unknown>).sandbox = {
    stage, root, player, basin, play, reset, setTuck,
    debug: () => ({
      frames,
      time: player.performanceTime,
      performing: player.performing,
      fired: [...fired],
      log: [...log],
      state: basin.state,
      mode: basin.mode,
      snapshot: basin.snapshot(),
      hold: { enabled: player.holdEnabled, tracks: player.holdTrackCount },
    }),
  };
}

boot().catch((err) => { statusEl.textContent = `加载失败：${err}`; console.error(err); });
