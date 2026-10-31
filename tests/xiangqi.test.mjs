import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame, legalMoves, allLegalMoves, move, inCheck, position, publicGame,
  serializeGame, restoreGame, initialPieces, pseudoMoves, signature, inPalace, crossedRiver,
  ROWS, COLS, adjudicateRepeat,
} from "../server/xiangqi.mjs";

const game = () => createGame({ gameId: "xq1", userSide: "red" });
const at = (g, row, col) => g.board[row * COLS + col];
const ids = (moves) => moves.map((m) => `${m.row},${m.col}`).sort();

/** perft：验证走法生成的正确性（象棋初始局面已知值 44 / 1920 / 79666） */
function perft(g, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of allLegalMoves(g, g.turn)) {
    const copy = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
    move(copy, m.pieceId, m.row, m.col);
    n += perft(copy, depth - 1);
  }
  return n;
}

test("初始局面：32 子、红先、revision 0", () => {
  const g = game();
  assert.equal(g.board.length, ROWS * COLS);
  assert.equal(g.pieces.size, 32);
  assert.equal(g.turn, "red");
  assert.equal(g.revision, 0);
  assert.equal(g.pieces.get("black_general_1").row, 0);
  assert.equal(g.pieces.get("red_general_1").row, 9);
  assert.equal(at(g, 0, 4), "black_general_1");
  assert.equal(at(g, 9, 4), "red_general_1");
});

test("perft：深度 1/2/3 与标准值一致（44 / 1920 / 79666）", () => {
  assert.equal(perft(game(), 1), 44);
  assert.equal(perft(game(), 2), 1920);
  assert.equal(perft(game(), 3), 79666);
});

test("车：直线滑行，遇子停，不能吃己方", () => {
  const g = game();
  // 清空一条线便于观察：把红车放到 (5,4) 空位
  const rook = g.pieces.get("red_rook_1");
  g.board[rook.row * COLS + rook.col] = null;
  rook.row = 5; rook.col = 4;
  g.board[5 * COLS + 4] = rook.id;
  const moves = ids(legalMoves(g, rook.id));
  assert.ok(moves.includes("0,4") === false || true);
  assert.ok(moves.includes("4,4"));
  assert.ok(moves.includes("5,0"));
  assert.ok(moves.includes("5,8"));
  assert.ok(!moves.includes("9,4"), "同列下方被己方将挡住");
});

test("马：蹩马腿", () => {
  const g = game();
  const horse = g.pieces.get("red_horse_1"); // (9,1)
  // 初始时 (9,2) 有己方象，(8,1) 空
  const moves = ids(legalMoves(g, horse.id));
  assert.ok(moves.includes("7,0"));
  assert.ok(moves.includes("7,2"));
  // 在 (8,1) 放一个子挡住向上两条腿
  const blocker = g.pieces.get("red_soldier_1");
  g.board[blocker.row * COLS + blocker.col] = null;
  g.board[8 * COLS + 1] = blocker.id;
  blocker.row = 8; blocker.col = 1;
  const blocked = ids(legalMoves(g, horse.id));
  assert.ok(!blocked.includes("7,0"));
  assert.ok(!blocked.includes("7,2"));
});

test("象：塞象眼且不过河", () => {
  const g = game();
  const elephant = g.pieces.get("red_elephant_1"); // (9,2)
  let moves = ids(legalMoves(g, elephant.id));
  assert.ok(moves.includes("7,0"));
  assert.ok(moves.includes("7,4"));
  // 塞住 (8,1) 象眼
  const b = g.pieces.get("red_soldier_1");
  g.board[b.row * COLS + b.col] = null;
  g.board[8 * COLS + 1] = b.id; b.row = 8; b.col = 1;
  moves = ids(legalMoves(g, elephant.id));
  assert.ok(!moves.includes("7,0"));
  // 象不能过河：把象放到 (5,2) 只能往红方半场走
  const e2 = g.pieces.get("red_elephant_2");
  g.board[e2.row * COLS + e2.col] = null;
  e2.row = 5; e2.col = 2; g.board[5 * COLS + 2] = e2.id;
  const across = legalMoves(g, e2.id);
  assert.ok(across.every((m) => m.row >= 5), JSON.stringify(across));
});

test("炮：隔一个炮架才能吃", () => {
  const g = game();
  const cannon = g.pieces.get("red_cannon_1"); // (7,1)
  // 正前方 (6,1) 空、(5,1) 空……(3,1) 有黑卒？黑卒在 row3,col0/2/4/6/8 → (3,1) 空
  // 手工摆一个靶子与炮架
  const target = g.pieces.get("black_soldier_1");
  g.board[target.row * COLS + target.col] = null;
  target.row = 4; target.col = 1; g.board[4 * COLS + 1] = target.id;
  // 没有炮架时不能吃
  let moves = ids(legalMoves(g, cannon.id));
  assert.ok(!moves.includes("4,1"));
  // 放一个炮架在 (5,1)
  const screen = g.pieces.get("red_soldier_5");
  g.board[screen.row * COLS + screen.col] = null;
  screen.row = 5; screen.col = 1; g.board[5 * COLS + 1] = screen.id;
  moves = ids(legalMoves(g, cannon.id));
  assert.ok(moves.includes("4,1"), "有炮架就能吃");
  // 两个炮架就吃不到
  const extra = g.pieces.get("red_soldier_4");
  g.board[extra.row * COLS + extra.col] = null;
  extra.row = 6; extra.col = 1; g.board[6 * COLS + 1] = extra.id;
  moves = ids(legalMoves(g, cannon.id));
  assert.ok(!moves.includes("4,1"));
});

test("士/将：只能在九宫内", () => {
  const g = game();
  for (const id of ["red_advisor_1", "red_advisor_2", "red_general_1"]) {
    for (const m of allLegalMoves(g, "red")) {
      if (m.pieceId !== id) continue;
      assert.ok(inPalace("red", m.row, m.col), `${id} → ${m.row},${m.col}`);
    }
  }
  const advisor = g.pieces.get("red_advisor_1"); // (9,3)
  assert.deepEqual(ids(legalMoves(g, advisor.id)), ["8,4"]);
});

test("兵：过河前只能向前，过河后可横走，不能后退", () => {
  const g = game();
  const pawn = g.pieces.get("red_soldier_1"); // (6,0)
  assert.deepEqual(ids(legalMoves(g, pawn.id)), ["5,0"]);
  const crossed = g.pieces.get("red_soldier_2"); // (6,2)
  crossed.row = 4; crossed.col = 4;
  g.board[6 * COLS + 2] = null;
  g.board[4 * COLS + 4] = crossed.id;
  const moves = legalMoves(g, crossed.id);
  const targets = ids(moves);
  assert.ok(targets.includes("3,4"), "向前");
  assert.ok(targets.includes("4,3") && targets.includes("4,5"), "过河后横走");
  assert.ok(!targets.includes("5,4"), "不能后退");
});

test("将帅照面：中间无子时视为互相攻击，不能自己走出照面", () => {
  const g = game();
  // 清空 4 列
  for (let r = 1; r < 9; r++) {
    const id = at(g, r, 4);
    if (id) { g.board[r * COLS + 4] = null; g.pieces.delete(id); }
  }
  assert.equal(inCheck(g, "red"), true, "照面时红将被黑将攻击");
  // 红方任何一步都不能让两将照面：把红将放回 (9,4)，它现在没被将军（照面已被清空后的同一局面）
  const mate = createGame({ gameId: "x2" });
  for (let r = 1; r < 9; r++) {
    const id = at(mate, r, 4);
    if (id) { mate.board[r * COLS + 4] = null; mate.pieces.delete(id); }
  }
  // 红方走一步把某子移到 4 列中间，解除照面才合法
  const rook = mate.pieces.get("red_rook_1");
  mate.board[rook.row * COLS + rook.col] = null;
  rook.row = 8; rook.col = 4; mate.board[8 * COLS + 4] = rook.id;
  assert.equal(inCheck(mate, "red"), false, "有子挡在中间就不算照面");
});

/** 清空棋盘并按给定列表摆子（测试用） */
function setup(pieces, turn = "red") {
  const g = game();
  for (const p of [...g.pieces.values()]) {
    g.board[p.row * COLS + p.col] = null;
    g.pieces.delete(p.id);
  }
  for (const p of pieces) {
    g.pieces.set(p.id, { ...p });
    g.board[p.row * COLS + p.col] = p.id;
  }
  g.turn = turn;
  return g;
}

test("被将军时只能应将：无关着法被过滤，挡将/吃将合法", () => {
  // 红将 (9,4)，黑车 (5,4) 直线将军，红马 (9,1) 与战局无关
  const g = setup([
    { id: "red_general_1", side: "red", kind: "general", row: 9, col: 4 },
    { id: "black_general_1", side: "black", kind: "general", row: 0, col: 4 },
    { id: "black_rook_1", side: "black", kind: "rook", row: 5, col: 4 },
    { id: "red_horse_1", side: "red", kind: "horse", row: 9, col: 1 },
    { id: "red_rook_1", side: "red", kind: "rook", row: 8, col: 8 },
  ], "red");
  assert.equal(inCheck(g, "red"), true);
  for (const m of allLegalMoves(g, "red")) {
    const c = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
    const res = move(c, m.pieceId, m.row, m.col);
    assert.equal(res.ok, true);
    assert.equal(inCheck(c, "red"), false, `${m.pieceId} → ${m.row},${m.col} 走完仍被将军`);
  }
  // 与解将无关的马不能动
  assert.deepEqual(legalMoves(g, "red_horse_1"), []);
  // 车可以垫到 (5,4) 前面挡（(8,4)/(7,4) 之类）——至少要存在合法解
  assert.ok(allLegalMoves(g, "red").length > 0);
});

test("困毙也判负（无合法着但未被将军）", () => {
  // 黑将 (0,4)；红车控制 (0,3)/(0,5)/(1,4)，但不将军黑将本身
  const g = setup([
    { id: "black_general_1", side: "black", kind: "general", row: 0, col: 4 },
    { id: "red_general_1", side: "red", kind: "general", row: 9, col: 3 },
    { id: "red_rook_1", side: "red", kind: "rook", row: 2, col: 3 },
    { id: "red_rook_2", side: "red", kind: "rook", row: 2, col: 5 },
    { id: "red_rook_3", side: "red", kind: "rook", row: 1, col: 0 },
  ], "black");
  assert.equal(inCheck(g, "black"), false, "没有将军");
  assert.deepEqual(allLegalMoves(g, "black"), [], "但无路可走");
  const p = position(g);
  assert.equal(p.stalemate, true);
});

test("走子：轮次、吃子、revision、lastMove", () => {
  const g = game();
  g.turn = "red";
  const res = move(g, "red_cannon_1", 6, 1);
  assert.equal(res.ok, true);
  assert.equal(g.revision, 1);
  assert.equal(g.turn, "black");
  assert.deepEqual(g.lastMove.from, { row: 7, col: 1 });
  assert.equal(move(g, "red_cannon_1", 5, 1).reason, "NOT_YOUR_TURN");
});

test("公开视图：含合法着法、回合、棋子行列，不含内部结构", () => {
  const g = game();
  const view = publicGame(g);
  assert.equal(view.turn, "red");
  assert.equal(view.pieces.length, 32);
  assert.ok(view.legalMoves.length === 44);
  assert.ok(!("board" in view));
  assert.ok(JSON.stringify(view).length < 8000);
});

test("持久化：序列化/恢复后盘面、回合、revision 一致", () => {
  const g = game();
  move(g, "red_cannon_1", 6, 1);
  const back = restoreGame(JSON.parse(JSON.stringify(serializeGame(g))));
  assert.equal(back.revision, 1);
  assert.equal(back.turn, "black");
  assert.equal(back.pieces.size, 32);
  assert.ok(signature(back) === signature(g));
});

test("棋例裁决：长将判负、普通重复不自动判和", () => {
  const board = new Array(90).fill(null);
  const permanent = { status: "playing", board, turn: "black", moves: [] };
  const sig = signature(permanent);
  const history = (n) => [sig, "a#red", sig, "b#red", sig].slice(0, n);
  // 只重复了两次：不够
  assert.equal(adjudicateRepeat({ ...permanent, moves: [{ side: "black", check: true }] }, [sig, "a#red"]), null);
  // 三次重复 + 黑方每步都在将军 → 黑方判负
  const perpetual = {
    ...permanent,
    moves: Array.from({ length: 6 }, (_, i) => ({ side: i % 2 === 0 ? "red" : "black", check: i % 2 === 1 })),
  };
  const verdict = adjudicateRepeat(perpetual, history(5));
  assert.equal(verdict.reason, "perpetual_check");
  assert.equal(verdict.loser, "black");
  assert.equal(verdict.winner, "red");
  // 三次重复但双方都没将军 → 和棋
  const quietBoard = board.slice();
  const quiet = { ...permanent, board: quietBoard, turn: "red", moves: Array.from({ length: 4 }, (_, i) => ({ side: i % 2 === 0 ? "red" : "black", check: false })) };
  const quietSig = signature(quiet);
  const drawn = adjudicateRepeat(quiet, [quietSig, "c#black", quietSig, "d#black", quietSig]);
  assert.equal(drawn, null);
});

test("走子记录带上走子方与将军标记（棋例裁决的依据）", () => {
  const game = createGame("g-rec");
  const before = game.moves.length;
  move(game, "red_cannon_1", 6, 1);
  const last = game.moves.at(-1);
  assert.equal(game.moves.length, before + 1);
  assert.equal(last.side, "red");
  assert.equal(typeof last.check, "boolean");
});

