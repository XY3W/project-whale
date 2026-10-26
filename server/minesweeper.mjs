/**
 * 扫雷规则核心（服务端私有）。
 *
 * 只有这里持有雷表；公开快照永远不含未揭示格的 value、邻雷数或其它可推断答案的字段。
 * 首次挖掘格安全、16×16 / 53 雷、八邻计数、零格一次展开、挖完所有非雷格获胜。
 */

export const SIZE = 16;
/**
 * 密度对齐经典扫雷「高级」（30×16 / 99 雷 ≈ 20.63%）：
 * 16×16 = 256 格，53 雷 ≈ 20.70%，取下限后最接近的一档。
 */
export const MINE_COUNT = 53;
export const SAFE_TOTAL = SIZE * SIZE - MINE_COUNT;
/** 棋盘仍占 8m × 8m 场地：16 格 → 每格 0.5m，边缘仍在 ±4m */
export const CELL_M = 0.5;
export const BOARD_HALF = (SIZE * CELL_M) / 2;

/** 小整数种子 PRNG（mulberry32），保证同一 seed 复现同一雷区 */
export function createRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const indexOf = (row, col) => row * SIZE + col;
export const cellOf = (index) => ({ row: Math.floor(index / SIZE), col: index % SIZE });
export const inBounds = (row, col) =>
  Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < SIZE && col >= 0 && col < SIZE;

export function neighbors(index) {
  const { row, col } = cellOf(index);
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = row + dr;
      const c = col + dc;
      if (inBounds(r, c)) out.push(indexOf(r, c));
    }
  }
  return out;
}

/** 雷区只在第一次挖掘提交时生成并持久化，排除本次挖掘格 */
export function placeMines(seed, safeIndex) {
  const random = createRandom(seed);
  const candidates = [];
  for (let i = 0; i < SIZE * SIZE; i++) if (i !== safeIndex) candidates.push(i);
  const mines = [];
  for (let i = 0; i < MINE_COUNT; i++) {
    const pick = Math.floor(random() * candidates.length);
    mines.push(candidates[pick]);
    candidates.splice(pick, 1);
  }
  return mines.sort((a, b) => a - b);
}

export function countAdjacentMines(mines, index) {
  const set = mines instanceof Set ? mines : new Set(mines);
  return neighbors(index).filter((n) => set.has(n)).length;
}

export function createGame({ gameId, seed }) {
  return {
    gameId,
    seed: seed >>> 0,
    mines: null, // 首次挖掘时生成
    mineSet: null,
    revealed: new Set(),
    flagged: new Set(),
    status: "playing", // playing | won | lost
    revision: 0,
    digs: 0,
    startedAt: Date.now(),
  };
}

/** 从持久化数据恢复（雷表只存在于服务端存储） */
export function restoreGame(raw) {
  if (!raw || typeof raw !== "object" || !raw.gameId) return null;
  // 棋盘尺寸变过（10×10 → 16×16）的旧存档直接用不了：索引会串格，宁可开新局
  if (raw.size !== undefined && raw.size !== SIZE) {
    console.warn(`[minesweeper] 忽略 ${raw.size}×${raw.size} 的旧存档，按 ${SIZE}×${SIZE} 重新开局`);
    return null;
  }
  if (raw.mines && Array.isArray(raw.mines) && raw.mines.some((i) => !Number.isInteger(i) || i < 0 || i >= SIZE * SIZE)) {
    console.warn("[minesweeper] 旧存档的雷索引超出当前棋盘，重新开局");
    return null;
  }
  const game = createGame({ gameId: raw.gameId, seed: raw.seed ?? 0 });
  game.mines = Array.isArray(raw.mines) ? raw.mines.map(Number) : null;
  game.mineSet = game.mines ? new Set(game.mines) : null;
  game.revealed = new Set(Array.isArray(raw.revealed) ? raw.revealed.map(Number) : []);
  game.status = ["playing", "won", "lost", "ended"].includes(raw.status) ? raw.status : "playing";
  game.revision = Number.isFinite(raw.revision) ? raw.revision : 0;
  game.digs = Number.isFinite(raw.digs) ? raw.digs : 0;
  game.startedAt = Number.isFinite(raw.startedAt) ? raw.startedAt : Date.now();
  return game;
}

/** 落盘用（含雷表，只在服务端存储里出现） */
export function serializeGame(game) {
  return {
    gameId: game.gameId,
    size: SIZE,
    mineCount: MINE_COUNT,
    seed: game.seed,
    mines: game.mines,
    revealed: [...game.revealed],
    status: game.status,
    revision: game.revision,
    digs: game.digs,
    startedAt: game.startedAt,
  };
}

/**
 * 公开棋盘：未揭示格只有 {row,col,state:'hidden'}，不给 value、邻雷数或概率。
 */
export function publicBoard(game) {
  const cells = [];
  for (let index = 0; index < SIZE * SIZE; index++) {
    const { row, col } = cellOf(index);
    if (game.revealed.has(index)) {
      const mine = game.mineSet ? game.mineSet.has(index) : false;
      cells.push({ row, col, state: "revealed", value: mine ? "mine" : countAdjacentMines(game.mineSet ?? [], index) });
    } else {
      cells.push({ row, col, state: "hidden" });
    }
  }
  const revealedSafe = game.revealed.size - (game.mineSet ? [...game.revealed].filter((i) => game.mineSet.has(i)).length : 0);
  return {
    gameId: game.gameId,
    revision: game.revision,
    status: game.status,
    size: SIZE,
    cellSize: CELL_M,
    boardHalf: BOARD_HALF,
    mineCount: MINE_COUNT,
    cells,
    revealedSafe,
    remainingSafe: Math.max(0, SAFE_TOTAL - revealedSafe),
    ...(game.status === "lost" && game.mineSet ? { mines: game.mines } : {}),
  };
}

/** 零格展开：同一 revision 下的一次原子揭示 */
function floodReveal(game, start) {
  const changed = [];
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    const index = queue.shift();
    if (game.revealed.has(index)) continue;
    game.revealed.add(index);
    const { row, col } = cellOf(index);
    const value = countAdjacentMines(game.mineSet, index);
    changed.push({ row, col, state: "revealed", value });
    if (value !== 0) continue;
    for (const n of neighbors(index)) {
      if (seen.has(n) || game.revealed.has(n)) continue;
      if (game.mineSet.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return changed;
}

/**
 * 挖掘结算。返回 { ok, reason?, changedCells, status, revision, firstDig }。
 * 重复挖同一格不扣次数、不增加 revision。
 */
export function dig(game, row, col) {
  if (!inBounds(row, col)) return { ok: false, reason: "OUT_OF_BOUNDS" };
  if (game.status !== "playing") return { ok: false, reason: "GAME_OVER" };
  const index = indexOf(row, col);
  if (game.revealed.has(index)) return { ok: false, reason: "ALREADY_REVEALED" };

  const firstDig = game.mines === null;
  if (firstDig) {
    game.mines = placeMines(game.seed, index);
    game.mineSet = new Set(game.mines);
  }

  game.digs++;
  game.revision++;

  if (game.mineSet.has(index)) {
    game.revealed.add(index);
    game.status = "lost";
    return {
      ok: true,
      firstDig,
      status: game.status,
      revision: game.revision,
      changedCells: [{ row, col, state: "revealed", value: "mine" }],
    };
  }

  const changedCells = floodReveal(game, index);
  const revealedSafe = [...game.revealed].filter((i) => !game.mineSet.has(i)).length;
  if (revealedSafe >= SAFE_TOTAL) game.status = "won";
  return { ok: true, firstDig, status: game.status, revision: game.revision, changedCells };
}

/** 用户主动结束：揭开雷区给个交代，状态记为 ended，之后不能再挖 */
export function endGame(game) {
  if (!game || game.status !== "playing") return { ok: false, reason: "GAME_OVER" };
  game.status = "ended";
  game.revision += 1;
  if (game.mineSet) for (const index of game.mineSet) game.revealed.add(index);
  return { ok: true, status: game.status, revision: game.revision };
}

/** 角色根位置 → 棋盘格子（半开区间；+4 不属于棋盘） */
export function cellAt(x, z) {
  const half = BOARD_HALF;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (x < -half || x >= half || z < -half || z >= half) return null;
  const col = Math.floor((x + half) / CELL_M);
  const row = Math.floor((z + half) / CELL_M);
  return inBounds(row, col) ? { row, col } : null;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;
export const cellCenter = (row, col) => ({
  x: round6(-BOARD_HALF + (col + 0.5) * CELL_M),
  z: round6(-BOARD_HALF + (row + 0.5) * CELL_M),
});
