/**
 * 挖掘授权 / 预算取消 / 手动暂停 的集成测试。
 * 用本地 stub 模型返回带 dig 的计划，不连真实 DeepSeek。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STUB_PORT = 19100 + Math.floor(Math.random() * 200);
const BRAIN_PORT = STUB_PORT + 300;
const requests = [];

/** 从模型消息里还原 REQUEST_CONTEXT_JSON（大括号配对） */
function contextOf(body) {
  const content = body?.messages?.[1]?.content ?? "";
  const at = content.indexOf("REQUEST_CONTEXT_JSON:");
  if (at < 0) return null;
  const start = content.indexOf("{", at);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(content.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    const ctx = body ? contextOf(body) : null;
    requests.push(ctx);
    const board = ctx?.board ?? null;
    const out =
      ctx?.phase === "planning" && ctx?.userMessage
        ? {
            type: "execute_plan",
            speech: "",
            steps: [{ action: "dig", game_id: board?.gameId, row: 3, col: 3, expected_revision: board?.revision ?? 0 }],
            memory_proposals: [],
          }
        : { type: "finish_task", outcome: "completed", speech: "", memory_proposals: [] };
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }),
    );
  });
});

await new Promise((resolve) => stub.listen(STUB_PORT, "127.0.0.1", resolve));
stub.unref(); // 不让 stub 的监听句柄拖住测试进程

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-auth-"));
  const proc = spawn(process.execPath, [path.resolve("server/index.mjs")], {
    cwd: dir,
    env: {
      ...process.env,
      BRAIN_PORT: String(BRAIN_PORT),
      DEEPSEEK_API_KEY: "stub-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${STUB_PORT}/chat/completions`,
      DEEPSEEK_MODEL: "stub-model",
      DEEPSEEK_THINKING: "0",
      AUTO_MINESWEEPER: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (process.env.WHALE_TEST_LOG) {
    proc.stdout.on("data", (d) => process.stderr.write(`[srv] ${d}`));
    proc.stderr.on("data", (d) => process.stderr.write(`[srv!] ${d}`));
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${BRAIN_PORT}/ws`);
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
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
  const ws = new WebSocket(`ws://127.0.0.1:${BRAIN_PORT}/ws`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  const send = (type, payload = {}) => ws.send(JSON.stringify({ protocolVersion: 1, type, ...payload }));
  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) send("heartbeat", {});
  }, 2000);
  ws.on("close", () => clearInterval(heartbeat));
  return new Promise((resolve) => ws.on("open", () => resolve({ ws, inbox, send })));
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

const heldSnapshot = (extra = {}) => ({
  x: 0.25,
  z: 0.25,
  yawDeg: 0,
  objects: [
    { object_id: "basin", state: "resting", position: [2.4, 0.134, 1.6], quaternion: [0, 0, 0, 1], upright: true },
    { object_id: "rice_scoop", state: "held", holder: "right_hand", position: [0.2, 0.9, 0.2], quaternion: [0, 0, 0, 1], upright: true },
  ],
  ...extra,
});

const restingScoopSnapshot = (extra = {}) => ({
  x: 0.25,
  z: 0.25,
  yawDeg: 0,
  objects: [
    { object_id: "basin", state: "resting", position: [2.4, 0.134, 1.6], quaternion: [0, 0, 0, 1], upright: true },
    { object_id: "rice_scoop", state: "resting", position: [0.85, 0.016, 0.85], quaternion: [0, 0, 0, 1], upright: true },
  ],
  ...extra,
});

test("挖掘提交必须绑定服务端授权，并且右手有勺", async (t) => {
  const { proc, dir } = await startServer();
  const { ws, inbox, send } = await connect();
  t.after(() => {
    ws.close();
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const state = await waitFor(inbox, (m) => m.type === "session_state");
  assert.ok(state, "需要 session_state");
  const epoch = state.leaseEpoch;
  send("chat_opened", { leaseEpoch: epoch });
  send("game_start", { requestId: "auth-1", leaseEpoch: epoch });
  const game = await waitFor(inbox, (m) => m.type === "game_state" && m.board);
  assert.equal(game.board.cells.length, 256);

  // 勺子在地上：即使有任务也不该能挖
  send("user_message", {
    text: "挖一格",
    leaseEpoch: epoch,
    snapshot: restingScoopSnapshot(),
  });
  const plan = await waitFor(inbox, (m) => m.type === "execute_plan" && m.plan.steps.some((s) => s.action === "dig"));
  assert.ok(plan, "应当收到带 dig 的计划");
  const authId = plan.digAuthId;
  assert.ok(typeof authId === "string" && authId.length > 0, "计划必须带 digAuthId");

  const center = { x: -4 + (3 + 0.5) * 0.5, z: -4 + (3 + 0.5) * 0.5 };
  // 1) 不带授权：拒绝
  send("dig_commit", {
    actionInstanceId: "x1",
    gameId: game.board.gameId,
    row: 3,
    col: 3,
    expectedRevision: 0,
    x: center.x,
    z: center.z,
    leaseEpoch: epoch,
  });
  const noAuth = await waitFor(inbox, (m) => m.type === "dig_result" && m.actionInstanceId === "x1");
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.reason, "NO_AUTH");

  // 2) 有授权但右手没勺：拒绝
  send("dig_commit", {
    actionInstanceId: "x2",
    digAuthId: authId,
    gameId: game.board.gameId,
    row: 3,
    col: 3,
    expectedRevision: 0,
    x: center.x,
    z: center.z,
    leaseEpoch: epoch,
  });
  const noScoop = await waitFor(inbox, (m) => m.type === "dig_result" && m.actionInstanceId === "x2");
  assert.equal(noScoop.ok, false);
  assert.equal(noScoop.reason, "NO_SCOOP");

  // 3) 站位不在格心：拒绝
  send("state_snapshot", { leaseEpoch: epoch, snapshot: heldSnapshot() });
  await sleep(150);
  send("dig_commit", {
    actionInstanceId: "x3",
    digAuthId: authId,
    gameId: game.board.gameId,
    row: 3,
    col: 3,
    expectedRevision: 0,
    x: center.x + 0.5,
    z: center.z,
    leaseEpoch: epoch,
  });
  const offCell = await waitFor(inbox, (m) => m.type === "dig_result" && m.actionInstanceId === "x3");
  assert.equal(offCell.ok, false);
  assert.equal(offCell.reason, "NOT_IN_CELL");

  // 4) 正常提交
  send("dig_commit", {
    actionInstanceId: "x4",
    digAuthId: authId,
    gameId: game.board.gameId,
    row: 3,
    col: 3,
    expectedRevision: 0,
    x: center.x,
    z: center.z,
    leaseEpoch: epoch,
  });
  const ok = await waitFor(inbox, (m) => m.type === "dig_result" && m.actionInstanceId === "x4");
  assert.equal(ok.ok, true);
  assert.equal(ok.revision, 1);

  // 5) 同实例重发：原样回放，不重复改棋盘
  send("dig_commit", {
    actionInstanceId: "x5",
    digAuthId: authId,
    gameId: game.board.gameId,
    row: 3,
    col: 3,
    expectedRevision: 0,
    x: center.x,
    z: center.z,
    leaseEpoch: epoch,
  });
  const replay = await waitFor(inbox, (m) => m.type === "dig_result" && m.actionInstanceId === "x5");
  assert.equal(replay.ok, true);
  assert.equal(replay.revision, 1, "重发必须回放同一个结算");
  assert.equal(replay.reason, undefined);
});

test("预算到期会下发 cancel_plan", async (t) => {
  const { proc, dir } = await startServer({ BRAIN_BUDGET_MS: "2500" });
  const { ws, inbox, send } = await connect();
  t.after(() => {
    ws.close();
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const state = await waitFor(inbox, (m) => m.type === "session_state");
  const epoch = state.leaseEpoch;
  send("chat_opened", { leaseEpoch: epoch });
  send("game_start", { requestId: "budget-1", leaseEpoch: epoch });
  const game = await waitFor(inbox, (m) => m.type === "game_state" && m.board);
  assert.ok(game, "先开一局");
  send("user_message", { text: "挖一格", leaseEpoch: epoch, snapshot: heldSnapshot() });
  const plan = await waitFor(inbox, (m) => m.type === "execute_plan");
  assert.ok(plan, "先要拿到计划");

  const cancel = await waitFor(inbox, (m) => m.type === "cancel_plan", 5000);
  assert.ok(cancel, "预算到期必须通知执行端取消");
  assert.equal(cancel.planId, plan.planId);
  const idle = await waitFor(inbox, (m) => m.type === "session_state" && m.phase === "idle", 3000);
  assert.ok(idle, "取消后任务应回到 idle");
});

test("手动结束的暂停不会被任务收尾覆盖", async (t) => {
  const { proc, dir } = await startServer({
    AUTO_MINESWEEPER: "1",
    AUTO_START_IDLE_MS: "100",
    AUTO_CONTINUE_IDLE_MS: "100",
    AUTO_AFTER_MANUAL_END_MS: "3000",
    AUTO_TICK_MS: "200",
  });
  const { ws, inbox, send } = await connect();
  t.after(() => {
    ws.close();
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const state = await waitFor(inbox, (m) => m.type === "session_state");
  const epoch = state.leaseEpoch;
  send("chat_opened", { leaseEpoch: epoch });
  send("game_start", { requestId: "pause-1", leaseEpoch: epoch });
  const first = await waitFor(inbox, (m) => m.type === "game_state" && m.board);
  assert.ok(first, "先开一局");
  const gameId = first.board.gameId;

  // 关掉聊天，让她有机会自己动；然后手动结束
  send("chat_closed", { leaseEpoch: epoch });
  send("game_end", { leaseEpoch: epoch });
  const ended = await waitFor(inbox, (m) => m.type === "game_state" && m.ended);
  assert.ok(ended, "结束应回包");

  // 新对局可能通过 game_state（按钮回包）或 session_state.game（服务端广播）下发。
  // 用“结束时刻已知的 gameId 集合”判断是否又开了一局，避免被之前的自主开局干扰。
  const gameIds = () =>
    inbox
      .map((m) => (m.type === "game_state" ? m.board : m.type === "session_state" ? m.game : null))
      .filter(Boolean)
      .map((g) => g.gameId);
  const known = new Set(gameIds());
  const unseenGame = () => gameIds().find((id) => !known.has(id)) ?? null;

  // 3 秒暂停期内不允许自己开新局
  await sleep(1500);
  assert.equal(unseenGame(), null, "手动结束后的暂停期内不该自己开新局");

  // 暂停过后会恢复自主开局
  let resumed = null;
  const t0 = Date.now();
  while (!resumed && Date.now() - t0 < 6000) {
    resumed = unseenGame();
    if (!resumed) await sleep(100);
  }
  assert.ok(resumed, "暂停结束后应当恢复自主开局");
});


test("扫雷进行中一分钟没有模型活动会被主动唤醒", async (t) => {
  const { proc, dir } = await startServer({
    AUTO_MINESWEEPER: "1",
    // 把正常续玩/开局都推远，只留看门狗一条路径
    AUTO_START_IDLE_MS: "600000",
    AUTO_CONTINUE_IDLE_MS: "600000",
    AUTO_STILL_PLAYING_MS: "500",
    AUTO_TICK_MS: "150",
    AUTO_MAX_CALLS: "50",
  });
  const { ws, inbox, send } = await connect();
  t.after(() => {
    ws.close();
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const state = await waitFor(inbox, (m) => m.type === "session_state");
  const epoch = state.leaseEpoch;
  send("chat_opened", { leaseEpoch: epoch });
  send("game_start", { requestId: "still-1", leaseEpoch: epoch });
  const game = await waitFor(inbox, (m) => m.type === "game_state" && m.board);
  assert.ok(game, "先要有一局在进行");
  send("chat_closed", { leaseEpoch: epoch });

  // 之后什么都不做：超过阈值没有模型活动时，宿主应当自己发一条提醒
  const t0 = Date.now();
  let hit = null;
  while (!hit && Date.now() - t0 < 8000) {
    hit = requests.find((r) => (r?.attentionEvents ?? []).some((e) => e.type === "game_still_active")) ?? null;
    if (!hit) await sleep(120);
  }
  assert.ok(hit, "扫雷进行中超过阈值没有模型活动，应当主动唤醒");
  assert.equal(hit.board?.status, "playing", "提醒时棋盘应当仍在进行中");
});
