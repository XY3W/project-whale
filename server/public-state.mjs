/**
 * 公开世界快照：物品注册表 + 只含公开字段的模型上下文。
 *
 * 这里产出的对象会原样进入提示词、客户端消息和日志，所以：
 * - 不含雷表、种子、未揭示格的 value；
 * - 不含 API Key、服务端私有路径或内部执行器字段。
 */
import {digAim} from "../shared/dig-aim.mjs";
import { OBJECTS } from "./capabilities.mjs";
import { DIG_TOLERANCE_M, SIZE, cellAt, cellCenter } from "./minesweeper.mjs";

/** 只有这三种状态会落盘：飞行和转移中要么回到稳定态，要么按 unknown 处理 */
export const PERSISTED_PROP_STATES = new Set(["resting", "held", "worn", "flying", "transferring", "reserved", "unknown"]);

const DEFAULT_SLOT = { basin: "left_hand", rice_scoop: "right_hand" };

export const propIdOf = (raw) => (typeof raw === "string" ? raw : raw?.object_id ?? raw?.id ?? null);

/**
 * 物品快照清洗与旧存档迁移。
 * 旧版只有盆且 holder 用 "hand"/"head"；hand 取决于物品：盆→左手，饭勺→右手。
 */
export function sanitizeProp(raw, previous = null) {
  const objectId = propIdOf(raw);
  const def = OBJECTS[objectId];
  if (!def) return null;
  if (!raw || typeof raw !== "object") return null;
  const pos = Array.isArray(raw.position) && raw.position.length === 3 && raw.position.every(Number.isFinite)
    ? raw.position.map(Number)
    : null;
  if (!pos) return null;
  const quat = Array.isArray(raw.quaternion) && raw.quaternion.length === 4 && raw.quaternion.every(Number.isFinite)
    ? raw.quaternion.map(Number)
    : null;
  let state = typeof raw.state === "string" ? raw.state : "resting";
  const checkpoint=["resting","held","worn"].includes(previous?.state)?previous:previous?.checkpoint??null;
  if(!PERSISTED_PROP_STATES.has(state))state="unknown";
  // 饭勺不能戴在头上：旧数据写错了就降级成手持
  if (state === "worn" && !def.wear) state = "held";
  let holder = raw.holder ?? raw.slot ?? null;
  if (holder === "hand") holder = DEFAULT_SLOT[objectId] ?? def.slots[0];
  if (!["held","worn"].includes(state)) holder = null;
  else if (state === "worn") holder = "head";
  else if (!def.slots.includes(holder)) holder = DEFAULT_SLOT[objectId] ?? def.slots[0];
  const stand = raw.pickupStand && typeof raw.pickupStand === "object"
    && Number.isFinite(raw.pickupStand.x) && Number.isFinite(raw.pickupStand.z)
    ? { x: round3(raw.pickupStand.x), z: round3(raw.pickupStand.z), yawDeg: round3(raw.pickupStand.yawDeg) }
    : null;
  return {
    object_id: objectId,
    type: def.type,
    state,
    checkpoint,
    grip:objectId==="basin"&&state==="held"?(raw.grip==="outward"?"outward":"inward"):null,
    position: pos,
    quaternion: quat,
    upright: raw.upright === true,
    variant: typeof raw.variant === "string" ? raw.variant : null,
    holder,
    revision: Number.isFinite(raw.revision) ? raw.revision : 0,
    ...(stand ? { pickupStand: stand } : {}),
    updatedAt: Date.now(),
  };
}

/** 双手槽位：由物品状态推出，不信任单独的 slots 字段 */
export function slotsOf(props) {
  const slots = { left_hand: null, right_hand: null, head: null };
  for (const prop of props.values()) {
    if (prop.state === "held" && prop.holder in slots && !slots[prop.holder]) slots[prop.holder] = prop.object_id;
    if (prop.state === "worn" && !slots.head) slots.head = prop.object_id;
  }
  return slots;
}

/** 模型看到的物品清单：位置、状态、holder、可用动作 */
export function propsContext(props, slots = slotsOf(props)) {
  return {
    slots: { ...slots },
    objects: [...props.values()].map((prop) => ({
      object_id: prop.object_id,
      type: prop.type,
      state: prop.state,
      holder: prop.holder,
      grip:prop.grip??null,
      position: [round3(prop.position[0]), round3(prop.position[2])],
      upright: prop.upright,
      ...(prop.pickupStand ? { pickupStand: prop.pickupStand } : {}),
      ...(prop.variant ? { pickupVariant: prop.variant } : {}),
      availability:{
        pickup:{enabled:prop.state==='resting',reason:prop.state==='resting'?'requires_nearby_alignment':'not_on_ground'},
        throw:{enabled:prop.state==='held'&&(prop.object_id!=='basin'||prop.grip!=='outward'),reason:prop.state!=='held'?'not_held':prop.grip==='outward'?'requires_explicit_inward_grip':null},
        ...(prop.object_id==='basin'?{
          set_basin_grip:{enabled:prop.state==='held',reason:prop.state==='held'?null:'requires_left_hand'},
          knock_basin:{enabled:prop.state==='held'&&prop.grip==='outward'&&slots.right_hand==='rice_scoop',reason:'requires_stationary_left_basin_outward_and_right_scoop'},
        }:{}),
      },
      actions: [
        ...(OBJECTS[prop.object_id]?.pickup ? ["pickup"] : []),
        ...(OBJECTS[prop.object_id]?.throw ? ["throw"] : []),
        ...(OBJECTS[prop.object_id]?.wear ? ["wear", "unwear", "set_basin_grip", "knock_basin"] : []),
      ],
    })),
  };
}

/**
 * 公开棋盘：给模型的是一张 16×16 的字符网格，而不是 256 条 JSON 记录。
 * 未揭示格一律是 "."，不携带 value、邻雷数或概率；雷表、种子永远不出现。
 */
export function boardContext(board, character = null) {
  if (!board) return null;
  const size = board.size;
  const cellSize = board.cellSize ?? 0.5;
  const half = board.boardHalf ?? (size * cellSize) / 2;
  const rows = [];
  for (let r = 0; r < size; r++) {
    let line = "";
    for (let c = 0; c < size; c++) {
      const cell = board.cells[r * size + c];
      if (!cell || cell.state !== "revealed") line += ".";
      else if (cell.value === "mine") line += "*";
      else line += String(cell.value);
    }
    rows.push(line);
  }
  const current = character && Number.isFinite(character.x) && Number.isFinite(character.z) ? cellAt(character.x, character.z) : null;
  const currentCenter = current ? cellCenter(current.row, current.col) : null;
  const currentOffset = currentCenter && character
    ? Math.round(Math.hypot(character.x - currentCenter.x, character.z - currentCenter.z) * 1000) / 1000
    : null;
  return {
    gameId: board.gameId,
    revision: board.revision,
    status: board.status,
    size,
    mineCount: board.mineCount,
    cellSizeM: cellSize,
    boardHalf: half,
    revealedSafe: board.revealedSafe,
    remainingSafe: board.remainingSafe,
    currentCell: current,
    currentCellCenter: currentCenter,
    /** 当前离所在格格心还有多远；挖掘要求 ≤ digToleranceM */
    currentCellDistanceM: currentOffset,
    digToleranceM: DIG_TOLERANCE_M,
    digRule: `dig 要求根位置距目标格格心 ≤ ${DIG_TOLERANCE_M}m；currentCell 只表示“你在这格里”，不代表够近，用 currentCellCenter 算还差多少`,
    coordinateRule: `row 从 -Z 向 +Z、col 从 -X 向 +X；每格 ${cellSize}m，格心 x=${-half}+(col+0.5)*${cellSize}，z=${-half}+(row+0.5)*${cellSize}；|x| 或 |z| ≥${half} 不属于棋盘`,
    legend: "rows[row][col]：. = 未揭示（未知）；0-9 = 已揭示格的邻雷数；* = 已引爆的雷",
    rows,
  };
}

/** 角色朝向与当前格，模型用它算转向和站位 */
export function characterContext(character) {
  const yawRad = ((character?.yawDeg ?? 0) * Math.PI) / 180;
  const cell = character && Number.isFinite(character.x) ? cellAt(character.x, character.z) : null;
  return {
    position: { x: round3(character?.x ?? 0), z: round3(character?.z ?? 0) },
    yawDeg: round3(character?.yawDeg ?? 0),
    forward: { x: round4(Math.sin(yawRad)), z: round4(Math.cos(yawRad)) },
    currentCell: cell,
    digAim:digAim({x:character?.x??0,z:character?.z??0,yawDeg:character?.yawDeg??0}),
  };
}

export function round3(v) {
  return Math.round((Number(v) || 0) * 1000) / 1000;
}
function round4(v) {
  return Math.round((Number(v) || 0) * 10000) / 10000;
}

export { SIZE };

/**
 * 执行报告瘦身：客户端可能上报整张棋盘（旧页面、或服务端回包原样转发），
 * 而棋盘本来就单独在上下文里。这里统一剥掉 board，并把过长的 changedCells
 * 压成数量，保证上下文大小与客户端版本无关。
 */
export function trimExecutionReport(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.steps)) return result;
  return {
    ...result,
    steps: result.steps.map((step) => {
      if (!step || typeof step !== "object" || !step.actual || typeof step.actual !== "object") return step;
      const { board: _board, changedCells: _cells, ...rest } = step.actual;
      void _board;
      const changed = Array.isArray(_cells) ? _cells : [];
      return {
        ...step,
        actual: {
          ...rest,
          ...(changed.length ? { changedCount: changed.length } : {}),
          ...(changed.length && changed.length <= 16 ? { changedCells: changed } : {}),
        },
      };
    }),
  };
}
