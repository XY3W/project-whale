import * as THREE from "three";

/**
 * 坐/躺的运行时位姿。
 *
 * 这套骨架是"扁平烘焙"的：每条骨骼都直接挂在 root.x 下，位置+旋转逐帧烘焙，
 * 腿没有父子链。所以不能只转根骨，必须自己算 FK：给定髋/膝/踝角度，
 * 算出膝和踝的新世界坐标，再把「大腿段 / 小腿段 / 脚段」整组刚性搬过去。
 *
 * 位姿在 mixer 之后逐帧覆盖（LayeredMotionPlayer.setPoseOverride），
 * 站起时按 weight 插值回 idle，不会跳变。
 */

const DEG = Math.PI / 180;
const AXIS_X = new THREE.Vector3(1, 0, 0);

export interface LegAngles {
  hipDeg: number;
  kneeDeg: number;
  ankleDeg: number;
}

/** 给定三个关节的静止世界坐标，返回旋转后的膝/踝位置与三段旋转。 */
export function solveSeatedLeg(hip: THREE.Vector3, knee: THREE.Vector3, ankle: THREE.Vector3, angles: LegAngles) {
  const hipPivot = hip.clone();
  const R1 = new THREE.Quaternion().setFromAxisAngle(AXIS_X, angles.hipDeg * DEG);
  const kneeNow = knee.clone().sub(hipPivot).applyQuaternion(R1).add(hipPivot);
  const R2 = R1.clone().multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, angles.kneeDeg * DEG));
  const ankleNow = kneeNow.clone().add(ankle.clone().sub(knee).applyQuaternion(R2));
  const R3 = R2.clone().multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, angles.ankleDeg * DEG));
  return { hipPivot, kneeNow, ankleNow, R1, R2, R3 };
}

export interface PoseTarget {
  hipDeg: number;
  kneeDeg: number;
  ankleDeg: number;
  leanDeg: number;
  /** 骨架根节点的世界 y 偏移（负数=下沉） */
  dropY: number;
  /** 骨架根节点的 z 偏移（躺下时挪到床中间） */
  offsetZ: number;
}

/** 按家具面高度生成坐/躺参数：髋落座面、脚尽量落地。 */
export function poseForSeat(name: "sit" | "lie", surfaceY: number, restHipY: number): PoseTarget {
  if (name === "lie") {
    return { hipDeg: 0, kneeDeg: 0, ankleDeg: 0, leanDeg: -90, dropY: -(restHipY - (surfaceY + 0.06)), offsetZ: 0.1 };
  }
  return { hipDeg: -85, kneeDeg: 85, ankleDeg: 5, leanDeg: -4, dropY: -(restHipY - (surfaceY + 0.01)), offsetZ: 0 };
}

type Rest = { pos: THREE.Vector3; quat: THREE.Quaternion };

export class FurniturePose {
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly rest = new Map<string, Rest>();
  private readonly rootBone: THREE.Bone | null;
  private captured = false;
  private targetId: string | null = null;
  private targetName: "sit" | "lie" | null = null;
  private weight = 0;
  private targetWeight = 0;
  private params: PoseTarget | null = null;
  private restHipY = 0.3;
  readonly blendSeconds: number;

  constructor(characterRoot: THREE.Object3D, blendSeconds = 0.45) {
    this.blendSeconds = blendSeconds;
    characterRoot.traverse((obj) => {
      const bone = obj as THREE.Bone;
      if (bone.isBone) this.bones.set(bone.name, bone);
    });
    this.rootBone = this.boneOf("root.x");
  }

  /** GLTFLoader 会把 "." 从骨骼名里去掉（thigh_twist.l → thigh_twistl）。 */
  private boneOf(name: string): THREE.Bone | null {
    return this.bones.get(name) ?? this.bones.get(name.replace(/\./g, "")) ?? null;
  }

  private restOf(name: string): Rest | null {
    const bone = this.boneOf(name);
    return bone ? this.rest.get(bone.name) ?? null : null;
  }

  /** mixer 跑过第一帧（或 idle）之后调用一次，记录静止姿态与世界变换。 */
  capture() {
    if (this.captured) return;
    const root = this.bones.values().next().value?.parent;
    root?.updateMatrixWorld(true);
    for (const [name, bone] of this.bones) {
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      bone.getWorldPosition(pos);
      bone.getWorldQuaternion(quat);
      this.rest.set(name, { pos, quat });
    }
    const hip = this.restOf("thigh_twist.l");
    if (hip) this.restHipY = hip.pos.y;
    this.captured = true;
  }

  get activeName(): "sit" | "lie" | null {
    return this.targetName;
  }

  get activeFurniture(): string | null {
    return this.targetId;
  }

  get currentWeight(): number {
    return this.weight;
  }

  sitOn(furnitureId: string, name: "sit" | "lie", surfaceY: number) {
    this.capture();
    this.targetId = furnitureId;
    this.targetName = name;
    this.params = poseForSeat(name, surfaceY, this.restHipY);
    this.targetWeight = 1;
  }

  standUp() {
    this.targetWeight = 0;
    this.targetName = null;
    this.targetId = null;
  }

  /** 每帧在 mixer 之后调用：把当前（idle）位姿按 weight 拉向目标位姿。 */
  update(dt: number) {
    if (this.weight === this.targetWeight && this.weight === 0) return;
    const step = dt / this.blendSeconds;
    this.weight = this.targetWeight > this.weight
      ? Math.min(this.targetWeight, this.weight + step)
      : Math.max(this.targetWeight, this.weight - step);
    if (!this.params || this.weight <= 0) {
      if (this.weight <= 0) this.params = null;
      return;
    }
    this.applyPose(this.params, this.weight);
  }

  private applyPose(params: PoseTarget, weight: number) {
    for (const side of ["l", "r"] as const) {
      const hipName = `thigh_twist.${side}`;
      const kneeName = `leg_stretch.${side}`;
      const ankleName = `foot.${side}`;
      const hipRest = this.restOf(hipName);
      const kneeRest = this.restOf(kneeName);
      const ankleRest = this.restOf(ankleName);
      if (!hipRest || !kneeRest || !ankleRest) continue;
      const solved = solveSeatedLeg(hipRest.pos, kneeRest.pos, ankleRest.pos, params);

      this.blendSegment([`thigh_twist.${side}`, `thigh_stretch.${side}`, `thigh_twist_2.${side}`], hipRest.pos, solved.hipPivot, solved.R1, weight);
      this.blendSegment([`leg_stretch.${side}`, `leg_twist.${side}`, `leg_twist_2.${side}`], kneeRest.pos, solved.kneeNow, solved.R2, weight);
      this.blendSegment([`foot.${side}`, `toes_01.${side}`], ankleRest.pos, solved.ankleNow, solved.R3, weight);
    }

    // 骨架整体下沉/后仰：作用在 root.x 上，已摆好的腿跟着一起走
    const rootRest = this.restOf("root.x");
    if (this.rootBone && rootRest) {
      const lean = new THREE.Quaternion().setFromAxisAngle(AXIS_X, params.leanDeg * DEG);
      const worldQ = lean.clone().multiply(rootRest.quat);
      const worldPos = rootRest.pos.clone();
      worldPos.y += params.dropY;
      worldPos.z += params.offsetZ;
      this.blendBone("root.x", worldPos, worldQ, weight);
    }
  }

  private blendSegment(names: string[], anchorRest: THREE.Vector3, anchorNow: THREE.Vector3, R: THREE.Quaternion, weight: number) {
    for (const name of names) {
      const base = this.restOf(name);
      if (!base) continue;
      const pos = base.pos.clone().sub(anchorRest).applyQuaternion(R).add(anchorNow);
      this.blendBone(name, pos, R.clone().multiply(base.quat), weight);
    }
  }

  private blendBone(name: string, worldPos: THREE.Vector3, worldQuat: THREE.Quaternion, weight: number) {
    const bone = this.boneOf(name);
    if (!bone || !bone.parent) return;
    bone.parent.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(bone.parent.matrixWorld).invert();
    const localPos = worldPos.clone().applyMatrix4(inverse);
    const parentQuat = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentQuat);
    const localQuat = parentQuat.invert().multiply(worldQuat);
    bone.position.lerp(localPos, weight);
    bone.quaternion.slerp(localQuat, weight);
  }
}
