import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GameService } from "../server/game.mjs";
import { cellOf } from "../server/minesweeper.mjs";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "whale-game-")), "minesweeper.json");

test("结束按钮：进行中→结束并揭开，再点→收摊清空", () => {
  const file = tmpFile();
  const svc = new GameService(file);
  const started = svc.start("r1");
  assert.equal(started.status, "playing");

  // 先挖一格，雷区才会生成
  const first = svc.commit({ gameId: started.gameId, row: 2, col: 2, expectedRevision: 0 });
  assert.equal(first.ok, true);
  const mine = cellOf(svc.game.mines[0]);
  svc.commit({ gameId: started.gameId, row: mine.row, col: mine.col, expectedRevision: first.revision });
  assert.equal(svc.status, "lost");

  // 踩雷之后按钮仍然是“结束”：点一下收摊
  const cleared = svc.end();
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, true);
  assert.equal(svc.public(), null);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")), null, "落盘也要清掉");

  // 收摊后可以重新开局
  const again = svc.start("r2");
  assert.equal(again.status, "playing");
  assert.notEqual(again.gameId, started.gameId);
});

test("结束按钮：进行中结束保留盘面，第二次点击才收摊", () => {
  const file = tmpFile();
  const svc = new GameService(file);
  const started = svc.start("r1");
  svc.commit({ gameId: started.gameId, row: 4, col: 4, expectedRevision: 0 });

  const ended = svc.end();
  assert.equal(ended.ok, true);
  assert.equal(ended.board.status, "ended");
  assert.ok(svc.public(), "结束后盘面还在，能看雷区");

  const cleared = svc.end();
  assert.equal(cleared.cleared, true);
  assert.equal(svc.public(), null);
});

test("结束按钮：没有对局时返回 NO_GAME", () => {
  const svc = new GameService(tmpFile());
  const result = svc.end();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_GAME");
});
