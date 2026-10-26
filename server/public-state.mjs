/**
 * 公开世界快照：物品注册表 + 只含公开字段的模型上下文。
 *
 * 这里产出的对象会原样进入提示词、客户端消息和日志，所以：
 * - 不含雷表、种子、未揭示格的 value；
 * - 不含 API Key、服务端私有路径或内部执行器字段。
 */
import { OBJECTS } from "./capabilities.mjs";
import { SIZE, cellAt, cellCenter } from "./minesweeper.mjs";

/** 只有这三种状态会落盘：飞行和转移中要么回到稳定态，要么按 unknown 处理 */
export const PERSISTED_PROP_STATES = new Set(["resting", "held", "worn"]);

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
  // 旧存档：transferring/flying 不在稳定态集合里，退回上一份稳定快照，没有就按落地处理
  if (!PERSISTED_PROP_STATES.has(state)) {
    if (previous && PERSISTED_PROP_STATES.has(previous.state)) {
      return { ...previous, updatedAt: Date.now() };
    }
    state = "resting";
  }
  // 饭勺不能戴在头上：旧数据写错了就降级成手持
  if (state === "worn" && !def.wear) state = "held";
  let holder = raw.holder ?? raw.slot ?? null;
  if (holder === "hand") holder = DEFAULT_SLOT[objectId] ?? def.slots[0];
  if (state === "resting") holder = null;
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
      position: [round3(prop.position[0]), round3(prop.position[2])],
      upright: prop.upright,
      ...(prop.pickupStand ? { pickupStand: prop.pickupStand } : {}),
      ...(prop.variant ? { pickupVariant: prop.variant } : {}),
      actions: [
        ...(OBJECTS[prop.object_id]?.pickup ? ["pickup"] : []),
        ...(OBJECTS[prop.object_id]?.throw ? ["throw"] : []),
        ...(OBJECTS[prop.object_id]?.wear ? ["wear", "unwear"] : []),
      ],
    })),
  };
}

/**
 * 公开棋盘：未揭示格只有 row/col/state，没有 value、邻雷数或概率。
 * 已结束的对局附上雷表（失败后允许公开），但模型上下文不使用该字段。
 */
export function boardContext(board, character = null) {
  if (!board) return null;
  const cells = board.cells.map((cell) =>
    cell.state === "revealed" ? { row: cell.row, col: cell.col, state: cell.state, value: cell.value } : { row: cell.row, col: cell.col, state: "hidden" },
  );
  const current = character && Number.isFinite(character.x) && Number.isFinite(character.z) ? cellAt(character.x, character.z) : null;
  return {
    gameId: board.gameId,
    revision: board.revision,
    status: board.status,
    size: board.size,
    mineCount: board.mineCount,
    cellSizeM: 0.8,
    boardHalf: 4,
    revealedSafe: board.revealedSafe,
    remainingSafe: board.remainingSafe,
    currentCell: current,
    currentCellCenter: current ? cellCenter(current.row, current.col) : null,
    coordinateRule: "row 从 -Z 向 +Z、col 从 -X 向 +X；格心 x=-4+(col+0.5)*0.8，z=-4+(row+0.5)*0.8；|x| 或 |z| ≥4 不属于棋盘",
    cells,
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
  };
}

export function round3(v) {
  return Math.round((Number(v) || 0) * 1000) / 1000;
}
function round4(v) {
  return Math.round((Number(v) || 0) * 10000) / 10000;
}

export { SIZE };
