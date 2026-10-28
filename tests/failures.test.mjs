import test from "node:test";
import assert from "node:assert/strict";
import { createFailureLog, describeFailures } from "../server/failures.mjs";
import { validatePlan } from "../server/capabilities.mjs";

test("档案：记一条并在签名下取回", () => {
  const log = createFailureLog();
  log.record({ signature: "NOT_ALIGNED:place_stone", taskId: "t1", action: "place_stone", reasonCode: "NOT_ALIGNED", actual: { distance_m: 1.337, tolerance_m: 1 } });
  const got = log.forSignature("NOT_ALIGNED:place_stone");
  assert.equal(got.length, 1);
  assert.equal(got[0].actual.distance_m, 1.337);
  assert.equal(log.size(), 1);
});

test("档案：同一签名只取最近 N 条，环形缓冲有上限", () => {
  const log = createFailureLog({ limit: 5 });
  for (let i = 0; i < 8; i++) log.record({ signature: "A:x", taskId: `t${i}` });
  assert.equal(log.size(), 5);
  const last3 = log.forSignature("A:x", 3);
  assert.deepEqual(last3.map((r) => r.taskId), ["t5", "t6", "t7"]);
});

test("档案：大的 actual 会被截断，不撑爆上下文", () => {
  const log = createFailureLog();
  log.record({ signature: "S:a", actual: { cells: Array.from({ length: 300 }, (_, i) => i) } });
  const rec = log.forSignature("S:a")[0];
  assert.equal(rec.actual.truncated, true);
  assert.ok(JSON.stringify(rec).length < 1200);
});

test("渲染：把结构化事实说成几句话，不编造", () => {
  const log = createFailureLog();
  log.record({
    signature: "NOT_ALIGNED:place_stone", action: "place_stone", reasonCode: "NOT_ALIGNED",
    actual: { distance_m: 1.337, tolerance_m: 1, hint: "目标点超出可操作范围" },
    planSteps: ["turn", "walk_adjust", "place_stone"], note: "我以为还在 1m 内",
  });
  const text = describeFailures("NOT_ALIGNED:place_stone", log.forSignature("NOT_ALIGNED:place_stone"));
  assert.ok(text.includes("离目标 1.337m"));
  assert.ok(text.includes("要求 ≤1m"));
  assert.ok(text.includes("turn→walk_adjust→place_stone"));
  assert.ok(text.includes("我以为还在 1m 内"));
});

test("渲染：没有记录时给一句实话，不装", () => {
  assert.ok(describeFailures("X:y", []).includes("没有留下详细记录"));
});

test("decision_note：合法时保留并截断到 60 字，非字符串时忽略", () => {
  const plan = (extra) => ({ type: "execute_plan", steps: [{ action: "turn", angle_deg: 10 }], ...extra });
  assert.equal(validatePlan(plan({ decision_note: "先转向再走" })).decisionNote, "先转向再走");
  assert.equal(validatePlan(plan({ decision_note: "x".repeat(200) })).decisionNote.length, 60);
  assert.equal(validatePlan(plan({ decision_note: 42 })).decisionNote, null);
  assert.equal(validatePlan(plan({})).decisionNote, null);
});
