/** 能力注册表：模型说明、Schema 与执行校验的唯一来源（D 批）。 */

export const CAPABILITY_VERSION = "cap-v1";

const DISTANCES = [0.09, 0.27, 0.45, 0.63, 0.81, 0.99, 1.17, 1.35, 1.53, 1.71, 1.89];
const PLAYS = ["greet", "notice", "nod", "look_left", "look_right"];
const TAILS = ["tail_idle", "tail_swish"];

export class ModelError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const CAPABILITIES = [
  { id: "turn", enabled: true, changesPosition: false, channels: ["motion"], params: { angle_deg: { type: "number", min: -180, max: 180, note: "正=左转" } } },
  { id: "walk", enabled: true, changesPosition: true, channels: ["motion"], params: { distance_m: { type: "number", enum: DISTANCES, note: "仅支持 0.09+0.18n" } } },
  { id: "play", enabled: true, channels: ["upper"], params: { action_id: { enum: PLAYS } } },
  { id: "tail", enabled: true, channels: ["tail"], params: { style: { enum: TAILS }, duration_s: { type: "number", min: 0, max: 10 } } },
  { id: "wait", enabled: true, channels: [], params: { duration_s: { type: "number", min: 0, max: 5 } } },
  { id: "parallel", enabled: true, channels: ["multi"], params: { items: { maxItems: 3, nested: false } } },
  { id: "pickup", enabled: false, disabledReason: "钢盆资产与拾取动画未接入" },
  { id: "wear", enabled: false, disabledReason: "戴帽动作与呆毛修正未接入" },
  { id: "unwear", enabled: false, disabledReason: "取下动作未接入" },
  { id: "throw", enabled: false, disabledReason: "物理沙盒未验收" },
  { id: "run", enabled: false, disabledReason: "没有跑步片段" },
  { id: "sit", enabled: false, disabledReason: "没有坐下片段" },
];

/** 禁用能力清单：给模型解释为什么不能做，但不注册成可执行工具 */
export function describeDisabled() {
  return CAPABILITIES.filter((c) => !c.enabled).map((c) => ({ id: c.id, reason: c.disabledReason }));
}

/** 模型可见清单：只含 enabled，且参数说明来自同一注册表 */
export function describeCapabilities() {
  return CAPABILITIES.filter((c) => c.enabled).map((c) => ({
    id: c.id,
    changesPosition: c.changesPosition,
    channels: c.channels,
    params: c.params,
  }));
}

const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function validatePlan(plan) {
  if (!plan || typeof plan !== "object") throw new ModelError("INVALID_SCHEMA", "输出不是对象", 0);
  if (plan.type === "finish_task") {
    if (!["completed", "cannot_complete", "cancelled"].includes(plan.outcome)) {
      throw new ModelError("INVALID_SCHEMA", "finish_task.outcome 非法", 0);
    }
    return {
      type: "finish_task",
      outcome: plan.outcome,
      speech: String(plan.speech ?? "").slice(0, 200),
      memoryProposals: Array.isArray(plan.memory_proposals) ? plan.memory_proposals : [],
    };
  }
  if (plan.type !== "execute_plan") throw new ModelError("INVALID_SCHEMA", "type 必须是 execute_plan 或 finish_task", 0);
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length || steps.length > 6) throw new ModelError("INVALID_SCHEMA", "steps 数量必须是 1..6", 0);
  return {
    type: "execute_plan",
    speech: String(plan.speech ?? "").slice(0, 200),
    plan: { steps: steps.map((s, i) => validateStep(s, `s${i + 1}`)) },
    memoryProposals: Array.isArray(plan.memory_proposals) ? plan.memory_proposals : [],
  };
}

export function validateStep(step, id = "step") {
  const cap = step && byId.get(step.action);
  if (!cap) throw new ModelError("INVALID_SCHEMA", `${id} 动作不在注册表`, 0);
  if (!cap.enabled) throw new ModelError("CAPABILITY_DISABLED", `${id} ${cap.id} 未启用：${cap.disabledReason}`, 0);

  switch (cap.id) {
    case "turn": {
      if (typeof step.angle_deg !== "number" || !Number.isFinite(step.angle_deg) || Math.abs(step.angle_deg) > 180) {
        throw new ModelError("INVALID_SCHEMA", `${id} angle_deg 必须是 [-180,180] 的数字`, 0);
      }
      return { action: "turn", angle_deg: step.angle_deg };
    }
    case "walk": {
      const dist = step.distance_m;
      const exact = typeof dist === "number" && DISTANCES.some((d) => Math.abs(d - dist) < 1e-9);
      if (!exact) {
        throw new ModelError("UNSUPPORTED_DISTANCE", `${id} 距离 ${step.distance_m} 不支持，可用 0.09+0.18n`, 0);
      }
      return { action: "walk", distance_m: dist };
    }
    case "play": {
      if (!PLAYS.includes(step.action_id)) throw new ModelError("INVALID_SCHEMA", `${id} action_id 非法`, 0);
      return { action: "play", action_id: step.action_id };
    }
    case "tail": {
      if (!TAILS.includes(step.style)) throw new ModelError("INVALID_SCHEMA", `${id} style 非法`, 0);
      if (typeof step.duration_s !== "number" || step.duration_s < 0 || step.duration_s > 10) {
        throw new ModelError("INVALID_SCHEMA", `${id} duration_s 越界`, 0);
      }
      return { action: "tail", style: step.style, duration_s: step.duration_s };
    }
    case "wait": {
      if (typeof step.duration_s !== "number" || step.duration_s < 0 || step.duration_s > 5) {
        throw new ModelError("INVALID_SCHEMA", `${id} duration_s 越界`, 0);
      }
      return { action: "wait", duration_s: step.duration_s };
    }
    case "parallel": {
      const items = Array.isArray(step.items) ? step.items : [];
      if (!items.length || items.length > 3) throw new ModelError("INVALID_SCHEMA", `${id} items 数量必须是 1..3`, 0);
      if (items.some((it) => it && it.action === "parallel")) throw new ModelError("INVALID_SCHEMA", `${id} 不允许嵌套 parallel`, 0);
      return { action: "parallel", items: items.map((it, j) => validateStep(it, `${id}.${j + 1}`)) };
    }
  }
  throw new ModelError("INVALID_SCHEMA", `${id} 无法识别`, 0);
}
