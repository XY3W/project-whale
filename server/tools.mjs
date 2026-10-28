/**
 * 工具定义：从能力表自动生成 JSON Schema，供原生 tool calling 使用。
 *
 * 只暴露三个“面”：
 * - run_plan：复合动作（一次调用 = 一套动作，避免把 turn/walk/adjust 拆成多次往返）
 * - skill：她自己的经验条目（含沙箱脚本）
 * - timer：定时任务
 * - finish：收尾
 *
 * 动作参数的事实来源是 capabilities.mjs，避免提示词和注册表漂移。
 */
import { CAPABILITIES, OBJECTS } from "./capabilities.mjs";

const NUM = { type: "number" };
const STR = { type: "string" };

/** capabilities 里的参数描述 → JSON Schema 片段 */
function paramSchema(param = {}) {
  const out = { ...(param.type === "number" ? NUM : STR) };
  if (param.type === "number") {
    if (typeof param.min === "number") out.minimum = param.min;
    if (typeof param.max === "number") out.maximum = param.max;
  }
  if (Array.isArray(param.enum)) out.enum = param.enum;
  if (param.note) out.description = param.note;
  return out;
}

/** 单步动作的 schema：action 用 const 固定，其余参数来自能力定义 */
function stepSchema(cap) {
  const properties = { action: { const: cap.id } };
  const required = ["action"];
  for (const [name, param] of Object.entries(cap.params ?? {})) {
    properties[name] = paramSchema(param);
    required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export function capabilityStepSchemas() {
  return CAPABILITIES.map(stepSchema);
}

/** 一步动作的联合（run_plan.steps 的元素） */
export function stepUnionSchema() {
  return { oneOf: capabilityStepSchemas() };
}

export function toolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "run_plan",
        description:
          "执行一套动作。一次调用最多 6 步；dig / place_stone 最多一个且必须放在最后；parallel 最多 3 项。动作会按顺序在角色身上执行，返回每步的真实结果。",
        parameters: {
          type: "object",
          properties: {
            speech: { type: "string", description: "执行这套动作时顺口说的一句话，可以为空" },
            decision_note: { type: "string", maxLength: 60, description: "可选：为什么这么安排（一两句判断依据）" },
            steps: { type: "array", minItems: 1, maxItems: 6, items: stepUnionSchema() },
          },
          required: ["steps"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "skill",
        description:
          "管理你自己写的经验（技能）。目录和正文分开：list 看标题+用途，read 读正文（下一轮可用），create 新建（立即启用），revise 改版，disable/enable 启停，run 执行 kind=script 的技能并拿到返回值。你不能删除。",
        parameters: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["list", "read", "create", "revise", "disable", "enable", "run"] },
            skill_id: { type: "string", description: "read/revise/disable/enable/run 时的技能 id" },
            filter: { type: "string", description: "list 的关键词过滤" },
            input: { description: "run 时传给脚本的参数（脚本里用 input 读取），任意 JSON 值" },
            skill: {
              type: "object",
              description: "create/revise 的技能内容",
              properties: {
                title: { type: "string", maxLength: 24 },
                trigger: { type: "string", maxLength: 40, description: "什么时候该用它" },
                body: { type: "string", maxLength: 600, description: "做法说明；kind=script 时写用途" },
                kind: { type: "string", enum: ["text", "script"] },
                script: { type: "string", maxLength: 3000, description: "kind=script 时执行的 JS 源码，必须调用 emit(...) 返回结果" },
                tags: { type: "array", items: { type: "string" }, maxItems: 4 },
              },
              required: ["title", "trigger"],
              additionalProperties: false,
            },
          },
          required: ["operation"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "timer",
        description: "定时任务：create 新建、list 查看、cancel 取消。到点会唤醒你提醒用户。",
        parameters: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["create", "list", "cancel"] },
            timer_id: { type: "string" },
            timer: {
              type: "object",
              properties: {
                name: { type: "string" },
                first_at: { type: "string", description: "带时区的 ISO 8601 真实时间" },
                interval_seconds: { type: ["integer", "null"] },
                total_occurrences: { type: ["integer", "null"] },
                display_message: { type: "string" },
                wake_note: { type: "string" },
              },
              required: ["name", "first_at", "display_message", "wake_note"],
              additionalProperties: false,
            },
          },
          required: ["operation"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description: "结束这一轮。目标达成用 completed；做不了用 cannot_complete；被取消用 cancelled。",
        parameters: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: ["completed", "cannot_complete", "cancelled"] },
            speech: { type: "string", description: "对用户说的最后一句话，可以为空" },
          },
          required: ["outcome"],
          additionalProperties: false,
        },
      },
    },
  ];
}

/** 给提示词用的一句话说明（tools 模式下不再需要完整 JSON 契约） */
export function toolSummary() {
  return `可用工具：run_plan(steps)、skill(operation)、timer(operation)、finish(outcome, speech)。一次动作要放在同一个 run_plan 里，不要拆成多次调用。`;
}

/** 沙箱里可以引用的道具名，供脚本文档使用 */
export const PROP_IDS = Object.keys(OBJECTS);
