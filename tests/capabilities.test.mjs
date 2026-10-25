import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITY_VERSION, describeCapabilities, validatePlan, validateStep } from "../server/capabilities.mjs";
import { createEventDeduper } from "../server/events.mjs";

test("注册表：enabled 清单不含 disabled 能力", () => {
  const ids = describeCapabilities().map((c) => c.id);
  assert.ok(ids.includes("walk"));
  assert.ok(!ids.includes("pickup"));
  assert.ok(!ids.includes("throw"));
  assert.equal(CAPABILITY_VERSION, "cap-v1");
});

test("距离：0.45 通过，0.5/0.449/字符串拒绝", () => {
  assert.equal(validateStep({ action: "walk", distance_m: 0.45 }).distance_m, 0.45);
  assert.throws(() => validateStep({ action: "walk", distance_m: 0.5 }), /不支持/);
  assert.throws(() => validateStep({ action: "walk", distance_m: 0.449 }), /不支持/);
  assert.throws(() => validateStep({ action: "walk", distance_m: "0.45" }), /不支持/);
});

test("类型严格：angle_deg 字符串被拒绝", () => {
  assert.throws(() => validateStep({ action: "turn", angle_deg: "45" }), /angle_deg/);
  assert.equal(validateStep({ action: "turn", angle_deg: -180 }).angle_deg, -180);
});

test("禁用能力给出 disabled 原因", () => {
  assert.throws(() => validateStep({ action: "pickup" }), /未启用/);
});

test("parallel 不允许嵌套，最多 3 项", () => {
  assert.throws(() => validateStep({ action: "parallel", items: [{ action: "parallel", items: [] }] }), /嵌套/);
  assert.throws(
    () => validateStep({ action: "parallel", items: Array.from({ length: 4 }, () => ({ action: "wait", duration_s: 1 })) }),
    /1..3/,
  );
});

test("整计划：finish_task 合法、未知 type 拒绝", () => {
  assert.equal(validatePlan({ type: "finish_task", outcome: "completed", speech: "好" }).outcome, "completed");
  assert.throws(() => validatePlan({ type: "nope" }), /type/);
});

test("事件去重：同 eventId 只发一次，revision 变化可再发", () => {
  const d = createEventDeduper(30_000);
  const ev = { eventId: "e1", objectId: "basin", type: "seen", revision: 1 };
  assert.equal(d.shouldEmit(ev, 1000), true);
  assert.equal(d.shouldEmit({ ...ev }, 2000), false);
  assert.equal(d.shouldEmit({ ...ev, eventId: "e2" }, 3000), false);
  assert.equal(d.shouldEmit({ ...ev, eventId: "e3", revision: 2 }, 4000), true);
});
