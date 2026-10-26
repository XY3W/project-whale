/** 能力注册表：模型说明、Schema 与执行校验的唯一来源（D 批）。 */
import { SIZE } from "./minesweeper.mjs";

export const CAPABILITY_VERSION = "cap-v1";

const DISTANCES = [0.09, 0.27, 0.45, 0.63, 0.81, 0.99, 1.17, 1.35, 1.53, 1.71, 1.89];
const PLAYS = ["greet", "notice", "nod", "look_left", "look_right", "think"];
const TAILS = ["tail_idle", "tail_swish"];

/**
 * 双手物品注册表：工具参数 object_id 与物品槽位的唯一来源。
 * 盆在左手或头顶；饭勺只能在右手，不能佩戴。
 */
export const OBJECTS = {
  basin: { type: "basin", slots: ["left_hand", "head"], pickup: true, throw: true, wear: true },
  rice_scoop: { type: "scoop", slots: ["right_hand"], pickup: true, throw: true, wear: false },
};
export const HAND_OBJECTS = Object.keys(OBJECTS).filter((id) => OBJECTS[id].pickup);
export const WEARABLE_OBJECTS = Object.keys(OBJECTS).filter((id) => OBJECTS[id].wear);

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
  { id: "run", enabled: true, changesPosition: true, channels: ["motion"], params: { distance_m: { type: "number", enum: [0.464, 0.784, 1.104, 1.424, 1.744, 2.064, 2.384, 2.704, 3.024, 3.344, 3.664] } } },
  { id: "walk_adjust", enabled: true, changesPosition: true, channels: ["motion"], params: { distance_m: { type: "number", enum: [0.02, 0.04, 0.06, 0.08] } } },
  {
    id: "dig",
    enabled: true,
    channels: ["item"],
    params: {
      game_id: { type: "string", note: "当前公开棋盘的 gameId" },
      row: { type: "number", min: 0, max: SIZE - 1, note: "0 从 -Z 向 +Z" },
      col: { type: "number", min: 0, max: SIZE - 1, note: "0 从 -X 向 +X" },
      expected_revision: { type: "number", min: 0, note: "必须等于公开棋盘 revision" },
    },
  },
  { id: "parallel", enabled: true, channels: ["multi"], params: { items: { maxItems: 3, nested: false } } },
  { id: "walk_to_basin", enabled: true, changesPosition: true, channels: ["motion"], params: {} },
  { id: "pickup", enabled: true, channels: ["item"], params: { object_id: { enum: HAND_OBJECTS, note: "盆→左手，饭勺→右手" } } },
  { id: "wear", enabled: true, channels: ["item"], params: { object_id: { enum: WEARABLE_OBJECTS, note: "只有盆能戴" } } },
  { id: "unwear", enabled: true, channels: ["item"], params: { object_id: { enum: WEARABLE_OBJECTS } } },
  {
    id: "throw",
    enabled: true,
    channels: ["item"],
    params: {
      object_id: { enum: HAND_OBJECTS },
      yaw_deg: { type: "number", min: -180, max: 180, note: "相对角色朝向，正=左" },
      elevation_deg: { type: "number", min: 0, max: 45 },
      speed_mps: { type: "number", min: 1, max: 6 },
    },
  },
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
  assertDigPlacement(steps);
  return {
    type: "execute_plan",
    speech: String(plan.speech ?? "").slice(0, 200),
    plan: { steps: steps.map((s, i) => validateStep(s, `s${i + 1}`)) },
    memoryProposals: Array.isArray(plan.memory_proposals) ? plan.memory_proposals : [],
  };
}

/**
 * 一次挖掘只改变一个格子的信息，所以一个计划最多一个 dig，且必须是最后一步。
 * 这条规则写在代码里，不依赖模型读提示词；违规计划整体拒绝，不派发残步。
 */
export function assertDigPlacement(steps) {
  const digAt = steps.map((s, i) => (s && s.action === "dig" ? i : -1)).filter((i) => i >= 0);
  if (digInParallel(steps)) {
    throw new ModelError("DIG_IN_PARALLEL", "dig 不能放进 parallel", 0);
  }
  if (digAt.length > 1) {
    throw new ModelError("MULTIPLE_DIG_STEPS", "一个计划最多一个 dig", 0);
  }
  if (digAt.length === 1 && digAt[0] !== steps.length - 1) {
    throw new ModelError("DIG_NOT_LAST", "dig 必须是一个计划的最后一步", 0);
  }
}

function digInParallel(steps) {
  return steps.some(
    (s) => s && s.action === "parallel" && Array.isArray(s.items) && s.items.some((it) => it && it.action === "dig"),
  );
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
    case "run": {
      const dist = step.distance_m;
      const ok = typeof dist === "number" && Number.isFinite(dist) && Math.abs((dist - 0.144) / 0.32 - Math.round((dist - 0.144) / 0.32)) < 1e-9;
      if (!ok || (dist - 0.144) / 0.32 < 1 || (dist - 0.144) / 0.32 > 11) {
        throw new ModelError("UNSUPPORTED_DISTANCE", `${id} run 只支持 0.144+0.32N（N=1..11）`, 0);
      }
      return { action: "run", distance_m: dist };
    }
    case "walk_adjust": {
      if (![0.02, 0.04, 0.06, 0.08].includes(step.distance_m)) {
        throw new ModelError("UNSUPPORTED_DISTANCE", `${id} walk_adjust 只支持 0.02/0.04/0.06/0.08`, 0);
      }
      return { action: "walk_adjust", distance_m: step.distance_m };
    }
    case "dig": {
      const { row, col, expected_revision: revision } = step;
      if (!Number.isInteger(row) || row < 0 || row >= SIZE || !Number.isInteger(col) || col < 0 || col >= SIZE) {
        throw new ModelError("INVALID_SCHEMA", `${id} row/col 必须是 0..${SIZE - 1} 的整数`, 0);
      }
      if (!Number.isInteger(revision) || revision < 0) {
        throw new ModelError("INVALID_SCHEMA", `${id} expected_revision 必须是非负整数`, 0);
      }
      if (typeof step.game_id !== "string" || !step.game_id) {
        throw new ModelError("INVALID_SCHEMA", `${id} game_id 缺失`, 0);
      }
      return { action: "dig", game_id: step.game_id, row, col, expected_revision: revision };
    }
    case "walk_to_basin":
      return { action: "walk_to_basin" };
    case "pickup":
    case "wear":
    case "unwear": {
      const allowed = cap.id === "pickup" ? HAND_OBJECTS : WEARABLE_OBJECTS;
      if (!allowed.includes(step.object_id)) {
        throw new ModelError("OBJECT_NOT_FOUND", `${id} ${cap.id} 只支持 ${allowed.join(" / ")}`, 0);
      }
      return { action: cap.id, object_id: step.object_id };
    }
    case "throw": {
      if (!HAND_OBJECTS.includes(step.object_id)) {
        throw new ModelError("OBJECT_NOT_FOUND", `${id} throw 只支持 ${HAND_OBJECTS.join(" / ")}`, 0);
      }
      const num = (value, min, max, name) => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
          throw new ModelError("INVALID_SCHEMA", `${id} ${name} 必须是 [${min},${max}] 的数字`, 0);
        }
        return value;
      };
      return {
        action: "throw",
        object_id: step.object_id,
        yaw_deg: num(step.yaw_deg, -180, 180, "yaw_deg"),
        elevation_deg: num(step.elevation_deg, 0, 45, "elevation_deg"),
        speed_mps: num(step.speed_mps, 1, 6, "speed_mps"),
      };
    }
    case "parallel": {
      const items = Array.isArray(step.items) ? step.items : [];
      if (!items.length || items.length > 3) throw new ModelError("INVALID_SCHEMA", `${id} items 数量必须是 1..3`, 0);
      if (items.some((it) => it && it.action === "parallel")) throw new ModelError("INVALID_SCHEMA", `${id} 不允许嵌套 parallel`, 0);
      if (items.some((it) => it && it.action === "dig")) throw new ModelError("DIG_IN_PARALLEL", `${id} dig 不能放进 parallel`, 0);
      return { action: "parallel", items: items.map((it, j) => validateStep(it, `${id}.${j + 1}`)) };
    }
  }
  throw new ModelError("INVALID_SCHEMA", `${id} 无法识别`, 0);
}

/** 由注册表生成输出契约文本，避免手写动作清单与注册表漂移 */
export function outputContract() {
  const steps = CAPABILITIES.filter((c) => c.enabled && c.id !== "parallel")
    .map((c) => {
      const props = Object.entries(c.params).map(([name, spec]) => {
        if (spec.enum) return `${name}:${JSON.stringify(spec.enum)}`;
        if (spec.type === "number") {
          if (spec.min !== undefined && spec.max !== undefined) return `${name}:number [${spec.min},${spec.max}]`;
          if (spec.min !== undefined) return `${name}:number >=${spec.min}`;
          return `${name}:number`;
        }
        return `${name}:?`;
      });
      return props.length ? `  {"action":"${c.id}", ${props.join(", ")}}` : `  {"action":"${c.id}"}`;
    })
    .join("\n");
  return [
    'execute_plan: {"type":"execute_plan","speech":"string","steps":[Step 1..6],"memory_proposals":[{"key","value","source_quote"}] 可选}',
    'finish_task: {"type":"finish_task","outcome":"completed|cannot_complete|cancelled","speech":"string"}',
    "Step 只能取以下之一：",
    steps,
    '  {"action":"parallel","items":[Step 1..3]}（不嵌套，通道不冲突）',
    "只输出一个 JSON 对象。",
  ].join("\n");
}
