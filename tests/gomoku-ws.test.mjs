/**
 * 五子棋 WS 链路：开局（她执黑）→ 派发落子授权 → 客户端走到位后提交 → 用户落子。
 * 用 BRAIN_DEV=1 的 debug_plan 注入“服务端计划”，走真实的授权/派发/提交路径。
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
  return new Promise((res) =>
    ws.on("open", () => {
      // 伪客户端也要报运行版本：落子要求 count33（走到位 + 提交）
      send("hello", { runtimeVersion: "playful-v2-count33", stopReadyProtocol: 1 });
      res({ ws, inbox, send });
    }),
  );
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

/** 拿到 hello 之后最新的 session_state（代际以它为准） */
async function lastState(inbox) {
  await sleep(150);
  return inbox.filter((m) => m.type === "session_state").at(-1);
}

/** 交点世界坐标（与服务端 cellCenter 一致） */
const cellCenter = (row, col) => {
  const cell = 8 / 15;
  return { x: -4 + (col + 0.5) * cell, z: -4 + (row + 0.5) * cell };
};

test("开局：她执黑，棋盘 15×15、0 子、轮到黑方", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await lastState(inbox);
  send("gomoku_start", { requestId: "g1", leaseEpoch: state.leaseEpoch });
  const board = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);
  assert.ok(board, "应当回 gomoku_state");
  assert.equal(board.board.size, 15);
  assert.equal(board.board.moves, 0);
  assert.equal(board.board.turn, "black");
  assert.equal(board.board.status, "playing");
  assert.equal(typeof board.board.stoneToleranceM, "number");
});

test("她的落子必须带授权并站在交点上：只派发不动棋盘", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await lastState(inbox);
  const epoch = state.leaseEpoch;
  send("gomoku_start", { requestId: "g1", leaseEpoch: epoch });
  const start = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);

  send("debug_plan", {
    leaseEpoch: epoch,
    steps: [{ action: "place_stone", game_id: start.board.gameId, row: 7, col: 7, expected_revision: 0 }],
  });
  const plan = await waitFor(inbox, (m) => m.type === "execute_plan" && m.stoneAuthId);
  assert.ok(plan, "应当下发 execute_plan + 落子授权");
  assert.equal(plan.plan.steps.at(-1).action, "place_stone");

  assert.equal(
    inbox.filter((m) => m.type === "gomoku_state" && m.board && m.board.moves > 0).length,
    0,
    "只派发不提交时棋盘不能变",
  );

  const center = cellCenter(7, 7);
  send("gomoku_commit", {
    leaseEpoch: epoch,
    stoneAuthId: plan.stoneAuthId,
    gameId: start.board.gameId,
    row: 7,
    col: 7,
    expectedRevision: 0,
    x: center.x,
    z: center.z,
  });
  const result = await waitFor(inbox, (m) => m.type === "stone_result");
  assert.ok(result, "应当回 stone_result");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.board.moves, 1, "提交后棋盘上多一子");
  assert.equal(result.board.turn, "white", "提交后轮到白方");
  assert.equal(result.board.stones[0].row, 7);
  assert.equal(result.board.stones[0].color, "black");
});

test("超出 1m 可操作范围：提交被拒，棋盘不变", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await lastState(inbox);
  const epoch = state.leaseEpoch;
  send("gomoku_start", { requestId: "g1", leaseEpoch: epoch });
  const start = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);

  // 目标在角落（离中心 3.77m），超过 1m 的可操作半径
  send("debug_plan", {
    leaseEpoch: epoch,
    steps: [{ action: "place_stone", game_id: start.board.gameId, row: 3, col: 3, expected_revision: 0 }],
  });
  const plan = await waitFor(inbox, (m) => m.type === "execute_plan" && m.stoneAuthId);
  assert.ok(plan);

  const center = cellCenter(3, 3);
  send("gomoku_commit", {
    leaseEpoch: epoch,
    stoneAuthId: plan.stoneAuthId,
    gameId: start.board.gameId,
    row: 3,
    col: 3,
    expectedRevision: 0,
    x: center.x,
    z: center.z,
  });
  const result = await waitFor(inbox, (m) => m.type === "stone_result");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_ALIGNED");
  assert.ok(result.distance_m > 0.2, JSON.stringify(result));
  assert.ok(String(result.hint).includes("可操作范围"), JSON.stringify(result));
  assert.equal(result.tolerance_m, 1);

  const moved = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board && m.board.moves > 0, 800);
  assert.equal(moved, null, "被拒时棋盘不应改变");
});

test("没有授权不能落子", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await lastState(inbox);
  const epoch = state.leaseEpoch;
  send("gomoku_start", { requestId: "g1", leaseEpoch: epoch });
  const start = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);
  const center = cellCenter(7, 7);
  send("gomoku_commit", {
    leaseEpoch: epoch,
    stoneAuthId: "forge-me",
    gameId: start.board.gameId,
    row: 7,
    col: 7,
    expectedRevision: 0,
    x: center.x,
    z: center.z,
  });
  const result = await waitFor(inbox, (m) => m.type === "stone_result");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_AUTH");
});

test("用户落子：轮到她之前不能被接受；接受后回合切换", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await lastState(inbox);
  const epoch = state.leaseEpoch;
  send("gomoku_start", { requestId: "g1", leaseEpoch: epoch });
  const start = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);
  const gameId = start.board.gameId;

  send("gomoku_move", { leaseEpoch: epoch, gameId, row: 5, col: 5, expectedRevision: 0 });
  const rejected = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.result && m.result.ok === false);
  assert.ok(rejected, "应当回一条拒绝");
  assert.equal(rejected.result.reason, "NOT_YOUR_TURN");

  send("debug_plan", { leaseEpoch: epoch, steps: [{ action: "place_stone", game_id: gameId, row: 7, col: 7, expected_revision: 0 }] });
  const plan = await waitFor(inbox, (m) => m.type === "execute_plan" && m.stoneAuthId);
  const center = cellCenter(7, 7);
  send("gomoku_commit", { leaseEpoch: epoch, stoneAuthId: plan.stoneAuthId, gameId, row: 7, col: 7, expectedRevision: 0, x: center.x, z: center.z });
  await waitFor(inbox, (m) => m.type === "stone_result" && m.ok === true);

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

  const state = await lastState(inbox);
  const epoch = state.leaseEpoch;
  send("gomoku_start", { requestId: "g1", leaseEpoch: epoch });
  const start = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board);
  send("debug_plan", { leaseEpoch: epoch, steps: [{ action: "place_stone", game_id: start.board.gameId, row: 7, col: 7, expected_revision: 0 }] });
  const plan = await waitFor(inbox, (m) => m.type === "execute_plan" && m.stoneAuthId);
  const center = cellCenter(7, 7);
  send("gomoku_commit", { leaseEpoch: epoch, stoneAuthId: plan.stoneAuthId, gameId: start.board.gameId, row: 7, col: 7, expectedRevision: 0, x: center.x, z: center.z });
  await waitFor(inbox, (m) => m.type === "stone_result" && m.ok === true);

  send("gomoku_end", { leaseEpoch: epoch });
  const ended = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board && m.board.status === "ended");
  assert.ok(ended, "应当进入 ended 且盘面保留");
  assert.equal(ended.board.moves, 1);

  send("gomoku_end", { leaseEpoch: epoch });
  const cleared = await waitFor(inbox, (m) => m.type === "gomoku_state" && m.board === null);
  assert.ok(cleared, "第二次结束应当收摊");
});
