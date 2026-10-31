/**
 * 中国象棋规则核心（纯函数，不碰 IO、不碰渲染）。
 *
 * 约定与素材契约一致：
 * - 10 行 × 9 列交点，row=0 黑底线、row=9 红底线；col=0..8
 * - 世界坐标 x=(col-4)*1.15, z=(row-4.5)*1.15（本模块不涉及，只给行列）
 * - 红先；双方各 16 子；稳定 pieceId 由初始布局给出
 *
 * 覆盖：七类棋子走法/吃法、九宫、河界、蹩马腿、塞象眼、炮架、兵卒过河、将帅照面、
 * 自陷将军过滤、将军/将死/困毙。重复与长将按 CCA2020 做近似裁决（见 adjudicateRepeat）。
 */

export const RULESET = "CCA2020";
export const ROWS = 10;
export const COLS = 9;
export const RED = "red";
export const BLACK = "black";
export const other = (side) => (side === RED ? BLACK : RED);

export const KINDS = ["general", "advisor", "elephant", "horse", "rook", "cannon", "pawn"];

const inBoard = (row, col) => Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < ROWS && col >= 0 && col < COLS;
const idx = (row, col) => row * COLS + col;
const cellOf = (i) => ({ row: Math.floor(i / COLS), col: i % COLS });

/** 九宫：黑 0..2 行，红 7..9 行，列 3..5 */
const inPalace = (side, row, col) => {
  if (col < 3 || col > 5) return false;
  return side === BLACK ? row >= 0 && row <= 2 : row >= 7 && row <= 9;
};
/** 过河：黑从 0 往里走，row>=5 已在红方半场；红 row<=4 在黑方半场 */
const crossedRiver = (side, row) => (side === BLACK ? row >= 5 : row <= 4);

/** 初始 32 子（按素材 initial_layout 的稳定 id 与行列） */
export function initialPieces() {
  const layout = [
    // 黑方（row 0/2/3）
    ["black_rook_1", BLACK, "rook", 0, 0],
    ["black_horse_1", BLACK, "horse", 0, 1],
    ["black_elephant_1", BLACK, "elephant", 0, 2],
    ["black_advisor_1", BLACK, "advisor", 0, 3],
    ["black_general_1", BLACK, "general", 0, 4],
    ["black_advisor_2", BLACK, "advisor", 0, 5],
    ["black_elephant_2", BLACK, "elephant", 0, 6],
    ["black_horse_2", BLACK, "horse", 0, 7],
    ["black_rook_2", BLACK, "rook", 0, 8],
    ["black_cannon_1", BLACK, "cannon", 2, 1],
    ["black_cannon_2", BLACK, "cannon", 2, 7],
    ["black_pawn_1", BLACK, "pawn", 3, 0],
    ["black_pawn_2", BLACK, "pawn", 3, 2],
    ["black_pawn_3", BLACK, "pawn", 3, 4],
    ["black_pawn_4", BLACK, "pawn", 3, 6],
    ["black_pawn_5", BLACK, "pawn", 3, 8],
    // 红方（row 9/7/6）
    ["red_rook_1", RED, "rook", 9, 0],
    ["red_horse_1", RED, "horse", 9, 1],
    ["red_elephant_1", RED, "elephant", 9, 2],
    ["red_advisor_1", RED, "advisor", 9, 3],
    ["red_general_1", RED, "general", 9, 4],
    ["red_advisor_2", RED, "advisor", 9, 5],
    ["red_elephant_2", RED, "elephant", 9, 6],
    ["red_horse_2", RED, "horse", 9, 7],
    ["red_rook_2", RED, "rook", 9, 8],
    ["red_cannon_1", RED, "cannon", 7, 1],
    ["red_cannon_2", RED, "cannon", 7, 7],
    ["red_pawn_1", RED, "pawn", 6, 0],
    ["red_pawn_2", RED, "pawn", 6, 2],
    ["red_pawn_3", RED, "pawn", 6, 4],
    ["red_pawn_4", RED, "pawn", 6, 6],
    ["red_pawn_5", RED, "pawn", 6, 8],
  ];
  return layout.map(([id, side, kind, row, col]) => ({ id, side, kind, row, col }));
}

export function createGame({ gameId, userSide = RED, startedAt = Date.now() } = {}) {
  const board = Array(ROWS * COLS).fill(null);
  const pieces = new Map();
  for (const p of initialPieces()) {
    board[idx(p.row, p.col)] = p.id;
    pieces.set(p.id, { ...p });
  }
  return {
    gameId: gameId ?? `xq${startedAt.toString(36)}`,
    ruleset: RULESET,
    board,
    pieces,
    turn: RED,
    revision: 0,
    status: "playing", // playing | won | draw | ended
    result: null, // { winner, reason }
    userSide,
    characterSide: other(userSide),
    moves: [], // { pieceId, from:{row,col}, to:{row,col}, captured, revision }
    lastMove: null,
    startedAt,
  };
}

const pieceAt = (game, row, col) => (inBoard(row, col) ? game.pieces.get(game.board[idx(row, col)]) ?? null : null);

/** 伪合法着法（不检查自陷将军/将帅照面），规则测试与 UI 候选都用它 */
export function pseudoMoves(game, pieceId) {
  const piece = game.pieces.get(pieceId);
  if (!piece || !inBoard(piece.row, piece.col)) return [];
  const out = [];
  const push = (row, col) => {
    if (!inBoard(row, col)) return false;
    const target = pieceAt(game, row, col);
    if (target && target.side === piece.side) return false;
    out.push({ row, col });
    return !target; // 空格可以继续滑
  };
  const { row, col, side, kind } = piece;
  switch (kind) {
    case "rook": {
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let k = 1; k < 10; k++) {
          if (!push(row + dr * k, col + dc * k)) break;
        }
      }
      break;
    }
    case "cannon": {
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let screen = false;
        for (let k = 1; k < 10; k++) {
          const r = row + dr * k;
          const c = col + dc * k;
          if (!inBoard(r, c)) break;
          const target = pieceAt(game, r, c);
          if (!screen) {
            if (!target) out.push({ row: r, col: c });
            else screen = true; // 炮架
            continue;
          }
          if (target) {
            if (target.side !== side) out.push({ row: r, col: c });
            break; // 炮架后只吃第一个
          }
        }
      }
      break;
    }
    case "horse": {
      const legs = [
        [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
        [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
      ];
      for (const [dr, dc, lr, lc] of legs) {
        if (pieceAt(game, row + lr, col + lc)) continue; // 蹩马腿
        push(row + dr, col + dc);
      }
      break;
    }
    case "elephant": {
      for (const [dr, dc] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
        const r = row + dr;
        const c = col + dc;
        if (!inBoard(r, c)) continue;
        if (pieceAt(game, row + dr / 2, col + dc / 2)) continue; // 塞象眼
        if (crossedRiver(side, r)) continue; // 象不过河
        push(r, c);
      }
      break;
    }
    case "advisor": {
      for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const r = row + dr;
        const c = col + dc;
        if (inPalace(side, r, c)) push(r, c);
      }
      break;
    }
    case "general": {
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const r = row + dr;
        const c = col + dc;
        if (inPalace(side, r, c)) push(r, c);
      }
      break;
    }
    case "pawn": {
      const forward = side === BLACK ? 1 : -1;
      push(row + forward, col);
      if (crossedRiver(side, row)) {
        push(row, col - 1);
        push(row, col + 1);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

const generalOf = (game, side) => [...game.pieces.values()].find((p) => p.side === side && p.kind === "general") ?? null;

/** 某个格是否被 side 的任一棋子攻击（用于将军判定；包含将帅照面） */
export function isAttacked(game, row, col, bySide) {
  if (!inBoard(row, col)) return false;
  // 将帅照面：对方将与目标同列且中间无子，等同于被将攻击（吃将不是合法着法，只用于将军判定）
  const enemyGeneral = [...game.pieces.values()].find((p) => p.side === bySide && p.kind === "general");
  if (enemyGeneral && enemyGeneral.col === col) {
    const lo = Math.min(enemyGeneral.row, row) + 1;
    const hi = Math.max(enemyGeneral.row, row);
    let blocked = false;
    for (let r = lo; r < hi; r++) if (game.board[idx(r, col)]) blocked = true;
    if (!blocked) return true;
  }
  // 判断“这一格是否被 bySide 攻击”。格子上通常站着被保护方自己的棋子（如将），
  // 对 bySide 来说那是可以吃掉的敌子，所以照常生成着法即可——不能先把格子清空，
  // 否则炮会失去“隔子吃将”的能力，导致被将军时漏判。
  for (const piece of game.pieces.values()) {
    if (piece.side !== bySide) continue;
    if (pseudoMoves(game, piece.id).some((m) => m.row === row && m.col === col)) return true;
  }
  return false;
}

/** 找到某方的将，返回它是否正被将军（含将帅照面：双方将同列无遮挡本身也算） */
export function inCheck(game, side) {
  const general = generalOf(game, side);
  if (!general) return true; // 将已被吃（正常规则不会出现，作为兜底）
  return isAttacked(game, general.row, general.col, other(side));
}

function cloneGame(game) {
  return {
    ...game,
    board: game.board.slice(),
    pieces: new Map([...game.pieces].map(([id, p]) => [id, { ...p }])),
  };
}

/** 在副本上执行一步（不校验回合），返回新状态 */
function applyUnchecked(game, pieceId, toRow, toCol) {
  const next = cloneGame(game);
  const piece = next.pieces.get(pieceId);
  const from = { row: piece.row, col: piece.col };
  const targetId = next.board[idx(toRow, toCol)];
  const captured = targetId ? next.pieces.get(targetId) ?? null : null;
  next.board[idx(from.row, from.col)] = null;
  if (targetId) next.pieces.delete(targetId);
  piece.row = toRow;
  piece.col = toCol;
  next.board[idx(toRow, toCol)] = pieceId;
  return { next, from, captured };
}

/** 合法着法：伪合法 + 自陷将军过滤（含将帅照面） */
export function legalMoves(game, pieceId) {
  const piece = game.pieces.get(pieceId);
  if (!piece || game.status !== "playing" || piece.side !== game.turn) return [];
  return pseudoMoves(game, pieceId).filter(({ row, col }) => {
    const { next } = applyUnchecked(game, pieceId, row, col);
    return !inCheck(next, piece.side);
  });
}

export function allLegalMoves(game, side = game.turn) {
  const out = [];
  for (const piece of game.pieces.values()) {
    if (piece.side !== side) continue;
    for (const m of legalMoves(game, piece.id)) out.push({ pieceId: piece.id, ...m });
  }
  return out;
}

/**
 * 走一步。返回值区分“规则拒绝”和“状态拒绝”，调用方据此决定提示。
 * 成功时会更新 revision / turn / status / result。
 */
export function move(game, pieceId, toRow, toCol) {
  if (!game || game.status !== "playing") return { ok: false, reason: "GAME_OVER" };
  const piece = game.pieces.get(pieceId);
  if (!piece) return { ok: false, reason: "NO_PIECE" };
  if (piece.side !== game.turn) return { ok: false, reason: "NOT_YOUR_TURN", turn: game.turn };
  if (!inBoard(toRow, toCol)) return { ok: false, reason: "OUT_OF_BOARD" };
  if (!legalMoves(game, pieceId).some((m) => m.row === toRow && m.col === toCol)) {
    return { ok: false, reason: "ILLEGAL_MOVE" };
  }
  const { next, from, captured } = applyUnchecked(game, pieceId, toRow, toCol);
  game.board = next.board;
  game.pieces = next.pieces;
  game.revision += 1;
  const record = { pieceId, from, to: { row: toRow, col: toCol }, captured: captured ? captured.id : null, revision: game.revision };
  game.moves.push(record);
  game.lastMove = record;

  const mover = piece.side;
  const opponent = other(mover);
  // 先换手，再判断对手是否还有合法着法（legalMoves 会按 game.turn 过滤）
  game.turn = opponent;
  const opponentInCheck = inCheck(game, opponent);
  const opponentMoves = allLegalMoves(game, opponent);
  if (!opponentMoves.length) {
    game.status = "won";
    game.result = { winner: mover, reason: opponentInCheck ? "checkmate" : "stalemate" };
  }
  game.result = game.status === "won" ? game.result : null;
  return { ok: true, record, captured: captured?.id ?? null, check: opponentInCheck, status: game.status, result: game.result ?? null };
}

/** 当前局面事实：将军/合法着法/终局 */
export function position(game) {
  const check = inCheck(game, game.turn);
  const moves = allLegalMoves(game, game.turn);
  return {
    turn: game.turn,
    check,
    status: game.status,
    result: game.result,
    legalMoves: moves,
    checkmate: game.status === "playing" && check && moves.length === 0,
    stalemate: game.status === "playing" && !check && moves.length === 0,
  };
}

/**
 * 重复/长将的近似裁决（CCA2020 完整棋例需要逐例裁决，这里先做保守实现并标注）。
 * - 同一局面（含走子方）出现 3 次：若期间一方每步都在将军，则连续将军的一方判负；
 *   否则判和。
 */
export function adjudicateRepeat(positions) {
  // positions: 历史局面签名数组（含当前），由服务层维护
  if (!Array.isArray(positions) || positions.length < 3) return null;
  const counts = new Map();
  for (const key of positions) counts.set(key, (counts.get(key) ?? 0) + 1);
  const repeated = [...counts].find(([, n]) => n >= 3);
  if (!repeated) return null;
  return { threefold: true };
}

/** 局面签名：棋盘 + 轮到谁（用于重复检测） */
export function signature(game) {
  return `${game.board.map((id) => (id ? id : ".")).join("|")}#${game.turn}`;
}

/** 公开视图：给模型和前端的权威盘面 */
export function publicGame(game) {
  const p = position(game);
  return {
    gameId: game.gameId,
    ruleset: game.ruleset,
    revision: game.revision,
    status: game.status,
    turn: game.turn,
    userSide: game.userSide,
    characterSide: game.characterSide,
    check: p.check,
    result: game.result,
    lastMove: game.lastMove,
    moves: game.moves.length,
    pieces: [...game.pieces.values()].map(({ id, side, kind, row, col }) => ({ id, side, kind, row, col })),
    legalMoves: p.legalMoves,
  };
}

export function serializeGame(game) {
  if (!game) return null;
  return {
    gameId: game.gameId,
    ruleset: game.ruleset,
    board: game.board,
    pieces: [...game.pieces.values()],
    turn: game.turn,
    revision: game.revision,
    status: game.status,
    result: game.result,
    userSide: game.userSide,
    characterSide: game.characterSide,
    moves: game.moves,
    lastMove: game.lastMove,
    startedAt: game.startedAt,
  };
}

export function restoreGame(raw) {
  if (!raw || typeof raw !== "object" || !raw.gameId) return null;
  if (raw.ruleset && raw.ruleset !== RULESET) return null;
  if (!Array.isArray(raw.board) || raw.board.length !== ROWS * COLS) return null;
  if (!Array.isArray(raw.pieces)) return null;
  const game = {
    gameId: raw.gameId,
    ruleset: RULESET,
    board: raw.board.slice(),
    pieces: new Map(raw.pieces.filter((p) => p && p.id).map((p) => [p.id, { ...p }])),
    turn: raw.turn === BLACK ? BLACK : RED,
    revision: Number(raw.revision) || 0,
    status: ["playing", "won", "draw", "ended"].includes(raw.status) ? raw.status : "playing",
    result: raw.result ?? null,
    userSide: raw.userSide === BLACK ? BLACK : RED,
    characterSide: other(raw.userSide === BLACK ? BLACK : RED),
    moves: Array.isArray(raw.moves) ? raw.moves : [],
    lastMove: raw.lastMove ?? null,
    startedAt: Number(raw.startedAt) || Date.now(),
  };
  return game;
}

export { inBoard, inPalace, crossedRiver, pieceAt, generalOf, cellOf };
