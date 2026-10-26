import * as THREE from "three";
import type { BasinCatalog, PropMotion } from "./catalog.ts";
import { sampleCurve } from "./catalog.ts";
import { BasinPhysics, hullPoints, type Pose } from "./basinPhysics.ts";

/**
 * 通用可持有物品。盆与饭勺共用同一套状态机，差异全部来自 catalog.props：
 * - 槽位（盆：left_hand / head；饭勺：right_hand）
 * - 挂接矩阵对应的骨骼（bindings.leftHand / rightHand / head）
 * - 拾取动作与道具曲线（饭勺有 face_up / face_down 两种落地姿态）
 */
export type PropState = "resting" | "reserved" | "held" | "transferring" | "worn" | "flying";
export type PropSlot = "left_hand" | "right_hand" | "head";

export interface PropSnapshot {
  id: string;
  object_id: string;
  type: string;
  revision: number;
  holder: PropSlot | null;
  state: PropState;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  upright: boolean;
  stationary: boolean;
  available: boolean;
  variant?: string;
  speed?: number;
  spin?: number;
}

export interface ThrowSpec {
  directionDeg: number;
  speed: number;
  spin: number;
  elevationDeg?: number;
}

export interface PropItemOptions {
  id: "basin" | "rice_scoop";
  catalog: BasinCatalog;
  propMotion: PropMotion;
  charRoot: THREE.Object3D;
  scene: THREE.Object3D;
  bones: Map<string, THREE.Bone>;
  parent: THREE.Object3D;
  setMorph?: (value: number) => void;
}

const norm = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "");
const UPRIGHT_MIN_Y = Math.cos((32 * Math.PI) / 180);
const VARIANT_TOLERANCE_DEG = 25;

type Mode = "world" | "hand" | "head" | "curve" | "physics" | "uprighting";
type Variant = { bodyClip: string; motionClip: string; reference: { position: number[]; quaternion: number[] } };

interface PropDef {
  file: string;
  allowedHolders: string[];
  binding: string;
  headBinding?: string;
  pickupReference: { position: number[]; quaternion: number[]; wearMorph?: number };
  pickupVariants?: Record<string, Variant>;
  bowlOpeningNormalLocal?: number[];
}

export class PropItem {
  readonly object = new THREE.Group();
  readonly id: "basin" | "rice_scoop";
  state: PropState = "resting";
  mode: Mode = "world";
  variant: string | null = null;

  readonly catalog: BasinCatalog;
  private readonly def: PropDef;
  private readonly charRoot: THREE.Object3D;
  private readonly motion: PropMotion;
  private readonly slot: PropSlot;
  private readonly bone?: THREE.Bone;
  private readonly headBone?: THREE.Bone;
  private readonly attach: THREE.Matrix4;
  private readonly headAttach?: THREE.Matrix4;
  private readonly setMorph: (value: number) => void;
  private readonly physics: BasinPhysics;
  private readonly autoUpright: boolean;

  private revision = 0;
  private actionId: string | null = null;
  private actionsBefore: PropState = "resting";
  private restorePose: Pose;
  private throwSpec: ThrowSpec | null = null;
  private lastPose: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  private lastCalm = 0;
  private lastSpeed = 0;
  private lastSpin = 0;
  private previewing = false;
  private uprightFrom: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  private uprightTo: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  private uprightTime = 0;
  private uprightDuration = 0.45;
  private uprightResult = { ok: false, moved: 0, rotatedDeg: 0 };

  private constructor(opts: PropItemOptions, physics: BasinPhysics) {
    this.id = opts.id;
    this.catalog = opts.catalog;
    this.charRoot = opts.charRoot;
    this.motion = opts.propMotion;
    this.physics = physics;
    this.setMorph = opts.setMorph ?? (() => {});
    this.def = (opts.catalog.props as Record<string, PropDef>)[opts.id];
    if (!this.def) throw new Error(`catalog 缺少物品 ${opts.id}`);
    this.object.add(opts.scene);
    opts.parent.add(this.object);

    const holders = this.def.allowedHolders ?? [];
    this.slot = holders.includes("left_hand") ? "left_hand" : holders.includes("right_hand") ? "right_hand" : "left_hand";
    const binding = (opts.catalog.bindings as Record<string, { bone: string; matrixColumnMajor: number[] }>)[this.def.binding];
    this.bone = opts.bones.get(norm(binding.bone));
    this.attach = new THREE.Matrix4().fromArray(binding.matrixColumnMajor);
    if (this.def.headBinding) {
      const headBinding = (opts.catalog.bindings as Record<string, { bone: string; matrixColumnMajor: number[] }>)[this.def.headBinding];
      this.headBone = opts.bones.get(norm(headBinding.bone));
      this.headAttach = new THREE.Matrix4().fromArray(headBinding.matrixColumnMajor);
    }
    this.autoUpright = this.slot === "left_hand";
    this.restorePose = {
      position: new THREE.Vector3(...(this.def.pickupReference.position as [number, number, number])),
      quaternion: new THREE.Quaternion(...(this.def.pickupReference.quaternion as [number, number, number, number])),
    };
    this.applyPose(this.restorePose);
  }

  static async create(opts: PropItemOptions): Promise<PropItem> {
    const hull = hullPoints(opts.scene);
    const physics = await BasinPhysics.create(hull, 4, opts.id === "basin" ? "cylinder" : "box");
    return new PropItem(opts, physics);
  }

  get position(): THREE.Vector3 { return this.object.position; }
  get action(): string | null { return this.actionId; }
  get uprighting(): boolean { return this.mode === "uprighting"; }
  get lastUpright() { return this.uprightResult; }
  get upright(): boolean {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.object.quaternion);
    return up.y >= UPRIGHT_MIN_Y;
  }
  get stationary(): boolean { return this.state !== "flying" || this.lastCalm > 0.4; }
  get bindings() { return { slot: this.slot, bone: this.def.binding, headBinding: this.def.headBinding ?? null }; }
  get variants(): string[] { return Object.keys(this.def.pickupVariants ?? {}); }

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

  private bump() { this.revision++; }

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

  placeAt(pose: Pose) {
    this.mode = "world";
    this.applyPose(pose);
    this.bump();
  }

  /** 拾取时必须匹配的落地姿态变体；不匹配返回 null（不自动扶正） */
  matchVariant(): string | null {
    const variants = this.def.pickupVariants;
    if (!variants) return "default";
    // 变体参考是“物品相对角色”的朝向，所以要把物品转到角色坐标系再比，
    // 否则角色转身之后同一个落地姿态会被误判成不支持。
    this.charRoot.updateWorldMatrix(true, false);
    const charQuat = new THREE.Quaternion();
    this.charRoot.getWorldQuaternion(charQuat);
    const local = charQuat.invert().multiply(this.object.quaternion.clone());
    let best: string | null = null;
    let bestDot = -Infinity;
    for (const [name, variant] of Object.entries(variants)) {
      const reference = new THREE.Quaternion(...(variant.reference.quaternion as [number, number, number, number]));
      const dot = Math.abs(local.dot(reference));
      if (dot > bestDot) { bestDot = dot; best = name; }
    }
    const angle = (2 * Math.acos(Math.min(1, bestDot)) * 180) / Math.PI;
    return angle <= VARIANT_TOLERANCE_DEG ? best : null;
  }

  canStart(actionId: string): boolean {
    if (this.actionId) return false;
    const pickup = `pickup_${this.id === "basin" ? "basin" : "scoop"}`;
    const wear = this.id === "basin" ? "wear_basin" : null;
    const unwear = this.id === "basin" ? "unwear_basin" : null;
    const throwIt = `throw_${this.id === "basin" ? "basin" : "scoop"}`;
    if (actionId === pickup) return this.state === "resting" && (this.autoUpright || this.matchVariant() !== null);
    if (wear && actionId === wear) return this.state === "held" && this.slot === "left_hand";
    if (unwear && actionId === unwear) return this.state === "worn";
    if (actionId === throwIt) return this.state === "held";
    return false;
  }

  begin(actionId: string, spec?: ThrowSpec): boolean {
    if (this.actionId) return false;
    if (!this.canStart(actionId)) return false;
    this.actionId = actionId;
    this.actionsBefore = this.state;
    this.restorePose = { position: this.object.position.clone(), quaternion: this.object.quaternion.clone() };
    this.throwSpec = spec ?? null;
    this.variant = this.matchVariant();
    if (actionId.startsWith("pickup_")) this.state = "reserved";
    return true;
  }

  private curveClip(): string | null {
    if (!this.actionId) return null;
    if (this.def.pickupVariants && this.variant) {
      return this.def.pickupVariants[this.variant]?.motionClip ?? null;
    }
    return this.actionId;
  }

  handleEvent(type: string) {
    this.bump();
    switch (type) {
      case "grasp":
      case "hand_catch":
        this.state = "held";
        this.mode = "hand";
        this.setMorph(0);
        break;
      case "toe_lift":
      case "hand_release_to_transfer":
      case "head_release_to_transfer":
        this.state = "transferring";
        this.mode = "curve";
        break;
      case "head_attach":
        this.state = "worn";
        this.mode = "head";
        this.setMorph(1);
        break;
      case "release":
        this.launch();
        break;
      default:
        console.warn(`[prop:${this.id}] 未知事件 ${type}`);
    }
  }

  private launch() {
    const spec = this.throwSpec ?? { directionDeg: 0, speed: 2.6, spin: 120 };
    const elevation = (spec.elevationDeg ?? 12) * (Math.PI / 180);
    const yaw = this.charRoot.rotation.y + (spec.directionDeg * Math.PI) / 180;
    const flat = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const velocity = flat.clone().multiplyScalar(spec.speed * Math.cos(elevation)).setY(spec.speed * Math.sin(elevation));
    const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), flat).normalize();
    const angularVelocity = axis.multiplyScalar((spec.spin * Math.PI) / 180);
    this.followBone(this.bone, this.attach);
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

  private followCurve(clip: string, time: number) {
    const samples = this.motion.clips[clip];
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

  update(dt: number, actionTime: number) {
    if (this.previewing) return;
    if (this.mode === "hand") { this.followBone(this.bone, this.attach); return; }
    if (this.mode === "head") { this.followBone(this.headBone, this.headAttach ?? this.attach); return; }
    if (this.mode === "curve") {
      const clip = this.curveClip();
      if (clip) this.followCurve(clip, actionTime);
      return;
    }
    if (this.mode === "uprighting") {
      this.uprightTime += dt;
      const k = Math.min(1, this.uprightTime / this.uprightDuration);
      const e = k * k * (3 - 2 * k);
      this.object.position.lerpVectors(this.uprightFrom.position, this.uprightTo.position, e);
      this.object.quaternion.slerpQuaternions(this.uprightFrom.quaternion, this.uprightTo.quaternion, e);
      if (k >= 1) { this.mode = "world"; this.state = "resting"; this.bump(); }
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

  finish(completed: boolean) {
    const actionId = this.actionId;
    this.actionId = null;
    this.throwSpec = null;
    if (actionId && actionId.startsWith("throw_") && this.mode === "physics") return;

    const settled =
      (actionId?.startsWith("pickup_") && this.state === "held") ||
      (actionId === "wear_basin" && this.state === "worn") ||
      (actionId === "unwear_basin" && this.state === "held") ||
      (actionId?.startsWith("throw_") && this.state === "flying");

    if (completed && settled) {
      if (actionId === "wear_basin") this.setMorph(1);
      else this.setMorph(0);
      return;
    }

    this.bump();
    this.state = this.actionsBefore;
    if (this.actionsBefore === "worn") { this.mode = "head"; this.setMorph(1); }
    else if (this.actionsBefore === "held") { this.mode = "hand"; this.setMorph(0); }
    else { this.mode = "world"; this.applyPose(this.restorePose); this.setMorph(0); }
  }

  /** 扶正：只对静止物品开放，位移超过 maxMove 直接拒绝 */
  startUpright(seconds = 0.45, maxMove = 0.35) {
    if (this.state !== "resting") { this.uprightResult = { ok: false, moved: 0, rotatedDeg: 0 }; return this.uprightResult; }
    const target = PropItem.toWorld(this.charRoot, this.def.pickupReference.position, this.def.pickupReference.quaternion);
    this.uprightFrom = { position: this.object.position.clone(), quaternion: this.object.quaternion.clone() };
    this.uprightTo = target;
    const moved = Math.hypot(target.position.x - this.object.position.x, target.position.z - this.object.position.z);
    const dot = Math.min(1, Math.abs(this.object.quaternion.dot(target.quaternion)));
    const rotatedDeg = (2 * Math.acos(dot) * 180) / Math.PI;
    this.uprightResult = { ok: moved <= maxMove, moved: Math.round(moved * 1000) / 1000, rotatedDeg: Math.round(rotatedDeg * 10) / 10 };
    if (!this.uprightResult.ok) return this.uprightResult;
    if (this.upright) { this.mode = "world"; return this.uprightResult; }
    this.uprightTime = 0;
    this.uprightDuration = Math.max(0.05, seconds);
    this.mode = "uprighting";
    return this.uprightResult;
  }

  resetToReference(): Pose {
    this.physics.stop();
    this.actionId = null;
    const target = PropItem.toWorld(this.charRoot, this.def.pickupReference.position, this.def.pickupReference.quaternion);
    this.state = "resting";
    this.mode = "world";
    this.applyPose(target);
    this.setMorph(0);
    this.bump();
    return target;
  }

  resetToCenter(): Pose {
    this.physics.stop();
    this.actionId = null;
    const pose: Pose = {
      position: new THREE.Vector3(0, this.def.pickupReference.position[1], 0),
      quaternion: new THREE.Quaternion(...(this.def.pickupReference.quaternion as [number, number, number, number])),
    };
    this.state = "resting";
    this.mode = "world";
    this.applyPose(pose);
    this.setMorph(0);
    this.bump();
    return pose;
  }

  /** 刷新恢复：只接受 resting / held / worn；其它按落地处理 */
  restore(record: { state?: string; position?: number[]; quaternion?: number[] | null }): boolean {
    const raw = record.state ?? "resting";
    const state: PropState = raw === "held" || raw === "worn" ? (raw as PropState) : "resting";
    const position = Array.isArray(record.position) && record.position.length === 3 ? record.position : null;
    if (!position || !position.every((v) => Number.isFinite(v))) return false;
    this.physics.stop();
    this.actionId = null;
    this.previewing = false;
    this.object.visible = true;
    if (state === "held") {
      this.state = "held";
      this.mode = "hand";
      this.setMorph(0);
      this.followBone(this.bone, this.attach);
      this.bump();
      return true;
    }
    if (state === "worn" && this.headBone) {
      this.state = "worn";
      this.mode = "head";
      this.setMorph(1);
      this.followBone(this.headBone, this.headAttach ?? this.attach);
      this.bump();
      return true;
    }
    const quaternion = Array.isArray(record.quaternion) && record.quaternion.length === 4 && record.quaternion.every((v) => Number.isFinite(v))
      ? new THREE.Quaternion(record.quaternion[0], record.quaternion[1], record.quaternion[2], record.quaternion[3])
      : new THREE.Quaternion(...(this.def.pickupReference.quaternion as [number, number, number, number]));
    this.applyPose({ position: new THREE.Vector3(position[0], position[1], position[2]), quaternion });
    this.setMorph(0);
    this.state = "resting";
    this.mode = "world";
    this.bump();
    return true;
  }

  previewAt(actionId: string | null, time: number) {
    if (!actionId || !actionId.includes(this.id === "basin" ? "basin" : "scoop")) {
      this.previewing = false;
      this.object.visible = true;
      return;
    }
    this.previewing = true;
    this.object.visible = !actionId.startsWith("throw_");
    const events = (this.catalog.actions.find((a) => a.id === actionId)?.events ?? []) as { time: number; type: string }[];
    let phase = "held";
    for (const event of events) {
      if (time < event.time) break;
      if (event.type === "grasp" || event.type === "hand_catch") phase = "held";
      else if (event.type === "toe_lift" || event.type.includes("release_to_transfer")) phase = "transferring";
      else if (event.type === "head_attach") phase = "worn";
    }
    if (actionId === "hold_basin" || actionId === "hold_scoop") phase = "held";
    if (phase === "held") { this.followBone(this.bone, this.attach); this.setMorph(0); }
    else if (phase === "worn" && this.headBone) { this.followBone(this.headBone, this.headAttach ?? this.attach); this.setMorph(1); }
    else if (phase === "transferring") this.followCurve(this.def.pickupVariants?.face_down && actionId === "pickup_scoop" ? "pickup_scoop_face_down" : actionId, time);
    else {
      const target = PropItem.toWorld(this.charRoot, this.def.pickupReference.position, this.def.pickupReference.quaternion);
      this.applyPose(target);
      this.setMorph(0);
    }
  }

  snapshot(): PropSnapshot {
    return {
      id: this.id,
      object_id: this.id,
      type: this.id === "basin" ? "basin" : "scoop",
      revision: this.revision,
      holder: this.mode === "hand" ? this.slot : this.mode === "head" ? "head" : null,
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
      ...(this.variant ? { variant: this.variant } : {}),
      ...(this.state === "flying" ? { speed: this.lastSpeed, spin: this.lastSpin } : {}),
    };
  }
}
