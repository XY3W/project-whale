import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

/** 地面高度（与 Stage 的地板一致） */
export const FLOOR_Y = 0;
export const ARENA_HALF = 4;
const STEP = 1 / 120;
const MAX_FRAME = 0.1;
/** 位姿变化在窗口内保持很小，才认为落地静止。 */
const STILL_SECONDS = 0.8;
const STILL_DISTANCE = 0.003;
const STILL_ANGLE = 0.02;
/**
 * 落地判定的海拔容差。碰撞体是“空心圆台”，接触发生在碰撞面上，而 hull 是外层视觉顶点，
 * 停下来时最低顶点常在 0.02~0.03m 之间——原来的 0.025 正好卡在边界上。
 */
const FLOOR_SLACK = 0.06;
/** 近零速度阈值：贴墙被接触约束顶住时，位移会有微抖，但速度其实已经归零。 */
const STILL_SPEED = 0.02;
const STILL_SPIN = 0.08;
/** 兜底：飞了这么久还没判成落地，只要接近静止就强制收 */
const MAX_FLIGHT = 20;

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
  /** 刚体是否已被物理引擎判定为睡眠（贴墙卡住时的重要信号） */
  asleep: boolean;
  /** 触发兜底收尾（超时/近零速） */
  forced: boolean;
}

export interface Impact {id:string;pair:string[];normalSpeed:number;point:{x:number;y:number;z:number}|null;}
type Shared={world:RAPIER.World;queue:RAPIER.EventQueue;ids:Map<number,string>;accumulator:number;sequence:number;last:Map<string,number>;time:number;owner?:BasinPhysics;};
let shared:Shared|null=null;
let impactListener:((event:Impact)=>void)|null=null;
export function onPropImpact(fn:(event:Impact)=>void){impactListener=fn;}
/** One world step per rendered frame, never once per item. Measure incident point velocities before solving. */
export function stepPropWorld(dt:number){
  if(!shared)return;const s=shared;s.accumulator+=Math.min(Math.max(dt,0),MAX_FRAME);
  while(s.accumulator>=STEP){
    const before=new Map<number,{v:THREE.Vector3;w:THREE.Vector3;p:THREE.Vector3}>();
    s.world.bodies.forEach(b=>{const v=b.linvel(),w=b.angvel(),p=b.translation();before.set(b.handle,{v:new THREE.Vector3(v.x,v.y,v.z),w:new THREE.Vector3(w.x,w.y,w.z),p:new THREE.Vector3(p.x,p.y,p.z)});});
    s.world.step(s.queue);s.time+=STEP;s.accumulator-=STEP;
    s.queue.drainCollisionEvents((a,b,started)=>{
      if(!started)return;const pair=[s.ids.get(a)??'environment',s.ids.get(b)??'environment'];if(!pair.includes('basin'))return;
      const ca=s.world.getCollider(a),cb=s.world.getCollider(b);if(!ca||!cb)return;
      let speed=0,point:Impact['point']=null;
      s.world.contactPair(ca,cb,(m,flipped)=>{
        const n=m.normal();const normal=new THREE.Vector3(n.x,n.y,n.z).multiplyScalar(flipped?-1:1);
        const hit=m.numSolverContacts()>0?m.solverContactPoint(0):null;
        if(hit)point={x:hit.x,y:hit.y,z:hit.z};
        const velocity=(c:RAPIER.Collider)=>{const body=c.parent();const info=body?before.get(body.handle):null;if(!info)return new THREE.Vector3();const v=info.v.clone();if(hit)v.add(info.w.clone().cross(new THREE.Vector3(hit.x,hit.y,hit.z).sub(info.p)));return v;};
        speed=Math.max(speed,velocity(ca).sub(velocity(cb)).dot(normal));
      });
      const key=pair.slice().sort().join(':');if(speed<.18||s.time-(s.last.get(key)??-Infinity)<.075)return;
      s.last.set(key,s.time);impactListener?.({id:`impact-${++s.sequence}`,pair,normalSpeed:speed,point});
    });
  }
}

/**
 * 投掷飞行用的刚体世界：静态地面和盆的组合碰撞体。
 * 只负责“脱手之后”的权威状态，动画期间盆由挂接/曲线驱动。
 */
export class BasinPhysics {
  private world: RAPIER.World;
  private sharedId?:string;
  private staticBody:RAPIER.RigidBody|null=null;
  private staticKey="";
  private body: RAPIER.RigidBody | null = null;
  private accumulator = 0;
  private calmFor = 0;
  private hull: Float32Array;
  private initialised = false;
  private flightTime = 0;
  private readonly stillAnchor = new THREE.Vector3();
  private readonly stillRotation = new THREE.Quaternion();
  private readonly shape: "cylinder" | "box" | "basin";
  private wallBodies: any[] = [];
  private arenaHalf = ARENA_HALF;
  private ownsWorld = false;

  private constructor(hull: Float32Array, half: number, shape: "cylinder" | "box" | "basin" = "cylinder", sharedId?:string) {
    this.hull = hull;
    this.shape = shape;
    this.sharedId=sharedId;
    if(sharedId&&shared){this.world=shared.world;shared.owner=shared.owner??this;return;}
    const gravity = { x: 0, y: -9.81, z: 0 };
    this.world = new RAPIER.World(gravity);
    this.world.timestep = STEP;
    if(sharedId)shared={world:this.world,queue:new RAPIER.EventQueue(true),ids:new Map(),accumulator:0,sequence:0,last:new Map(),time:0,owner:this};
    this.ownsWorld = true;
    this.wallBodies = [];
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, FLOOR_Y - 0.1, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(half + 1, 0.1, half + 1).setFriction(0.9), ground);
    this.buildWalls(half);
  }

  /** 空气墙：四面固定挡板，把盆关在场地里（角色边界是 half，墙再往外半米） */
  private buildWalls(half: number) {
    for (const body of this.wallBodies ?? []) this.world.removeRigidBody(body);
    this.wallBodies = [];
    this.arenaHalf = half;
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
      this.wallBodies.push(body);
    }
  }

  /** 场地换尺寸（象棋 11.5m）：重建空气墙，道具才不会在棋盘上飞出旧边界 */
  setArenaHalf(half: number): boolean {
    if (!Number.isFinite(half) || half <= 0) return false;
    if (!this.ownsWorld) return false;
    if (Math.abs(half - this.arenaHalf) < 1e-6) return false;
    this.buildWalls(half);
    return true;
  }

  get arenaHalfSize(): number { return this.arenaHalf; }

  /** 碰撞体形状：盆用空心圆台近似，饭勺这类细长物品用外接长方体 */
  static async create(hull: Float32Array, half = ARENA_HALF, shape: "cylinder" | "box" | "basin" = "cylinder", sharedId?:string): Promise<BasinPhysics> {
    await RAPIER.init();
    const physics = new BasinPhysics(hull, half, shape,sharedId);
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
    this.syncStatic(null);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(init.position.x, init.position.y, init.position.z)
        .setRotation({ x: init.quaternion.x, y: init.quaternion.y, z: init.quaternion.z, w: init.quaternion.w })
        .setLinvel(init.velocity.x, init.velocity.y, init.velocity.z)
        .setAngvel({ x: init.angularVelocity.x, y: init.angularVelocity.y, z: init.angularVelocity.z })
        .setLinearDamping(0.12)
        .setAngularDamping(this.shape === "box" ? 0.9 : 3.0)
        .setCanSleep(true),
    );
    body.enableCcd(true);
    this.attachColliders(body, true);
    this.body = body;
    this.accumulator = 0;
    this.calmFor = 0;
    this.flightTime = 0;
    this.stillAnchor.copy(init.position);
    this.stillRotation.copy(init.quaternion);
  }

  /** Compound hollow frustum: a bottom disk and separate sloped wall segments. */
  private colliderDescs(): RAPIER.ColliderDesc[] {
    if (this.shape === "box") {
      const bounds = boxFromHull(this.hull);
      return [RAPIER.ColliderDesc.cuboid(bounds.halfExtents.x, bounds.halfExtents.y, bounds.halfExtents.z)
        .setTranslation(bounds.center.x, bounds.center.y, bounds.center.z)];
    }
    const shape = cylinderFromHull(this.hull);
    if (this.shape === "cylinder") return [RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius).setTranslation(shape.center.x, shape.center.y, shape.center.z)];
    const height = shape.halfHeight * 2;
    const y0 = shape.center.y - shape.halfHeight, y1 = shape.center.y + shape.halfHeight;
    // The actual asset widens towards +Y. Sample the bottom to avoid the lip/handles inflating the base.
    let baseRadius = 0;
    for (let i = 0; i < this.hull.length; i += 3) if (this.hull[i + 1] <= y0 + height * 0.14)
      baseRadius = Math.max(baseRadius, Math.hypot(this.hull[i] - shape.center.x, this.hull[i + 2] - shape.center.z));
    baseRadius = Math.max(shape.radius * 0.5, Math.min(baseRadius || shape.radius * 0.7, shape.radius * 0.9));
    const thickness = Math.max(0.006, Math.min(0.012, height * 0.045));
    const descs = [RAPIER.ColliderDesc.cylinder(thickness / 2, baseRadius).setTranslation(shape.center.x, y0 + thickness / 2, shape.center.z)];
    const sides = 16;
    for (let i = 0; i < sides; i++) {
      const vertices: number[] = [];
      for (const [y, radius] of [[y0, baseRadius], [y1, shape.radius]]) {
        for (const a of [2 * Math.PI * i / sides, 2 * Math.PI * (i + 1) / sides]) {
          for (const rad of [radius - thickness, radius]) vertices.push(shape.center.x + rad * Math.cos(a), y, shape.center.z + rad * Math.sin(a));
        }
      }
      const wall = RAPIER.ColliderDesc.convexHull(new Float32Array(vertices));
      if (!wall) throw new Error("Cannot build basin collision wall");
      descs.push(wall);
    }
    return descs;
  }

  private attachColliders(body: RAPIER.RigidBody, dynamic: boolean) {
    for (const desc of this.colliderDescs()) {
      desc.setRestitution(0.15).setFriction(0.9).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      if (dynamic) desc.setDensity(this.sharedId === "rice_scoop" ? 400 : 180);
      const collider = this.world.createCollider(desc, body);
      if (this.sharedId && shared) shared.ids.set(collider.handle, this.sharedId);
    }
  }

  /** 推进物理并返回权威姿态；未启动时返回 null。 */
  step(dt: number): StepResult | null {
    const body = this.body;
    if (!body) return null;
    if(!this.sharedId)this.accumulator += Math.min(dt, MAX_FRAME);
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
    // Measure displacement from a fixed anchor across time, not instantaneous velocity.
    // Both translation and rotation matter: a basin can roll in place without moving its centre.
    const moved = pose.position.distanceTo(this.stillAnchor);
    const dot = Math.min(1, Math.abs(pose.quaternion.dot(this.stillRotation)));
    const turned = 2 * Math.acos(dot);
    let lowest = Infinity;
    const point = new THREE.Vector3();
    for (let i = 0; i < this.hull.length; i += 3) {
      point.set(this.hull[i], this.hull[i + 1], this.hull[i + 2]).applyQuaternion(pose.quaternion).add(pose.position);
      lowest = Math.min(lowest, point.y);
    }
    const onFloor = lowest <= FLOOR_Y + FLOOR_SLACK;
    const asleep = typeof body.isSleeping === "function" ? body.isSleeping() : false;
    const still = moved <= STILL_DISTANCE && turned <= STILL_ANGLE;
    // 位移是硬门槛：真的不动了才算停（防止被“推着走但速度读数为 0”骗过）。
    // 速度/睡眠只用来放宽“脚是不是落在地上”这一条——贴墙时碰撞面在接触，视觉 hull 可能悬空。
    const nearZero = speed <= STILL_SPEED && spin <= STILL_SPIN;
    const settled = still && (onFloor || nearZero || asleep);
    const timedOut = this.flightTime >= MAX_FLIGHT && still;
    if (settled || timedOut) this.calmFor += dt;
    else { this.calmFor = 0; this.stillAnchor.copy(pose.position); this.stillRotation.copy(pose.quaternion); }
    const forced = timedOut && !(onFloor && still);
    return {
      pose,
      calm: this.calmFor,
      resting: this.calmFor >= STILL_SECONDS && (settled || timedOut),
      speed: Math.round(speed * 1000) / 1000,
      spin: Math.round(spin * 1000) / 1000,
      flightTime: Math.round(this.flightTime * 100) / 100,
      asleep,
      forced,
    };
  }

  syncStatic(pose:Pose|null){
    if(!this.sharedId)return;
    if(!pose){if(this.staticBody){for(let i=0;i<this.staticBody.numColliders();i++)shared?.ids.delete(this.staticBody.collider(i).handle);this.world.removeRigidBody(this.staticBody);this.staticBody=null;}this.staticKey='';return;}
    const key=[...pose.position.toArray(),...pose.quaternion.toArray()].map(n=>n.toFixed(4)).join(',');
    if(key===this.staticKey)return;this.syncStatic(null);this.staticKey=key;
    const b=this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pose.position.x,pose.position.y,pose.position.z).setRotation(pose.quaternion));
    this.attachColliders(b, false);
    this.staticBody=b;
  }

  stop(): void {
    if (!this.body) return;
    for(let i=0;i<this.body.numColliders();i++)shared?.ids.delete(this.body.collider(i).handle);
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

/** 由点集求外接长方体（细长物品用，避免圆柱把勺子滚成轮胎） */
export function boxFromHull(points: Float32Array) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
    minZ = Math.min(minZ, points[i + 2]); maxZ = Math.max(maxZ, points[i + 2]);
  }
  return {
    center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
    halfExtents: new THREE.Vector3(
      Math.max(0.005, (maxX - minX) / 2),
      Math.max(0.005, (maxY - minY) / 2),
      Math.max(0.005, (maxZ - minZ) / 2),
    ),
  };
}
