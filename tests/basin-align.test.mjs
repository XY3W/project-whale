import test from "node:test";
import assert from "node:assert/strict";
import { planApproach, expectedBasin, normalizeDeg, signedDeltaDeg } from "../src/prop/align.ts";

const REF = { x: -0.5460312366485596, z: 0.2100873738527298 };
const REACH = Math.hypot(REF.x, REF.z);
const DISTANCES = [0.09, 0.27, 0.45, 0.63, 0.81, 0.99, 1.17, 1.35, 1.53, 1.71, 1.89];

const applyPlan = (start, yawDeg, plan) => {
  const yaw1 = yawDeg + plan.turn1Deg;
  const stand = {
    x: start.x + Math.sin((yaw1 * Math.PI) / 180) * plan.distanceM,
    z: start.z + Math.cos((yaw1 * Math.PI) / 180) * plan.distanceM,
  };
  return { stand, yaw2: yaw1 + plan.turn2Deg };
};

test("角度工具：180 与 -180 不混淆", () => {
  assert.equal(signedDeltaDeg(0, 180), 180);
  assert.equal(signedDeltaDeg(0, -180), 180);
  assert.equal(signedDeltaDeg(170, -170), 20);
  assert.equal(normalizeDeg(540), 180);
});

test("站位求解：任意起点都落在参考半径 + 支持距离上", () => {
  const samples = [
    { c: { x: 0, z: 0 }, yaw: 0, b: { x: 0, z: 0.9 } },
    { c: { x: 1.2, z: -0.7 }, yaw: -135, b: { x: 0, z: 0 } },
    { c: { x: -2.1, z: 1.4 }, yaw: 47, b: { x: 0.0, z: 0.5 } },
    { c: { x: 0.4, z: 0.3 }, yaw: 179, b: { x: -0.5, z: 0.6 } },
    { c: { x: 2.3, z: 0.1 }, yaw: 12, b: { x: 0, z: 0 } },
  ];
  for (const s of samples) {
    const plan = planApproach({ character: s.c, basin: s.b, yawDeg: s.yaw, reference: REF, half: 4, margin: 0.3 });
    assert.ok(!("error" in plan), `应能求解: ${JSON.stringify(plan)}`);
    assert.ok(DISTANCES.some((d) => Math.abs(d - plan.distanceM) < 1e-9), "距离必须是支持值");
    const { stand, yaw2 } = applyPlan(s.c, s.yaw, plan);
    assert.ok(Math.abs(stand.x - plan.stand.x) < 1e-6 && Math.abs(stand.z - plan.stand.z) < 1e-6, "站位可复现");
    const toBasin = Math.hypot(s.b.x - stand.x, s.b.z - stand.z);
    assert.ok(Math.abs(toBasin - REACH) < 1e-6, `站位到盆距离应等于参考半径，实际 ${toBasin}`);
    const expect = expectedBasin(stand, yaw2, REF);
    assert.ok(Math.abs(expect.x - s.b.x) < 1e-6 && Math.abs(expect.z - s.b.z) < 1e-6, "终点朝向应让参考偏移落在盆上");
  }
});

test("边界：太近、太远给出明确错误", () => {
  const near = planApproach({ character: { x: 0, z: 0.05 }, basin: { x: 0, z: 0 }, yawDeg: 0, reference: REF, half: 4 });
  assert.equal(near.error, "TOO_CLOSE");
  const far = planApproach({ character: { x: 0, z: 9 }, basin: { x: 0, z: 0 }, yawDeg: 0, reference: REF, half: 9 });
  assert.equal(far.error, "TOO_FAR");
  // 单段步行的可达上限是 1.89 + reach，超过就不是一段能走到的
  const unreachable = planApproach({ character: { x: 2.9, z: 2.9 }, basin: { x: 0, z: 0 }, yawDeg: 12, reference: REF, half: 4 });
  assert.equal(unreachable.error, "NO_SUPPORTED_DISTANCE");
  assert.ok(unreachable.direct > 1.89 + unreachable.reach);
});

test("场地边界：站位越界时放弃该解", () => {
  const plan = planApproach({ character: { x: 0, z: 0 }, basin: { x: 0, z: 0.9 }, yawDeg: 0, reference: REF, half: 4, margin: 0.3 });
  assert.ok(!("error" in plan));
  assert.ok(Math.abs(plan.stand.x) <= 3.7 + 1e-9 && Math.abs(plan.stand.z) <= 3.7 + 1e-9);
});

test("重复调用稳定：同一输入输出一致", () => {
  const args = { character: { x: 1.1, z: -0.4 }, basin: { x: -0.2, z: 0.7 }, yawDeg: 33, reference: REF, half: 4 };
  assert.deepEqual(planApproach(args), planApproach(args));
});
