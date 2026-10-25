import * as THREE from "three";
import type { BasinAction, BasinCatalog, PropMotion } from "./catalog.ts";
import { sampleCurve } from "./catalog.ts";
import { BasinPhysics, hullPoints, type Pose } from "./basinPhysics.ts";

export type BasinState = "resting" | "reserved" | "held" | "transferring" | "worn" | "flying";

export interface BasinSnapshot {
  id: "basin";
  object_id: "basin";
  revision: number;
  holder: "hand" | "head" | null;
  state: BasinState;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  upright: boolean;
  stationary: boolean;
  available: boolean;
  /** 飞行中的线速度 m/s 与角速度 rad/s，便于验收落地判定 */
  speed?: number;
  spin?: number;
}

export interface ThrowSpec {
  /** 相对角色朝向的水平方向（度） */
  directionDeg: number;
  /** 出手速度 m/s */
  speed: number;
  /** 自转角速度 deg/s */
  spin: number;
  /** 出手仰角（度），默认 12 */
  elevationDeg?: number;
}

export interface BasinPropOptions {
  catalog: BasinCatalog;
  propMotion: PropMotion;
  /** 角色根节点（盆的世界变换与曲线都以它为参考） */
  charRoot: THREE.Object3D;
  /** 盆的 glTF 场景，会被放进内部容器 */
  scene: THREE.Object3D;
  bones: Map<string, THREE.Bone>;
  /** 头顶收拢形态键写入 */
  setMorph?: (value: number) => void;
  /** 容器要挂到的场景节点 */
  parent: THREE.Object3D;
}

const norm = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "");
const UPRIGHT_MIN_Y = Math.cos((32 * Math.PI) / 180);

type Mode = "world" | "hand" | "head" | "curve" | "physics" | "uprighting";

export interface UprightResult {
  ok: boolean;
  /** 被挪动的水平距离（米）与扶正角度（度） */
  moved: number;
  rotatedDeg: number;
}

export class BasinProp {
  readonly object = new THREE.Group();
  readonly catalog: BasinCatalog;
  readonly actions: Map<string, BasinAction>;
  state: BasinState = "resting";
  mode: Mode = "world";
  private revision = 0;

  private readonly charRoot: THREE.Object3D;
  private readonly motion: PropMotion;
  private readonly handBone?: THREE.Bone;
  private readonly headBone?: THREE.Bone;
  private readonly handAttach: THREE.Matrix4;
  private readonly headAttach: THREE.Matrix4;
  private readonly setMorph: (value: number) => void;
  private readonly physics: BasinPhysics;

  private actionId: string | null = null;
  private actionsBefore: BasinState = "resting";
  private restorePose: Pose;
  private throwSpec: ThrowSpec | null = null;
  private lastPose: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  private lastCalm = 0;
  private lastSpeed = 0;
  private lastSpin = 0;
  private uprightFrom: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  private uprightTo: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  private uprightTime = 0;
  private uprightDuration = 0.45;
  private uprightResult: UprightResult = { ok: false, moved: 0, rotatedDeg: 0 };
  private previewing = false;

  private constructor(opts: BasinPropOptions, physics: BasinPhysics) {
    this.catalog = opts.catalog;
    this.motion = opts.propMotion;
    this.charRoot = opts.charRoot;
    this.physics = physics;
    this.setMorph = opts.setMorph ?? (() => {});
    this.object.add(opts.scene);
    opts.parent.add(this.object);

    this.actions = new Map(opts.catalog.actions.map((a) => [a.id, a]));
    this.handAttach = new THREE.Matrix4().fromArray(opts.catalog.bindings.hand.matrixColumnMajor);
    this.headAttach = new THREE.Matrix4().fromArray(opts.catalog.bindings.head.matrixColumnMajor);
    this.handBone = opts.bones.get(norm(opts.catalog.bindings.hand.bone));
    this.headBone = opts.bones.get(norm(opts.catalog.bindings.head.bone));
    if (!this.handBone) console.warn("[basin] 找不到手部挂点骨骼", opts.catalog.bindings.hand.bone);
    if (!this.headBone) console.warn("[basin] 找不到头部挂点骨骼", opts.catalog.bindings.head.bone);

    const ref = opts.catalog.pickupReference;
    this.restorePose = {
      position: new THREE.Vector3(ref.position[0], ref.position[1], ref.position[2]),
      quaternion: new THREE.Quaternion(ref.quaternion[0], ref.quaternion[1], ref.quaternion[2], ref.quaternion[3]),
    };
    this.applyPose(this.restorePose);
  }

  static async create(opts: BasinPropOptions): Promise<BasinProp> {
    const hull = hullPoints(opts.scene);
    const physics = await BasinPhysics.create(hull);
    return new BasinProp(opts, physics);
  }

  /** 把“角色根局部坐标”下的静置姿态换成世界坐标（角色移动/转身后仍用这份局部定义） */
  static toWorld(charRoot: THREE.Object3D, position: number[], quaternion: number[]): Pose {
    charRoot.updateWorldMatrix(true, false);
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(position[0], position[1], position[2]),
      new THREE.Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]),
      new THREE.Vector3(1, 1, 1),
    );
    const world = new THREE.Matrix4().multiplyMatrices(charRoot.matrixWorld, local);
    const pose: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    world.decompose(pose.position, pose.quaternion, new THREE.Vector3());
    return pose;
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  get action(): string | null {
    return this.actionId;
  }

  private bump() {
    this.revision++;
  }

  private applyPose(pose: Pose) {
    this.object.position.copy(pose.position);
    this.object.quaternion.copy(pose.quaternion);
    this.lastPose.position.copy(pose.position);
    this.lastPose.quaternion.copy(pose.quaternion);
  }

  private followBone(bone: THREE.Bone | undefined, matrix: THREE.Matrix4) {
    if (!bone) return;
    bone.updateWorldMatrix(true, false);
    const world = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, matrix);
    const scale = new THREE.Vector3();
    world.decompose(this.object.position, this.object.quaternion, scale);
    this.lastPose.position.copy(this.object.position);
    this.lastPose.quaternion.copy(this.object.quaternion);
  }

  /** 直接把盆放到世界坐标（静置、或物理落地后固化） */
  placeAt(pose: Pose) {
    this.mode = "world";
    this.applyPose(pose);
    this.bump();
  }

  /**
   * 开始一段互动。返回 false 表示当前状态不允许（调用方不应播放动画）。
   * pickup 在开始时就占位（resting → reserved），避免并行计划重复拾取。
   */
  begin(actionId: string, spec?: ThrowSpec): boolean {
    if (this.actionId) return false;
    const allowed = this.canStart(actionId);
    if (!allowed) return false;
    this.actionId = actionId;
    this.actionsBefore = this.state;
    this.restorePose = {
      position: this.object.position.clone(),
      quaternion: this.object.quaternion.clone(),
    };
    this.throwSpec = spec ?? null;
    if (actionId === "pickup_basin") this.state = "reserved";
    return true;
  }

  canStart(actionId: string): boolean {
    if (this.actionId) return false;
    switch (actionId) {
      case "pickup_basin":
        return this.state === "resting" && this.upright;
      case "wear_basin":
        return this.state === "held";
      case "unwear_basin":
        return this.state === "worn";
      case "throw_basin":
        // 戴头时不能直接投掷：必须先 unwear，避免盆从头顶飞出
        return this.state === "held";
      default:
        return false;
    }
  }

  private followCurve(actionId: string, time: number) {
    const samples = this.motion.clips[actionId];
    if (!samples) return;
    const sample = sampleCurve(samples, time);
    if (!sample) return;
    this.charRoot.updateWorldMatrix(true, false);
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(sample.position[0], sample.position[1], sample.position[2]),
      new THREE.Quaternion(sample.quaternion[0], sample.quaternion[1], sample.quaternion[2], sample.quaternion[3]),
      new THREE.Vector3(1, 1, 1),
    );
    const world = new THREE.Matrix4().multiplyMatrices(this.charRoot.matrixWorld, local);
    const scale = new THREE.Vector3();
    world.decompose(this.object.position, this.object.quaternion, scale);
    this.lastPose.position.copy(this.object.position);
    this.lastPose.quaternion.copy(this.object.quaternion);
    this.setMorph(sample.wearMorph);
  }

  /**
   * 调试用：按“互动片段 + 时间”预览盆的挂接状态，只改视觉，不动状态机与物理。
   * 事件里的 from/to 已经描述了 resting→held→transferring→worn 的时序，直接复用。
   */
  previewAt(actionId: string | null, time: number) {
    if (actionId === "hold_basin") {
      // 持盆循环没有事件，直接挂在手上
      this.previewing = true;
      this.object.visible = true;
      this.followBone(this.handBone, this.handAttach);
      this.setMorph(0);
      return;
    }
    const events = actionId ? this.actions.get(actionId)?.events ?? [] : [];
    if (!actionId || !events.length) {
      this.previewing = false;
      this.object.visible = true;
      return;
    }
    this.previewing = true;
    let phase = events[0].from ?? "resting";
    for (const event of events) if (time >= event.time) phase = event.to ?? phase;
    this.object.visible = phase !== "flying";
    if (phase === "held") {
      this.followBone(this.handBone, this.handAttach);
      this.setMorph(0);
    } else if (phase === "worn") {
      this.followBone(this.headBone, this.headAttach);
      this.setMorph(1);
    } else if (phase === "transferring") {
      this.followCurve(actionId, time);
    } else if (phase === "resting") {
      const reference = this.catalog.pickupReference;
      this.applyPose(BasinProp.toWorld(this.charRoot, reference.position, reference.quaternion));
      this.setMorph(0);
    }
  }

  /** 由动画事件驱动：调用前骨骼世界矩阵必须已经是事件时刻的姿态 */
  handleEvent(type: string) {
    const actionId = this.actionId;
    this.bump();
    switch (type) {
      case "grasp":
        this.state = "held";
        this.mode = "hand";
        this.setMorph(0);
        break;
      case "hand_release_to_transfer":
        this.state = "transferring";
        this.mode = "curve";
        break;
      case "head_attach":
        this.state = "worn";
        this.mode = "head";
        this.setMorph(1);
        break;
      case "head_release_to_transfer":
        this.state = "transferring";
        this.mode = "curve";
        break;
      case "hand_catch":
        this.state = "held";
        this.mode = "hand";
        this.setMorph(0);
        break;
      case "release":
        this.launch();
        break;
      default:
        console.warn(`[basin] 未知事件 ${type}（${actionId}）`);
    }
  }

  private launch() {
    const spec = this.throwSpec ?? { directionDeg: 0, speed: 2.6, spin: 120 };
    const elevation = (spec.elevationDeg ?? 12) * (Math.PI / 180);
    const yaw = this.charRoot.rotation.y + (spec.directionDeg * Math.PI) / 180;
    const flat = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const velocity = flat
      .clone()
      .multiplyScalar(spec.speed * Math.cos(elevation))
      .setY(spec.speed * Math.sin(elevation));
    const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), flat).normalize();
    const angularVelocity = axis.multiplyScalar((spec.spin * Math.PI) / 180);
    // 事件时刻的手部姿态是权威起点
    this.followBone(this.handBone, this.handAttach);
    this.physics.launch({
      position: this.object.position.clone(),
      quaternion: this.object.quaternion.clone(),
      velocity,
      angularVelocity,
    });
    this.state = "flying";
    this.mode = "physics";
    this.lastCalm = 0;
  }

  get uprighting(): boolean {
    return this.mode === "uprighting";
  }

  get lastUpright(): UprightResult {
    return this.uprightResult;
  }

  /**
   * 把静止的盆扶成正放：在 0.45 秒内平滑插值到“当前站位对应的标准姿态”。
   * 只对静止的盆开放，且由执行器在确认站位误差后调用。
   */
  startUpright(seconds = 0.45, maxMove = 0.35): UprightResult {
    if (this.state !== "resting") {
      this.uprightResult = { ok: false, moved: 0, rotatedDeg: 0 };
      return this.uprightResult;
    }
    const reference = this.catalog.pickupReference;
    const target = BasinProp.toWorld(this.charRoot, reference.position, reference.quaternion);
    this.uprightFrom = { position: this.object.position.clone(), quaternion: this.object.quaternion.clone() };
    this.uprightTo = target;
    const moved = Math.hypot(target.position.x - this.object.position.x, target.position.z - this.object.position.z);
    const dot = Math.min(1, Math.abs(this.object.quaternion.dot(target.quaternion)));
    const rotatedDeg = (2 * Math.acos(dot) * 180) / Math.PI;
    this.uprightResult = { ok: moved <= maxMove, moved: Math.round(moved * 1000) / 1000, rotatedDeg: Math.round(rotatedDeg * 10) / 10 };
    if (!this.uprightResult.ok) return this.uprightResult;
    if (this.upright) {
      this.mode = "world";
      return this.uprightResult;
    }
    this.uprightTime = 0;
    this.uprightDuration = Math.max(0.05, seconds);
    this.mode = "uprighting";
    return this.uprightResult;
  }

  /**
   * 从服务器持久化的快照恢复：刷新页面后盆应该还在原来的状态和位置。
   * 手持/戴头只恢复状态（位置下一帧由骨骼重算）；飞行中用零初速度重新落下。
   */
  restore(record: {
    state?: string;
    position?: number[];
    quaternion?: number[] | null;
    holder?: "hand" | "head" | null;
  }): boolean {
    // 服务端只保存 resting / held / worn；其它状态一律按落地静置恢复
    const raw = record.state ?? "resting";
    const state: BasinState = raw === "held" || raw === "worn" ? (raw as BasinState) : "resting";
    const position = Array.isArray(record.position) && record.position.length === 3 ? record.position : null;
    if (!position || !position.every((v) => Number.isFinite(v))) return false;
    this.physics.stop();
    this.actionId = null;
    this.previewing = false;
    this.object.visible = true;
    const reference = this.catalog.pickupReference;

    if (state === "held") {
      this.state = "held";
      this.mode = "hand";
      this.setMorph(0);
      this.followBone(this.handBone, this.handAttach);
      this.bump();
      return true;
    }
    if (state === "worn") {
      this.state = "worn";
      this.mode = "head";
      this.setMorph(1);
      this.followBone(this.headBone, this.headAttach);
      this.bump();
      return true;
    }

    const quaternion = Array.isArray(record.quaternion) && record.quaternion.length === 4 && record.quaternion.every((v) => Number.isFinite(v))
      ? new THREE.Quaternion(record.quaternion[0], record.quaternion[1], record.quaternion[2], record.quaternion[3])
      : new THREE.Quaternion(reference.quaternion[0], reference.quaternion[1], reference.quaternion[2], reference.quaternion[3]);
    this.applyPose({ position: new THREE.Vector3(position[0], position[1], position[2]), quaternion });
    this.setMorph(0);
    this.state = "resting";
    this.mode = "world";
    this.bump();
    return true;
  }

  /** 回到“当前站位对应的标准静置姿态”（调试台与沙盒用） */
  resetToReference(): Pose {
    this.physics.stop();
    this.actionId = null;
    const reference = this.catalog.pickupReference;
    const target = BasinProp.toWorld(this.charRoot, reference.position, reference.quaternion);
    this.state = "resting";
    this.mode = "world";
    this.applyPose(target);
    this.setMorph(0);
    this.bump();
    return target;
  }

  /** 调试用：摆成侧躺，用来检查自动扶正 */
  tiltOver(radians = Math.PI / 2): void {
    this.physics.stop();
    this.actionId = null;
    this.state = "resting";
    this.mode = "world";
    this.object.quaternion.setFromEuler(new THREE.Euler(0, 0.4, radians));
    this.bump();
  }

  /** 回到场地正中心、正放静止 */
  resetToCenter(): Pose {
    this.physics.stop();
    this.actionId = null;
    const reference = this.catalog.pickupReference;
    const pose: Pose = {
      position: new THREE.Vector3(0, reference.position[1], 0),
      quaternion: new THREE.Quaternion(reference.quaternion[0], reference.quaternion[1], reference.quaternion[2], reference.quaternion[3]),
    };
    this.state = "resting";
    this.mode = "world";
    this.applyPose(pose);
    this.setMorph(0);
    this.bump();
    return pose;
  }

  /** 每帧调用：必须在骨骼世界矩阵更新之后 */
  update(dt: number, actionTime: number) {
    if (this.previewing) return;
    if (this.mode === "hand") {
      this.followBone(this.handBone, this.handAttach);
      return;
    }
    if (this.mode === "head") {
      this.followBone(this.headBone, this.headAttach);
      return;
    }
    if (this.mode === "curve") {
      if (this.actionId) this.followCurve(this.actionId, actionTime);
      return;
    }
    if (this.mode === "uprighting") {
      this.uprightTime += dt;
      const k = Math.min(1, this.uprightTime / this.uprightDuration);
      const e = k * k * (3 - 2 * k);
      this.object.position.lerpVectors(this.uprightFrom.position, this.uprightTo.position, e);
      this.object.quaternion.slerpQuaternions(this.uprightFrom.quaternion, this.uprightTo.quaternion, e);
      if (k >= 1) {
        this.mode = "world";
        this.state = "resting";
        this.bump();
      }
      return;
    }
    if (this.mode === "physics") {
      const result = this.physics.step(dt);
      if (!result) return;
      this.object.position.copy(result.pose.position);
      this.object.quaternion.copy(result.pose.quaternion);
      this.lastPose.position.copy(this.object.position);
      this.lastPose.quaternion.copy(this.object.quaternion);
      this.lastCalm = result.calm;
      this.lastSpeed = result.speed;
      this.lastSpin = result.spin;
      if (result.resting) {
        this.physics.stop();
        this.mode = "world";
        this.state = "resting";
        this.bump();
      }
    }
  }

  /** 动画结束（或取消）时收尾：未到达终态就退回起始状态，不凭空造出第二只盆 */
  finish(completed: boolean) {
    const actionId = this.actionId;
    this.actionId = null;
    this.throwSpec = null;
    if (actionId === "throw_basin" && this.mode === "physics") return; // 飞行交回物理系统

    const settled =
      (actionId === "pickup_basin" && this.state === "held") ||
      (actionId === "wear_basin" && this.state === "worn") ||
      (actionId === "unwear_basin" && this.state === "held") ||
      (actionId === "throw_basin" && this.state === "flying");

    if (completed && settled) {
      if (actionId === "wear_basin") this.setMorph(1);
      else this.setMorph(0);
      return;
    }

    // 取消/失败：退回动作开始前的状态
    this.bump();
    this.state = this.actionsBefore;
    if (this.actionsBefore === "worn") {
      this.mode = "head";
      this.setMorph(1);
    } else if (this.actionsBefore === "held") {
      this.mode = "hand";
      this.setMorph(0);
    } else {
      this.mode = "world";
      this.applyPose(this.restorePose);
      this.setMorph(0);
    }
  }

  get upright(): boolean {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.object.quaternion);
    return up.y >= UPRIGHT_MIN_Y;
  }

  get stationary(): boolean {
    return this.state !== "flying" || this.lastCalm > 0.4;
  }

  snapshot(): BasinSnapshot {
    return {
      id: "basin",
      object_id: "basin",
      revision: this.revision,
      holder: this.mode === "hand" ? "hand" : this.mode === "head" ? "head" : null,
      state: this.state,
      position: [
        Math.round(this.object.position.x * 1000) / 1000,
        Math.round(this.object.position.y * 1000) / 1000,
        Math.round(this.object.position.z * 1000) / 1000,
      ],
      quaternion: [
        Math.round(this.object.quaternion.x * 10000) / 10000,
        Math.round(this.object.quaternion.y * 10000) / 10000,
        Math.round(this.object.quaternion.z * 10000) / 10000,
        Math.round(this.object.quaternion.w * 10000) / 10000,
      ],
      upright: this.upright,
      stationary: this.stationary,
      available: this.state === "resting",
      ...(this.state === "flying" ? { speed: this.lastSpeed, spin: this.lastSpin } : {}),
    };
  }
}
