import * as THREE from "three";
import "./style.css";
import { Stage } from "./core/Stage";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { enableMultiWeight } from "./character/multiWeight";
import { LayeredMotionPlayer } from "./character/LayeredMotionPlayer";
import { ChatPanel } from "./ui/ChatPanel";
import { BrainClient } from "./brain/BrainClient";
import type { Plan } from "./behavior/protocol.ts";
import { ActionExecutor } from "./behavior/ActionExecutor";
import type { Locomotion } from "./behavior/protocol.ts";
import { cyclesFor } from "./behavior/distances.ts";
import { Hud } from "./ui/Hud";

const MODEL = "/models/animation-v9/character_v9.glb";
const AREA_HALF = 3.7;
const DEBUG = new URLSearchParams(location.search).has("debug");

type Phase = "idle" | "stopping" | "turning" | "walking";

async function boot() {
  const stage = new Stage(document.getElementById("app")!);

  const loading = document.getElementById("loading")!;
  const bar = loading.querySelector(".loading-bar i") as HTMLElement;
  const note = loading.querySelector(".loading-note") as HTMLElement;

  const gltf = await new GLTFLoader().loadAsync(MODEL, (e) => {
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

  // ---- 状态 ----
  let phase: Phase = "idle";
  let destination: THREE.Vector3 | null = null;
  let wantChat = false;
  let chatYaw = 0;
  let postTurn: (() => void) | null = null;
  let roamTimer = 4;

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

  // ---- UI ----
  const chat = new ChatPanel();
  const client = new BrainClient();
  let taskActive = false;
  let readOnly = false;

  // 头顶红色断连图标：固定屏幕尺寸，跟随角色投影
  const errIcon = document.createElement("div");
  errIcon.className = "net-error";
  errIcon.textContent = "!";
  document.body.appendChild(errIcon);
  const setError = (on: boolean) => errIcon.classList.toggle("show", on);

  const bubble = document.createElement("div");
  bubble.className = "speech-bubble";
  document.body.appendChild(bubble);
  let bubbleUntil = 0;
  const speak = (text: string, ms = 5000) => {
    bubble.textContent = text;
    bubble.classList.add("show");
    bubbleUntil = performance.now() + ms;
  };

  const snapshot = () => ({
    x: +root.position.x.toFixed(3),
    z: +root.position.z.toFixed(3),
    yawDeg: +((root.rotation.y * 180) / Math.PI).toFixed(1),
    base: player.state.base,
    walking: player.state.walking,
    chatOpen: chat.open,
  });

  chat.onSend = (text) => {
    if (!client.connected) {
      chat.setError("还没有连上大脑服务");
      chat.setThinking(false);
      return;
    }
    if (readOnly) {
      chat.setError("另一个页面正在执行角色，这里只读");
      chat.setThinking(false);
      return;
    }
    chat.setError(null);
    chat.setThinking(true);
    client.sendUserMessage(text, snapshot());
  };
  chat.onTimeout = () => {
    bubble.classList.remove("show");
  };

  // ---- 移动 ----
  const requestMove = (point: THREE.Vector3) => {
    tmp.copy(point).sub(root.position).setY(0);
    if (tmp.lengthSq() < 0.0025) return;
    destination = point.clone();
    if (phase === "walking") {
      player.setWalking(false);
      phase = "stopping";
    } else if (phase === "turning") {
      phase = "idle";
    }
  };

  const startTurn = (toYaw: number, then: (() => void) | null) => {
    turn.from = root.rotation.y;
    turn.to = toYaw;
    turn.t = 0;
    turn.dur = THREE.MathUtils.clamp(0.3 + Math.abs(toYaw - root.rotation.y) * 0.45, 0.3, 1.15);
    postTurn = then;
    phase = "turning";
  };

  const enterChat = () => {
    if (chat.open) {
      chat.openPanel();
      return;
    }
    destination = null;
    if (phase === "walking" || player.state.walking) {
      player.setWalking(false);
      phase = "stopping";
    }
    chatYaw = Math.atan2(
      stage.camera.position.x - root.position.x,
      stage.camera.position.z - root.position.z,
    );
    wantChat = true;
  };

  // ---- 输入：只识别角色点击 ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt: { x: number; y: number; t: number } | null = null;

  const canvas = stage.renderer.domElement;
  canvas.addEventListener("pointerdown", (e) => {
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener("pointercancel", () => {
    downAt = null;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const quick = performance.now() - downAt.t < 400;
    downAt = null;
    if (moved > 6 || !quick) return;

    ndc.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
    raycaster.setFromCamera(ndc, stage.camera);
    if (raycaster.intersectObjects(meshes, true).length === 0) return; // 地面点击不做事
    enterChat();
  });

  // ---- 调试 HUD（仅 ?debug）----
  if (DEBUG) {
    new Hud((id) => {
      if (id === "walk") requestMove(root.position.clone().add(new THREE.Vector3(0, 0, 0.45)));
      else if (id === "tail") player.setTail(player.state.tail !== "tail_swish");
      else player.gesture(id);
    }, ["greet", "notice", "nod", "look_left", "look_right", "think", "tail"]);
  }

  // ---- 精确执行器接线 ----
  const waiters: { check: () => boolean; done: () => void }[] = [];
  const waitFor = (check: () => boolean, timeoutMs = 15000) =>
    new Promise<void>((resolve) => {
      const w = { check, done: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        resolve();
      }, timeoutMs);
      waiters.push(w);
    });

  const loco: Locomotion = {
    yaw: () => root.rotation.y,
    position: () => ({ x: root.position.x, z: root.position.z }),
    walk: async (meters) => {
      if (cyclesFor(meters) === null) return;
      player.walkDistance(meters);
      await waitFor(() => !player.state.walking && player.state.base === "idle_stand");
    },
    turn: async (deg) => {
      startTurn(root.rotation.y + (deg * Math.PI) / 180, null);
      await waitFor(() => phase !== "turning", 5000);
    },
    play: async (id) => {
      player.gesture(id);
      await waitFor(() => player.state.upper === null, 8000);
    },
    tail: async (style, dur) => {
      player.setTail(style === "tail_swish");
      await new Promise((r) => setTimeout(r, dur * 1000));
      player.setTail(false);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const executor = new ActionExecutor(loco, { half: 4, margin: 0.3 });
  executor.onCancel(() => {
    player.clearGesture();
    player.setWalking(false);
  });
  let roamBusy = false;
  let planChain: Promise<void> = Promise.resolve();

  client.on({
    onPlan: (msg) => {
      chat.setError(null);
      if (msg.speech) {
        chat.addMessage("whale", msg.speech);
        speak(msg.speech);
      }
      // 串行执行：新计划排队，旧计划先被取消钩子快速收尾
      planChain = planChain.then(async () => {
        const result = await executor.run(msg.plan as unknown as Plan);
        client.sendPlanResult(msg.taskId, result);
      });
    },
    onReply: (msg) => {
      chat.addMessage("whale", msg.speech);
      speak(msg.speech);
    },
    onTaskState: (phase) => {
      taskActive = phase === "thinking" || phase === "executing" || phase === "checking";
      chat.setThinking(taskActive);
      if (phase === "idle") chat.setThinking(false);
    },
    onError: (code, message) => {
      chat.setError(`${code}：${message}`);
      chat.setThinking(false);
      if (code !== "BUSY") setError(true);
    },
    onCancel: () => {
      executor.cancel();
      chat.setThinking(false);
    },
    onReadOnly: (ro) => {
      readOnly = ro;
      chat.setError(ro ? "另一个页面正在执行角色，这里只读" : null);
    },
    onReconcile: () => client.sendReconciled(snapshot()),
    onConnection: (ok) => {
      if (!ok) {
        chat.setError("与大脑的连接断开，正在重连…");
        chat.setThinking(false);
        taskActive = false;
        executor.cancel();
        player.setWalking(false);
        setError(true);
      } else {
        chat.setError(null);
        setError(false);
        taskActive = false;
      }
    },
  });
  client.connect();

  // ---- 主循环 ----
  const clock = new THREE.Clock();

  stage.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    player.update(dt);

    forward.set(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    if (player.movementDelta > 0 && phase !== "turning") {
      root.position.addScaledVector(forward, player.movementDelta);
    }

    switch (phase) {
      case "stopping":
        if (player.state.base === "idle_stand") phase = "idle";
        break;
      case "idle": {
        if (wantChat) {
          wantChat = false;
          const delta = shortest(root.rotation.y, chatYaw);
          if (Math.abs(delta) > 0.09) startTurn(chatYaw, () => chat.openPanel());
          else chat.openPanel();
          break;
        }
        if (!destination) break;
        tmp.copy(destination).sub(root.position).setY(0);
        if (tmp.length() < 0.08) {
          destination = null;
          player.setWalking(false);
          phase = "stopping";
          break;
        }
        const delta = shortest(root.rotation.y, yawTo(destination));
        if (Math.abs(delta) > 0.09) startTurn(root.rotation.y + delta, null);
        else {
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
        if (u >= 1) {
          phase = "idle";
          const next = postTurn;
          postTurn = null;
          next?.();
        }
        break;
      }
      case "walking":
        if (!destination) break;
        tmp.copy(destination).sub(root.position).setY(0);
        if (tmp.length() < 0.08) {
          destination = null;
          player.setWalking(false);
          phase = "stopping";
        }
        break;
    }

    // ---- 机械漫游门禁 ----
    const canRoam =
      !chat.open && !wantChat && !destination && !roamBusy && !taskActive && phase === "idle" &&
      !player.state.walking && player.state.base === "idle_stand";

    if (canRoam) {
      roamTimer -= dt;
      if (roamTimer <= 0) {
        roamTimer = 3 + Math.random() * 5;
        roamBusy = true;
        const angle = (Math.random() - 0.5) * 60;
        const distance = Math.random() < 0.5 ? 0.27 : 0.45;
        void executor
          .run({ steps: [{ action: "turn", angle_deg: Math.round(angle) }, { action: "walk", distance_m: distance }] })
          .finally(() => { roamBusy = false; });
      }
    } else {
      roamTimer = Math.max(roamTimer, 2 + Math.random() * 3);
    }

    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].check()) {
        waiters[i].done();
        waiters.splice(i, 1);
      }
    }

    root.position.x = THREE.MathUtils.clamp(root.position.x, -AREA_HALF, AREA_HALF);
    root.position.z = THREE.MathUtils.clamp(root.position.z, -AREA_HALF, AREA_HALF);

    if (bubble.classList.contains("show")) {
      if (performance.now() > bubbleUntil) bubble.classList.remove("show");
      else {
        const p = root.position.clone();
        p.y += 1.35;
        p.project(stage.camera);
        const x = (p.x * 0.5 + 0.5) * innerWidth;
        const y = (-p.y * 0.5 + 0.5) * innerHeight;
        bubble.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
      }
    }

    if (errIcon.classList.contains("show")) {
      const p = root.position.clone();
      p.y += 1.75;
      p.project(stage.camera);
      const x = (p.x * 0.5 + 0.5) * innerWidth;
      const y = (-p.y * 0.5 + 0.5) * innerHeight;
      errIcon.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    }

    stage.update();
  });

  loading.classList.add("done");
  setTimeout(() => loading.remove(), 900);

  (window as unknown as Record<string, unknown>).whale = {
    stage, root, player, meshes, chat, requestMove, enterChat, executor, client,
  };
}

boot().catch((err) => {
  console.error(err);
  const note = document.querySelector(".loading-note");
  if (note) note.textContent = `载入失败：${err instanceof Error ? err.message : String(err)}`;
});
