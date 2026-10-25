import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

/** 地面高度（与 Stage 的地板一致） */
export const FLOOR_Y = 0;
const STEP = 1 / 120;
const MAX_FRAME = 0.1;

export interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface FlightInit extends Pose {
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
}

export interface StepResult {
  pose: Pose;
  /** 连续静止时长（秒） */
  calm: number;
  resting: boolean;
  speed: number;
  spin: number;
}

/**
 * 投掷飞行用的刚体世界：一个静态地面 + 一个盆的凸包碰撞体。
 * 只负责“脱手之后”的权威状态，动画期间盆由挂接/曲线驱动。
 */
export class BasinPhysics {
  private world: RAPIER.World;
  private body: RAPIER.RigidBody | null = null;
  private accumulator = 0;
  private calmFor = 0;
  private hull: Float32Array;
  private initialised = false;

  private constructor(hull: Float32Array) {
    this.hull = hull;
    const gravity = { x: 0, y: -9.81, z: 0 };
    this.world = new RAPIER.World(gravity);
    this.world.timestep = STEP;
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, FLOOR_Y - 0.1, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(6, 0.1, 6).setFriction(0.85), ground);
  }

  static async create(hull: Float32Array): Promise<BasinPhysics> {
    await RAPIER.init();
    const physics = new BasinPhysics(hull);
    physics.initialised = true;
    return physics;
  }

  get active(): boolean {
    return this.body !== null;
  }

  get ready(): boolean {
    return this.initialised;
  }

  launch(init: FlightInit): void {
    this.stop();
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(init.position.x, init.position.y, init.position.z)
        .setRotation({ x: init.quaternion.x, y: init.quaternion.y, z: init.quaternion.z, w: init.quaternion.w })
        .setLinvel(init.velocity.x, init.velocity.y, init.velocity.z)
        .setAngvel({ x: init.angularVelocity.x, y: init.angularVelocity.y, z: init.angularVelocity.z })
        .setLinearDamping(0.05)
        .setAngularDamping(0.35)
        .setCanSleep(true),
    );
    body.enableCcd(true);
    const desc = RAPIER.ColliderDesc.convexHull(this.hull);
    if (!desc) throw new Error("盆的凸包碰撞体构建失败");
    this.world.createCollider(desc.setRestitution(0.22).setFriction(0.8).setDensity(180), body);
    this.body = body;
    this.accumulator = 0;
    this.calmFor = 0;
  }

  /** 推进物理并返回权威姿态；未启动时返回 null。 */
  step(dt: number): StepResult | null {
    const body = this.body;
    if (!body) return null;
    this.accumulator += Math.min(dt, MAX_FRAME);
    while (this.accumulator >= STEP) {
      this.world.step();
      this.accumulator -= STEP;
    }
    const t = body.translation();
    const r = body.rotation();
    const lv = body.linvel();
    const av = body.angvel();
    const speed = Math.hypot(lv.x, lv.y, lv.z);
    const spin = Math.hypot(av.x, av.y, av.z);
    const slow = speed < 0.03 && spin < 0.25;
    this.calmFor = slow ? this.calmFor + dt : 0;
    return {
      pose: {
        position: new THREE.Vector3(t.x, t.y, t.z),
        quaternion: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      },
      calm: this.calmFor,
      resting: this.calmFor > 0.4 && t.y < 0.6,
      speed: Math.round(speed * 1000) / 1000,
      spin: Math.round(spin * 1000) / 1000,
    };
  }

  stop(): void {
    if (!this.body) return;
    this.world.removeRigidBody(this.body);
    this.body = null;
  }
}

/** 从 glTF 场景里收集顶点（相对容器局部坐标），供凸包碰撞体使用。 */
export function hullPoints(root: THREE.Object3D, max = 512): Float32Array {
  root.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const out: number[] = [];
  const v = new THREE.Vector3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    const m = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const stride = Math.max(1, Math.floor(position.count / 256));
    for (let i = 0; i < position.count; i += stride) {
      v.fromBufferAttribute(position as THREE.BufferAttribute, i).applyMatrix4(m);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out.slice(0, max * 3));
}
