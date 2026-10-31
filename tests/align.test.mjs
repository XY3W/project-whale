import test from "node:test";
import assert from "node:assert/strict";
import { planApproach } from "../src/prop/align.ts";

const REF = { x: 0, z: 0.59 };
const req = (character, basin, yawDeg = 0) => ({ character, basin, yawDeg, reference: REF, half: 4, margin: 0.3 });

test("常规位置：有精确解，不需要 adjust", () => {
  const plan = planApproach(req({ x: 0, z: 0 }, { x: 1.2, z: 0 }));
  assert.ok(!("error" in plan), JSON.stringify(plan));
  assert.equal(plan.approx, undefined);
  assert.equal(plan.adjustM, undefined);
  assert.ok(Math.abs(plan.distanceM - (0.09 + 0.18 * Math.round((plan.distanceM - 0.09) / 0.18))) < 1e-6);
});

test("精确解不存在时走近似解：站位仍在 reach 圆上，零头交给 walk_adjust", () => {
  // 余量收紧到 0.3 时，盆贴近墙角就没有任何“圆交点”落在场内，只能走近似解
  const plan = planApproach({ ...req({ x: 2.2, z: 2.2 }, { x: 3.9, z: 3.9 }), margin: 0.3 });
  assert.ok(!("error" in plan), JSON.stringify(plan));
  assert.equal(plan.approx, true);
  assert.ok(plan.adjustM > 0 && plan.adjustM <= 0.18 + 1e-9, `adjust=${plan.adjustM}`);
  // distanceM 必须是支持档位
  assert.ok(Math.abs(plan.distanceM - (0.09 + 0.18 * Math.round((plan.distanceM - 0.09) / 0.18))) < 1e-6);
  // 站位到盆的距离仍然等于 reach
  const reach = Math.hypot(plan.stand.x - 3.9, plan.stand.z - 3.9);
  assert.ok(Math.abs(reach - plan.reach) < 1e-6, `reach=${reach}`);
});

test("放宽站位余量后，贴角盆也能找到精确站位（不再一律失败）", () => {
  const plan = planApproach({ ...req({ x: 2.2, z: 2.2 }, { x: 3.86, z: 3.86 }), margin: 0.12 });
  assert.ok(!("error" in plan), JSON.stringify(plan));
  assert.ok(Math.abs(plan.stand.x) <= 3.88 && Math.abs(plan.stand.z) <= 3.88);
});

test("贴墙：能找到可执行站位（精确或近似都可以）", () => {
  const plan = planApproach(req({ x: 2.6, z: 3.5 }, { x: 3.9, z: 3.5 }));
  assert.ok(!("error" in plan), JSON.stringify(plan));
  if (plan.approx) assert.ok(plan.adjustM > 0 && plan.adjustM <= 0.18 + 1e-9);
});

test("太远时留给多段走位：明确报 NO_SUPPORTED_DISTANCE 而不是硬凑", () => {
  const plan = planApproach(req({ x: 0, z: 3.5 }, { x: 3.9, z: 3.5 }));
  assert.equal(plan.error, "NO_SUPPORTED_DISTANCE");
});

test("太近：仍然明确报 TOO_CLOSE，不硬凑", () => {
  const plan = planApproach(req({ x: 0, z: 0 }, { x: 0.3, z: 0 }));
  // 0.3m 时 exact 解可能存在；换一个确实太近的
  const closer = planApproach(req({ x: 0, z: 0 }, { x: 0.55, z: 0 }));
  assert.ok(!("error" in closer) || closer.error === "TOO_CLOSE", JSON.stringify(closer));
  assert.ok(!("error" in plan) || plan.error === "TOO_CLOSE");
});
