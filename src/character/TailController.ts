import * as THREE from "three";
import { AXIS } from "./Character";

interface BoneHost {
  getBone(name: string): THREE.Bone | undefined;
  rotateWorld(name: string, axis: THREE.Vector3, angle: number): void;
}

export interface TailParams {
  amplitude: number; // 0..1，1 = 当前标定上限
  tempo: "slow" | "normal";
}

export interface TailResult {
  status: "accepted" | "clamped" | "rejected";
  amplitude: number;
  tempo: "slow" | "normal";
  reason?: string;
}

/** 每节骨在幅度 1 时的最大旋转（弧度）。未标定，属于占位值。 */
const MAX_ANGLE = [0.10, 0.12, 0.14, 0.14, 0.12, 0.10];
const PHASE_LAG = 0.32;
const TEMPO_HZ: Record<TailParams["tempo"], number> = { slow: 0.35, normal: 0.7 };

/**
 * 尾巴参数控制器：六节 FK，按幅度 + 节奏生成连续曲线。
 * 这是 v0.3 设计里「参数 → 限幅 → 骨骼变形 → 诊断」链路的最小样机。
 */
export class TailController {
  private target = 0;
  private amplitude = 0;
  private phase = 0;
  private tempo: TailParams["tempo"] = "slow";
  private groundClamp = 1;

  constructor(private readonly host: BoneHost) {}

  get state() {
    return { target: this.target, amplitude: this.amplitude, tempo: this.tempo, phase: this.phase };
  }

  set(params: Partial<TailParams>): TailResult {
    let status: TailResult["status"] = "accepted";
    let reason: string | undefined;

    if (params.amplitude !== undefined) {
      const a = params.amplitude;
      if (!Number.isFinite(a)) return { status: "rejected", amplitude: this.target, tempo: this.tempo, reason: "amplitude 非有限数" };
      if (a < 0 || a > 1) {
        status = "clamped";
        reason = `amplitude ${a} 超出 [0,1]`;
      }
      this.target = THREE.MathUtils.clamp(a, 0, 1);
    }
    if (params.tempo !== undefined) {
      if (params.tempo !== "slow" && params.tempo !== "normal") {
        return { status: "rejected", amplitude: this.target, tempo: this.tempo, reason: "未知 tempo" };
      }
      this.tempo = params.tempo;
    }
    return { status, amplitude: this.target, tempo: this.tempo, reason };
  }

  update(dt: number) {
    // 幅度的变化速度受限，回中同样走这条路径
    const rate = 0.8;
    const delta = this.target - this.amplitude;
    this.amplitude += THREE.MathUtils.clamp(delta, -rate * dt, rate * dt);

    this.phase += dt * Math.PI * 2 * TEMPO_HZ[this.tempo];
    const a = this.amplitude * this.groundClamp;

    for (let i = 0; i < 6; i++) {
      const name = `WhaleTail_0${i + 1}`;
      if (!this.host.getBone(name)) continue;
      const angle = Math.sin(this.phase - i * PHASE_LAG) * a * MAX_ANGLE[i];
      this.host.rotateWorld(name, AXIS.y, angle);
    }

    // 简化避让：尾尖离地过低时整体收幅
    const tip = this.host.getBone("WhaleTail_06");
    if (tip) {
      const y = tip.getWorldPosition(new THREE.Vector3()).y;
      this.groundClamp = y < 0.06 ? Math.max(0.2, this.groundClamp - dt * 2) : Math.min(1, this.groundClamp + dt * 2);
    }
  }
}
