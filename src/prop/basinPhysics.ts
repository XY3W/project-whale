import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

/** 地面高度（与 Stage 的地板一致） */
export const FLOOR_Y = 0;
export const ARENA_HALF = 4;
const STEP = 1 / 120;
const MAX_FRAME = 0.1;
/** 兜底：飞行超过这个时间且已经贴地，就强制停下，避免无限缓慢滚动 */
const MAX_FLIGHT_S = 6;

export interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface ColliderShape {
  kind: "cylinder";
  radius: number;
  halfHeight: number;
  center: THREE.Vector3;
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
  flightTime: number;
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
  private flightTime = 0;
  private readonly lastPosition = new THREE.Vector3();
  private readonly lastQuaternion = new THREE.Quaternion();

  private constructor(hull: Float32Array, half: number) {
    this.hull = hull;
    const gravity = { x: 0, y: -9.81, z: 0 };
    this.world = new RAPIER.World(gravity);
    this.world.timestep = STEP;
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, FLOOR_Y - 0.1, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(half + 1, 0.1, half + 1).setFriction(0.9), ground);
    // 空气墙：四面固定挡板，把盆关在场地里（角色边界是 half，墙再往外半米）
    const thickness = 0.5;
    const wallHalfHeight = 1.5;
    const walls = [
      { x: half + thickness / 2, z: 0, hx: thickness / 2, hz: half + thickness },
      { x: -(half + thickness / 2), z: 0, hx: thickness / 2, hz: half + thickness },
      { x: 0, z: half + thickness / 2, hx: half + thickness, hz: thickness / 2 },
      { x: 0, z: -(half + thickness / 2), hx: half + thickness, hz: thickness / 2 },
    ];
    for (const wall of walls) {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(wall.x, wallHalfHeight, wall.z),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(wall.hx, wallHalfHeight, wall.hz).setRestitution(0.2).setFriction(0.4),
        body,
      );
    }
  }

  static async create(hull: Float32Array, half = ARENA_HALF): Promise<BasinPhysics> {
    await RAPIER.init();
    const physics = new BasinPhysics(hull, half);
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
        .setLinearDamping(0.12)
        .setAngularDamping(0.9)
        .setCanSleep(true),
    );
    body.enableCcd(true);
    this.world.createCollider(this.colliderDesc().setRestitution(0.15).setFriction(0.9).setDensity(180), body);
    this.body = body;
    this.accumulator = 0;
    this.calmFor = 0;
    this.flightTime = 0;
    this.lastPosition.set(init.position.x, init.position.y, init.position.z);
    this.lastQuaternion.copy(init.quaternion);
  }

  /**
   * 碰撞体：用贴合外接尺寸的圆柱，而不是整个凸包。
   * 261 点的凸包落在平面上时接触流形会持续抖动（贴地后线速度一直在 5 cm/s 上下，
   * 画面表现为“抽搐”），圆柱的平面/直线接触稳定得多，且外接圆柱不会让视觉穿地。
   */
  private colliderDesc(): RAPIER.ColliderDesc {
    const shape = cylinderFromHull(this.hull);
    const desc = RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
    return desc.setTranslation(shape.center.x, shape.center.y, shape.center.z);
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
    this.flightTime += dt;
    const pose = {
      position: new THREE.Vector3(t.x, t.y, t.z),
      quaternion: new THREE.Quaternion(r.x, r.y, r.z, r.w),
    };
    // 静止判定同时看速度与“实际位移”：贴着地面缓慢打转时速度不为 0，但画面已经不动了
    const moved = pose.position.distanceTo(this.lastPosition);
    const dot = Math.min(1, Math.abs(pose.quaternion.dot(this.lastQuaternion)));
    const turned = 2 * Math.acos(dot);
    const slow = speed < 0.06 && spin < 0.9;
    const visuallyStill = moved < 0.0004 && turned < 0.002;
    this.calmFor = slow || visuallyStill ? this.calmFor + dt : 0;
    this.lastPosition.copy(pose.position);
    this.lastQuaternion.copy(pose.quaternion);
    const onFloor = t.y < 0.6;
    const forced = this.flightTime > MAX_FLIGHT_S && onFloor;
    return {
      pose,
      calm: this.calmFor,
      resting: onFloor && (this.calmFor > 0.45 || forced),
      speed: Math.round(speed * 1000) / 1000,
      spin: Math.round(spin * 1000) / 1000,
      flightTime: Math.round(this.flightTime * 100) / 100,
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

/** 由凸包点集求外接圆柱（轴向 +Y），用于稳定的碰撞体近似 */
export function cylinderFromHull(points: Float32Array): ColliderShape {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
    minZ = Math.min(minZ, points[i + 2]); maxZ = Math.max(maxZ, points[i + 2]);
  }
  const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  let radius = 0;
  for (let i = 0; i < points.length; i += 3) {
    radius = Math.max(radius, Math.hypot(points[i] - center.x, points[i + 2] - center.z));
  }
  return { kind: "cylinder", radius, halfHeight: Math.max(0.01, (maxY - minY) / 2), center };
}
