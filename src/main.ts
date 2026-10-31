import * as THREE from "three";
import "./style.css";
import { digAim } from "../shared/dig-aim.mjs";
import { PropAudio } from "./audio/PropAudio";
import { mountControls } from "./ui/Controls";
import { stepPropWorld, onPropImpact } from "./prop/basinPhysics";
import { Stage } from "./core/Stage";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { enableMultiWeight } from "./character/multiWeight";
import { LayeredMotionPlayer } from "./character/LayeredMotionPlayer";
import { CHARACTER_MODEL } from "./character/assets";
import { ChatPanel } from "./ui/ChatPanel";
import { TimerPanel } from "./ui/TimerPanel";
import { BrainClient } from "./brain/BrainClient";
import type { Plan } from "./behavior/protocol.ts";
import { ActionExecutor } from "./behavior/ActionExecutor";
import type { Locomotion } from "./behavior/protocol.ts";
import { cyclesFor, nearestSupported } from "./behavior/distances.ts";
import { pickRoamPlan } from "./behavior/roam.ts";
import { Hud } from "./ui/Hud";
import { PropItem } from "./prop/PropItem";
import { loadBasinAssets } from "./prop/catalog";
import { planApproach, signedDeltaDeg } from "./prop/align";
import type { BasinBridge, BasinView, DigBridge, DigOutcome, GameView, GomokuView, XiangqiView } from "./behavior/protocol.ts";
import { MinesweeperBoard } from "./game/MinesweeperBoard";
import { GomokuBoard, gomokuCellAt, gomokuCellCenter } from "./game/GomokuBoard";
import { XiangqiBoard, xqPoint, xqPointAt, XQ_HALF, placementFor } from "./game/XiangqiBoard";
import { ProgressMonitor } from "./behavior/progress.ts";

const MODEL = CHARACTER_MODEL;
const BASIN_ASSET_DIR = "/models/playful-v2";
const BASIN_MODEL = "/models/playful-v2/steel_basin_v2.glb";
const SCOOP_MODEL = "/models/playful-v2/rice_scoop_straight_v3.glb";
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
      m.castShadow = !m.name.startsWith("Blink_");
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

  const board = new MinesweeperBoard(stage.scene, stage.groundTop);
  let gameBoard: GameView | null = null;
  const gomokuBoard = new GomokuBoard(stage.scene, stage.groundTop);
  const xiangqiBoard = new XiangqiBoard(stage.scene, stage.groundTop);
  let gomokuView: GomokuView | null = null;
  let xiangqiView: XiangqiView | null = null;
  let xiangqiArmy: XiangqiView | null = null;
  /** execute_plan 下发的单次搬运 token */
  let xiangqiTokenRef: string | null = null;

  /** 五子棋状态条（和扫雷共用样式，互斥显示） */
  const gomokuChip = document.createElement("div");
  gomokuChip.className = "game-chip gomoku-chip";
  document.body.appendChild(gomokuChip);
  const gomokuButton = document.getElementById("start-gomoku") as HTMLButtonElement | null;
  const xiangqiButton = document.getElementById("start-xiangqi") as HTMLButtonElement | null;
  const syncGomokuButton = () => {
    if (!gomokuButton) return;
    const onField = !!gomokuView;
    gomokuButton.textContent = onField ? "五子棋结束" : "五子棋开局";
    gomokuButton.style.background = onField ? "#8a3a3a" : "#3d62ad";
  };
  const renderGomokuChip = (view: GomokuView | null) => {
    if (!view) {
      gomokuChip.classList.remove("show");
      syncGomokuButton();
      return;
    }
    const label =
      view.status === "won"
        ? view.winner === "black" ? "她赢了" : "你赢了"
        : view.status === "draw" ? "和棋"
        : view.status === "ended" ? "已结束"
        : view.turn === "white" ? "轮到你" : "她正在想";
    gomokuChip.textContent = `五子棋 15×15 · ${label} · 第 ${view.moves} 手`;
    gomokuChip.classList.toggle("playing", view.status === "playing");
    gomokuChip.classList.toggle("won", view.status === "won" || view.status === "draw");
    gomokuChip.classList.toggle("ended", view.status === "ended");
    gomokuChip.classList.remove("lost");
    gomokuChip.classList.add("show");
    syncGomokuButton();
  };

  /** 左上角状态条：没开局时隐藏，开局后显示盘面信息 */
  const gameChip = document.createElement("div");
  gameChip.className = "game-chip";
  document.body.appendChild(gameChip);
  const renderChip = (view: GameView | null) => {
    if (!view) {
      gameChip.classList.remove("show");
      return;
    }
    const label =
      view.status === "won" ? "通关" : view.status === "lost" ? "踩雷" : view.status === "ended" ? "已结束" : "进行中";
    gameChip.textContent = `扫雷 ${view.size}×${view.size} · ${view.mineCount} 雷 · ${label} · 剩 ${view.remainingSafe}`;
    gameChip.classList.toggle("playing", view.status === "playing");
    gameChip.classList.toggle("lost", view.status === "lost");
    gameChip.classList.toggle("won", view.status === "won");
    gameChip.classList.toggle("ended", view.status === "ended");
    gameChip.classList.add("show");
    syncStartButton();
  };

  /**
   * 只要盘面还在（进行中 / 踩雷 / 通关 / 已结束）按钮就是「扫雷结束」：
   * 进行中 → 结束并揭开雷区；已经结束 → 收起盘面，场地回到正常状态。
   */
  const startButton = document.getElementById("start-minesweeper") as HTMLButtonElement | null;
  const syncStartButton = () => {
    if (!startButton) return;
    const onField = !!gameBoard;
    startButton.textContent = onField ? "扫雷结束" : "扫雷开局";
    startButton.style.background = onField ? "#8a3a3a" : "#3d62ad";
  };

  // ---- 状态 ----
  let phase: Phase = "idle";
  let destination: THREE.Vector3 | null = null;
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
  const timerPanel = new TimerPanel((id, at) => client.skipTimer(id, at));
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

  // 头顶“正在想”指示器：模型思考/审核期间显示三个跳动的小点
  const thinkBadge = document.createElement("div");
  thinkBadge.className = "thinking-badge";
  thinkBadge.innerHTML = "<i></i><i></i><i></i>";
  document.body.appendChild(thinkBadge);
  let llmThinking = false;
  const setLlmThinking = (on: boolean) => {
    llmThinking = on;
    thinkBadge.classList.toggle("show", on);
  };

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
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    heldObjectId: basin.state === "held" ? "basin" : scoop.state === "held" ? "rice_scoop" : null,
    headObjectId: basin.state === "worn" ? "basin" : null,
    slots: {
      left_hand: basin.state === "held" ? "basin" : null,
      right_hand: scoop.state === "held" ? "rice_scoop" : null,
      head: basin.state === "worn" ? "basin" : null,
      waist_slot: scoop.mode === "waist" ? "rice_scoop" : null,
    },
    objects: [
      { ...basin.snapshot(), ...(basin.state === "resting" ? { approachCandidates: approachHint() } : {}) },
      { ...scoop.snapshot(), ...(scoop.state === "resting" ? { pickupStand: variantStand("rice_scoop") } : {}) },
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

  let turnTravel=0;
  const startTurn = (toYaw: number, then: (() => void) | null) => {
    turnTravel=0;
    turn.from = root.rotation.y;
    turn.to = toYaw;
    turn.t = 0;
    turn.dur = THREE.MathUtils.clamp(0.3 + Math.abs(toYaw - root.rotation.y) * 0.45, 0.3, 1.15);
    postTurn = then;
    phase = "turning";
  };

  const tapCharacter = () => {
    if (!client.connected) { chat.setError("还没有连上大脑服务"); return; }
    if (readOnly) { chat.setError("另一个页面正在执行角色，这里只读"); return; }
    errorActive = false;
    setError(false);
    chat.setError(null);
    chat.setThinking(true);
    client.sendUserMessage("用户轻拍了你一下", snapshot());
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

    // 象棋：轮到你时，先点自己的子选中，再点合法交点落子；点别处取消
    if (xiangqiView && xiangqiBoard.visible && xiangqiView.status === "playing") {
      const at = xiangqiPointAt(e.clientX, e.clientY);
      if (at) {
        const mine = xiangqiView.turn === xiangqiView.userSide;
        const piece = xiangqiView.pieces.find((p) => p.row === at.row && p.col === at.col);
        if (mine && piece && piece.side === xiangqiView.userSide) {
          const next = piece.id === xiangqiBoard.selection ? null : piece.id;
          xiangqiBoard.select(next);
          xiangqiBoard.liftSelected(next);
          return;
        }
        const selected = xiangqiBoard.selection;
        if (mine && selected && xiangqiBoard.legalTargets(selected).some((t) => t.row === at.row && t.col === at.col)) {
          client.xiangqiMove({
            gameId: xiangqiView.gameId,
            pieceId: selected,
            toRow: at.row,
            toCol: at.col,
            expectedRevision: xiangqiView.revision,
            moveId: `${xiangqiView.gameId}-${xiangqiView.revision}-${selected}`,
          });
          xiangqiBoard.select(null);
          return;
        }
        if (!mine) {
          xiangqiBoard.select(null);
          return;
        }
      }
    }

    // 五子棋：轮到你时，点交点落子
    if (gomokuView && gomokuBoard.visible && gomokuView.status === "playing" && gomokuView.turn === "white") {
      const cell = gomokuHoverAt(e.clientX, e.clientY);
      if (cell && !gomokuView.stones.some((s) => s.row === cell.row && s.col === cell.col)) {
        client.gomokuMove({
          gameId: gomokuView.gameId,
          row: cell.row,
          col: cell.col,
          expectedRevision: gomokuView.revision,
          moveId: `${gomokuView.gameId}-${gomokuView.revision}`,
        });
        return;
      }
    }

    ndc.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
    raycaster.setFromCamera(ndc, stage.camera);
    if (raycaster.intersectObjects(meshes, true).length === 0) return; // 地面点击不做事
    tapCharacter();
  });

  /** 扫雷盘面悬停：只做渲染高亮，点击格子不会移动或挖掘（行为仍由模型下令） */
  const hoverCellAt = (clientX: number, clientY: number) => {
    if (!gameBoard || !board.visible) return null;
    ndc.set((clientX / innerWidth) * 2 - 1, -((clientY / innerHeight) * 2 - 1));
    raycaster.setFromCamera(ndc, stage.camera);
    const hit = raycaster.intersectObject(board.mesh, false)[0];
    if (!hit) return null;
    const { x, z } = hit.point;
    const cellSize = gameBoard.cellSize ?? 0.5;
    const half = gameBoard.boardHalf ?? (gameBoard.size * cellSize) / 2;
    if (Math.abs(x) >= half || Math.abs(z) >= half) return null;
    return { row: Math.floor((z + half) / cellSize), col: Math.floor((x + half) / cellSize) };
  };
  /** 屏幕点 → 角色场地平面上的象棋交点（棋盘铺满 y=0，射线和数学平面求交即可） */
  const xiangqiPointAt = (clientX: number, clientY: number) => {
    if (!xiangqiView || !xiangqiBoard.visible) return null;
    ndc.set((clientX / innerWidth) * 2 - 1, -((clientY / innerHeight) * 2 - 1));
    raycaster.setFromCamera(ndc, stage.camera);
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return xqPointAt(hit.x, hit.z);
  };

  /** 五子棋交点悬停：只有轮到你、且点在交点附近时才给预落子提示 */
  const gomokuHoverAt = (clientX: number, clientY: number) => {
    if (!gomokuView || !gomokuBoard.visible) return null;
    ndc.set((clientX / innerWidth) * 2 - 1, -((clientY / innerHeight) * 2 - 1));
    raycaster.setFromCamera(ndc, stage.camera);
    const hit = raycaster.intersectObject(gomokuBoard.mesh, false)[0];
    if (!hit) return null;
    return gomokuCellAt(hit.point.x, hit.point.z);
  };
  canvas.addEventListener("pointermove", (e) => {
    if (xiangqiView && xiangqiBoard.visible) {
      board.setHover(null);
      gomokuBoard.setHover(null);
      xiangqiBoard.setHover(xiangqiPointAt(e.clientX, e.clientY));
      return;
    }
    if (gomokuView && gomokuBoard.visible) {
      board.setHover(null);
      gomokuBoard.setHover(gomokuHoverAt(e.clientX, e.clientY));
      return;
    }
    gomokuBoard.setHover(null);
    board.setHover(hoverCellAt(e.clientX, e.clientY));
  });
  canvas.addEventListener("pointerleave", () => {
    board.setHover(null);
    gomokuBoard.setHover(null);
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
        () => !player.state.walking && player.state.resting,
        () => root.position.distanceTo(from),
        { idleMs: 8000 },
      );
    },
    run: async (meters) => {
      const from = root.position.clone();
      if (!player.runDistance(meters)) return;
      await waitForProgress(
        () => !player.moving && player.state.resting,
        () => root.position.distanceTo(from),
        { idleMs: 8000 },
      );
    },
    adjust: async (meters) => {
      const from = root.position.clone();
      player.adjustDistance(meters);
      await waitForProgress(
        () => !player.moving && player.state.resting,
        () => root.position.distanceTo(from),
        { idleMs: 8000 },
      );
    },
    turn: async (deg) => {
      const from = root.rotation.y;
      startTurn(from + (deg * Math.PI) / 180, null);
      // 转向只有 0.3–1.15 秒动画；低帧率机器上两帧之间可能隔几秒，
      // 15 秒没有任何角度变化才算真卡住。
      await waitForProgress(
        () => phase !== "turning",
        () => Math.abs(root.rotation.y - from),
        { idleMs: 15000, maxMs: 120000 },
      );
      return turnTravel*180/Math.PI;
    },
    play: async (id) => {
      player.gesture(id);
      await waitForProgress(() => player.state.upper === null, () => performance.now(), { idleMs: 60000, maxMs: 60000 });
    },
    /**
     * 走到指定世界坐标：宿主算转向与步数（walk + walk_adjust），模型只给目标点。
     * 落点不止五子棋——任何“先站到某个位置”的需求都能用。
     */
    walkTo: async (x, z, toleranceM = 0.1) => {
      const epoch = bridgeEpoch;
      const checkCancelled = () => { if (epoch !== bridgeEpoch) throw new Error("CANCELLED"); };
      const from = { x: root.position.x, z: root.position.z };
      const dx = x - from.x;
      const dz = z - from.z;
      const distance = Math.hypot(dx, dz);
      const tolerance = Math.max(0.02, Math.min(0.5, toleranceM));
      if (distance <= tolerance) {
        return { ok: true, distance_m: +distance.toFixed(3), position: { x: +from.x.toFixed(3), z: +from.z.toFixed(3) }, moved: 0 };
      }
      // atan2 返回弧度，turn 用度：这里必须换算，否则只会转一点点
      const targetDeg = (Math.atan2(dx, dz) * 180) / Math.PI;
      await loco.turn!(signedDeltaDeg(degYaw(), targetDeg));
      checkCancelled();
      // 目标距离取容差的一半：步长是 0.18/0.02 的量化档位，留足余量才不会“差一点”判失败
      let rest = Math.max(0, distance - tolerance * 0.5);
      let moved = 0;
      while (rest >= 0.09 - 1e-9) {
        const stepM = nearestSupported(rest).below;
        if (!Number.isFinite(stepM) || stepM <= 0) break;
        await loco.walk!(stepM);
        checkCancelled();
        rest -= stepM;
        moved += stepM;
        if (rest < 0.09) break;
      }
      while (rest >= 0.02 - 1e-9) {
        const adj = loco.adjust ? Math.min(0.08, Math.floor(rest / 0.02) * 0.02) : 0;
        if (!adj) break;
        await loco.adjust!(adj);
        checkCancelled();
        rest -= adj;
        moved += adj;
      }
      const after = { x: root.position.x, z: root.position.z };
      const remaining = Math.hypot(x - after.x, z - after.z);
      if (remaining > tolerance + 0.02) {
        return {
          ok: false,
          error: "NOT_ALIGNED",
          distance_m: +remaining.toFixed(3),
          tolerance_m: tolerance,
          position: { x: +after.x.toFixed(3), z: +after.z.toFixed(3) },
          moved: +moved.toFixed(3),
          hint: `还差 ${remaining.toFixed(2)}m（需要 ≤${tolerance}m），可能被边界挡住或距离档位不够，换个方向或换个目标点`,
        };
      }
      return {
        ok: true,
        distance_m: +remaining.toFixed(3),
        position: { x: +after.x.toFixed(3), z: +after.z.toFixed(3) },
        moved: +moved.toFixed(3),
      };
    },
    /**
     * 五子棋落子：先走到交点旁（≤stoneToleranceM），做一次落子动作，再提交授权。
     * 服务端会复检站位与版本，所以这里不“替”服务端决定成败。
     */
    stone: {
      current: () => gomokuView,
      precheck: (step) => {
        const view = gomokuView;
        if (!view) return { ok: false, reason: "PRECONDITION_FAILED" as const, detail: { error: "NO_GAME" } };
        if (view.status !== "playing") return { ok: false, reason: "PRECONDITION_FAILED" as const, detail: { error: "GAME_OVER", status: view.status } };
        if (view.turn !== "black") return { ok: false, reason: "PRECONDITION_FAILED" as const, detail: { error: "NOT_YOUR_TURN", turn: view.turn } };
        if (view.gameId !== step.game_id) return { ok: false, reason: "PRECONDITION_FAILED" as const, detail: { error: "STALE_GAME" } };
        if (step.expected_revision !== view.revision) {
          return { ok: false, reason: "PRECONDITION_FAILED" as const, detail: { error: "STALE_REVISION", actual: view.revision } };
        }
        if (view.stones.some((s) => s.row === step.row && s.col === step.col)) {
          return { ok: false, reason: "PRECONDITION_FAILED" as const, detail: { error: "OCCUPIED", row: step.row, col: step.col } };
        }
        const center = gomokuCellCenter(step.row, step.col);
        const tolerance = view.stoneToleranceM ?? 1;
        const distance = Math.hypot(root.position.x - center.x, root.position.z - center.z);
        if (distance > tolerance + 1e-6) {
          return {
            ok: false,
            reason: "NOT_ALIGNED" as const,
            detail: {
              error: "NOT_ALIGNED",
              distance_m: +distance.toFixed(3),
              tolerance_m: tolerance,
              target: { row: step.row, col: step.col, x: +center.x.toFixed(3), z: +center.z.toFixed(3) },
              position: { x: +root.position.x.toFixed(3), z: +root.position.z.toFixed(3) },
              hint: `目标点超出可操作范围：离你 ${distance.toFixed(2)}m，需要 ≤${tolerance}m。先走近再落子`,
            },
          };
        }
        if (phase !== "idle" || player.state.walking || player.performing !== null) {
          return { ok: false, reason: "PRECONDITION_FAILED" as const, detail: { error: "NOT_STILL" } };
        }
        return { ok: true };
      },
      perform: async (step) => {
        // 落子动作：目前没有专门的“放子”片段，用一次点头表示把子按在这一点上
        player.gesture("nod");
        await waitForProgress(() => player.state.upper === null, () => performance.now(), { idleMs: 60000, maxMs: 60000 });
        const result = await client.commitStone({
          stoneAuthId: activePlan?.stoneAuthId ?? null,
          gameId: step.game_id,
          row: step.row,
          col: step.col,
          expectedRevision: step.expected_revision,
          x: root.position.x,
          z: root.position.z,
          taskId: activePlan?.taskId ?? null,
          generation: activePlan?.generation ?? null,
          planId: activePlan?.planId ?? null,
          leaseEpoch: activePlan?.leaseEpoch,
        });
        const { board: _board, ...rest } = result as Record<string, unknown>;
        void _board;
        return rest as unknown as { ok: boolean };
      },
    },
    tail: async (style, dur) => {
      const epoch=bridgeEpoch;
      player.setTail(style === "tail_swish");
      await new Promise((r) => setTimeout(r, dur * 1000));
      if(epoch===bridgeEpoch)player.setTail(false);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    isMoving: () => player.moving || phase !== "idle" || player.performing!==null,
  };
  const degYaw = () => (root.rotation.y * 180) / Math.PI;
  const items = new Map<string, PropItem>([["basin", basin], ["rice_scoop", scoop]]);
  const itemOf = (objectId: string) => items.get(objectId) ?? null;
  const referenceOf = (objectId: string) => {
    const def = basinCatalog.props?.[objectId as "basin" | "rice_scoop"];
    return def ? { x: def.pickupReference.position[0], z: def.pickupReference.position[2] } : { x: basinReference.position[0], z: basinReference.position[2] };
  };
  /** 把对齐误差翻译成一句可执行的提示，模型不用自己推导 yawErrorDeg 的符号 */
  const alignHint = (distanceError: number, yawErrorDeg: number) => {
    const fmt = (v: number) => (Math.round(v * 10) / 10).toString();
    // 距离差明显时先说距离：1.7m 之外光转身是没用的
    if (distanceError > 0.1) return `离盆还差 ${fmt(distanceError)}m：先用 walk_to_basin 走近（它会算好站位），再 pickup。`;
    if (distanceError < -0.1) return `离盆太近 ${fmt(-distanceError)}m：先退开一点，再 pickup。`;
    if (Math.abs(yawErrorDeg) > 2) {
      return `站位够了，朝向差 ${fmt(Math.abs(yawErrorDeg))}°：turn(angle_deg=${fmt(yawErrorDeg)}) 之后再 pickup（正数左转、负数右转）。所需朝向由盆的摆放决定，不一定是朝盆心。`;
    }
    if (distanceError > 0.02) return `朝向没问题，但离盆还差 ${fmt(distanceError)}m：再靠近一点。`;
    if (distanceError < -0.02) return `朝向没问题，但离盆太近 ${fmt(-distanceError)}m：退开一点。`;
    return "站位和朝向都满足，可以直接 pickup。";
  };
  const alignInfo = (objectId = "basin") => {
    // 有落地变体的物品（饭勺）：站位点和朝向都由物品姿态唯一确定，
    // 判据是“离站位点多远 + 朝向差多少”，不是径向距离。用径向判断的话，
    // 几毫米的切向偏差会被放大成几度的朝向误差，拾取会莫名其妙 NOT_ALIGNED。
    const stand = variantStand(objectId);
    if (stand) {
      const standError = Math.hypot(root.position.x - stand.x, root.position.z - stand.z);
      const yawErrorDeg = signedDeltaDeg(degYaw(), stand.yawDeg);
      return {
        distanceError: Math.round(standError * 10000) / 10000,
        yawErrorDeg: Math.round(yawErrorDeg * 1000) / 1000,
        ok: standError <= 0.02 && Math.abs(yawErrorDeg) <= 2,
        hint: alignHint(standError, yawErrorDeg),
      };
    }
    const item = itemOf(objectId) ?? basin;
    const ref = referenceOf(objectId);
    const reach = Math.hypot(ref.x, ref.z);
    const dx = item.position.x - root.position.x;
    const dz = item.position.z - root.position.z;
    const direct = Math.hypot(dx, dz);
    const offsetBearing = (Math.atan2(ref.x, ref.z) * 180) / Math.PI;
    const wantYaw = (Math.atan2(dx, dz) * 180) / Math.PI - offsetBearing;
    const yawErrorDeg = signedDeltaDeg(degYaw(), wantYaw);
    const distanceError = direct - reach;
    return {
      distanceError: Math.round(distanceError * 10000) / 10000,
      yawErrorDeg: Math.round(yawErrorDeg * 1000) / 1000,
      ok: Math.abs(distanceError) <= 0.02 && Math.abs(yawErrorDeg) <= 2,
      hint: alignHint(distanceError, yawErrorDeg),
    };
  };

  /**
   * 有落地变体的物品（饭勺）：站位由“物品位置 − 朝向变换后的拾取偏移”唯一确定，
   * 同时给出站位朝向。模型拿这个点自己 turn/walk，不用猜偏移。
   */
  const variantStand = (objectId: string) => {
    const item = itemOf(objectId);
    if (!item || item.variants.length === 0) return null;
    const ref = referenceOf(objectId);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(item.object.quaternion);
    const itemYaw = (Math.atan2(forward.x, forward.z) * 180) / Math.PI;
    // 站位朝向来自“参考四元数”的朝向，而不是参考位置的方位角
    const refQuat = new THREE.Quaternion(...(item.definition.pickupReference.quaternion as [number, number, number, number]));
    const refForward = new THREE.Vector3(0, 0, 1).applyQuaternion(refQuat);
    const referenceYaw = (Math.atan2(refForward.x, refForward.z) * 180) / Math.PI;
    const yawDeg = itemYaw - referenceYaw;
    const rad = (yawDeg * Math.PI) / 180;
    return {
      x: item.position.x - (ref.x * Math.cos(rad) + ref.z * Math.sin(rad)),
      z: item.position.z - (-ref.x * Math.sin(rad) + ref.z * Math.cos(rad)),
      yawDeg: round3(yawDeg),
      reach: round3(Math.hypot(ref.x, ref.z)),
      variant: item.matchVariant(),
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
      margin: 0.12,
    });
    if ("error" in plan) return { error: plan.error, reach: round3(plan.reach) };
    return {
      reach: round3(plan.reach),
      recommended: {
        turn_deg: round3(plan.turn1Deg),
        walk_m: plan.distanceM,
        ...(plan.adjustM && plan.adjustM > 0.005 ? { adjust_m: round3(plan.adjustM) } : {}),
        final_turn_deg: round3(plan.turn2Deg),
        stand: { x: round3(plan.stand.x), z: round3(plan.stand.z) },
        final_yaw_deg: round3(plan.finalYawDeg),
      },
    };
  };

  const audio=new PropAudio();
  const controls=mountControls(client,audio);
  onPropImpact(event=>audio.play('collision',event.id,Math.min(1,event.normalSpeed*.32)));
  let bridgeEpoch=0;
  let currentHoldGrip='inward';
  const updateBasinHold=()=>{
    if(currentHoldGrip===basin.grip)return;currentHoldGrip=basin.grip;
    player.setHold('left_hand',gltf.animations.find(c=>c.name===(basin.grip==='outward'?'hold_basin_outward':'hold_basin'))??null);
  };
  const stopMotion=()=>{
    bridgeEpoch++;destination=null;postTurn=null;phase='idle';player.haltMovement();player.clearGesture();player.setTail(false);player.cancelPerformance();basin.cancel();scoop.cancel();
  };

  const basinBridge: BasinBridge = {
    items: () => [...items.values()].map((item) => item.snapshot() as unknown as BasinView),
    snapshot: (objectId) => (itemOf(objectId)?.snapshot() as unknown as BasinView) ?? null,
    alignment: (objectId) => alignInfo(objectId),
    upright: async (objectId) => {
      const epoch=bridgeEpoch;
      const item = itemOf(objectId);
      if (!item) return { ok: false, moved: 0, rotatedDeg: 0 };
      const started = item.startUpright(0.45);
      if (!started.ok) return started;
      // 扶正按帧推进：低帧率机器上 0.45 秒可能要跑十几秒墙钟
      const t0 = performance.now();
      while (item.uprighting && performance.now() - t0 < 20000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ...item.lastUpright, ok: epoch===bridgeEpoch&&!item.uprighting && item.upright };
    },
    reset: (objectId) => {
      player.clearGesture();
      player.setWalking(false);
      player.cancelPerformance();
      const put = (id: string) => {
        const item = itemOf(id);
        if (!item) return;
        // 盆回正中心；勺子挪开半米，否则两件物品会叠在同一格上
        if (id === "rice_scoop") item.resetToCenter(0.85, 0.85);
        else item.resetToCenter();
      };
      if (objectId) put(objectId);
      else for (const item of items.values()) put(item.id);
    },
    canStart: (objectId, actionId) => itemOf(objectId)?.canStart(actionId) ?? false,
    cancel: () => { player.cancelPerformance(); },
    align: async (objectId) => {
      const epoch=bridgeEpoch;
      const checked=async(p:Promise<void|number>)=>{await p;if(epoch!==bridgeEpoch)throw Error('CANCELLED');};
      const item = itemOf(objectId);
      if (!item) return { ok: false, plan: null, error: "OBJECT_NOT_FOUND" };
      const reference = referenceOf(objectId);
      // 有落地变体的物品（饭勺）朝向固定：站位朝向必须由物品朝向反推，
      // 否则从任意方位走过去都会让“脚尖挑勺”的动画方向不对。
      if (item.variants.length > 0) {
        const computed = variantStand(objectId)!;
        const finalYaw = computed.yawDeg;
        const stand = { x: computed.x, z: computed.z };
        const bearing = (Math.atan2(stand.x - root.position.x, stand.z - root.position.z) * 180) / Math.PI;
        await checked(loco.turn!(signedDeltaDeg(degYaw(), bearing)));
        // 用 walk + walk_adjust 把点落到 1cm 以内
        for (let step = 0; step < 16; step++) {
          const remaining = Math.hypot(stand.x - root.position.x, stand.z - root.position.z);
          if (remaining <= 0.01) break;
          const walkDistances = [1.89, 1.71, 1.53, 1.35, 1.17, 0.99, 0.81, 0.63, 0.45, 0.27, 0.09];
          const walk = walkDistances.find((d) => d <= remaining + 1e-6);
          if (walk !== undefined) { await checked(loco.walk!(walk)); continue; }
          const adjusts = [0.08, 0.06, 0.04, 0.02];
          const adjust = adjusts.find((d) => d <= remaining + 1e-6);
          if (adjust === undefined || !loco.adjust) break;
          await checked(loco.adjust!(adjust));
        }
        await checked(loco.turn!(signedDeltaDeg(degYaw(), finalYaw)));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        const check = alignInfo(objectId);
        return {
          ok: check.ok,
          plan: { distanceM: 0, turn1Deg: 0, turn2Deg: 0, stand, finalYawDeg: finalYaw, reach: Math.hypot(reference.x, reference.z) },
          error: check.ok ? undefined : "NOT_ALIGNED",
        };
      }
      // 距离远时先按最大支持距离走近，再求精确站位；最多 10 段，避免无限循环
      for (let leg = 0; leg < 10; leg++) {
        let plan = planApproach({
          character: { x: root.position.x, z: root.position.z },
          basin: { x: item.position.x, z: item.position.z },
          yawDeg: degYaw(),
          reference,
          half: AREA_HALF,
          margin: 0.12,
        });
        if (!("error" in plan)) {
          // 走近一次后可能还差一点（残差、恢复位置的时序），再按新位姿小修一到两次
          let check = alignInfo(objectId);
          for (let attempt = 0; attempt < 3 && !check.ok; attempt++) {
            if (Math.abs(plan.turn1Deg) > 0.01) await checked(loco.turn!(plan.turn1Deg));
            if (plan.distanceM > 0) await checked(loco.walk!(plan.distanceM));
            // 档位残差用 walk_adjust 补齐（近似解才有 adjustM）
            if (plan.adjustM && plan.adjustM > 0.005 && loco.adjust) {
              let rest = plan.adjustM;
              for (let k = 0; k < 6 && rest >= 0.02 - 1e-9; k++) {
                const adj = Math.min(0.08, Math.floor(rest / 0.02) * 0.02);
                if (adj <= 0) break;
                await checked(loco.adjust(adj));
                rest -= adj;
              }
            }
            if (Math.abs(plan.turn2Deg) > 0.01) await checked(loco.turn!(plan.turn2Deg));
            // 等一帧再读，避免收步/转身归一化还没落到读数上
            await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
            check = alignInfo(objectId);
            if (check.ok) break;
            const retry = planApproach({
              character: { x: root.position.x, z: root.position.z },
              basin: { x: item.position.x, z: item.position.z },
              yawDeg: degYaw(),
              reference,
              half: AREA_HALF,
              margin: 0.12,
            });
            if ("error" in retry) break;
            plan = retry;
          }
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
          const bearing = (Math.atan2(item.position.x - root.position.x, item.position.z - root.position.z) * 180) / Math.PI;
          await checked(loco.turn!(signedDeltaDeg(degYaw(), bearing)));
          await checked(loco.walk!(1.89));
          continue;
        }
        return { ok: false, plan: null, error: plan.error };
      }
      return { ok: false, plan: null, error: "TOO_FAR" };
    },
    setGrip: async(grip)=>{
      if(basin.state!=='held'||phase!=='idle'||player.moving||player.performing)return false;
      if(basin.grip===grip)return true;
      const epoch=bridgeEpoch;
      const id=grip==='outward'?'basin_grip_outward':'basin_grip_inward';
      const events=basinAssets.catalog.actions.find(a=>a.id===id)?.events??[];
      const ok=await player.perform(id,events,type=>{if(epoch===bridgeEpoch&&type==='grip_commit'){basin.setGrip(grip);updateBasinHold();}},'left_arm');
      updateBasinHold();return ok&&epoch===bridgeEpoch&&basin.grip===grip;
    },
    knock: async(count,stepId)=>{
      const result={requestedCount:count,committedCount:0,stopReason:'PRECONDITION_FAILED'};
      if(basin.state!=='held'||basin.grip!=='outward'||scoop.state!=='held'||phase!=='idle'||player.moving||player.performing)return result;
      const epoch=bridgeEpoch,id=`${activePlan?.planId??crypto.randomUUID()}:${stepId}`;
      const ok=await player.performKnocks(count,index=>{
        if(epoch!==bridgeEpoch||basin.state!=='held'||basin.grip!=='outward'||scoop.state!=='held')return;
        result.committedCount=index;audio.play('knock',`${id}:${index}`);
      });
      result.stopReason=ok&&epoch===bridgeEpoch?'completed':'cancelled';return result;
    },
    perform: async (objectId, actionId, spec) => {
      const epoch=bridgeEpoch;
      const item=items.get(objectId);if(!item||player.moving||phase!=='idle')return false;
      if(objectId==='basin'&&['wear_basin','throw_basin'].includes(actionId)&&basin.grip!=='inward')return false;
      if(!item.begin(actionId,spec))return false;
      const meta=basinAssets.catalog.actions.find(a=>a.id===actionId);
      const ok=await player.perform(actionId,meta?.events??[],type=>{
        if(epoch!==bridgeEpoch)return;root.updateMatrixWorld(true);item.update(0,player.performanceTime);item.handleEvent(type);
      },meta?.layer??'full_body');
      if(epoch===bridgeEpoch)item.finish(ok);updateBasinHold();return ok&&epoch===bridgeEpoch;
    },
  };
  loco.basin = basinBridge;

  /** 格心：与服务端 cellCenter 同一套公式（8m 场地，边长由棋盘下发，16×16 → 0.5m） */
  const cellCenterOf = (row: number, col: number) => {
    const size = gameBoard?.cellSize ?? 0.5;
    const half = gameBoard?.boardHalf ?? 4;
    return { x: -half + (col + 0.5) * size, z: -half + (row + 0.5) * size };
  };

  /** 当前正在执行的计划：dig 提交要带上任务/计划/授权，服务端据此校验 */
  let activePlan: { taskId: string; generation?: number; planId?: string; leaseEpoch?:number; digAuthId: string | null; stoneAuthId: string | null } | null = null;

  const digBridge: DigBridge = {
    current: () => gameBoard,
    precheck: (step) => {
      const board = gameBoard;
      if (!board) return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "NO_GAME" } };
      if (board.gameId !== step.game_id) {
        return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "STALE_GAME", gameId: board.gameId } };
      }
      if (board.status !== "playing") {
        return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "GAME_OVER", status: board.status } };
      }
      if (Number.isInteger(step.expected_revision) && step.expected_revision !== board.revision) {
        return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "STALE_REVISION", revision: board.revision } };
      }
      if (scoop.state !== "held") {
        return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "NO_SCOOP", scoop: scoop.snapshot() } };
      }
      const cell = board.cells.find((c) => c.row === step.row && c.col === step.col);
      if (!cell) return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "NO_SUCH_CELL", row: step.row, col: step.col } };
      if (cell.state === "revealed") {
        return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "ALREADY_REVEALED", row: step.row, col: step.col } };
      }
      const center = cellCenterOf(step.row, step.col);
      const distance = Math.hypot(root.position.x - center.x, root.position.z - center.z);
      const tolerance = board.digToleranceM ?? 0.18;
      if (distance > tolerance + 1e-6) {
        return {
          ok: false,
          reason: "PRECONDITION_FAILED",
          detail: { error: "NOT_IN_CELL", distance_m: +distance.toFixed(3), targetCellCenter: center, position: { x: +root.position.x.toFixed(3), z: +root.position.z.toFixed(3) } },
        };
      }
      const cellSize=board.cellSize??.5;
      const aim=digAim({x:root.position.x,z:root.position.z,yawDeg:degYaw()});
      if(Math.abs(aim.tip.x-center.x)>cellSize/2-.001||Math.abs(aim.tip.z-center.z)>cellSize/2-.001)return {ok:false,reason:"PRECONDITION_FAILED",detail:{error:"TOOL_NOT_IN_CELL",projectedTip:aim.tip,suggestedRoot:{x:center.x+aim.standOffset.x,z:center.z+aim.standOffset.z},keepYawDeg:degYaw()}};
      if (phase !== "idle" || player.state.walking || player.performing !== null) {
        return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "NOT_STILL" } };
      }
      return { ok: true };
    },
    perform: async (step, stepId) => {
      const epoch=bridgeEpoch;
      const meta = basinCatalog.actions.find((a) => a.id === "dig");
      let pending: Promise<Record<string, unknown>> | null = null;
      await player.perform("dig", (meta?.events ?? []).map((e) => ({ time: e.time, type: e.type })), (type) => {
        if (type !== "dig_contact" || epoch!==bridgeEpoch || scoop.state!=="held" || phase!=="idle" || player.moving) return;
        root.updateMatrixWorld(true);scoop.update(0,player.performanceTime);scoop.object.updateMatrixWorld(true);
        const proxy=basinCatalog.props?.rice_scoop.collisionProxies?.at(-1)?.center??[0,.048384532,-.228484109];
        const tip=scoop.object.localToWorld(new THREE.Vector3(proxy[0],proxy[1],proxy[2]));
        const size=gameBoard?.cellSize??.5,half=gameBoard?.boardHalf??4;
        if(Math.floor((tip.x+half)/size)!==step.col||Math.floor((tip.z+half)/size)!==step.row)return;
        client.sendStateSnapshot(snapshot());
        pending = client.commitDig({
          toolPoint:{x:tip.x,z:tip.z},
          gameId: step.game_id,
          row: step.row,
          col: step.col,
          expectedRevision: step.expected_revision,
          x: root.position.x,
          z: root.position.z,
          digAuthId: activePlan?.digAuthId ?? null,
          leaseEpoch:activePlan?.leaseEpoch,
          taskId: activePlan?.taskId ?? null,
          generation: activePlan?.generation ?? null,
          planId: activePlan?.planId ?? null,
          stepId: stepId ?? null,
        });
      }, meta?.layer ?? "full_body");
      const result = pending ? await pending : { ok: false, reason: "NO_CONTACT" };
      // 服务端回包里带着整张公开棋盘（256 格）；棋盘本来就单独在上下文里，
      // 这里必须剥掉，否则一次挖掘的执行报告会多出 6k+ tokens。
      const { board: _board, changedCells: _cells, ...rest } = result as Record<string, unknown>;
      void _board;
      const changed = Array.isArray(_cells) ? (_cells as unknown[]) : [];
      return {
        ...rest,
        changedCount: changed.length,
        // 零格展开可能一次翻开上百格：只给数量，格子列表过长会把上下文撑爆
        ...(changed.length <= 16 ? { changedCells: changed } : {}),
      } as unknown as DigOutcome;
    },
  };
  loco.dig = digBridge;

  // ---- 右腰挂勺：bindings.rightWaist 只存在于象棋目录，用到时才拉一次 ----
  let waist: { bone: THREE.Bone; matrix: THREE.Matrix4 } | null = null;
  const ensureWaist = async () => {
    if (waist) return waist;
    const res = await fetch("/models/xiangqi-v1/catalog.json");
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    const catalog = (await res.json()) as { bindings?: Record<string, { bone: string; matrixColumnMajor: number[] }> };
    const binding = catalog.bindings?.rightWaist;
    if (!binding) throw new Error("catalog 缺少 rightWaist 绑定");
    const bone = boneMap.get(binding.bone.replace(/[^A-Za-z0-9_]/g, ""));
    if (!bone) throw new Error(`缺少骨骼 ${binding.bone}`);
    waist = { bone, matrix: new THREE.Matrix4().fromArray(binding.matrixColumnMajor) };
    scoop.setWaistTarget(waist.bone, waist.matrix);
    return waist;
  };

  /**
   * 挂勺 / 取勺共用一条路径：整段右臂动画（1.4s），在素材给的时刻才换父级。
   * stow_scoop 0.9s waist_attach；unstow_scoop 0.5s hand_attach。
   */
  const scoopTransfer = async (kind: "stow" | "unstow") => {
    if (kind === "stow") {
      if (scoop.state !== "held") return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "NO_SCOOP" } };
      try { await ensureWaist(); } catch (error) { return { ok: false, reason: "CAPABILITY_DISABLED", detail: { error: String(error) } }; }
    } else if (scoop.mode !== "waist") {
      return { ok: false, reason: "PRECONDITION_FAILED", detail: { error: "NOT_STOWED" } };
    }
    const events = kind === "stow" ? [{ time: 0.9, type: "waist_attach" }] : [{ time: 0.5, type: "hand_attach" }];
    const done = await player.perform(kind === "stow" ? "stow_scoop" : "unstow_scoop", events, (type) => scoop.handleEvent(type), "right_arm");
    if (!done) return { ok: false, reason: "TRANSFER_FAILED" };
    return { ok: true, slot: kind === "stow" ? "waist_slot" : "right_hand", state: scoop.state };
  };
  loco.stowScoop = () => scoopTransfer("stow");
  loco.unstowScoop = () => scoopTransfer("unstow");
  // 开局就把腰挂点准备好：刷新时如果勺子是挂在腰上的，restore 才有地方挂
  void ensureWaist().catch((error) => console.warn("[scoop] 腰挂绑定加载失败", error));

  /** 象棋搬棋：走近 0.85m → 魔法吸附 → 抱到目标旁 → 送出 → 带 token 提交 */
  loco.xiangqiMove = async (step, ctx) => {
    // 没有授权、或授权属于另一盘棋：一步都别动（走位和吸附都不能先发生）
    if (!ctx?.token) return { ok: false, reason: "NO_AUTH" };
    if (!xiangqiView || xiangqiView.gameId !== step.game_id) return { ok: false, reason: "STALE_GAME" };
    if (xiangqiView.status !== "playing") return { ok: false, reason: "GAME_OVER" };
    if (xiangqiView.turn !== xiangqiView.characterSide) return { ok: false, reason: "NOT_YOUR_TURN" };
    const piece = xiangqiView.pieces.find((p) => p.id === step.piece_id);
    if (!piece) return { ok: false, reason: "NO_PIECE" };
    // 抢占/取消：每一步之前先问执行器还要不要继续，别把整段搬运跑完
    const aborted = () => Boolean(ctx?.isCancelled?.());
    const from = xqPoint(piece.row, piece.col);
    const to = xqPoint(step.to_row, step.to_col);
    const bearing = (a: { x: number; z: number }, b: { x: number; z: number }) => (Math.atan2(b.x - a.x, b.z - a.z) * 180) / Math.PI;
    const walkToPoint = async (x: number, z: number) => {
      const steps = [1.89, 1.71, 1.53, 1.35, 1.17, 0.99, 0.81, 0.63, 0.45, 0.27, 0.09];
      const adjusts = [0.08, 0.06, 0.04, 0.02];
      await loco.turn!(signedDeltaDeg(degYaw(), bearing({ x: root.position.x, z: root.position.z }, { x, z })));
      for (let i = 0; i < 14; i++) {
        if (aborted()) return false;
        const d = Math.hypot(x - root.position.x, z - root.position.z);
        if (d <= 0.03) break;
        const w = steps.find((v) => v <= d + 1e-6);
        if (w !== undefined) { await loco.walk!(w); continue; }
        const a = adjusts.find((v) => v <= d + 1e-6);
        if (a === undefined || !loco.adjust) break;
        await loco.adjust(a);
      }
      await loco.turn!(signedDeltaDeg(degYaw(), bearing({ x: root.position.x, z: root.position.z }, { x, z })));
      return true;
    };
    // 站位：从棋子朝角色方向退 0.85m
    const dx = root.position.x - from.x;
    const dz = root.position.z - from.z;
    const dist = Math.hypot(dx, dz) || 1;
    const stand = { x: from.x + (dx / dist) * 0.85, z: from.z + (dz / dist) * 0.85 };
    await walkToPoint(stand.x, stand.z);
    await loco.turn!(signedDeltaDeg(degYaw(), bearing({ x: root.position.x, z: root.position.z }, from)));
    let carried = false;
    try {
      const picked = await player.perform("chess_pickup", [{ time: 0.4, type: "summon_start" }, { time: 1.2, type: "grasp" }], (type) => {
        if (type === "grasp") { xiangqiBoard.beginCarry(piece.id, root); carried = true; }
      });
      if (!picked) return { ok: false, reason: aborted() ? "CANCELLED" : "PICKUP_FAILED" };
      // 棋子已经在手上：换成抱棋基底层，之后走路不再摆臂
      player.setCarrying(true);
      // 抱到目标旁：仍站在距目标 0.85m 的位置
      const dx2 = root.position.x - to.x;
      const dz2 = root.position.z - to.z;
      const d2 = Math.hypot(dx2, dz2) || 1;
      const stand2 = { x: to.x + (dx2 / d2) * 0.85, z: to.z + (dz2 / d2) * 0.85 };
      if (!(await walkToPoint(stand2.x, stand2.z))) return { ok: false, reason: "CANCELLED" };
      await loco.turn!(signedDeltaDeg(degYaw(), bearing({ x: root.position.x, z: root.position.z }, to)));
      // 事件表来自 catalog.actions[chess_place]：0.4 release / 1.2 placement_gate / 1.3 land_confirmed
      if (aborted()) return { ok: false, reason: "CANCELLED" };
      // 吃子和普通落子是两段交付动作：目标格上有敌子就用 chess_capture_place
      const placement = placementFor(xiangqiView?.pieces, piece.id, step.to_row, step.to_col);
      const placeClip = placement.clip;
      const placed = await player.perform(placement.clip, placement.events, (type) => {
        if (type === "release") xiangqiBoard.endCarry(piece.id, { row: step.to_row, col: step.to_col });
      });
      carried = false;
      player.setCarrying(false);
      if (!placed) return { ok: false, reason: "PLACE_FAILED" };
      const token = (ctx as { token?: string } | undefined)?.token ?? xiangqiTokenRef;
      const res = await client.xiangqiCommit({ token, expectedRevision: step.expected_revision, toRow: step.to_row, toCol: step.to_col });
      if (!res.committed) return { ok: false, reason: String(res.reason ?? "NOT_COMMITTED"), ...res };
      return { ok: true, committed: true, revision: Number(res.revision) || 0, captured: (res.captured as string | null) ?? null, placeClip };
    } finally {
      // 抢占/取消/异常：不提交棋步，棋子放回原格，退出抱棋（安全放置）
      if (carried) {
        xiangqiBoard.endCarry(piece.id, { row: piece.row, col: piece.col });
        player.setCarrying(false);
      }
    }
  };


  gomokuButton?.addEventListener("click", () => {
    if (!client.connected) {
      chat.setError("还没有连上大脑服务，稍等一下再开局");
      return;
    }
    if (readOnly) {
      chat.setError("另一个页面正在执行角色，这里只读");
      return;
    }
    chat.setError(null);
    if (gomokuView) {
      client.endGomoku();
      speak(gomokuView.status === "playing" ? "这局先下到这里。" : "收起来了。", 1800);
      return;
    }
    client.startGomoku(`gm${Date.now()}`);
  });

  xiangqiButton?.addEventListener("click", () => {
    if (!client.connected) { chat.setError("还没有连上大脑服务，稍等一下再开局"); return; }
    if (readOnly) { chat.setError("另一个页面正在执行角色，这里只读"); return; }
    chat.setError(null);
    if (xiangqiView) {
      client.endXiangqi();
      speak(xiangqiView.status === "playing" ? "这局先下到这里。" : "收起来了。", 1800);
      return;
    }
    client.startXiangqi("red");
  });

  startButton?.addEventListener("click", () => {
    // 连接还没就绪、或这个页面只是只读镜像时给个提示，而不是静默失败
    if (!client.connected) {
      chat.setError("还没有连上大脑服务，稍等一下再开局");
      return;
    }
    if (readOnly) {
      chat.setError("另一个页面正在执行角色，这里只读");
      return;
    }
    chat.setError(null);
    if (gameBoard) {
      client.endGame();
      speak(gameBoard.status === "playing" ? "这局先到这里。" : "收起来了。", 1800);
      return;
    }
    client.startGame(`r${Date.now()}`);
  });

  document.getElementById("reset-basin")?.addEventListener("click", () => {
    basinBridge.reset("basin");
    speak("盆放回场地中心了", 1800);
  });
  document.getElementById("reset-scoop")?.addEventListener("click", () => {
    basinBridge.reset("rice_scoop");
    speak("勺子放回场地上了", 1800);
  });

  // 每次运行独立执行器：过期 run 的取消不会复活，也不会影响新 run
  let currentExecutor: ActionExecutor | null = null;
  const makeExecutor = () => {
    const ex = new ActionExecutor(loco, { half: stage.roomHalf, margin: 0.3 });
    ex.xiangqiToken = xiangqiTokenRef ?? undefined;
    ex.onCancel(stopMotion);
    currentExecutor = ex;
    return ex;
  };
  let roamBusy = false;
  let planChain: Promise<void> = Promise.resolve();
  const seenPlans=new Set<string>();
  const cancelledTasks=new Set<string>();
  let errorActive = false;

  // ---- 单一动作调度入口（P0-A）----
  // 漫游、模型计划都经由这里；同一时刻只有一个动作所有者。
  type Owner = "none" | "roaming" | "plan";
  let motionOwner: Owner = "none";
  let motionEpoch = 0;

  // 收步也是按帧推进的：低帧率下 0.8 秒的收步可能占好几秒墙钟，给足时间
  const waitBodySettled = async (timeoutMs = 30000) => {
    const t0 = performance.now();
    while (player.state.walking || !player.state.resting || phase !== "idle" || player.state.upper !== null || player.performing !== null) {
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
    onTimers: (list, serverNow) => timerPanel.update(list, serverNow),
    onTimerFired: (_name, message) => { chat.addMessage("whale", message); speak(message); },
    onPlan: (msg) => {
      xiangqiTokenRef = msg.xiangqiToken ?? null;
      chat.endReasoning(msg.taskId);
      if(msg.planId&&seenPlans.has(msg.planId))return;
      if(msg.planId){seenPlans.add(msg.planId);if(seenPlans.size>200)seenPlans.delete(seenPlans.values().next().value!);}
      chat.setError(null);
      if (msg.speech) {
        chat.addMessage("whale", msg.speech);
        speak(msg.speech);
      }
      // 串行执行：新计划排队，旧计划先被取消钩子快速收尾
      planChain = planChain.then(async () => {
        if(cancelledTasks.has(msg.taskId)||readOnly||msg.leaseEpoch!==client.leaseEpoch)return;
        // 这次挖掘提交要带上的任务/计划/授权；runOwned 结束时清空
        activePlan = {
          taskId: msg.taskId,
          generation: msg.generation,
          planId: msg.planId,
          digAuthId: msg.digAuthId ?? null,
          stoneAuthId: msg.stoneAuthId ?? null,
          leaseEpoch:msg.leaseEpoch,
        };
        const result = await runOwned("plan", msg.plan as unknown as Plan);
        if (result) {
          client.sendPlanResult(msg.taskId, result, { generation: msg.generation, planId: msg.planId, leaseEpoch:msg.leaseEpoch }, snapshot());
        } else {
          // 接管失败（身体停不下来）也必须回报，否则服务端会一直等 plan_result 到预算耗尽
          client.sendPlanResult(
            msg.taskId,
            {
              status: "failed",
              stopped: true,
              steps: [
                {
                  stepId: "s0",
                  action: "plan",
                  status: "unknown",
                  requested: {},
                  actual: null,
                  startState: {},
                  endState: null,
                  reasonCode: "SUPERSEDED",
                  durationMs: 0,
                },
              ],
            },
            { generation: msg.generation, planId: msg.planId, leaseEpoch:msg.leaseEpoch },
            snapshot(),
          );
        }
        lastReport = performance.now();
        activePlan = null;
      });
    },
    onReasoningStart: taskId => {
      errorActive = false;
      setError(false);
      chat.setError(null);
      chat.startReasoning(taskId);
    },
    onReasoningDelta: (taskId, text) => chat.appendReasoning(taskId, text),
    onReply: (msg) => {
      chat.endReasoning(msg.taskId);
      errorActive = false;
      setError(false);
      if(msg.speech){chat.addMessage("whale", msg.speech);speak(msg.speech);}
    },
    onMode:value=>controls.updateMode(value),
    onSkillEvent:(payload)=>{
      const data = payload as { op?: string; note?: string; skill?: { title?: string }; stats?: { enabled?: number; max?: number } };
      const label: Record<string, string> = { create: "技能 +1", revise: "技能已更新", disable: "技能已停用", enable: "技能已启用", "auto-disable": "技能自动停用" };
      const head = label[data.op ?? ""] ?? "技能";
      const title = data.skill?.title ? `「${data.skill.title}」` : "";
      const count = data.stats ? `（启用 ${data.stats.enabled}/${data.stats.max}）` : "";
      chat.addNote(`${head}${title}${data.note ? ` · ${data.note}` : ""}${count}`);
    },
    onMemoryUpdated:count=>controls.updatePending(count),
    onTaskState: (phase,taskId) => {
      if((phase==='thinking'||phase==='checking')&&motionOwner==='roaming'){currentExecutor?.cancel();}
      if(phase==='thinking'&&taskId){void waitBodySettled().then(ok=>{if(ok)client.ready(taskId,snapshot());});}
      if(phase==='stopping'){
        currentExecutor?.cancel();stopMotion();
        void waitBodySettled().then(ok=>{if(ok&&taskId)client.acknowledgeStop(taskId,snapshot());});
      }
      taskActive = phase === "thinking" || phase === "executing" || phase === "checking" || phase === "stopping" || phase === "unknown";
      chat.setThinking(taskActive);
      // 只有“等模型”的阶段才亮头顶图标；executing 是她在动，不是在想
      setLlmThinking(phase === "thinking" || phase === "checking");
      if (phase === "idle") { chat.setThinking(false); chat.endReasoning(); }
    },
    onError: (code, message) => {
      chat.endReasoning();
      errorActive = true;
      chat.setError(`${code}：${message}`);
      chat.setThinking(false);
      if (code !== "BUSY") setError(true);
    },
    onCancel: (taskId) => {
      chat.endReasoning(taskId);
      cancelledTasks.add(taskId);
      currentExecutor?.cancel();
      chat.setThinking(false);
    },
    onReadOnly: (ro) => {
      readOnly = ro;controls.readOnly(ro);
      if(ro){currentExecutor?.cancel();stopMotion();}
      chat.setError(ro ? "另一个页面正在执行角色，这里只读" : null);
    },
    onReconcile: () => {currentExecutor?.cancel();stopMotion();void waitBodySettled().then(ok=>{if(ok)client.sendReconciled(snapshot());});},
    onSnapshot: (s) => {
      if (stateApplied) return;
      stateApplied = true;
      root.position.x = THREE.MathUtils.clamp(s.x, -AREA_HALF, AREA_HALF);
      root.position.z = THREE.MathUtils.clamp(s.z, -AREA_HALF, AREA_HALF);
      root.rotation.y = (s.yawDeg * Math.PI) / 180;
    },
    onGame: (value) => {
      gameBoard = (value as GameView) ?? null;
      if (gameBoard) {
        // 两盘互斥：扫雷盘上桌，先让五子棋交还地板
        gomokuView = null;
        gomokuBoard.show(false);
        renderGomokuChip(null);
      }
      board.update(gameBoard as never);
      renderChip(gameBoard);
      syncStartButton();
    },
    onXiangqi: (value) => {
      const view = (value as XiangqiView) ?? null;
      xiangqiView = view;
      if (view && !xiangqiArmy) {
        // 第一份棋局到达时再加载素材，避免平时多下载 40MB
        xiangqiArmy = view;
        void xiangqiBoard.load().then(() => xiangqiBoard.update(xiangqiView));
      }
      if (view) {
        // 象棋上桌：收起其他棋盘，场地放到 11.5m
        if (gomokuView) { gomokuView = null; gomokuBoard.update(null); }
        if (gameBoard) { gameBoard = null; board.update(null as never); renderChip(null); }
        stage.setArena(XQ_HALF * 2);
      } else {
        stage.resetArena();
      }
      xiangqiBoard.update(view);
    },
    onGomoku: (value) => {
      gomokuView = (value as GomokuView) ?? null;
      if (gomokuView) {
        // 五子棋真的上桌了才需要把扫雷盘收起来（session_state 每次心跳都带 gomoku:null，
        // 无条件去收起会误伤正在进行的扫雷盘）
        gameBoard = null;
        renderChip(null);
        board.show(false);
      }
      gomokuBoard.update(gomokuView);
      renderGomokuChip(gomokuView);
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
        setLlmThinking(false);
        setError(true);
      } else {
        errorActive = false;
        chat.setError(null);
        setError(false);
        taskActive = false;
      }
    },
  });
  client.connect();

  // ---- 主循环 ----
  const clock = new THREE.Clock();

  // 盆/勺落定这类稀有事件立刻上报：否则模型会一直以为它还在飞
  const reportSettled = () => {
    if (!stateApplied || readOnly) return;
    lastBasinReport = performance.now();
    lastReport = lastBasinReport;
    client.sendStateSnapshot(snapshot());
  };
  basin.onSettled = reportSettled;
  scoop.onSettled = reportSettled;

  stage.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    client.keepAlive();
    player.update(dt);

    forward.set(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    if (player.movementDelta > 0 && phase !== "turning") {
      root.position.addScaledVector(forward, player.movementDelta);
    }

    switch (phase) {
      case "stopping":
        if (player.state.resting) phase = "idle";
        break;
      case "idle": {
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
        turnTravel=(turn.to-turn.from)*e;
        root.rotation.y = turn.from + turnTravel;
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
    // 有进行中的扫雷局时不启动机械漫游：那是她的“棋盘时间”，
    // 模型在思考/退避时也该待在盘边，而不是走开去闲逛。
    const gameInProgress = gameBoard?.status === "playing";
    const canRoam =
      stateApplied && !errorActive && !readOnly && client.connected && motionOwner === "none" && !destination && !roamBusy && !taskActive &&
      !gameInProgress && phase === "idle" && !player.state.walking && player.state.resting;

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
    if (stateApplied && !readOnly && now - lastReport > 2000 && !player.state.walking && phase === "idle" && !taskActive) {
      lastReport = now;
      client.sendStateSnapshot(snapshot());
    }

    if (llmThinking) {
      const p = root.position.clone();
      p.y += 1.24;
      p.project(stage.camera);
      const x = (p.x * 0.5 + 0.5) * innerWidth;
      const y = (-p.y * 0.5 + 0.5) * innerHeight;
      thinkBadge.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
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
    board.tick();
    gomokuBoard.tick();
    const carry = player.carrySample;
    if (carry) xiangqiBoard.followCarry(carry.clip, carry.time);
    xiangqiBoard.tick(performance.now());
    stepPropWorld(dt);
    basin.update(dt, player.performanceTime);
    scoop.update(dt, player.performanceTime);
    // 持仓层只看“这只手现在有没有东西”；哪只手要被动作接管由动作的 layer 决定，
    // 不能用“是否正在表演”一刀切——挖掘不含左臂，盆的姿势必须保留。
    updateBasinHold();
    player.setHoldEnabled("left_hand", basin.mode === "hand");
    player.setHoldEnabled("right_hand", scoop.mode === "hand");

    stage.update();
  });

  window.addEventListener("pagehide", () => { if (!readOnly) client.sendStateSnapshot(snapshot()); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && !readOnly) client.sendStateSnapshot(snapshot());
  });

  if(DEBUG){
    const tools=document.createElement('div');tools.style.cssText='position:fixed;left:18px;bottom:16px;z-index:100;display:flex;gap:6px;align-items:center;background:white;padding:10px;border-radius:8px';
    const output=document.createElement('span');output.textContent='动作验收';
    const setup=document.createElement('button');setup.textContent='验收双持准备';setup.onclick=()=>{currentExecutor?.cancel();stopMotion();basin.restore({state:'held',position:[0,1,0],grip:'outward'});scoop.restore({state:'held',position:[0,1,0]});updateBasinHold();output.textContent='双持就绪';};
    tools.append(setup);
    for(const count of [1,10,32]){const b=document.createElement('button');b.textContent=`验收敲${count}下`;b.onclick=()=>{output.textContent='执行中';void runOwned('plan',{steps:[{action:'knock_basin',object_id:'basin',tool_id:'rice_scoop',count,tempo:'normal'}]}).then(r=>{output.textContent=JSON.stringify(r?.steps[0]?.actual??r);});};tools.append(b);}
    for (const [label, action] of [['眨眼', () => player.blink.trigger()], ['保持闭眼', () => player.blink.setManual(1)], ['自然眨眼', () => player.blink.setManual(null)]] as const) { const b=document.createElement('button');b.textContent=label;b.onclick=action;tools.append(b); }
    const cancel=document.createElement('button');cancel.textContent='停止验收';cancel.onclick=()=>currentExecutor?.cancel();tools.append(cancel,output);document.body.append(tools);
  }

  loading.classList.add("done");
  setTimeout(() => loading.remove(), 900);

  (window as unknown as Record<string, unknown>).whale = {
    stage, root, player, meshes, chat, requestMove, tapCharacter, client, basin, scoop, basinBridge, alignInfo, board, audio, THREE, stepPropWorld, xiangqiBoard,
    stowScoop: loco.stowScoop, unstowScoop: loco.unstowScoop,
    getXiangqi: () => xiangqiView,
    getGame: () => gameBoard,
    gomokuBoard,
    getGomoku: () => gomokuView,
    /** 探针用：当前客户端快照（与服务端同步的同一份） */
    snapshot,
    get executor() { return currentExecutor; },
    getMotionOwner: () => motionOwner,
    resetBasin: () => basinBridge.reset("basin"),
    resetScoop: () => basinBridge.reset("rice_scoop"),
    /** 调试用：不经模型直接跑一套计划（与模型下发走同一条调度路径） */
    run: (plan: Plan) => runOwned("plan", plan),
  };
}

boot().catch((err) => {
  console.error(err);
  const note = document.querySelector(".loading-note");
  if (note) note.textContent = `载入失败：${err instanceof Error ? err.message : String(err)}`;
});
