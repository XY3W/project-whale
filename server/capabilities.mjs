/** 能力注册表：模型说明、Schema 与执行校验的唯一来源（D 批）。 */
import { parallelConflict } from "../shared/resources.mjs";
import { SIZE } from "./minesweeper.mjs";

export const CAPABILITY_VERSION = "cap-playful-v2-count32";

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
  {
    id: "stow_scoop",
    enabled: true,
    channels: ["item"],
    params: {
      object_id: { enum: ["rice_scoop"], note: "要挂到右腰的兵械（当前只有饭勺）" },
    },
  },
  {
    id: "unstow_scoop",
    enabled: true,
    channels: ["item"],
    params: {
      object_id: { enum: ["rice_scoop"], note: "要从右腰取回的兵械（当前只有饭勺）" },
    },
  },
  {
    id: "xiangqi_move",
    enabled: true,
    channels: ["item"],
    params: {
      game_id: { type: "string", note: "当前象棋的 gameId" },
      piece_id: { type: "string", note: "要搬的棋子稳定 id，如 red_rook_1" },
      to_row: { type: "number", min: 0, max: 9, note: "0 黑底线，9 红底线" },
      to_col: { type: "number", min: 0, max: 8, note: "0 从 -X 向 +X" },
      expected_revision: { type: "number", min: 0, note: "必须等于公开棋局的 revision" },
    },
  },
  {
    id: "place_stone",
    enabled: true,
    channels: ["item"],
    params: {
      game_id: { type: "string", note: "当前五子棋的 gameId" },
      row: { type: "number", min: 0, max: 14, note: "0 从 -Z 向 +Z" },
      col: { type: "number", min: 0, max: 14, note: "0 从 -X 向 +X" },
      expected_revision: { type: "number", min: 0, note: "必须等于公开棋盘的 revision" },
    },
  },
  { id: "parallel", enabled: true, channels: ["multi"], params: { items: { maxItems: 3, nested: false } } },
  { id: "walk_to_basin", enabled: true, changesPosition: true, channels: ["motion"], params: {} },
  {
    id: "walk_to",
    enabled: true,
    changesPosition: true,
    channels: ["motion"],
    params: {
      x: { type: "number", min: -3.7, max: 3.7, note: "目标点世界坐标 x（米）" },
      z: { type: "number", min: -3.7, max: 3.7, note: "目标点世界坐标 z（米）" },
      tolerance_m: { type: "number", min: 0.02, max: 0.5, note: "可选，到位半径，默认 0.1" },
    },
  },
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
  { id:"set_basin_grip", enabled:true, channels:["body_locomotion","left_arm","item:basin"], params:{object_id:{enum:["basin"]},grip:{enum:["inward","outward"]}} },
  { id:"knock_basin", enabled:true, channels:["body_locomotion","left_arm","right_arm","item:basin","item:rice_scoop"], params:{object_id:{enum:["basin"]},tool_id:{enum:["rice_scoop"]},count:{type:"integer",min:1,max:32},tempo:{enum:["normal"]}} },
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
  if (plan.type === "skill_tool") {
    const ops = ["list", "read", "create", "revise", "disable", "enable"];
    if (!ops.includes(plan.operation)) throw new ModelError("INVALID_SCHEMA", `技能操作无效（可用：${ops.join("/")}）`, 0);
    if (["read", "revise", "disable", "enable"].includes(plan.operation)
      && (typeof plan.skill_id !== "string" || !plan.skill_id)) {
      throw new ModelError("INVALID_SCHEMA", `${plan.operation} 需要 skill_id`, 0);
    }
    return { type: "skill_tool", operation: plan.operation, skill_id: plan.skill_id, skill: plan.skill, filter: plan.filter, expected_version: plan.expected_version, edits: plan.edits };
  }
  if (plan.type === "timer_tool") {
    if (!["create", "list", "cancel"].includes(plan.operation)) throw new ModelError("INVALID_SCHEMA", "定时器操作无效", 0);
    return {type:"timer_tool", operation:plan.operation, timer:plan.timer, timer_id:plan.timer_id};
  }
  if (plan.type === "finish_task") {
    if (!["completed", "cannot_complete", "cancelled"].includes(plan.outcome)) {
      throw new ModelError("INVALID_SCHEMA", "finish_task.outcome 非法", 0);
    }
    return {
      type: "finish_task",
      outcome: plan.outcome,
      speech: String(plan.speech ?? "").slice(0, 200),
      memoryProposals: Array.isArray(plan.memory_proposals) ? plan.memory_proposals : [],
      summaryProposal: plan.summary_proposal ?? null,
    };
  }
  if (plan.type !== "execute_plan") throw new ModelError("INVALID_SCHEMA", "type 必须是 execute_plan 或 finish_task", 0);
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length || steps.length > 6) throw new ModelError("INVALID_SCHEMA", "steps 数量必须是 1..6", 0);
  assertDigPlacement(steps);
  return {
    type: "execute_plan",
    speech: String(plan.speech ?? "").slice(0, 200),
    // 可选：一句话说明“为什么这么安排”，写技能和排查时要用
    decisionNote: typeof plan.decision_note === "string" && plan.decision_note.trim()
      ? plan.decision_note.trim().slice(0, 60)
      : null,
    plan: { steps: steps.map((s, i) => validateStep(s, `s${i + 1}`)) },
    memoryProposals: Array.isArray(plan.memory_proposals) ? plan.memory_proposals : [],
    summaryProposal: plan.summary_proposal ?? null,
  };
}

/**
 * 一次挖掘只改变一个格子的信息，所以一个计划最多一个 dig，且必须是最后一步。
 * 这条规则写在代码里，不依赖模型读提示词；违规计划整体拒绝，不派发残步。
 */
export function assertDigPlacement(steps) {
  // dig 和 place_stone 都是一次性“落地”动作：最多一个，且必须是最后一步
  for (const [action, label] of [["dig", "DIG"], ["place_stone", "STONE"], ["xiangqi_move", "XIANGQI_MOVE"]]) {
    const at = steps.map((s, i) => (s && s.action === action ? i : -1)).filter((i) => i >= 0);
    if (at.length > 1) throw new ModelError(`MULTIPLE_${label}_STEPS`, `一个计划最多一个 ${action}`, 0);
    if (at.length === 1 && at[0] !== steps.length - 1) {
      throw new ModelError(`${label}_NOT_LAST`, `${action} 必须是一个计划的最后一步`, 0);
    }
  }
  if (digInParallel(steps)) {
    throw new ModelError("DIG_IN_PARALLEL", "dig/place_stone/xiangqi_move 不能放进 parallel", 0);
  }
}

/** 需要独占且必须最后一步的动作（dig / place_stone / xiangqi_move）不能进 parallel */
const EXCLUSIVE_STEPS = new Set(["dig", "place_stone", "xiangqi_move"]);
function digInParallel(steps) {
  return steps.some(
    (s) => s && s.action === "parallel" && Array.isArray(s.items)
      && s.items.some((it) => it && EXCLUSIVE_STEPS.has(it.action)),
  );
}

export function validateStep(step, id = "step") {
  const cap = step && byId.get(step.action);
  if (!cap) throw new ModelError("INVALID_SCHEMA", `${id} 动作不在注册表`, 0);
  if (!cap.enabled) throw new ModelError("CAPABILITY_DISABLED", `${id} ${cap.id} 未启用：${cap.disabledReason}`, 0);

  switch (cap.id) {
    case "stow_scoop":
      if (step.object_id !== "rice_scoop") throw new ModelError("INVALID_SCHEMA", `${id} stow_scoop 只支持 rice_scoop`, 0);
      return { action: "stow_scoop", object_id: "rice_scoop" };
    case "unstow_scoop":
      if (step.object_id !== "rice_scoop") throw new ModelError("INVALID_SCHEMA", `${id} unstow_scoop 只支持 rice_scoop`, 0);
      return { action: "unstow_scoop", object_id: "rice_scoop" };
    case "xiangqi_move": {
      const row = step.to_row, col = step.to_col, rev = step.expected_revision;
      if (typeof step.game_id !== "string" || !step.game_id) throw new ModelError("INVALID_SCHEMA", `${id} 需要 game_id`, 0);
      if (typeof step.piece_id !== "string" || !step.piece_id) throw new ModelError("INVALID_SCHEMA", `${id} 需要 piece_id`, 0);
      if (!Number.isInteger(row) || row < 0 || row > 9) throw new ModelError("INVALID_SCHEMA", `${id} to_row 必须是 0..9 的整数`, 0);
      if (!Number.isInteger(col) || col < 0 || col > 8) throw new ModelError("INVALID_SCHEMA", `${id} to_col 必须是 0..8 的整数`, 0);
      if (!Number.isInteger(rev) || rev < 0) throw new ModelError("INVALID_SCHEMA", `${id} expected_revision 必须是非负整数`, 0);
      return { action: "xiangqi_move", game_id: step.game_id, piece_id: step.piece_id, to_row: row, to_col: col, expected_revision: rev };
    }
    case "set_basin_grip":
      if(step.object_id!=="basin"||!["inward","outward"].includes(step.grip))throw new ModelError("INVALID_SCHEMA",`${id} 持盆参数非法`,0);
      return {action:cap.id,object_id:"basin",grip:step.grip};
    case "knock_basin":
      if(step.object_id!=="basin"||step.tool_id!=="rice_scoop"||!Number.isInteger(step.count)||step.count<1||step.count>32||step.tempo!=="normal")throw new ModelError("INVALID_SCHEMA",`${id} count 必须整数1..32，tempo=normal，左盆右勺`,0);
      return {action:cap.id,object_id:"basin",tool_id:"rice_scoop",count:step.count,tempo:"normal"};
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
    case "place_stone": {
      const { row, col, expected_revision: revision } = step;
      if (!Number.isInteger(row) || row < 0 || row > 14 || !Number.isInteger(col) || col < 0 || col > 14) {
        throw new ModelError("INVALID_SCHEMA", `${id} row/col 必须是 0..14 的整数`, 0);
      }
      if (!Number.isInteger(revision) || revision < 0) {
        throw new ModelError("INVALID_SCHEMA", `${id} expected_revision 必须是非负整数`, 0);
      }
      if (typeof step.game_id !== "string" || !step.game_id) {
        throw new ModelError("INVALID_SCHEMA", `${id} game_id 缺失`, 0);
      }
      return { action: "place_stone", game_id: step.game_id, row, col, expected_revision: revision };
    }

    case "walk_to_basin":
      return { action: "walk_to_basin" };

    case "walk_to": {
      const { x, z } = step;
      if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 3.7 || Math.abs(z) > 3.7) {
        throw new ModelError("INVALID_SCHEMA", `${id} x/z 必须是 ±3.7 米内的数字`, 0);
      }
      const tol = step.tolerance_m === undefined ? 0.1 : Number(step.tolerance_m);
      if (!Number.isFinite(tol) || tol < 0.02 || tol > 0.5) {
        throw new ModelError("INVALID_SCHEMA", `${id} tolerance_m 必须在 0.02..0.5 之间`, 0);
      }
      return { action: "walk_to", x, z, tolerance_m: tol };
    }
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
      if (items.some((it) => it && EXCLUSIVE_STEPS.has(it.action))) {
        throw new ModelError("DIG_IN_PARALLEL", `${id} dig/place_stone/xiangqi_move 不能放进 parallel`, 0);
      }
      if(parallelConflict(items))throw new ModelError("CHANNEL_CONFLICT",`${id} 并行动作资源冲突`,0);
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
        if (spec.type === "number" || spec.type === "integer") {
          if (spec.min !== undefined && spec.max !== undefined) return `${name}:${spec.type} [${spec.min},${spec.max}]`;
          if (spec.min !== undefined) return `${name}:number >=${spec.min}`;
          return `${name}:number`;
        }
        return `${name}:?`;
      });
      return props.length ? `  {"action":"${c.id}", ${props.join(", ")}}` : `  {"action":"${c.id}"}`;
    })
    .join("\n");
  return [
    'execute_plan: {"type":"execute_plan","speech":"string","decision_note":"可选≤60字：为什么这么安排","steps":[Step 1..6],"memory_proposals":[{"key","value","sourceMessageId","sourceQuote"}] 可选}',
    'finish_task: {"type":"finish_task","outcome":"completed|cannot_complete|cancelled","speech":"string"}',
    'skill_tool: list/read/create/revise/disable/enable；revise 必须先 read，在 expected_version 中填写读到的版本，以 edits 数组局部修改：每项包含 field=title|trigger|body|script、operation=append|replace、text，replace 还需唯一匹配的 find。未修改的内容保留；create 使用 skill。你没有删除权限。',
    'timer_tool: {"type":"timer_tool","operation":"create","timer":{"name":"任务名","first_at":"带时区的 ISO 8601 真实时间","interval_seconds":null或整数秒,"total_occurrences":null或整数,"display_message":"提醒文字","wake_note":"到期时交给自己的提醒任务"}}；list: {"type":"timer_tool","operation":"list"}；cancel: {"type":"timer_tool","operation":"cancel","timer_id":"任务ID"}。',
    "Step 只能取以下之一：",
    steps,
    '  {"action":"parallel","items":[Step 1..3]}（不嵌套，通道不冲突）',
    "两种输出均可附memory_proposals最多2条、summary_proposal:{text,sourceMessageIds}；没有真实来源不提案。只输出一个 JSON 对象。",
  ].join("\n");
}
