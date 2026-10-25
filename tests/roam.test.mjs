import test from "node:test";
import assert from "node:assert/strict";
import { freeDistance, headingWeight, pickRoamPlan } from "../src/behavior/roam.ts";

test("边缘距离：朝墙方向为 0，朝场内为正", () => {
  assert.ok(Math.abs(freeDistance(3.6, 0, Math.PI / 2, 4) - 0.4) < 1e-9); // 朝 +X 距边界 0.4
  assert.ok(freeDistance(0, 0, Math.PI / 2, 4) === 4);
});

test("权重：0.5 米内为 0，2 米外为 1", () => {
  assert.equal(headingWeight(0.3), 0);
  assert.equal(headingWeight(0.5), 0);
  assert.ok(headingWeight(1.0) > 0 && headingWeight(1.0) < 1);
  assert.equal(headingWeight(2.0), 1);
  assert.equal(headingWeight(5), 1);
});

test("贴着右边缘时，不会再选朝右的方向", () => {
  let picked = null;
  for (let i = 0; i < 200; i++) {
    const p = pickRoamPlan({ x: 3.8, z: 0, yaw: Math.PI / 2, half: 4, rng: Math.random });
    if (p) { picked = p; break; }
  }
  assert.ok(picked);
  // 相对角度不能接近 0（0 表示继续朝 +X 走）
  assert.ok(Math.abs(picked.angleDeg) >= 45, `got ${picked.angleDeg}`);
});

test("角落无出路时返回 null 或安全方向", () => {
  const p = pickRoamPlan({ x: 3.95, z: 3.95, yaw: Math.PI / 4, half: 4, rng: () => 0.5 });
  // 角落允许转向场内（±180 度窗口），但不能有朝角外的方向
  if (p) {
    const heading = Math.PI / 4 + (p.angleDeg * Math.PI) / 180;
    const free = freeDistance(3.95, 3.95, heading, 4);
    assert.ok(free > 0.5, `free=${free}`);
  }
});

test("走路距离不会越过边界", () => {
  for (let i = 0; i < 200; i++) {
    const p = pickRoamPlan({ x: 3.2, z: 0, yaw: Math.PI / 2, half: 4, rng: Math.random });
    if (!p) continue;
    const heading = Math.PI / 2 + (p.angleDeg * Math.PI) / 180;
    assert.ok(p.distance <= freeDistance(3.2, 0, heading, 4) - 0.2);
  }
});
