import { AXIS, Character } from "./Character";
import { Gaze } from "./Gaze";

/**
 * 表演层：60fps 的"活着"细节。
 *
 * 呼吸、重心、头颈微动、视线——这些不需要模型思考，
 * 由程序按生理节奏生成。导演（未来是 LLM）只在这一层之上改变意图。
 *
 * 注意：这套资产的 5 个表情 shape key 是坏的（源工程里位移方向错乱、
 * 幅度还被逐级放大 2 倍），所以这里不做眨眼和表情驱动。
 * 详见 README「资产问题」一节。
 */
export class Idle {
  readonly gaze = new Gaze();

  /** 重心摆动幅度倍率，导演可以临时调大 */
  swayGain = 1;
  /** 站立时的呼吸强度 */
  breathGain = 1;
  /** 头部侧倾目标（弧度），导演用来表达"歪头" */
  tiltTarget = 0;

  private t = 0;
  private tilt = 0;

  constructor(private readonly character: Character) {}

  update(dt: number, pointer: { x: number; y: number }, pointerIdle: boolean) {
    this.t += dt;
    const c = this.character;

    this.gaze.update(dt, c.forward, pointer, !pointerIdle);
    this.applyBreath();
    this.applySway();
    this.applyGaze();
    this.applyTilt(dt);
  }

  private applyBreath() {
    const c = this.character;
    const phase = (this.t / 4.3) * Math.PI * 2;
    const breath = Math.sin(phase);
    const g = this.breathGain;

    // 肋骨/胸腔：这些 c_spine_* 控制骨才是真正带动躯干和手臂的层级
    c.rotateWorld("c_spine_03.x", AXIS.x, breath * 0.011 * g);
    c.rotateWorld("c_spine_04.x", AXIS.x, breath * 0.007 * g);
    c.rotateWorld("c_spine_02.x", AXIS.x, breath * 0.004 * g);
    // 肩随呼吸极轻微起伏
    c.rotateWorld("arm.l", AXIS.z, Math.sin(phase) * 0.006 * g);
    c.rotateWorld("arm.r", AXIS.z, -Math.sin(phase) * 0.006 * g);
    // 头部呼吸带来的微小上下
    c.rotateWorld("head.x", AXIS.x, Math.sin(phase - 0.6) * 0.0035 * g);
  }

  private applySway() {
    const c = this.character;
    const phase = (this.t / 8.7) * Math.PI * 2;
    const s = Math.sin(phase) * this.swayGain;

    // 整身像钟摆一样极缓慢地换重心。
    // 头不在脊柱链上，所以全身摆动必须走 c_traj，否则头会被"落在原地"。
    c.rotateWorld("c_traj", AXIS.z, s * 0.018);
    c.rotateWorld("c_spine_04.x", AXIS.z, -s * 0.006);
    // 手臂跟着轻微外摆
    c.rotateWorld("arm.l", AXIS.z, -Math.abs(s) * 0.006);
    c.rotateWorld("arm.r", AXIS.z, Math.abs(s) * 0.006);
  }

  private applyGaze() {
    const c = this.character;
    const yaw = this.gaze.yaw;
    const pitch = this.gaze.pitch;
    // 这套骨架的头直接挂在 c_traj 下，neck 转不动头，只能整体交给 head.x
    c.rotateWorld("head.x", AXIS.y, yaw);
    // 绕世界 +X 正角是低头，所以抬头要取负
    c.rotateWorld("head.x", AXIS.x, -pitch);
    // 视线带一点无意识的头侧倾
    c.rotateWorld("head.x", AXIS.z, yaw * 0.06);
  }

  private applyTilt(dt: number) {
    this.tilt += (this.tiltTarget - this.tilt) * (1 - Math.exp(-4 * dt));
    if (Math.abs(this.tilt) < 1e-4) return;
    this.character.rotateWorld("head.x", AXIS.z, this.tilt);
  }

  lookAway(yaw: number, pitch: number) {
    this.gaze.mode = "away";
    this.gaze.setPull(yaw, pitch);
  }

  lookAtCursor() {
    this.gaze.mode = "cursor";
  }
}
