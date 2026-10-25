import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { BasinProp } from "../src/prop/BasinProp.ts";
import { sampleCurve } from "../src/prop/catalog.ts";
import { hullPoints } from "../src/prop/basinPhysics.ts";

const BASE = new URL("../public/models/basin-v2/", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("catalog.json", BASE), "utf8"));
const propMotion = JSON.parse(readFileSync(new URL("prop_motion.json", BASE), "utf8"));

function makeRig() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  const character = new THREE.Group();
  const arm = new THREE.Bone(); arm.name = "upper_arm.r"; arm.position.set(-0.18, 0.42, 0);
  const hand = new THREE.Bone(); hand.name = "hand.r"; hand.position.set(-0.02, -0.12, 0.05);
  const head = new THREE.Bone(); head.name = "head.x"; head.position.set(0, 0.57, -0.06);
  arm.add(hand);
  character.add(arm, head);
  root.add(character);
  scene.add(root);
  root.position.set(0.3, 0, -0.2);
  root.rotation.y = 0.7;
  root.updateMatrixWorld(true);
  const bones = new Map();
  for (const bone of [arm, hand, head]) bones.set(bone.name.replace(/[^A-Za-z0-9_]/g, ""), bone);
  return { scene, root, bones };
}

function makeBasinScene() {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.24), new THREE.MeshBasicMaterial());
  mesh.position.y = 0.06;
  group.add(mesh);
  return group;
}

async function makeProp(rig) {
  const morphs = [];
  const prop = await BasinProp.create({
    catalog,
    propMotion,
    charRoot: rig.root,
    scene: makeBasinScene(),
    bones: rig.bones,
    setMorph: (v) => morphs.push(v),
    parent: rig.scene,
  });
  prop.placeAt(BasinProp.toWorld(rig.root, catalog.pickupReference.position, catalog.pickupReference.quaternion));
  return { prop, morphs };
}

test("凸包采样：取到网格顶点且是有限值", () => {
  const hull = hullPoints(makeBasinScene());
  assert.ok(hull.length >= 24);
  assert.ok(hull.every((v) => Number.isFinite(v)));
});

test("曲线插值：端点精确，事件时刻是采样点", () => {
  const samples = propMotion.clips.wear_basin;
  const first = sampleCurve(samples, 0);
  assert.deepEqual(first.position.map((v) => +v.toFixed(6)), samples[0].position.map((v) => +v.toFixed(6)));
  const event = samples.find((s) => Math.abs(s.time - 0.7) < 1e-6);
  assert.ok(event, "0.7s 应是精确采样点");
  const at = sampleCurve(samples, 0.7);
  assert.deepEqual(at.position, event.position);
  assert.ok(Math.abs(at.wearMorph - event.wearMorph) < 1e-9);
});

test("状态机：拾取 → 戴上 → 取下 → 投掷 → 落地", async () => {
  const rig = makeRig();
  const { prop } = await makeProp(rig);

  assert.equal(prop.state, "resting");
  assert.equal(prop.canStart("pickup_basin"), true);
  assert.equal(prop.canStart("wear_basin"), false);

  // 拾取：grasp 之前盆不动
  const rest = prop.position.clone();
  assert.equal(prop.begin("pickup_basin"), true);
  assert.equal(prop.state, "reserved");
  prop.update(1 / 60, 0.5);
  assert.ok(prop.position.distanceTo(rest) < 1e-9, "抓取前盆不能移动");
  prop.handleEvent("grasp");
  assert.equal(prop.state, "held");
  prop.update(1 / 60, 1.05);
  const hand = rig.bones.get("handr");
  hand.updateWorldMatrix(true, false);
  const expected = new THREE.Matrix4()
    .multiplyMatrices(hand.matrixWorld, new THREE.Matrix4().fromArray(catalog.bindings.hand.matrixColumnMajor));
  const p = new THREE.Vector3().setFromMatrixPosition(expected);
  assert.ok(prop.position.distanceTo(p) < 1e-6, `盆应跟随手部挂点，误差 ${prop.position.distanceTo(p)}`);
  prop.finish(true);
  assert.equal(prop.state, "held");

  // 戴上
  assert.equal(prop.begin("wear_basin"), true);
  prop.handleEvent("hand_release_to_transfer");
  assert.equal(prop.state, "transferring");
  prop.update(1 / 60, 1.2);
  const curve = sampleCurve(propMotion.clips.wear_basin, 1.2);
  const local = new THREE.Vector3(...curve.position).applyMatrix4(rig.root.matrixWorld);
  assert.ok(prop.position.distanceTo(local) < 1e-6, "转移期间由曲线驱动");
  prop.handleEvent("head_attach");
  assert.equal(prop.state, "worn");
  prop.update(1 / 60, 1.95);
  const head = rig.bones.get("headx");
  head.updateWorldMatrix(true, false);
  const headWorld = new THREE.Matrix4()
    .multiplyMatrices(head.matrixWorld, new THREE.Matrix4().fromArray(catalog.bindings.head.matrixColumnMajor));
  assert.ok(prop.position.distanceTo(new THREE.Vector3().setFromMatrixPosition(headWorld)) < 1e-6, "戴上后跟随头部");
  prop.finish(true);
  assert.equal(prop.snapshot().holder, "head");

  // 取下
  assert.equal(prop.begin("unwear_basin"), true);
  prop.handleEvent("head_release_to_transfer");
  assert.equal(prop.state, "transferring");
  prop.handleEvent("hand_catch");
  assert.equal(prop.state, "held");
  prop.finish(true);
  assert.equal(prop.snapshot().state, "held");

  // 投掷 → 物理接管
  assert.equal(prop.begin("throw_basin", { directionDeg: 0, speed: 3, spin: 180 }), true);
  prop.handleEvent("release");
  assert.equal(prop.state, "flying");
  assert.equal(prop.mode, "physics");
  let steps = 0;
  while (prop.state === "flying" && steps < 900) {
    prop.update(1 / 60, 0);
    steps++;
  }
  assert.equal(prop.state, "resting", `应在 15 秒内落地静止，实际 ${steps} 步`);
  assert.ok(prop.position.y < 0.6, "落地高度合理");
  assert.equal(prop.snapshot().available, prop.upright);
});

test("取消：拾取未到抓取点就退回静置，不产生第二只盆", async () => {
  const rig = makeRig();
  const { prop } = await makeProp(rig);
  const rest = prop.position.clone();
  assert.equal(prop.begin("pickup_basin"), true);
  prop.update(1 / 60, 0.4);
  prop.finish(false);
  assert.equal(prop.state, "resting");
  assert.equal(prop.mode, "world");
  assert.ok(prop.position.distanceTo(rest) < 1e-9, "取消后回到原位");
  assert.equal(prop.begin("pickup_basin"), true, "仍可再次拾取");
});

test("戴上后不能再次戴上；戴头必须先取下才能投掷", async () => {
  const rig = makeRig();
  const { prop } = await makeProp(rig);
  prop.begin("pickup_basin");
  prop.handleEvent("grasp");
  prop.finish(true);
  prop.begin("wear_basin");
  prop.handleEvent("head_attach");
  prop.finish(true);
  assert.equal(prop.state, "worn");
  assert.equal(prop.canStart("wear_basin"), false);
  assert.equal(prop.canStart("pickup_basin"), false);
  assert.equal(prop.canStart("unwear_basin"), true);
  // 戴头时不能直接投掷：必须先取下
  assert.equal(prop.canStart("throw_basin"), false);
  assert.equal(prop.canStart("unwear_basin"), true);
});

test("快照字段：revision 随状态变化递增", async () => {
  const rig = makeRig();
  const { prop } = await makeProp(rig);
  const r0 = prop.snapshot().revision;
  prop.begin("pickup_basin");
  prop.handleEvent("grasp");
  prop.finish(true);
  const r1 = prop.snapshot().revision;
  assert.ok(r1 > r0);
  assert.equal(prop.snapshot().object_id, "basin");
});
