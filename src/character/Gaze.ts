import * as THREE from "three";

export type GazeMode = "cursor" | "camera" | "away";

const UP = new THREE.Vector3(0, 1, 0);
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * 视线控制器。
 *
 * 输入是"想要看哪里"（光标方向 / 相机 / 发散），输出是头颈的偏航俯仰角。
 * 不直接旋转骨骼——Idle 会把 yaw/pitch 按比例分摊给 neck 和 head。
 */
export class Gaze {
  mode: GazeMode = "cursor";
  yaw = 0;
  pitch = 0;
  /** 转头速度，越大越"警觉"，越小越"慵懒" */
  stiffness = 5.5;

  private targetYaw = 0;
  private targetPitch = 0;
  private t = 0;
  private saccade = 0;
  private saccadeT = 0;
  private nextSaccade = 1.2;

  setPull(yaw: number, pitch: number) {
    this.targetYaw = yaw;
    this.targetPitch = pitch;
  }

  update(dt: number, characterFacing: THREE.Vector3, pointer: { x: number; y: number }, interactive: boolean) {
    this.t += dt;

    if (this.mode === "cursor" && interactive) {
      // 把屏幕光标换算成"角色前方的某个方向"，与角色朝向无关
      _f.copy(characterFacing).setY(0).normalize();
      _r.crossVectors(UP, _f).normalize();

      _d.copy(_f)
        .addScaledVector(_r, pointer.x * 1.15)
        .addScaledVector(UP, pointer.y * 0.8)
        .normalize();

      const horizontal = Math.hypot(_d.x, _d.z) || 1e-6;
      // 注意符号：绕 +Y 正角把 +Z 转向 +X，所以用 (z×x 的反向) 叉积
      const yaw = Math.atan2(_f.z * _d.x - _f.x * _d.z, _f.x * _d.x + _f.z * _d.z);
      const pitch = Math.atan2(_d.y, horizontal);
      this.setPull(THREE.MathUtils.clamp(yaw, -0.55, 0.55), THREE.MathUtils.clamp(pitch, -0.22, 0.34));
    } else if (this.mode === "camera") {
      this.setPull(0.02, 0.06);
    } else if (this.mode === "away") {
      // 由导演设定，保持不动
    }

    // 微跳视：让视线不是一条平滑曲线，而是有"人"的抖动
    this.nextSaccade -= dt;
    if (this.nextSaccade <= 0) {
      this.nextSaccade = 1.4 + Math.random() * 2.6;
      this.saccade = (Math.random() - 0.5) * 0.05;
      this.saccadeT = 0;
    }
    this.saccadeT += dt;
    const saccadeFalloff = Math.exp(-this.saccadeT * 6);

    const k = 1 - Math.exp(-this.stiffness * dt);
    this.yaw += (this.targetYaw + this.saccade * saccadeFalloff - this.yaw) * k;
    this.pitch += (this.targetPitch + this.saccade * 0.35 * saccadeFalloff - this.pitch) * k;

    // 极慢的漂移，避免长时间完全静止
    this.yaw += Math.sin(this.t * 0.37) * 0.0012;
    this.pitch += Math.cos(this.t * 0.29) * 0.0008;
  }
}
