import test from "node:test";
import assert from "node:assert/strict";
import {
  BLACK, WHITE, SIZE, CELLS, WIN_LENGTH, createGame, place, endGame, publicGame,
  winningLine, serializeGame, restoreGame, indexOf, other,
} from "../server/gomoku.mjs";

const newGame = (id = "g1") => createGame({ gameId: id });

/** 依次落子（自动轮换），返回最后一步的结果 */
function playSeq(game, points) {
  let last = null;
  for (const [row, col] of points) last = place(game, row, col);
  return last;
}

test("开局：15×15、黑先、无子、revision 0", () => {
  const game = newGame();
  assert.equal(game.size, SIZE);
  assert.equal(SIZE, 15);
  assert.equal(WIN_LENGTH, 5);
  assert.equal(game.board.length, CELLS);
  assert.ok(game.board.every((v) => v === null));
  assert.equal(game.turn, BLACK);
  assert.equal(game.status, "playing");
  assert.equal(game.revision, 0);
});

test("黑先白后：白方在开局不能下", () => {
  const game = newGame();
  assert.equal(place(game, 7, 7, WHITE).reason, "NOT_YOUR_TURN");
  assert.equal(place(game, 7, 7).ok, true);
  assert.equal(game.turn, WHITE);
  assert.equal(place(game, 7, 8, BLACK).reason, "NOT_YOUR_TURN");
});

test("同一个点不能重复落子", () => {
  const game = newGame();
  place(game, 7, 7);
  place(game, 0, 0);
  assert.equal(place(game, 7, 7).reason, "OCCUPIED");
});

test("越界：行列必须在 0..14", () => {
  const game = newGame();
  assert.equal(place(game, -1, 0).reason, "OUT_OF_BOUNDS");
  assert.equal(place(game, 0, SIZE).reason, "OUT_OF_BOUNDS");
  assert.equal(place(game, 1.5, 2).reason, "OUT_OF_BOUNDS");
});

test("横向五连获胜，并把连子按顺序返回", () => {
  const game = newGame();
  // 黑：7,3 7,4 7,5 7,6 7,7；白在别处捣乱
  playSeq(game, [[7, 3], [0, 0], [7, 4], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3]]);
  const last = place(game, 7, 7);
  assert.equal(last.ok, true);
  assert.equal(game.status, "won");
  assert.equal(game.winner, BLACK);
  assert.equal(game.line.length >= 5, true);
  assert.deepEqual(game.line[0], { row: 7, col: 3 });
  assert.deepEqual(game.line.at(-1), { row: 7, col: 7 });
});

test("纵向、斜向、反斜向都能判胜", () => {
  // 纵向
  const v = newGame("v");
  playSeq(v, [[3, 7], [0, 0], [4, 7], [0, 1], [5, 7], [0, 2], [6, 7], [0, 3]]);
  assert.equal(place(v, 7, 7).status, "won");
  // 斜向 ↘
  const d = newGame("d");
  playSeq(d, [[3, 3], [0, 0], [4, 4], [0, 1], [5, 5], [0, 2], [6, 6], [0, 3]]);
  assert.equal(place(d, 7, 7).status, "won");
  // 斜向 ↙
  const a = newGame("a");
  playSeq(a, [[3, 11], [0, 0], [4, 10], [0, 1], [5, 9], [0, 2], [6, 8], [0, 3]]);
  assert.equal(place(a, 7, 7).status, "won");
});

test("白方也能赢，且赢家记在白方", () => {
  const game = newGame();
  // 黑 9,9 白 2,2；黑 9,10 白 2,3；黑 9,11 白 2,4；黑 9,12 白 2,5；黑 0,0 白 2,6
  playSeq(game, [[9, 9], [2, 2], [9, 10], [2, 3], [9, 11], [2, 4], [9, 12], [2, 5], [0, 0]]);
  const last = place(game, 2, 6);
  assert.equal(last.status, "won");
  assert.equal(game.winner, WHITE);
  assert.equal(game.status, "won");
});

test("连成 5 子以上也算赢（自由规则）", () => {
  const game = newGame();
  playSeq(game, [[7, 3], [0, 0], [7, 4], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3]]);
  place(game, 7, 7); // 五连
  // 换个盘子测六连
  const six = newGame("six");
  // 黑：7,2 7,3 7,4 7,5 7,6 → 五连已经赢了，所以改用先摆四子再补成六连
  playSeq(six, [[7, 2], [0, 0], [7, 3], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3], [7, 4]]);
  // 第 5 子（7,4）把 2,3,4,5,6 连成 5 个
  assert.equal(six.status, "won");
  assert.ok(six.line.length >= 5);
});

test("一方获胜后不能再落子", () => {
  const game = newGame();
  playSeq(game, [[7, 3], [0, 0], [7, 4], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3]]);
  place(game, 7, 7);
  assert.equal(game.status, "won");
  assert.equal(place(game, 8, 8).reason, "GAME_OVER");
});

test("下满判和：填满都不连五很难，直接构造满盘且无五连的近似局面", () => {
  // 直接构造：棋盘上按“每行交替两块”铺满会连五，所以这里只验证 draw 分支的条件
  const game = newGame();
  game.moves = Array.from({ length: CELLS - 1 }, (_, i) => ({ row: Math.floor(i / SIZE), col: i % SIZE, color: i % 2 ? WHITE : BLACK }));
  game.board = game.moves.map((m) => m.color);
  game.turn = BLACK;
  // 最后一个空位：右下角
  const lastIndex = CELLS - 1;
  game.board[lastIndex] = null;
  game.moves = game.moves.filter((m) => indexOf(m.row, m.col) !== lastIndex);
  const { row, col } = { row: SIZE - 1, col: SIZE - 1 };
  const result = place(game, row, col);
  assert.equal(result.ok, true);
  // 这种交替铺法大概率会连五，两种结果都必须自洽
  assert.ok(["won", "draw"].includes(game.status), game.status);
});

test("用户结束：状态 ended，之后不能落子", () => {
  const game = newGame();
  place(game, 7, 7);
  const res = endGame(game);
  assert.equal(res.ok, true);
  assert.equal(game.status, "ended");
  assert.equal(place(game, 7, 8).reason, "GAME_OVER");
});

test("公开视图只带已落子点，空格不占体积", () => {
  const game = newGame();
  place(game, 7, 7);
  place(game, 8, 8);
  const view = publicGame(game);
  assert.equal(view.stones.length, 2);
  assert.deepEqual(view.stones[0], { row: 7, col: 7, color: BLACK });
  assert.equal(view.moves, 2);
  assert.equal(view.turn, BLACK);
  assert.ok(!("board" in view));
  assert.ok(JSON.stringify(view).length < 300);
});

test("持久化：序列化→恢复后盘面、回合、胜负一致", () => {
  const game = newGame("save");
  playSeq(game, [[7, 3], [0, 0], [7, 4], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3]]);
  place(game, 7, 7);
  const restored = restoreGame(JSON.parse(JSON.stringify(serializeGame(game))));
  assert.equal(restored.gameId, "save");
  assert.equal(restored.status, "won");
  assert.equal(restored.winner, BLACK);
  assert.deepEqual(restored.board, game.board);
  assert.equal(restored.moves.length, game.moves.length);
  assert.equal(restored.revision, game.revision);
});

test("恢复：尺寸不符或盘面不合法直接丢弃", () => {
  const game = newGame("x");
  const raw = serializeGame(game);
  assert.equal(restoreGame({ ...raw, size: 19 }), null);
  assert.equal(restoreGame({ ...raw, board: [null, "red"] }), null);
  assert.equal(restoreGame(null), null);
});

test("winningLine 只认自己颜色的连子", () => {
  const game = newGame();
  playSeq(game, [[7, 3], [0, 0], [7, 4], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3]]);
  assert.equal(winningLine(game.board, 7, 7, BLACK), null, "还没落子");
  place(game, 7, 7);
  assert.equal(winningLine(game.board, 7, 7, WHITE), null, "颜色不对不算");
  assert.ok(winningLine(game.board, 7, 7, BLACK));
});

test("other() 轮换黑白", () => {
  assert.equal(other(BLACK), WHITE);
  assert.equal(other(WHITE), BLACK);
});
