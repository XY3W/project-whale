import * as THREE from "three";
import { AXIS, Character } from "./Character";

const smooth = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * 手势层：比"待机微动"更明确、有始有终的动作。
 * 全部基于世界轴旋转，叠加在动画片段之上，不依赖额外动画资源。
 */
export class Gesture {
  private name: "wave" | null = null;
  private t = 0;
  private duration = 3.2;

  constructor(private readonly character: Character) {}

  get active(): boolean {
    return this.name !== null;
  }

  wave() {
    this.name = "wave";
    this.t = 0;
  }

  update(dt: number) {
    if (!this.name) return;
    this.t += dt;
    if (this.t >= this.duration) {
      this.name = null;
      return;
    }
    this.applyWave();
  }

  private applyWave() {
    const c = this.character;
    // 抬起→保持→放下
    const env = smooth(0, 0.45, this.t) * (1 - smooth(2.55, 3.0, this.t));
    if (env <= 0.001) return;

    // 这套角色的手臂很短、袖口很大，抬太高会被头发完全遮住。
    // 实测 0.85 弧度 + 略微前伸时，手正好露在胸前，是最可读的位置。
    c.rotateWorld("arm.l", AXIS.z, 0.9 * env);
    c.rotateWorld("arm.l", AXIS.x, -0.5 * env);
    // 小臂来回摆动 = 挥手
    const swing = Math.sin((this.t - 0.45) * 9.5) * 0.3 * env;
    c.rotateWorld("forearm.l", AXIS.z, (0.5 + swing) * env);
    // 头和视线稍微偏向抬起的那只手
    c.rotateWorld("head.x", AXIS.z, -0.055 * env);
    c.rotateWorld("head.x", AXIS.y, 0.06 * env);
  }
}
