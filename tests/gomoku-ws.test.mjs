/**
 * 五子棋 WS 链路：开局（她执黑）→ 服务端派发落子 → 用户落子 → 轮到她的看门狗。
 * 用 BRAIN_DEV=1 的 debug_plan 注入“服务端计划”，走真实的派发/落子路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const PORT = 8700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-gomoku-ws-"));
  const proc = spawn(process.execPath, [path.resolve("server/index.mjs")], {
    cwd: dir,
    env: { ...process.env, BRAIN_PORT: String(PORT), DEEPSEEK_API_KEY: "", BRAIN_DEV: "1", AUTO_MINESWEEPER: "0", ...extra },
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
    } catch {
      await sleep(100);
    }
  }
  throw new Error("server did not become ready");
}

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  const send = (type, payload = {}) => ws.send(JSON.stringify({ protocolVersion: 1, type, ...payload }));
  return new Promise((res) => ws.on("open", () => res({ ws, inbox, send })));
}

async function waitFor(inbox, pred, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = inbox.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

const latestGomoku = (inbox) =>
  inbox.filter((m) => m.type === "gomoku_state" && m.board).at(-1)?.board ?? null;

test("开局：她执黑，棋盘 15×15、0 子、轮到黑方", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await waitFor(inbox, (m) => m.type === "session_state");
  send("gomoku_start", { requestId: "g1", leaseEpoch: state.leaseEpoch });
  const board = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);
  assert.ok(board, "应当回 gomoku_state");
  assert.equal(board.board.size, 15);
  assert.equal(board.board.moves, 0);
  assert.equal(board.board.turn, "black");
  assert.equal(board.board.status, "playing");
});

test("她落子：服务端派发时原子落地，轮到用户", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await waitFor(inbox, (m) => m.type === "session_state");
  const epoch = state.leaseEpoch;
  send("gomoku_start", { requestId: "g1", leaseEpoch: epoch });
  const start = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);
  assert.ok(start);

  // 注入一份“她的计划”：落子在中心
  send("debug_plan", {
    leaseEpoch: epoch,
    steps: [{ action: "place_stone", game_id: start.board.gameId, row: 7, col: 7, expected_revision: 0 }],
  });
  const after = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board && m.board.moves === 1 && m.board.turn === "white");
  assert.ok(after, "她的落子应当被服务端接受并轮到白方");
  assert.equal(after.board.stones[0].row, 7);
  assert.equal(after.board.stones[0].color, "black");
});

test("用户落子：轮到她之前不能被接受；接受后回合切换", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await waitFor(inbox, (m) => m.type === "session_state");
  const epoch = state.leaseEpoch;
  send("gomoku_start", { requestId: "g1", leaseEpoch: epoch });
  const start = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);
  const gameId = start.board.gameId;

  // 黑方还没走，白方先点：拒绝
  send("gomoku_move", { leaseEpoch: epoch, gameId, row: 5, col: 5, expectedRevision: 0 });
  const rejected = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.result && m.result.ok === false);
  assert.ok(rejected, "应当回一条拒绝");
  assert.equal(rejected.result.reason, "NOT_YOUR_TURN");

  // 她先落子
  send("debug_plan", { leaseEpoch: epoch, steps: [{ action: "place_stone", game_id: gameId, row: 7, col: 7, expected_revision: 0 }] });
  await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board && m.board.moves === 1);

  // 用户在白方回合落子
  send("gomoku_move", { leaseEpoch: epoch, gameId, row: 7, col: 8, expectedRevision: 1 });
  const accepted = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board && m.board.moves === 2);
  assert.ok(accepted, "用户的落子应当被接受");
  assert.equal(accepted.board.turn, "black");
  assert.equal(accepted.board.stones.at(-1).color, "white");
});

test("结束：进行中结束保留盘面，再点收摊", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await waitFor(inbox, (m) => m.type === "session_state");
  const epoch = state.leaseEpoch;
  send("gomoku_start", { requestId: "g1", leaseEpoch: epoch });
  const start = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);
  send("debug_plan", { leaseEpoch: epoch, steps: [{ action: "place_stone", game_id: start.board.gameId, row: 7, col: 7, expected_revision: 0 }] });
  await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board && m.board.moves === 1);

  send("gomoku_end", { leaseEpoch: epoch });
  const ended = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board && m.board.status === "ended");
  assert.ok(ended, "应当进入 ended 且盘面保留");
  assert.equal(ended.board.moves, 1);

  send("gomoku_end", { leaseEpoch: epoch });
  const cleared = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board === null);
  assert.ok(cleared, "第二次结束应当收摊");
});
