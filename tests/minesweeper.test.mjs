import test from "node:test";
import assert from "node:assert/strict";
import {
  SIZE, MINE_COUNT, SAFE_TOTAL, createGame, dig, endGame, placeMines, countAdjacentMines,
  indexOf, cellOf, cellAt, cellCenter, inBounds, publicBoard, restoreGame, serializeGame,
} from "../server/minesweeper.mjs";

const newGame = (seed = 12345, gameId = "g1") => createGame({ gameId, seed });

test("建盘：首次挖掘前没有雷表，公开快照全是 hidden", () => {
  const game = newGame();
  assert.equal(game.mines, null);
  const board = publicBoard(game);
  assert.equal(board.cells.length, SIZE * SIZE);
  assert.ok(board.cells.every((c) => c.state === "hidden" && c.value === undefined));
  assert.equal(board.mineCount, MINE_COUNT);
  assert.equal(board.remainingSafe, SAFE_TOTAL);
});

test("首次挖掘安全：200 个随机种子都不踩雷", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const game = newGame(seed);
    const first = dig(game, 5, 5);
    assert.equal(first.ok, true);
    assert.equal(first.status !== "lost", true, `seed ${seed} 首挖踩雷`);
    assert.equal(game.mineSet.has(indexOf(5, 5)), false);
  }
});

test(`布雷：${MINE_COUNT} 颗、无重复、不含首挖格、同 seed 可复现`, () => {
  const a = placeMines(999, indexOf(0, 0));
  const b = placeMines(999, indexOf(0, 0));
  assert.deepEqual(a, b);
  assert.equal(a.length, MINE_COUNT);
  assert.equal(new Set(a).size, MINE_COUNT);
  assert.ok(!a.includes(indexOf(0, 0)));
  assert.ok(a.every((i) => i >= 0 && i < SIZE * SIZE));
});

test("八邻计数：角落、边、中间各自正确", () => {
  const mines = [indexOf(0, 0), indexOf(1, 1), indexOf(4, 4)];
  assert.equal(countAdjacentMines(mines, indexOf(0, 1)), 2);
  assert.equal(countAdjacentMines(mines, indexOf(1, 0)), 2);
  assert.equal(countAdjacentMines(mines, indexOf(5, 5)), 1);
  assert.equal(countAdjacentMines(mines, indexOf(SIZE - 1, SIZE - 1)), 0);
});

test("零格展开：同一次挖掘一次 revision，changedCells 含边界数字", () => {
  const game = newGame(7);
  // 找一个零格：先挖开看看
  const first = dig(game, 0, 0);
  assert.equal(first.ok, true);
  const zeros = [...game.revealed].filter((i) => countAdjacentMines(game.mineSet, i) === 0);
  const target = zeros[0] ?? null;
  if (target === null) return; // 首挖不是零格时跳过展开断言
  const game2 = newGame(7);
  game2.mines = [...game.mines];
  game2.mineSet = new Set(game.mines);
  game2.revealed = new Set();
  const before = game2.revision;
  const result = dig(game2, cellOf(target).row, cellOf(target).col);
  assert.equal(result.ok, true);
  assert.equal(game2.revision, before + 1, "展开只加一次 revision");
  assert.ok(result.changedCells.length > 1);
  const values = result.changedCells.map((c) => c.value);
  assert.ok(values.every((v) => typeof v === "number" && v >= 0 && v <= 8));
});

test("踩雷：status=lost，公开快照才给出雷表", () => {
  const game = newGame(42);
  dig(game, 0, 0);
  const mineIndex = game.mines[0];
  const { row, col } = cellOf(mineIndex);
  const result = dig(game, row, col);
  assert.equal(result.ok, true);
  assert.equal(result.status, "lost");
  assert.equal(game.status, "lost");
  const board = publicBoard(game);
  assert.equal(board.status, "lost");
  assert.ok(Array.isArray(board.mines) && board.mines.length === MINE_COUNT);
  // 游戏结束后不能再挖
  assert.equal(dig(game, 5, 5).reason, "GAME_OVER");
});

test("重复挖同一格：ALREADY_REVEALED，不增加 revision", () => {
  const game = newGame(11);
  dig(game, 3, 3);
  const revision = game.revision;
  const again = dig(game, 3, 3);
  assert.equal(again.ok, false);
  assert.equal(again.reason, "ALREADY_REVEALED");
  assert.equal(game.revision, revision);
});

test(`越界：行列必须在 0..${SIZE - 1}，坐标 ±4 不属于棋盘`, () => {
  const game = newGame(5);
  assert.equal(dig(game, -1, 0).reason, "OUT_OF_BOUNDS");
  assert.equal(dig(game, 0, SIZE).reason, "OUT_OF_BOUNDS");
  assert.equal(dig(game, 1.5, 2).reason, "OUT_OF_BOUNDS");
  assert.equal(cellAt(0, 0).row, SIZE / 2);
  assert.equal(cellAt(0, 0).col, SIZE / 2);
  assert.equal(cellAt(3.99, 3.99).col, SIZE - 1);
  assert.equal(cellAt(4, 0), null);
  assert.equal(cellAt(-4.01, 0), null);
  assert.equal(inBounds(SIZE - 1, SIZE - 1), true);
  assert.equal(inBounds(SIZE, SIZE - 1), false);
});

test("格心公式：col 从 -X 到 +X、row 从 -Z 到 +Z，每格 0.5m", () => {
  assert.deepEqual(cellCenter(0, 0), { x: -3.75, z: -3.75 });
  assert.deepEqual(cellCenter(SIZE - 1, SIZE - 1), { x: 3.75, z: 3.75 });
  const center = cellCenter(5, 5);
  const back = cellAt(center.x, center.z);
  assert.deepEqual(back, { row: 5, col: 5 });
});

test("胜利：挖开全部非雷格后 status=won", () => {
  const game = newGame(2024);
  dig(game, 0, 0);
  const mines = new Set(game.mines);
  for (let index = 0; index < SIZE * SIZE; index++) {
    if (mines.has(index) || game.revealed.has(index)) continue;
    const { row, col } = cellOf(index);
    dig(game, row, col);
  }
  assert.equal(game.status, "won");
  const board = publicBoard(game);
  assert.equal(board.status, "won");
  assert.equal(board.remainingSafe, 0);
  assert.equal(board.revealedSafe, SAFE_TOTAL);
});

test("持久化：序列化→恢复后雷表、已开格、状态一致", () => {
  const game = newGame(77);
  dig(game, 4, 4);
  const saved = JSON.parse(JSON.stringify(serializeGame(game)));
  const restored = restoreGame(saved);
  assert.deepEqual([...restored.revealed].sort((a, b) => a - b), [...game.revealed].sort((a, b) => a - b));
  assert.deepEqual(restored.mines, game.mines);
  assert.equal(restored.status, game.status);
  assert.equal(restored.revision, game.revision);
  // 恢复后继续挖仍然一致
  const { row, col } = cellOf(game.mines[0]);
  assert.equal(dig(restored, row, col).status, "lost");
});

test("旧尺寸存档：不会把 10×10 的索引误读成 16×16", () => {
  assert.equal(restoreGame({ gameId: "old", seed: 1, size: 10, revealed: [0, 5] }), null);
  assert.equal(restoreGame({ gameId: "old2", seed: 1, mines: [SIZE * SIZE + 3] }), null);
  const saved = serializeGame(newGame());
  assert.equal(saved.size, SIZE);
  assert.equal(saved.mineCount, MINE_COUNT);
});

test("用户结束：状态 ended、揭开雷区、之后不能再挖", () => {
  const game = newGame(5);
  dig(game, 3, 3); // 先挖一下，雷区才会生成
  const revision = game.revision;
  const result = endGame(game);
  assert.equal(result.ok, true);
  assert.equal(result.status, "ended");
  assert.equal(game.status, "ended");
  assert.equal(game.revision, revision + 1);
  const board = publicBoard(game);
  assert.equal(board.status, "ended");
  const mines = board.cells.filter((c) => c.value === "mine");
  assert.equal(mines.length, MINE_COUNT, "结束时要揭开所有雷");
  const again = endGame(game);
  assert.equal(again.ok, false);
  assert.equal(again.reason, "GAME_OVER");
  assert.equal(dig(game, 4, 4).reason, "GAME_OVER");
});

test("用户结束：还没挖过就结束也不会崩", () => {
  const game = newGame(6);
  const result = endGame(game);
  assert.equal(result.ok, true);
  assert.equal(game.mineSet, null);
  assert.equal(publicBoard(game).status, "ended");
});

test("公开快照：未揭示格永远不含 value", () => {
  const game = newGame(31);
  dig(game, 5, 5);
  const board = publicBoard(game);
  for (const cell of board.cells) {
    if (cell.state === "hidden") {
      assert.equal("value" in cell, false, `${cell.row},${cell.col} 泄漏了 value`);
    }
  }
  const hiddenWithValue = board.cells.filter((c) => c.state === "hidden" && "value" in c);
  assert.equal(hiddenWithValue.length, 0);
  const json = JSON.stringify(board.cells);
  assert.equal(json.includes('"value":"mine"'), false, "进行中的棋盘不能出现 mine 值");
});
