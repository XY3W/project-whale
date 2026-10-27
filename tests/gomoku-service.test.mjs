import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GomokuService } from "../server/gomoku-service.mjs";
import { BLACK, WHITE } from "../server/gomoku.mjs";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "whale-gomoku-")), "gomoku.json");

test("开局：黑先、幂等 requestId、新 requestId 换局", () => {
  const svc = new GomokuService(tmpFile());
  const a = svc.start("r1");
  assert.equal(a.turn, BLACK);
  assert.equal(a.moves, 0);
  assert.equal(svc.start("r1").gameId, a.gameId, "同 requestId 幂等");
  const b = svc.start("r2");
  assert.notEqual(b.gameId, a.gameId);
  assert.equal(b.turn, BLACK);
  assert.equal(svc.waitingForCharacter(), true);
});

test("落子：用户白方要等黑方先走，回合正确轮换", () => {
  const svc = new GomokuService(tmpFile());
  const game = svc.start("r1");
  const early = svc.move({ gameId: game.gameId, row: 7, col: 7, color: WHITE, expectedRevision: 0 });
  assert.equal(early.reason, "NOT_YOUR_TURN", "黑先，白方现在不能下");

  const black = svc.move({ moveId: "b1", gameId: game.gameId, row: 7, col: 7, color: BLACK, expectedRevision: 0 });
  assert.equal(black.ok, true);
  assert.equal(black.board.turn, WHITE);
  assert.equal(svc.waitingForUser(), true);

  const white = svc.move({ moveId: "w1", gameId: game.gameId, row: 8, col: 8, color: WHITE, expectedRevision: 1 });
  assert.equal(white.ok, true);
  assert.equal(white.board.turn, BLACK);
  assert.equal(white.board.moves, 2);
});

test("幂等：同一 moveId 重发回放，不会重复落子", () => {
  const svc = new GomokuService(tmpFile());
  const game = svc.start("r1");
  svc.move({ moveId: "b1", gameId: game.gameId, row: 7, col: 7, color: BLACK, expectedRevision: 0 });
  const replay = svc.move({ moveId: "b1", gameId: game.gameId, row: 7, col: 7, color: BLACK, expectedRevision: 0 });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.board.moves, 1);
});

test("版本过期但确实是上次那一步：按重放处理；否则 STALE_REVISION", () => {
  const svc = new GomokuService(tmpFile());
  const game = svc.start("r1");
  svc.move({ gameId: game.gameId, row: 7, row2: 0, col: 7, color: BLACK, expectedRevision: 0 });
  const same = svc.move({ gameId: game.gameId, row: 7, col: 7, color: BLACK, expectedRevision: 0 });
  assert.equal(same.replay, true);
  const stale = svc.move({ gameId: game.gameId, row: 6, col: 6, color: WHITE, expectedRevision: 0 });
  assert.equal(stale.reason, "STALE_REVISION");
});

test("非法落子：占位重复、越界、错局", () => {
  const svc = new GomokuService(tmpFile());
  const game = svc.start("r1");
  svc.move({ gameId: game.gameId, row: 7, col: 7, color: BLACK });
  assert.equal(svc.move({ gameId: game.gameId, row: 7, col: 7, color: WHITE }).reason, "OCCUPIED");
  assert.equal(svc.move({ gameId: game.gameId, row: -1, col: 0, color: WHITE }).reason, "OUT_OF_BOUNDS");
  assert.equal(svc.move({ gameId: "nope", row: 1, col: 1, color: WHITE }).reason, "STALE_GAME");
});

test("胜负：连五后状态 won，之后不能再落子；结束按钮收摊", () => {
  const svc = new GomokuService(tmpFile());
  const game = svc.start("r1");
  const blackMoves = [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]];
  const whiteMoves = [[0, 0], [0, 1], [0, 2], [0, 3]];
  let rev = 0;
  for (let i = 0; i < blackMoves.length; i++) {
    const b = svc.move({ gameId: game.gameId, row: blackMoves[i][0], col: blackMoves[i][1], color: BLACK, expectedRevision: rev++ });
    assert.equal(b.ok, true);
    if (b.status === "won") break;
    const w = svc.move({ gameId: game.gameId, row: whiteMoves[i][0], col: whiteMoves[i][1], color: WHITE, expectedRevision: rev++ });
    assert.equal(w.ok, true);
  }
  assert.equal(svc.status, "won");
  assert.equal(svc.public().winner, BLACK);
  assert.equal(svc.public().line.length >= 5, true);
  assert.equal(svc.move({ gameId: game.gameId, row: 1, col: 1, color: WHITE }).reason, "GAME_OVER");

  const cleared = svc.end();
  assert.equal(cleared.cleared, true);
  assert.equal(svc.public(), null);
});

test("持久化：重启后继续同一局（含回合与已落子）", () => {
  const file = tmpFile();
  const a = new GomokuService(file);
  const game = a.start("r1");
  a.move({ gameId: game.gameId, row: 7, col: 7, color: BLACK, expectedRevision: 0 });
  const b = new GomokuService(file);
  assert.equal(b.public().gameId, game.gameId);
  assert.equal(b.public().moves, 1);
  assert.equal(b.turn, WHITE);
  assert.equal(b.waitingForUser(), true);
});

test("进行中结束：状态 ended 但盘面保留", () => {
  const svc = new GomokuService(tmpFile());
  const game = svc.start("r1");
  svc.move({ gameId: game.gameId, row: 7, col: 7, color: BLACK, expectedRevision: 0 });
  const ended = svc.end();
  assert.equal(ended.ok, true);
  assert.equal(ended.board.status, "ended");
  assert.equal(ended.board.moves, 1);
  assert.equal(svc.waitingForCharacter(), false);
  assert.equal(svc.waitingForUser(), false);
});
