import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { sampleCurve, type CurveSample } from "../prop/catalog.ts";
import type { XiangqiView } from "../behavior/protocol";

/** 与素材契约一致：格宽 1.15m，10 行 × 9 列交点，场地 11.5×11.5m */
/** 落子动作：目标格上有敌子就走吃子片段，否则走普通落子片段（事件时刻来自 catalog） */
export function placementFor(
  pieces: Array<{ id: string; row: number; col: number }> | null | undefined,
  moverId: string,
  toRow: number,
  toCol: number,
) {
  const victim = pieces?.find((p) => p.id !== moverId && p.row === toRow && p.col === toCol) ?? null;
  return victim
    ? { clip: "chess_capture_place", victim: victim.id, events: [{ time: 0.4, type: "release" }, { time: 1.1, type: "capture_commit_gate" }, { time: 1.5, type: "land_confirmed" }] }
    : { clip: "chess_place", victim: null, events: [{ time: 0.4, type: "release" }, { time: 1.2, type: "placement_gate" }, { time: 1.3, type: "land_confirmed" }] };
}

const MOVE_DURATION_MS = 420;
type TargetPose = {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  /** 这一跳的起点与开始时间：弧线按时间推进，低帧率也一定落到地面 */
  from?: { pos: THREE.Vector3; quat: THREE.Quaternion };
  t0?: number;
  /** 新目标还没起跳：第一次 tick 时才记录起点，避免落稳后又被重启 */
  pending?: boolean;
};
export const XQ_CELL = 1.15;
export const XQ_HALF = 5.75;
export const XQ_ROWS = 10;
export const XQ_COLS = 9;

/** 交点世界坐标：row=0 黑底线、row=9 红底线；x=(col-4)*1.15, z=(row-4.5)*1.15 */
export function xqPoint(row: number, col: number) {
  return { x: (col - 4) * XQ_CELL, z: (row - 4.5) * XQ_CELL };
}

/** 世界坐标 → 最近交点；超过 0.45 格或越界返回 null */
export function xqPointAt(x: number, z: number): { row: number; col: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const col = Math.round(x / XQ_CELL + 4);
  const row = Math.round(z / XQ_CELL + 4.5);
  if (row < 0 || row >= XQ_ROWS || col < 0 || col >= XQ_COLS) return null;
  const p = xqPoint(row, col);
  if (Math.hypot(x - p.x, z - p.z) > XQ_CELL * 0.45) return null;
  return { row, col };
}

interface LayoutPiece {
  pieceId: string;
  side: "red" | "black";
  kind: string;
  template: string;
  row: number;
  col: number;
  position: [number, number, number];
  rotationY: number;
}

const LEGAL = 0x4fd1c5;
const CAPTURE = 0xff6b6b;
const HOVER = 0xffd166;

/**
 * 象棋盘面：木质棋盘铺满 11.5×11.5 场地，棋子用交付的 14 模板 ×32 实例。
 * 只渲染服务端公开状态；点击、悬停、弧线都只是表现，不改权威盘面。
 */
export class XiangqiBoard {
  readonly group = new THREE.Group();
  private readonly scene: THREE.Scene;
  private templates = new Map<string, THREE.Object3D>();
  private layout = new Map<string, LayoutPiece>();
  private instances = new Map<string, THREE.Object3D>();
  private targets = new Map<string, TargetPose>();
  private markers: THREE.Mesh[] = [];
  private markerKey = "";
  private view: XiangqiView | null = null;
  private active = false;
  private hover: { row: number; col: number } | null = null;
  private selected: string | null = null;
  private loaded = false;
  private lastMovePulse = 0;
  private lastRevision = -1;
  /** 被吃掉的棋子：先缩小淡出再移除，别在提交瞬间"啪"地凭空消失 */
  private readonly fading: Array<{ id: string; obj: THREE.Object3D; t: number }> = [];
  private lastTickAt = 0;
  private lastGameId: string | null = null;
  /** 正在被抱着的棋子：暂时脱离盘面同步 */
  private carried = new Set<string>();
  /** 素材交付的持棋轨迹：每个 chess_* 动作一条 actor-local 曲线（prop_motion.json） */
  private curves: Record<string, { chess: CurveSample[] }> = {};

  private readonly groundTop: THREE.Mesh | null;

  constructor(scene: THREE.Scene, groundTop: THREE.Mesh | null = null) {
    this.scene = scene;
    this.groundTop = groundTop;
    this.group.name = "xiangqi";
    this.group.visible = false;
    this.scene.add(this.group);
  }

  get visible() {
    return this.active;
  }

  get state() {
    return { view: this.view, hover: this.hover, selected: this.selected, visible: this.active };
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const loader = new GLTFLoader();
    const base = "/models/xiangqi-v1/";
    try {
      const [board, pieces, layout, motion] = await Promise.all([
        loader.loadAsync(`${base}board.glb`),
        loader.loadAsync(`${base}pieces.glb`),
        fetch(`${base}initial_layout.json`).then((r) => r.json() as Promise<LayoutPiece[]>),
        fetch(`${base}prop_motion.json`).then((r) => r.json() as Promise<{ clips: Record<string, { chess: CurveSample[] }> }>),
      ]);
      this.curves = motion.clips;
      // 棋盘：11.5×11.5 平面，压在地板上方一点
      const boardRoot = board.scene;
      boardRoot.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = false;
          mesh.receiveShadow = true;
          (mesh.material as THREE.MeshStandardMaterial).roughness = 0.86;
        }
      });
      boardRoot.position.set(0, 0.003, 0);
      this.group.add(boardRoot);
      // 棋子模板：piece_black_0..6 / piece_red_0..6
      pieces.scene.traverse((o) => {
        if (/^piece_(red|black)_\d+$/.test(o.name)) {
          o.traverse((c) => {
            const mesh = c as THREE.Mesh;
            if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
          });
          this.templates.set(o.name, o);
        }
      });
      for (const p of layout) this.layout.set(p.pieceId, p);
    } catch (err) {
      console.error("[xiangqi] 素材加载失败", err);
    }
  }

  /** 服务端公开状态 → 盘面（null 表示收起） */
  update(view: XiangqiView | null) {
    if (!view && !this.view) return;
    this.view = view;
    const next = !!view;
    if (next !== this.active) {
      this.active = next;
      this.group.visible = next;
      // 象棋期间隐藏 8m 网格地板，避免和木纹棋盘叠两层
      if (this.groundTop) this.groundTop.visible = !next;
    }
    if (!view) {
      this.hover = null;
      this.selected = null;
      this.clearMarkers();
      for (const fade of this.fading) this.group.remove(fade.obj);
      this.fading.length = 0;
      return;
    }
    if (view.gameId !== this.lastGameId) {
      this.lastGameId = view.gameId;
      this.lastMovePulse = performance.now();
      this.selected = null;
    } else if (view.revision !== this.lastRevision) {
      // 每一手都要重新点亮"最近一步"，不是只有换局才亮
      this.lastRevision = view.revision;
      this.lastMovePulse = performance.now();
      this.markerKey = "";
    }
    this.syncPieces(view);
    this.syncMarkers(view);
    this.hover = null;
  }

  show(visible: boolean) {
    if (!visible) {
      this.active = false;
      this.group.visible = false;
      this.clearMarkers();
    }
  }

  /** 点选：先选中自己的棋子，再点合法目标 */
  pick(x: number, z: number) {
    return xqPointAt(x, z);
  }

  setHover(at: { row: number; col: number } | null) {
    if (this.hover?.row === at?.row && this.hover?.col === at?.col) return;
    this.hover = at;
    if (this.view) this.syncMarkers(this.view);
  }

  select(pieceId: string | null) {
    this.selected = pieceId;
    this.liftSelected(pieceId); // 取消选择也要把棋子放回地面
    if (this.view) this.syncMarkers(this.view);
  }

  get selection() {
    return this.selected;
  }

  /** 服务端公开状态里这枚子的合法目标 */
  legalTargets(pieceId: string | null): { row: number; col: number }[] {
    if (!pieceId || !this.view) return [];
    return this.view.legalMoves.filter((m) => m.pieceId === pieceId).map(({ row, col }) => ({ row, col }));
  }

  private syncPieces(view: XiangqiView) {
    const alive = new Set<string>();
    for (const piece of view.pieces) {
      alive.add(piece.id);
      if (this.carried.has(piece.id)) continue;
      let obj = this.instances.get(piece.id);
      if (!obj) {
        const layout = this.layout.get(piece.id);
        const template = layout ? this.templates.get(layout.template) : null;
        if (!template) continue;
        // 同一枚子又回到盘面（撤步/重连）：把还在淡出的替身收掉
        for (let i = this.fading.length - 1; i >= 0; i--) {
          if (this.fading[i].id !== piece.id) continue;
          this.group.remove(this.fading[i].obj);
          this.fading.splice(i, 1);
        }
        obj = template.clone(true);
        obj.name = `xq-${piece.id}`;
        obj.userData.pieceId = piece.id;
        this.group.add(obj);
        this.instances.set(piece.id, obj);
      }
      const point = xqPoint(piece.row, piece.col);
      const layout = this.layout.get(piece.id);
      const rotation = layout?.rotationY ?? (piece.side === "red" ? 0 : Math.PI);
      const target: TargetPose = {
        pos: new THREE.Vector3(point.x, piece.id === this.selected ? 0.045 : 0, point.z),
        quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation),
      };
      const previous = this.targets.get(piece.id);
      if (previous && previous.pos.distanceTo(target.pos) < 1e-6) {
        // 目标没变：沿用这一跳的进度（包括"已经落稳"）
        target.from = previous.from;
        target.t0 = previous.t0;
        target.pending = previous.pending;
      } else {
        target.pending = true; // 新目标，下一帧起跳
      }
      this.targets.set(piece.id, target);
      if (!obj.userData.settled) {
        obj.position.copy(target.pos);
        obj.quaternion.copy(target.quat);
        obj.userData.settled = true;
      }
    }
    // 被吃掉的棋子：退出盘面状态，用一个短淡出收尾再真正移除
    for (const [id, obj] of this.instances) {
      if (alive.has(id)) continue;
      this.instances.delete(id);
      this.targets.delete(id);
      this.fading.push({ id, obj, t: 0 });
    }
  }

  /** 被吃棋子：0.28s 缩到 15% 并微微抬起，然后真正移除 */
  private advanceFades(dt: number) {
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const fade = this.fading[i];
      fade.t += dt;
      const k = Math.min(1, fade.t / 0.28);
      fade.obj.scale.setScalar(1 - 0.85 * k);
      fade.obj.position.y += 0.0035 * (1 - k);
      if (k < 1) continue;
      this.group.remove(fade.obj);
      this.fading.splice(i, 1);
    }
  }

  /** 调试用：还在淡出的棋子数量 */
  get fadingCount(): number { return this.fading.length; }

  private syncMarkers(view: XiangqiView) {
    const key = `${view.gameId}:${view.revision}:${this.selected ?? ""}:${this.hover?.row ?? -1},${this.hover?.col ?? -1}:${view.status}:${view.turn}`;
    if (key === this.markerKey) return;
    this.markerKey = key;
    this.clearMarkers();
    if (view.status !== "playing") return;
    const targets = this.legalTargets(this.selected);
    for (const t of targets) {
      const occupant = view.pieces.find((p) => p.row === t.row && p.col === t.col);
      const ring = this.makeRing(xqPoint(t.row, t.col), occupant ? CAPTURE : LEGAL, occupant ? 0.5 : 0.36, 0.04);
      this.markers.push(ring);
    }
    if (this.hover && targets.some((t) => t.row === this.hover!.row && t.col === this.hover!.col)) {
      this.markers.push(this.makeRing(xqPoint(this.hover.row, this.hover.col), HOVER, 0.56, 0.03));
    }
  }

  private makeRing(point: { x: number; z: number }, color: number, radius: number, thickness: number) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - thickness, radius, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(point.x, 0.012, point.z);
    ring.renderOrder = 2;
    this.group.add(ring);
    return ring;
  }

  private clearMarkers() {
    for (const m of this.markers) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.markers = [];
  }

  /** 每帧：棋子朝目标位置缓动（弧线），最近一步的棋子微微发亮提示 */
  tick(now: number) {
    if (!this.active) return;
    const dt = this.lastTickAt ? Math.min(0.25, (now - this.lastTickAt) / 1000) : 0;
    this.lastTickAt = now;
    this.advanceFades(dt);
    for (const [id, obj] of this.instances) {
      if (this.carried.has(id)) continue; // 抱着的棋子由 followCarry 独占，缓动不能再拉它
      const target = this.targets.get(id);
      if (!target) continue;
      // 每枚棋子自己的一跳：0→1 按真实时间推进，到 1 精确落地
      if (target.pending) {
        target.from = { pos: obj.position.clone(), quat: obj.quaternion.clone() };
        target.t0 = now;
        target.pending = false;
      }
      if (!target.from) {
        // 已经落稳：保持精确贴住目标（选中抬高也只改目标高度）
        obj.position.copy(target.pos);
        obj.quaternion.copy(target.quat);
        continue;
      }
      const u = Math.min(1, (now - (target.t0 ?? now)) / MOVE_DURATION_MS);
      const ease = u * u * (3 - 2 * u);
      obj.position.lerpVectors(target.from.pos, target.pos, ease);
      obj.position.y += Math.sin(u * Math.PI) * 0.3;
      obj.quaternion.slerpQuaternions(target.from.quat, target.quat, ease);
      if (u >= 1) {
        obj.position.copy(target.pos);
        obj.quaternion.copy(target.quat);
        target.from = undefined;
        target.t0 = undefined;
      }
    }
    // 合法目标环轻微脉动
    const pulse = 0.75 + 0.25 * Math.sin(now / 320);
    for (const m of this.markers) {
      (m.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * pulse;
    }
    // 最近一步的落点：金色环提示（选中环之外再叠一层，几秒后自动消失）
    const last = this.view?.lastMove;
    if (last && this.lastMovePulse && now - this.lastMovePulse < 3500) {
      if (!this.markers.some((m) => m.userData.lastMove)) {
        const ring = this.makeRing(xqPoint(last.to.row, last.to.col), 0xffd166, 0.62, 0.025);
        ring.userData.lastMove = true;
        this.markers.push(ring);
      }
    }
  }

  /** 魔法吸附：棋子挂到角色身上（世界变换由 attach 保持），盘面同步暂停 */
  beginCarry(pieceId: string, parent: THREE.Object3D, local = new THREE.Vector3(0, 0.45, 0.36)) {
    const obj = this.instances.get(pieceId);
    if (!obj) return false;
    this.carried.add(pieceId);
    this.targets.delete(pieceId);
    parent.attach(obj);
    obj.position.copy(local);
    obj.quaternion.identity();
    return true;
  }

  /**
   * 抱棋推进：棋子按素材交付的 actor-local 曲线（prop_motion.json 的 chess 键）
   * 跟着双手走，而不是固定在身体某个点。时间轴与动画同一个时钟。
   */
  followCarry(clip: string, time: number) {
    const samples = this.curves[clip]?.chess;
    if (!samples?.length || !this.carried.size) return false;
    const sample = sampleCurve(samples, time);
    if (!sample) return false;
    for (const id of this.carried) {
      const obj = this.instances.get(id);
      if (!obj) continue;
      obj.position.fromArray(sample.position);
      obj.quaternion.fromArray(sample.quaternion);
    }
    return true;
  }

  /** 调试用：被抱棋子的角色本地坐标 */
  carriedPose(): { x: number; y: number; z: number } | null {
    for (const id of this.carried) {
      const obj = this.instances.get(id);
      if (obj) return { x: obj.position.x, y: obj.position.y, z: obj.position.z };
    }
    return null;
  }

  /** 送出：棋子回到棋盘层，之后由 tick 缓动到目标交点 */
  endCarry(pieceId: string, target?: { row: number; col: number }) {
    const obj = this.instances.get(pieceId);
    if (!obj) return;
    this.group.attach(obj);
    if (target) {
      const p = xqPoint(target.row, target.col);
      this.targets.set(pieceId, { pos: new THREE.Vector3(p.x, 0, p.z), quat: new THREE.Quaternion() });
    }
    this.carried.delete(pieceId);
    this.markerKey = "";
  }

  isCarried(pieceId: string) {
    return this.carried.has(pieceId);
  }

  /** 选中棋子抬高 4.5cm（悬停感），不发光 */
  liftSelected(pieceId: string | null) {
    for (const [id, target] of this.targets) target.pos.y = id === pieceId ? 0.045 : 0;
  }
}
