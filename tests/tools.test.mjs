import test from "node:test";
import assert from "node:assert/strict";
import { toolDefinitions, capabilityStepSchemas, stepUnionSchema, toolSummary } from "../server/tools.mjs";
import { mergeToolDelta, finalizeToolCalls } from "../server/llm.mjs";
import { CAPABILITIES } from "../server/capabilities.mjs";

test("工具清单：run_plan / skill / timer / finish", () => {
  const names = toolDefinitions().map((t) => t.function.name);
  assert.deepEqual(names, ["run_plan", "skill", "timer", "finish"]);
});

test("动作 schema 由能力表生成，数量和 id 一致", () => {
  const schemas = capabilityStepSchemas();
  assert.equal(schemas.length, CAPABILITIES.length);
  for (const cap of CAPABILITIES) {
    const schema = schemas.find((s) => s.properties.action.const === cap.id);
    assert.ok(schema, `缺少 ${cap.id} 的 schema`);
    for (const param of Object.keys(cap.params ?? {})) {
      assert.ok(schema.properties[param], `${cap.id}.${param} 没有生成`);
      assert.ok(schema.required.includes(param));
    }
  }
});

test("数值参数带上 min/max，枚举参数带上 enum", () => {
  const dig = capabilityStepSchemas().find((s) => s.properties.action.const === "dig");
  assert.equal(dig.properties.row.minimum, 0);
  assert.ok(dig.properties.row.maximum >= 15);
  const walk = capabilityStepSchemas().find((s) => s.properties.action.const === "walk");
  assert.ok(Array.isArray(walk.properties.distance_m.enum));
  assert.ok(walk.properties.distance_m.enum.length > 5);
});

test("run_plan 限制 6 步、dig/place_stone 排在最后靠提示词+校验，不在 schema 里写死顺序", () => {
  const runPlan = toolDefinitions()[0].function.parameters;
  assert.equal(runPlan.properties.steps.maxItems, 6);
  assert.ok(stepUnionSchema().oneOf.length >= 10);
});

test("skill 工具：不允许 delete，脚本有长度上限", () => {
  const skill = toolDefinitions()[1].function.parameters;
  const ops = skill.properties.operation.enum;
  assert.ok(!ops.includes("delete"));
  assert.ok(ops.includes("run"));
  assert.equal(skill.properties.skill.properties.script.maxLength, 3000);
  assert.equal(skill.properties.skill.properties.body.maxLength, 2000);
});

test("流式 tool_calls 增量按 index 合并", () => {
  const acc = [];
  mergeToolDelta(acc, [{ index: 0, id: "call_1", function: { name: "run_plan", arguments: '{"steps":[' } }]);
  mergeToolDelta(acc, [{ index: 0, function: { arguments: '{"action":"turn"}]}' } }]);
  mergeToolDelta(acc, [{ index: 1, id: "call_2", function: { name: "finish", arguments: '{"outcome":"completed"}' } }]);
  const calls = finalizeToolCalls(acc);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, { steps: [{ action: "turn" }] });
  assert.equal(calls[1].name, "finish");
});

test("参数不是合法 JSON 时保留原文并给 null", () => {
  const acc = [];
  mergeToolDelta(acc, [{ index: 0, function: { name: "skill", arguments: '{"operation":' } }]);
  const calls = finalizeToolCalls(acc);
  assert.equal(calls[0].args, null);
  assert.ok(calls[0].argumentsRaw.startsWith('{"operation"'));
});

test("toolSummary 里没有 JSON 契约的味道", () => {
  assert.ok(toolSummary().includes("run_plan"));
  assert.ok(!toolSummary().includes("execute_plan"));
});
