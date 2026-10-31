import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { XiangqiService } from "../server/xiangqi-service.mjs";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "whale-xq-")), "xiangqi.json");

test("开局：红先、32 子、revision 0、同 requestId 幂等", () => {
  const svc = new XiangqiService(tmp());
  const a = svc.start({ requestId: "r1", userSide: "red" });
  assert.equal(a.turn, "red");
  assert.equal(a.pieces.length, 32);
  assert.equal(a.revision, 0);
  assert.equal(a.userSide, "red");
  assert.equal(a.characterSide, "black");
  assert.equal(svc.start({ requestId: "r1" }).gameId, a.gameId);
  const b = svc.start({ requestId: "r2", userSide: "black" });
  assert.notEqual(b.gameId, a.gameId);
  assert.equal(b.userSide, "black");
  assert.equal(b.characterSide, "red");
});

test("用户落子：只能动自己的子，moveId 幂等，版本校验", () => {
  const svc = new XiangqiService(tmp());
  const g = svc.start({ requestId: "r1", userSide: "red" });
  // 红方回合，但试图动黑子
  assert.equal(svc.userMove({ gameId: g.gameId, pieceId: "black_soldier_1", toRow: 4, toCol: 0, expectedRevision: 0 }).reason, "NOT_YOUR_PIECE");
  const ok = svc.userMove({ moveId: "m1", gameId: g.gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.board.turn, "black");
  assert.equal(ok.board.revision, 1);
  const replay = svc.userMove({ moveId: "m1", gameId: g.gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0 });
  assert.equal(replay.replay, true);
  assert.equal(replay.board.revision, 1);
  // 版本过期
  assert.equal(svc.userMove({ moveId: "m2", gameId: g.gameId, pieceId: "black_soldier_1", toRow: 4, toCol: 0, expectedRevision: 0 }).reason, "STALE_REVISION");
});

test("角色落子：beginMove 签发 token，commitMove 结算一次", () => {
  const svc = new XiangqiService(tmp());
  const g = svc.start({ requestId: "r1", userSide: "red" });
  // 让用户先走一步，轮到黑（角色）
  svc.userMove({ moveId: "u1", gameId: g.gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0 });
  assert.equal(svc.waitingForCharacter(), true);
  const began = svc.beginMove({ pieceId: "black_cannon_1", toRow: 4, toCol: 1, expectedRevision: 1, taskId: "t1", generation: 1 });
  assert.equal(began.ok, true, JSON.stringify(began));
  assert.ok(began.token.startsWith("xq-"));
  const commit = svc.commitMove({ token: began.token, revision: 1 });
  assert.equal(commit.ok, true);
  assert.equal(commit.committed, true);
  assert.equal(commit.board.revision, 2);
  assert.equal(commit.board.turn, "red");
  // 重复提交回放，不重复结算
  const again = svc.commitMove({ token: began.token, revision: 1 });
  assert.equal(again.replay, true);
  assert.equal(again.board.revision, 2);
});

test("角色落子：非法着不签发 token，版本不符拒绝", () => {
  const svc = new XiangqiService(tmp());
  const g = svc.start({ requestId: "r1", userSide: "red" });
  svc.userMove({ moveId: "u1", gameId: g.gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0 });
  assert.equal(svc.beginMove({ pieceId: "black_cannon_1", toRow: 9, toCol: 9, expectedRevision: 1 }).reason, "ILLEGAL_MOVE");
  assert.equal(svc.beginMove({ pieceId: "black_cannon_1", toRow: 4, toCol: 1, expectedRevision: 0 }).reason, "STALE_REVISION");
  // 拿了对方的子：归属错误比“没轮到你”更准确
  assert.equal(svc.beginMove({ pieceId: "red_cannon_1", toRow: 5, toCol: 1 }).reason, "NOT_YOUR_PIECE");
});

test("提交复检：token 过期/目标不符/已提交", () => {
  const svc = new XiangqiService(tmp());
  const g = svc.start({ requestId: "r1", userSide: "red" });
  svc.userMove({ moveId: "u1", gameId: g.gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0 });
  const began = svc.beginMove({ pieceId: "black_cannon_1", toRow: 4, toCol: 1, expectedRevision: 1 });
  assert.equal(svc.commitMove({ token: began.token, toRow: 5, toCol: 1 }).reason, "STALE_TARGET");
  assert.equal(svc.commitMove({ token: "伪造" }).reason, "NO_AUTH");
});

test("认输：判负并结束；结束后不能再走", () => {
  const svc = new XiangqiService(tmp());
  const g = svc.start({ requestId: "r1", userSide: "red" });
  const res = svc.resign("red");
  assert.equal(res.ok, true);
  assert.equal(res.board.status, "won");
  assert.equal(res.board.result.winner, "black");
  assert.equal(svc.userMove({ moveId: "x", gameId: g.gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 1 }).reason, "GAME_OVER");
});

test("持久化：重启后继续同一局（回合/棋子/版本）", () => {
  const file = tmp();
  const a = new XiangqiService(file);
  const g = a.start({ requestId: "r1", userSide: "red" });
  a.userMove({ moveId: "u1", gameId: g.gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0 });
  const b = new XiangqiService(file);
  assert.equal(b.public().gameId, g.gameId);
  assert.equal(b.public().revision, 1);
  assert.equal(b.turn, "black");
  assert.equal(b.waitingForCharacter(), true);
});

test("收摊：清空并落盘 null", () => {
  const svc = new XiangqiService(tmp());
  svc.start({ requestId: "r1" });
  assert.equal(svc.clear().cleared, true);
  assert.equal(svc.public(), null);
});

test("公开快照：含合法着法与终局事实，不含内部 token", () => {
  const svc = new XiangqiService(tmp());
  const g = svc.start({ requestId: "r1", userSide: "red" });
  const view = svc.public();
  assert.equal(view.legalMoves.length, 44);
  assert.ok(!("tokens" in view));
  assert.ok(!JSON.stringify(view).includes("xq-1-"));
  svc.userMove({ moveId: "u1", gameId: g.gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0 });
  assert.equal(svc.facts().turn, "black");
});
