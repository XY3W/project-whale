/**
 * 回归：手动结束（扫雷结束/收起）会设下“不再自动开局”的暂停，
 * 但这不能挡住事件回合——否则手动开五子棋时她根本不会被叫起来落子。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const PORT = 8900 + Math.floor(Math.random() * 90);
const MODEL_PORT = PORT + 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 最小的流式模型桩：记录请求，统一回 finish_task */
function startModelStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push(raw);
      const plan = { type: "finish_task", outcome: "completed", speech: "" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(MODEL_PORT, "127.0.0.1", () => resolve({ server, requests })));
}

async function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-gomoku-pause-"));
  const proc = spawn(process.execPath, [path.resolve("server/index.mjs")], {
    cwd: dir,
    env: { ...process.env, BRAIN_PORT: String(PORT), AUTO_MINESWEEPER: "0", ...env },
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

async function waitFor(pred, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = pred();
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}

test("手动结束扫雷之后手动开五子棋，仍然会触发模型回合", async (t) => {
  const { server, requests } = await startModelStub();
  const { proc, dir } = await startServer({
    DEEPSEEK_API_KEY: "stub",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/chat/completions`,
    DEEPSEEK_THINKING: "0",
  });
  const { ws, inbox, send } = await connect();
  t.after(() => { ws.close(); proc.kill(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const state = await waitFor(() => inbox.find((m) => m.type === "session_state"));
  const epoch = state.leaseEpoch;
  send("chat_closed", { leaseEpoch: epoch });

  // 手动结束扫雷两次（结束 → 收起），这一步会设下“不再自动开局”的暂停
  send("game_start", { requestId: "ms1", leaseEpoch: epoch });
  await waitFor(() => inbox.find((m) => m.type === "game_state" && m.board));
  send("game_end", { leaseEpoch: epoch });
  await waitFor(() => inbox.find((m) => m.type === "game_state" && m.board && m.board.status === "ended"));
  send("game_end", { leaseEpoch: epoch });
  await waitFor(() => inbox.find((m) => m.type === "game_state" && m.board === null));

  // 再手动开五子棋：她执黑，必须被叫起来
  send("gomoku_start", { requestId: "gm1", leaseEpoch: epoch });
  const board = await waitFor(() => inbox.find((m) => m.type === "gomoku_state" && m.board));
  assert.ok(board, "五子棋应当开局");

  const woke = await waitFor(() => requests.some((r) => r.includes("gomoku_started")));
  assert.ok(woke, "手动开局后应当触发一次模型回合（gomoku_started）");
});
