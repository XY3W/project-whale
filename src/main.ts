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
import { pickRoamPlan } from "./behavior/roam.ts";
import { Hud } from "./ui/Hud";
import { PropItem } from "./prop/PropItem";
import { loadBasinAssets } from "./prop/catalog";
import { planApproach, signedDeltaDeg } from "./prop/align";
import type { BasinBridge } from "./behavior/protocol.ts";
import { ProgressMonitor } from "./behavior/progress.ts";

const MODEL = "/models/minesweeper-v1/character_minesweeper.glb";
const BASIN_ASSET_DIR = "/models/minesweeper-v1";
const BASIN_MODEL = "/models/minesweeper-v1/steel_basin_v2.glb";
const SCOOP_MODEL = "/models/minesweeper-v1/rice_scoop_straight_v3.glb";
const AREA_HALF = 3.7;
const DEBUG = new URLSearchParams(location.search).has("debug");
const round3 = (v: number) => Math.round(v * 1000) / 1000;

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

  // ---- 钢盆互动资产（v2：4 段互动 + 持盆循环）----
  note.textContent = "正在准备钢盆…";
  const [basinAssets, basinGltf] = await Promise.all([
    loadBasinAssets(BASIN_ASSET_DIR),
    new GLTFLoader().loadAsync(BASIN_MODEL),
  ]);
  const basinCatalog = basinAssets.catalog;
  const tuckTargets: THREE.Mesh[] = [];
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    const dict = m.morphTargetDictionary;
    if (dict && dict[basinCatalog.wearMorph] !== undefined) tuckTargets.push(m);
  });
  const setTuck = (value: number) => {
    for (const mesh of tuckTargets) {
      const index = mesh.morphTargetDictionary![basinCatalog.wearMorph]!;
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = value;
    }
  };
  const boneMap = new Map<string, THREE.Bone>();
  gltf.scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) boneMap.set(o.name.replace(/[^A-Za-z0-9_]/g, ""), o as THREE.Bone);
  });
  const scoopGltf = await new GLTFLoader().loadAsync(SCOOP_MODEL);
  const basin = await PropItem.create({
    id: "basin",
    catalog: basinCatalog,
    propMotion: basinAssets.propMotion,
    charRoot: root,
    scene: basinGltf.scene,
    bones: boneMap,
    setMorph: setTuck,
    parent: stage.scene,
  });
  const scoop = await PropItem.create({
    id: "rice_scoop",
    catalog: basinCatalog,
    propMotion: basinAssets.propMotion,
    charRoot: root,
    scene: scoopGltf.scene,
    bones: boneMap,
    parent: stage.scene,
  });
  root.updateMatrixWorld(true);
  basin.resetToReference();
  scoop.resetToReference();
  const holdBasinClip = gltf.animations.find((c) => c.name === "hold_basin") ?? null;
  const holdScoopClip = gltf.animations.find((c) => c.name === "hold_scoop") ?? null;
  if (holdBasinClip) player.setHold("left_hand", holdBasinClip);
  if (holdScoopClip) player.setHold("right_hand", holdScoopClip);

  /** catalog 里盆的拾取参考（旧代码直接读顶层 pickupReference） */
  const basinReference = basinCatalog.props!.basin.pickupReference;

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
  let stateApplied = false;
  let basinApplied = false;
  let lastBasinRevision = -1;
  let lastBasinReport = 0;
  let lastReport = 0;

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
    heldObjectId: basin.state === "held" ? "basin" : scoop.state === "held" ? "rice_scoop" : null,
    headObjectId: basin.state === "worn" ? "basin" : null,
    slots: { left_hand: basin.state === "held" ? "basin" : null, right_hand: scoop.state === "held" ? "rice_scoop" : null, head: basin.state === "worn" ? "basin" : null },
    objects: [
      { ...basin.snapshot(), ...(basin.state === "resting" ? { approachCandidates: approachHint() } : {}) },
      scoop.snapshot(),
    ],
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
    errorActive = false;
    setError(false);
    chat.setError(null);
    chat.setThinking(true);
    client.sendUserMessage(text, snapshot());
  };
  chat.onTimeout = () => {
    bubble.classList.remove("show");
  };
  // 关闭聊天：没有进行中的任务时，漫游门禁会自动放行（chat.open 为 false）
  chat.onClose = () => {
    bubble.classList.remove("show");
    client.setChatOpen(false);
  };
  chat.onOpen = () => client.setChatOpen(true);

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
    // 任务执行中点击角色：先取消旧计划，再由统一入口接管
    if (motionOwner === "plan") {
      currentExecutor?.cancel();
      motionEpoch++;
      motionOwner = "none"; // 旧 run 的 finally 因 epoch 变化不会清 owner，这里显式释放
    }
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
  /**
   * 按“有没有继续动”等待，而不是按墙钟。
   * 动画按帧推进，低帧率或后台标签页会把 17 秒路程拉长到几分钟；固定超时会把
   * 正常行走切成半截，再被判定成位移不符。
   */
  const waitForProgress = (
    check: () => boolean,
    progress: () => number,
    opts: { idleMs?: number; maxMs?: number } = {},
  ) =>
    new Promise<void>((resolve, reject) => {
      const monitor = new ProgressMonitor({ start: performance.now(), initial: progress(), ...opts });
      const timer = setInterval(() => {
        const state = monitor.sample(performance.now(), progress(), check());
        if (state === "done") {
          clearInterval(timer);
          resolve();
        } else if (state === "stalled") {
          clearInterval(timer);
          reject(new Error("STALLED"));
        }
      }, 50);
    });

  const loco: Locomotion = {
    yaw: () => root.rotation.y,
    position: () => ({ x: root.position.x, z: root.position.z }),
    walk: async (meters) => {
      if (cyclesFor(meters) === null) return;
      const from = root.position.clone();
      player.walkDistance(meters);
      // 进展 = 已走距离；收步阶段也要算，否则最后 0.09 m 会被当成卡住
      await waitForProgress(
        () => !player.state.walking && player.state.base === "idle_stand",
        () => root.position.distanceTo(from),
        { idleMs: 8000 },
      );
    },
    turn: async (deg) => {
      const from = root.rotation.y;
      startTurn(from + (deg * Math.PI) / 180, null);
      await waitForProgress(
        () => phase !== "turning",
        () => Math.abs(root.rotation.y - from),
        { idleMs: 4000, maxMs: 60000 },
      );
    },
    play: async (id) => {
      player.gesture(id);
      await waitForProgress(() => player.state.upper === null, () => performance.now(), { idleMs: 60000, maxMs: 60000 });
    },
    tail: async (style, dur) => {
      player.setTail(style === "tail_swish");
      await new Promise((r) => setTimeout(r, dur * 1000));
      player.setTail(false);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    isMoving: () => player.state.walking || phase !== "idle",
  };
  const degYaw = () => (root.rotation.y * 180) / Math.PI;
  const alignInfo = () => {
    const ref = basinReference.position;
    const reach = Math.hypot(ref[0], ref[2]);
    const dx = basin.position.x - root.position.x;
    const dz = basin.position.z - root.position.z;
    const direct = Math.hypot(dx, dz);
    const offsetBearing = (Math.atan2(ref[0], ref[2]) * 180) / Math.PI;
    const wantYaw = (Math.atan2(dx, dz) * 180) / Math.PI - offsetBearing;
    const yawErrorDeg = signedDeltaDeg(degYaw(), wantYaw);
    const distanceError = direct - reach;
    return {
      distanceError: Math.round(distanceError * 10000) / 10000,
      yawErrorDeg: Math.round(yawErrorDeg * 1000) / 1000,
      ok: Math.abs(distanceError) <= 0.02 && Math.abs(yawErrorDeg) <= 2,
    };
  };

  // 给模型的站位建议：站位点由“参考半径 + 精确步行距离”两个圆求交得到
  const approachHint = () => {
    const plan = planApproach({
      character: { x: root.position.x, z: root.position.z },
      basin: { x: basin.position.x, z: basin.position.z },
      yawDeg: degYaw(),
      reference: { x: basinReference.position[0], z: basinReference.position[2] },
      half: AREA_HALF,
      margin: 0.3,
    });
    if ("error" in plan) return { error: plan.error, reach: round3(plan.reach) };
    return {
      reach: round3(plan.reach),
      recommended: {
        turn_deg: round3(plan.turn1Deg),
        walk_m: plan.distanceM,
        final_turn_deg: round3(plan.turn2Deg),
        stand: { x: round3(plan.stand.x), z: round3(plan.stand.z) },
        final_yaw_deg: round3(plan.finalYawDeg),
      },
    };
  };

  const basinBridge: BasinBridge = {
    snapshot: () => basin.snapshot(),
    alignment: alignInfo,
    upright: async () => {
      const started = basin.startUpright(0.45);
      if (!started.ok) return started;
      // 扶正按帧推进：低帧率机器上 0.45 秒可能要跑十几秒墙钟
      const t0 = performance.now();
      while (basin.uprighting && performance.now() - t0 < 20000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ...basin.lastUpright, ok: !basin.uprighting && basin.upright };
    },
    reset: () => {
      player.clearGesture();
      player.setWalking(false);
      player.cancelPerformance();
      basin.resetToCenter();
    },
    canStart: (id) => basin.canStart(id),
    cancel: () => { player.cancelPerformance(); },
    align: async () => {
      const reference = { x: basinReference.position[0], z: basinReference.position[2] };
      // 距离远时先按最大支持距离走近，再求精确站位；最多 10 段，避免无限循环
      for (let leg = 0; leg < 10; leg++) {
        const plan = planApproach({
          character: { x: root.position.x, z: root.position.z },
          basin: { x: basin.position.x, z: basin.position.z },
          yawDeg: degYaw(),
          reference,
          half: AREA_HALF,
          margin: 0.3,
        });
        if (!("error" in plan)) {
          if (Math.abs(plan.turn1Deg) > 0.01) await loco.turn(plan.turn1Deg);
          if (plan.distanceM > 0) await loco.walk(plan.distanceM);
          if (Math.abs(plan.turn2Deg) > 0.01) await loco.turn(plan.turn2Deg);
          const check = alignInfo();
          return {
            ok: check.ok,
            plan: {
              distanceM: plan.distanceM,
              turn1Deg: plan.turn1Deg,
              turn2Deg: plan.turn2Deg,
              stand: plan.stand,
              finalYawDeg: plan.finalYawDeg,
              reach: plan.reach,
            },
            error: check.ok ? undefined : "NOT_ALIGNED",
          };
        }
        if (plan.error === "NO_SUPPORTED_DISTANCE" && plan.direct > plan.reach + 1.89 + 0.2) {
          const bearing = (Math.atan2(basin.position.x - root.position.x, basin.position.z - root.position.z) * 180) / Math.PI;
          await loco.turn(signedDeltaDeg(degYaw(), bearing));
          await loco.walk(1.89);
          continue;
        }
        return { ok: false, plan: null, error: plan.error };
      }
      return { ok: false, plan: null, error: "TOO_FAR" };
    },
    perform: async (actionId, spec) => {
      if (!basin.begin(actionId, spec)) return false;
      const meta = basinCatalog.actions.find((a) => a.id === actionId);
      const events = (meta?.events ?? []).map((e) => ({ time: e.time, type: e.type }));
      const ok = await player.perform(actionId, events, (type) => basin.handleEvent(type), meta?.layer ?? "full_body");
      basin.finish(ok);
      return ok;
    },
  };
  loco.basin = basinBridge;

  const resetButton = document.getElementById("reset-basin");
  resetButton?.addEventListener("click", () => {
    basinBridge.reset();
    speak("盆放回场地中心了", 1800);
  });

  // 每次运行独立执行器：过期 run 的取消不会复活，也不会影响新 run
  let currentExecutor: ActionExecutor | null = null;
  const makeExecutor = () => {
    const ex = new ActionExecutor(loco, { half: 4, margin: 0.3 });
    ex.onCancel(() => {
      player.clearGesture();
      player.setWalking(false);
      basinBridge.cancel();
    });
    currentExecutor = ex;
    return ex;
  };
  let roamBusy = false;
  let planChain: Promise<void> = Promise.resolve();
  let errorActive = false;

  // ---- 单一动作调度入口（P0-A）----
  // 漫游、模型计划都经由这里；同一时刻只有一个动作所有者。
  type Owner = "none" | "roaming" | "plan";
  let motionOwner: Owner = "none";
  let motionEpoch = 0;

  // 收步也是按帧推进的：低帧率下 0.8 秒的收步可能占好几秒墙钟，给足时间
  const waitBodySettled = async (timeoutMs = 30000) => {
    const t0 = performance.now();
    while (player.state.walking || player.state.base !== "idle_stand" || phase !== "idle" || player.state.upper !== null || player.performing !== null) {
      if (performance.now() - t0 > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  };

  const runOwned = async (owner: Owner, plan: Plan) => {
    if (motionOwner !== "none") {
      currentExecutor?.cancel();
      player.clearGesture();
      player.setWalking(false);
      const settled = await waitBodySettled();
      if (!settled) {
        console.warn("[motion] body did not settle, refusing new run");
        return null; // 停不下来就不接管，避免叠加动作
      }
    }
    motionOwner = owner;
    const epoch = ++motionEpoch;
    const ex = makeExecutor();
    try {
      const result = await ex.run(plan);
      return epoch === motionEpoch && currentExecutor === ex ? result : null; // 过期结果不回报
    } finally {
      if (epoch === motionEpoch) motionOwner = "none";
    }
  };

  client.on({
    onPlan: (msg) => {
      chat.setError(null);
      if (msg.speech) {
        chat.addMessage("whale", msg.speech);
        speak(msg.speech);
      }
      // 串行执行：新计划排队，旧计划先被取消钩子快速收尾
      planChain = planChain.then(async () => {
        const result = await runOwned("plan", msg.plan as unknown as Plan);
        if (result) {
          client.sendPlanResult(msg.taskId, result, { generation: msg.generation, planId: msg.planId }, snapshot());
          lastReport = performance.now();
        }
      });
    },
    onReply: (msg) => {
      errorActive = false;
      setError(false);
      chat.addMessage("whale", msg.speech);
      speak(msg.speech);
    },
    onTaskState: (phase) => {
      taskActive = phase === "thinking" || phase === "executing" || phase === "checking";
      chat.setThinking(taskActive);
      if (phase === "idle") chat.setThinking(false);
    },
    onError: (code, message) => {
      errorActive = true;
      chat.setError(`${code}：${message}`);
      chat.setThinking(false);
      if (code !== "BUSY") setError(true);
    },
    onCancel: () => {
      currentExecutor?.cancel();
      chat.setThinking(false);
    },
    onReadOnly: (ro) => {
      readOnly = ro;
      chat.setError(ro ? "另一个页面正在执行角色，这里只读" : null);
    },
    onReconcile: () => client.sendReconciled(snapshot()),
    onSnapshot: (s) => {
      if (stateApplied) return;
      stateApplied = true;
      root.position.x = THREE.MathUtils.clamp(s.x, -AREA_HALF, AREA_HALF);
      root.position.z = THREE.MathUtils.clamp(s.z, -AREA_HALF, AREA_HALF);
      root.rotation.y = (s.yawDeg * Math.PI) / 180;
    },
    onBasin: (record) => {
      if (basinApplied) return;
      basinApplied = true;
      root.updateMatrixWorld(true);
      const ok = basin.restore(record);
      const scoopRecord = Array.isArray((record as { objects?: unknown[] }).objects)
        ? ((record as { objects?: Array<Record<string, unknown>> }).objects ?? []).find((o) => o.object_id === "rice_scoop")
        : null;
      if (scoopRecord) scoop.restore(scoopRecord);
      console.info("[basin] restored", ok ? record.state : "failed", record.position);
    },
    onConnection: (ok) => {
      if (!ok) {
        chat.setError("与大脑的连接断开，正在重连…");
        chat.setThinking(false);
        taskActive = false;
        errorActive = true;
        currentExecutor?.cancel();
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
          // 朝向归一化到 (-π, π]：累计多次转向后避免出现 400° 之类的数值
          root.rotation.y = Math.atan2(Math.sin(root.rotation.y), Math.cos(root.rotation.y));
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
      stateApplied && !errorActive && !readOnly && client.connected && motionOwner === "none" && !chat.open && !wantChat && !destination && !roamBusy && !taskActive && phase === "idle" &&
      !player.state.walking && player.state.base === "idle_stand";

    if (canRoam) {
      roamTimer -= dt;
      if (roamTimer <= 0) {
        roamTimer = 3 + Math.random() * 5;
        // 加权选向：越靠近边缘，朝该方向的权重越低，0.5 米内为 0
        const plan = pickRoamPlan({
          x: root.position.x,
          z: root.position.z,
          yaw: root.rotation.y,
          half: 4 - 0.3, // 留出角色半身
        });
        if (plan) {
          roamBusy = true;
          void runOwned("roaming", {
            steps: [
              { action: "turn", angle_deg: Math.round(plan.angleDeg) },
              { action: "walk", distance_m: plan.distance },
            ],
          }).finally(() => { roamBusy = false; });
        }
      }
    } else {
      roamTimer = Math.max(roamTimer, 2 + Math.random() * 3);
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

    // 钢盆状态一变就立刻上报，避免刚拾取完就刷新导致恢复成旧状态
    const basinRevision = basin.snapshot().revision;
    if (basinRevision !== lastBasinRevision) {
      lastBasinRevision = basinRevision;
      const now = performance.now();
      if (stateApplied && !readOnly && now - lastBasinReport > 500 && !player.performing) {
        lastBasinReport = now;
        lastReport = now;
        client.sendStateSnapshot(snapshot());
      }
    }

    // 上报位置：停稳后每 2 秒一次，供刷新恢复
    const now = performance.now();
    if (stateApplied && now - lastReport > 2000 && !player.state.walking && phase === "idle" && !taskActive) {
      lastReport = now;
      client.sendStateSnapshot(snapshot());
    }

    if (errIcon.classList.contains("show")) {
      const p = root.position.clone();
      p.y += 1.75;
      p.project(stage.camera);
      const x = (p.x * 0.5 + 0.5) * innerWidth;
      const y = (-p.y * 0.5 + 0.5) * innerHeight;
      errIcon.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    }

    root.updateMatrixWorld(true);
    basin.update(dt, player.performanceTime);
    scoop.update(dt, player.performanceTime);
    // 拾取/取下片段收尾时立刻接管持盆姿势，避免 0.15s 淡出把手臂拉回 idle
    player.setHoldEnabled("left_hand", basin.mode === "hand" && (!player.performing || player.performanceEnding));
    player.setHoldEnabled("right_hand", scoop.mode === "hand");

    stage.update();
  });

  window.addEventListener("pagehide", () => client.sendStateSnapshot(snapshot()));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") client.sendStateSnapshot(snapshot());
  });

  loading.classList.add("done");
  setTimeout(() => loading.remove(), 900);

  (window as unknown as Record<string, unknown>).whale = {
    stage, root, player, meshes, chat, requestMove, enterChat, client, basin, scoop, basinBridge, alignInfo,
    get executor() { return currentExecutor; },
    getMotionOwner: () => motionOwner,
    resetBasin: () => basinBridge.reset(),
    /** 调试用：不经模型直接跑一套计划（与模型下发走同一条调度路径） */
    run: (plan: Plan) => runOwned("plan", plan),
  };
}

boot().catch((err) => {
  console.error(err);
  const note = document.querySelector(".loading-note");
  if (note) note.textContent = `载入失败：${err instanceof Error ? err.message : String(err)}`;
});
