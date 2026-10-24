import * as THREE from "three";
import "./style.css";
import { Stage } from "./core/Stage";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { enableMultiWeight } from "./character/multiWeight";
import { LayeredMotionPlayer } from "./character/LayeredMotionPlayer";
import { Hud } from "./ui/Hud";

const MODEL = "/models/animation-v9/character_v9.glb";
const AREA_HALF = 3.7; // 8m 场地，留出角色半径

async function boot() {
  const stage = new Stage(document.getElementById("app")!);

  const loading = document.getElementById("loading")!;
  const bar = loading.querySelector(".loading-bar i") as HTMLElement;
  const note = loading.querySelector(".loading-note") as HTMLElement;

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL, (e) => {
    if (e.total > 0) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
  });
  note.textContent = "正在准备动作…";

  const root = new THREE.Group();
  root.add(gltf.scene);

  const meshes: THREE.SkinnedMesh[] = [];
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      if ((m as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(m as THREE.SkinnedMesh);
    }
  });

  await enableMultiWeight(gltf, meshes);

  const player = new LayeredMotionPlayer(root, gltf.animations);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  root.position.y -= box.min.y;

  stage.scene.add(root);
  stage.setRoomCamera();

  // ---- 移动与转身 ----
  type Phase = "idle" | "stopping" | "turning" | "walking";
  let phase: Phase = "idle";
  let destination: THREE.Vector3 | null = null;
  const forward = new THREE.Vector3(0, 0, 1);
  const tmp = new THREE.Vector3();
  const turn = { from: 0, to: 0, t: 0, dur: 0.4 };

  const shortest = (from: number, to: number) => {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  const yawTo = (p: THREE.Vector3) => Math.atan2(p.x - root.position.x, p.z - root.position.z);

  const requestMove = (point: THREE.Vector3) => {
    tmp.copy(point).sub(root.position).setY(0);
    if (tmp.lengthSq() < 0.0025) return;
    destination = point.clone();
    if (phase === "walking") {
      player.setWalking(false); // 先停稳，再由转身阶段接管
      phase = "stopping";
    } else if (phase === "turning") {
      phase = "idle"; // 落点变了，重新算朝向
    }
  };

  // ---- 输入：点击与拖动分流 ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let downAt: { x: number; y: number; t: number } | null = null;

  const canvas = stage.renderer.domElement;
  canvas.addEventListener("pointerdown", (e) => {
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const quick = performance.now() - downAt.t < 400;
    downAt = null;
    if (moved > 6 || !quick) return;

    ndc.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
    raycaster.setFromCamera(ndc, stage.camera);

    if (raycaster.intersectObjects(meshes, true).length > 0) {
      player.gesture("notice");
      return;
    }
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return;
    hit.x = THREE.MathUtils.clamp(hit.x, -AREA_HALF, AREA_HALF);
    hit.z = THREE.MathUtils.clamp(hit.z, -AREA_HALF, AREA_HALF);
    requestMove(hit);
  });

  // ---- HUD ----
  const hud = new Hud(
    (id) => {
      switch (id) {
        case "walk": {
          if (phase === "walking" || player.state.walking) {
            destination = null;
            player.setWalking(false);
            phase = "stopping";
          } else {
            const dir = new THREE.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
            requestMove(root.position.clone().addScaledVector(dir, 2.4));
          }
          break;
        }
        case "tail":
          player.setTail(player.state.tail !== "tail_swish");
          break;
        default:
          player.gesture(id);
      }
    },
    ["walk", "greet", "notice", "nod", "look_left", "look_right", "think", "tail"],
  );

  // ---- 主循环 ----
  const clock = new THREE.Clock();
  let hudTimer = 0;

  stage.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);

    player.update(dt);

    // 世界位移只来自片段本身
    forward.set(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    if (player.movementDelta > 0 && phase !== "turning") root.position.addScaledVector(forward, player.movementDelta);

    // 转身：缓入缓出，站定后再走
    switch (phase) {
      case "stopping":
        if (player.state.base === "idle_stand") phase = "idle";
        break;
      case "idle": {
        if (!destination) break;
        tmp.copy(destination).sub(root.position).setY(0);
        if (tmp.length() < 0.08) { destination = null; break; }
        const delta = shortest(root.rotation.y, yawTo(destination));
        if (Math.abs(delta) > 0.09) {
          turn.from = root.rotation.y;
          turn.to = root.rotation.y + delta;
          turn.t = 0;
          turn.dur = THREE.MathUtils.clamp(0.3 + Math.abs(delta) * 0.45, 0.3, 1.15);
          phase = "turning";
        } else {
          phase = "walking";
          player.setWalking(true);
        }
        break;
      }
      case "turning": {
        turn.t += dt;
        const u = Math.min(1, turn.t / turn.dur);
        const e = u * u * (3 - 2 * u);
        root.rotation.y = turn.from + (turn.to - turn.from) * e;
        if (u >= 1) phase = "idle";
        break;
      }
      case "walking": {
        if (!destination) break;
        tmp.copy(destination).sub(root.position).setY(0);
        if (tmp.length() < 0.08) {
          destination = null;
          player.setWalking(false);
          phase = "stopping";
        }
        break;
      }
    }


    root.position.x = THREE.MathUtils.clamp(root.position.x, -AREA_HALF, AREA_HALF);
    root.position.z = THREE.MathUtils.clamp(root.position.z, -AREA_HALF, AREA_HALF);

    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.15;
      const s = player.state;
      hud.setStatus(s.walking ? "走路" : "待机", s.upper ?? "—", s.tail);
    }

    stage.update();
  });

  loading.classList.add("done");
  setTimeout(() => loading.remove(), 900);

  (window as unknown as Record<string, unknown>).whale = { stage, root, player, meshes, requestMove };
}

boot().catch((err) => {
  console.error(err);
  const note = document.querySelector(".loading-note");
  if (note) note.textContent = `载入失败：${err instanceof Error ? err.message : String(err)}`;
});
