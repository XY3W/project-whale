/**
 * 五子棋规则核心（纯函数，不碰 IO）。
 *
 * 15×15，自由规则：横竖斜任意方向连成 5 子（含 5 子以上）即胜，不设禁手。
 * 黑先白后；board 用一维数组存 "black" | "white" | null，索引 = row * SIZE + col。
 */

export const SIZE = 15;
export const WIN_LENGTH = 5;
export const CELLS = SIZE * SIZE;
/** 棋盘仍铺满 8m×8m 场地：15 格 → 每格 0.5333m，交点在 ±4m 之间 */
export const CELL_M = 8 / SIZE;
export { SIZE as GOMOKU_SIZE, CELL_M as GOMOKU_CELL_M };

/** 棋盘半宽（交点四周留半格，外框在 ±4） */
export const BOARD_HALF = (CELL_M * SIZE) / 2;
/** 落子站位容差：根位置到交点。格子 0.533m，0.2m 仍在格内且看起来是“站在点旁” */
export const STONE_TOLERANCE_M = 0.2;
/** 世界坐标 → 交点位置 */
export const cellCenter = (row, col) => ({
  x: -BOARD_HALF + (col + 0.5) * CELL_M,
  z: -BOARD_HALF + (row + 0.5) * CELL_M,
});

export const BLACK = "black";
export const WHITE = "white";
export const other = (color) => (color === BLACK ? WHITE : BLACK);
export const isColor = (v) => v === BLACK || v === WHITE;

const inBounds = (row, col) =>
  Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < SIZE && col >= 0 && col < SIZE;

export const indexOf = (row, col) => row * SIZE + col;
export const cellOf = (index) => ({ row: Math.floor(index / SIZE), col: index % SIZE });

/** 四个方向：横、竖、两条斜线 */
const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

export function createGame({ gameId, startedAt = Date.now() } = {}) {
  return {
    // 加随机后缀：同一毫秒内连开两局也不会撞 id
    gameId: gameId ?? `gm${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    size: SIZE,
    board: Array(CELLS).fill(null),
    moves: [], // { row, col, color, revision }
    turn: BLACK,
    status: "playing", // playing | won | draw | ended
    winner: null,
    line: null, // 获胜的五个点，用来在盘面上高亮
    revision: 0,
    lastMove: null,
    startedAt,
  };
}

/**
 * 从刚落下的一子检查是否连成 5。返回连成的点（至少 5 个）或 null。
 * 只沿着这一子所在的四条线数，不需要扫全盘。
 */
export function winningLine(board, row, col, color) {
  if (!isColor(color) || !inBounds(row, col)) return null;
  // 起点必须是这个颜色：否则会把“空格 + 四连”误判成五连
  if (board[indexOf(row, col)] !== color) return null;
  for (const [dr, dc] of DIRECTIONS) {
    const line = [{ row, col }];
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (inBounds(r, c) && board[indexOf(r, c)] === color) {
        line.push({ row: r, col: c });
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= WIN_LENGTH) {
      // 排序成从一端到另一端，方便前端按顺序画高亮
      line.sort((a, b) => a.row - b.row || a.col - b.col);
      return line;
    }
  }
  return null;
}

/**
 * 落子。默认落在当前回合的一方；也可以指定 color（仅测试/回放用，会校验是不是该它走）。
 * 返回 { ok, reason?, game? }，调用方拿到的是原地修改后的 game。
 */
export function place(game, row, col, color = game.turn) {
  if (!game || game.status !== "playing") return { ok: false, reason: "GAME_OVER" };
  if (!inBounds(row, col)) return { ok: false, reason: "OUT_OF_BOUNDS" };
  if (!isColor(color)) return { ok: false, reason: "BAD_COLOR" };
  if (color !== game.turn) return { ok: false, reason: "NOT_YOUR_TURN", turn: game.turn };
  const index = indexOf(row, col);
  if (game.board[index] !== null) return { ok: false, reason: "OCCUPIED" };

  game.board[index] = color;
  game.revision += 1;
  const move = { row, col, color, revision: game.revision };
  game.moves.push(move);
  game.lastMove = move;

  const line = winningLine(game.board, row, col, color);
  if (line) {
    game.status = "won";
    game.winner = color;
    game.line = line;
    return { ok: true, move, status: game.status, winner: color, line };
  }
  if (game.moves.length >= CELLS) {
    game.status = "draw";
    return { ok: true, move, status: game.status, winner: null };
  }
  game.turn = other(color);
  return { ok: true, move, status: game.status, turn: game.turn };
}

/** 用户主动结束/收起：状态记为 ended，不能再落子 */
export function endGame(game) {
  if (!game) return { ok: false, reason: "NO_GAME" };
  if (game.status === "playing") {
    game.status = "ended";
    game.revision += 1;
  }
  return { ok: true, status: game.status };
}

/** 公开视图：只含已落子的点，空格不占体积 */
export function publicGame(game) {
  if (!game) return null;
  return {
    gameId: game.gameId,
    size: game.size,
    revision: game.revision,
    status: game.status,
    turn: game.turn,
    winner: game.winner,
    line: game.line,
    moves: game.moves.length,
    lastMove: game.lastMove,
    stoneToleranceM: STONE_TOLERANCE_M,
    stones: game.moves.map(({ row, col, color }) => ({ row, col, color })),
  };
}

/** 落盘用 */
export function serializeGame(game) {
  if (!game) return null;
  return {
    gameId: game.gameId,
    size: game.size,
    board: game.board,
    moves: game.moves,
    turn: game.turn,
    status: game.status,
    winner: game.winner,
    line: game.line,
    revision: game.revision,
    lastMove: game.lastMove,
    startedAt: game.startedAt,
  };
}

/** 从持久化数据恢复；尺寸不符或数据不合法就当没有这局 */
export function restoreGame(raw) {
  if (!raw || typeof raw !== "object" || !raw.gameId) return null;
  if (raw.size !== undefined && raw.size !== SIZE) return null;
  if (!Array.isArray(raw.board) || raw.board.length !== CELLS) return null;
  if (raw.board.some((v) => v !== null && !isColor(v))) return null;
  const game = createGame({ gameId: raw.gameId, startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : Date.now() });
  game.board = raw.board.slice();
  game.moves = Array.isArray(raw.moves) ? raw.moves.filter((m) => m && inBounds(m.row, m.col) && isColor(m.color)) : [];
  game.turn = isColor(raw.turn) ? raw.turn : BLACK;
  game.status = ["playing", "won", "draw", "ended"].includes(raw.status) ? raw.status : "playing";
  game.winner = isColor(raw.winner) ? raw.winner : null;
  game.line = Array.isArray(raw.line) ? raw.line : null;
  game.revision = Number.isFinite(raw.revision) ? raw.revision : game.moves.length;
  game.lastMove = raw.lastMove ?? game.moves.at(-1) ?? null;
  return game;
}
