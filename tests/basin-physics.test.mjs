import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BasinPhysics, hullPoints, cylinderFromHull, ARENA_HALF } from "../src/prop/basinPhysics.ts";

globalThis.self ??= globalThis;
const BASE = new URL("../public/models/basin-v2/", import.meta.url);
const buf = readFileSync(new URL("steel_basin_v2.glb", BASE));
const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
const hull = hullPoints(gltf.scene);

const run = async ({ tilt = 0, velocity = [0.2, 1.2, 2.4], angular = [0, 3.1, 0], from = [0, 0.42, 0], maxSeconds = 12 }) => {
  const physics = await BasinPhysics.create(hull);
  physics.launch({
    position: new THREE.Vector3(...from),
    quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0.4, tilt * 0.5)),
    velocity: new THREE.Vector3(...velocity),
    angularVelocity: new THREE.Vector3(...angular),
  });
  let t = 0;
  let out = null;
  while (t < maxSeconds) {
    out = physics.step(1 / 60);
    t += 1 / 60;
    if (out.resting) break;
  }
  physics.stop();
  return { ...out, time: t };
};

test("碰撞体：外接圆柱贴合盆的外形，且不穿地", () => {
  const shape = cylinderFromHull(hull);
  // 盆直径约 0.74 m（含两个提手），高约 0.27 m
  assert.ok(shape.radius > 0.35 && shape.radius < 0.39, `半径 ${shape.radius}`);
  assert.ok(shape.halfHeight > 0.12 && shape.halfHeight < 0.15, `半高 ${shape.halfHeight}`);
  // 圆柱底面不高于盆的最低点，避免视觉穿地
  const bottom = shape.center.y - shape.halfHeight;
  let minY = Infinity;
  for (let i = 1; i < hull.length; i += 3) minY = Math.min(minY, hull[i]);
  assert.ok(bottom <= minY + 1e-6, `碰撞体底面 ${bottom} 应不高于网格最低点 ${minY}`);
});

test("平放抛掷：2 秒内静止，不再持续抖动", async () => {
  const out = await run({});
  assert.ok(out.resting, "应该进入静止");
  assert.ok(out.time < 3, `静止耗时 ${out.time.toFixed(2)}s`);
  assert.equal(out.speed, 0);
  assert.equal(out.spin, 0);
  assert.ok(out.pose.position.y > 0.1 && out.pose.position.y < 0.2, `静止高度 ${out.pose.position.y}`);
});

test("侧躺落地：同样能停下（不会一直缓慢打转）", async () => {
  const out = await run({ tilt: Math.PI / 2, velocity: [0.3, 0.8, 1.6], angular: [2.2, 1.4, 0.6] });
  assert.ok(out.resting, "侧躺也要进入静止");
  assert.ok(out.time < 6.5, `静止耗时 ${out.time.toFixed(2)}s`);
});

test("空气墙：用力朝 +X 扔也留在场地内", async () => {
  const out = await run({ velocity: [9, 2.2, 0], angular: [0, 6, 0], from: [3.2, 0.5, 0], maxSeconds: 8 });
  assert.ok(out.pose.position.x < ARENA_HALF + 0.6, `x=${out.pose.position.x} 应该被墙挡住`);
  assert.ok(Math.abs(out.pose.position.z) < ARENA_HALF + 0.6);
});

test("空气墙：斜向高速也不会穿出对角", async () => {
  const out = await run({ velocity: [7, 3, 7], angular: [4, 4, 4], from: [0, 0.6, 0], maxSeconds: 10 });
  assert.ok(Math.abs(out.pose.position.x) < ARENA_HALF + 0.6);
  assert.ok(Math.abs(out.pose.position.z) < ARENA_HALF + 0.6);
});

test("兜底：贴地后最迟 6 秒强制静止", async () => {
  const out = await run({ velocity: [0.05, 0.5, 0.05], angular: [0, 0.2, 0], from: [0, 0.2, 0], maxSeconds: 12 });
  assert.ok(out.resting);
  assert.ok(out.flightTime <= 6.2, `飞行时间 ${out.flightTime}`);
});
