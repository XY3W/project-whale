/**
 * 象棋 WS 链路：开局（用户执红）→ 用户走子 → 服务端签发搬运 token → 客户端提交 → 结束。
 * 用 BRAIN_DEV=1 的 debug_plan 注入“服务端计划”，走真实的授权/提交路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const PORT = 8900 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-xq-ws-"));
  const proc = spawn(process.execPath, [path.resolve("server/index.mjs")], {
    cwd: dir,
    env: { ...process.env, BRAIN_PORT: String(PORT), DEEPSEEK_API_KEY: "", BRAIN_DEV: "1", AUTO_MINESWEEPER: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
      ws.close();
      await sleep(80);
      return { proc, dir };
    } catch { await sleep(100); }
  }
  throw new Error("server did not become ready");
}

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  const send = (type, payload = {}) => ws.send(JSON.stringify({ protocolVersion: 1, type, ...payload }));
  return new Promise((res) => ws.on("open", () => {
    send("hello", { runtimeVersion: "playful-v2-count33", stopReadyProtocol: 1 });
    res({ ws, inbox, send });
  }));
}
async function waitFor(inbox, pred, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const hit = inbox.find(pred); if (hit) return hit; await sleep(50); }
  return null;
}
const lastState = async (inbox) => { await sleep(150); return inbox.filter((m) => m.type === "session_state").at(-1); };

test("开局：用户执红、红先、32 子", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = await lastState(inbox);
  send("xiangqi_start", { requestId: "x1", userSide: "red", leaseEpoch: state.leaseEpoch });
  const msg = await waitFor(inbox, (m) => m.type === "xiangqi_state" && m.board);
  assert.ok(msg, "应当回 xiangqi_state");
  assert.equal(msg.board.pieces.length, 32);
  assert.equal(msg.board.turn, "red");
  assert.equal(msg.board.userSide, "red");
  assert.equal(msg.board.characterSide, "black");
  assert.equal(msg.board.ruleset, "CCA2020");
  assert.equal(msg.board.legalMoves.length, 44);
});

test("用户走子：合法则 revision 前进，非法则原样返回原因", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = await lastState(inbox);
  send("xiangqi_start", { requestId: "x1", userSide: "red", leaseEpoch: state.leaseEpoch });
  const start = await waitFor(inbox, (m) => m.type === "xiangqi_state" && m.board);
  const gameId = start.board.gameId;
  // 非法：红炮横穿自己的兵
  send("xiangqi_move", { moveId: "u0", gameId, pieceId: "red_rook_1", toRow: 8, toCol: 1, expectedRevision: 0, leaseEpoch: state.leaseEpoch });
  const bad = await waitFor(inbox, (m) => m.type === "xiangqi_state" && m.result && m.result.reason === "ILLEGAL_MOVE");
  assert.ok(bad, JSON.stringify(inbox.slice(-3).map((m) => m.type)));
  assert.equal(bad.board.revision, 0);
  // 合法：炮进一格
  send("xiangqi_move", { moveId: "u1", gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0, leaseEpoch: state.leaseEpoch });
  const ok = await waitFor(inbox, (m) => m.type === "xiangqi_state" && m.result && m.result.ok);
  assert.equal(ok.board.revision, 1);
  assert.equal(ok.board.turn, "black");
  // 同一 moveId 重发：回放，不再推进
  send("xiangqi_move", { moveId: "u1", gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0, leaseEpoch: state.leaseEpoch });
  const replay = await waitFor(inbox, (m) => m.type === "xiangqi_state" && m.result && m.result.replay);
  assert.equal(replay.board.revision, 1);
});

test("角色落子：计划带 token，提交后才改棋盘；重复提交回放", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = await lastState(inbox);
  send("xiangqi_start", { requestId: "x1", userSide: "red", leaseEpoch: state.leaseEpoch });
  const start = await waitFor(inbox, (m) => m.type === "xiangqi_state" && m.board);
  const gameId = start.board.gameId;
  send("xiangqi_move", { moveId: "u1", gameId, pieceId: "red_cannon_1", toRow: 6, toCol: 1, expectedRevision: 0, leaseEpoch: state.leaseEpoch });
  await waitFor(inbox, (m) => m.type === "xiangqi_state" && m.result && m.result.ok);
  // 注入“她走黑炮”的计划，拿服务端签发的 token
  send("debug_plan", { steps: [{ action: "xiangqi_move", game_id: gameId, piece_id: "black_cannon_1", to_row: 4, to_col: 1, expected_revision: 1 }], leaseEpoch: state.leaseEpoch });
  const exec = await waitFor(inbox, (m) => m.type === "execute_plan");
  assert.ok(exec, "应当派发 execute_plan");
  assert.ok(exec.xiangqiToken, JSON.stringify(exec).slice(0, 200));
  // 未提交时棋盘不动
  const before = await lastState(inbox);
  assert.equal(before.xiangqi.revision, 1);
  // 提交
  send("xiangqi_commit", { token: exec.xiangqiToken, expectedRevision: 1, toRow: 4, toCol: 1, leaseEpoch: state.leaseEpoch });
  const result = await waitFor(inbox, (m) => m.type === "xiangqi_result");
  assert.equal(result.committed, true);
  assert.equal(result.revision, 2);
  // 重复提交：回放，不再结算
  send("xiangqi_commit", { token: exec.xiangqiToken, expectedRevision: 1, toRow: 4, toCol: 1, leaseEpoch: state.leaseEpoch });
  const again = await waitFor(inbox, (m) => m.type === "xiangqi_result" && m.revision === 2);
  assert.ok(again);
});

test("结束：清空棋局", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = await lastState(inbox);
  send("xiangqi_start", { requestId: "x1", userSide: "black", leaseEpoch: state.leaseEpoch });
  await waitFor(inbox, (m) => m.type === "xiangqi_state" && m.board);
  send("xiangqi_end", { leaseEpoch: state.leaseEpoch });
  const ended = await waitFor(inbox, (m) => m.type === "xiangqi_state" && m.board === null);
  assert.ok(ended);
});
