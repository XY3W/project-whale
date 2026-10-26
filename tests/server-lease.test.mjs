/**
 * 服务端租约/代际/去重集成测试（FakeBrain，不联网）。
 * 运行：node --test tests/server-lease.test.mjs   （在服务器仓库根目录）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const PORT = 8100 + Math.floor(Math.random() * 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-test-"));
  const proc = spawn(process.execPath, [path.resolve("server/index.mjs")], {
    cwd: dir,
    env: { ...process.env, BRAIN_PORT: String(PORT), DEEPSEEK_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 就绪信号：可连接即视为启动完成，替代固定 sleep
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.close();
      await sleep(100);
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
  return new Promise((resolve) => ws.on("open", () => resolve({ ws, inbox })));
}

async function waitFor(inbox, pred, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = inbox.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

test("租约、代际与重复结果去重", async (t) => {
  const { proc, dir } = await startServer();
  t.after(async () => {
    try { a.ws.close(); b.ws.close(); } catch {}
    await new Promise((resolve) => {
      proc.once("exit", resolve);
      proc.kill();
      setTimeout(resolve, 2000);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const a = await connect();
  const aState = await waitFor(a.inbox, (m) => m.type === "session_state");
  assert.equal(aState.readOnly, false, "首个连接应取得执行权");
  assert.ok(aState.leaseEpoch >= 1);

  const b = await connect();
  const bState = await waitFor(b.inbox, (m) => m.type === "session_state");
  assert.equal(bState.readOnly, true, "第二个连接应只读");

  // 未打开聊天时拒绝发送
  a.ws.send(JSON.stringify({ protocolVersion: 1, type: "user_message", text: "挥挥手", leaseEpoch: aState.leaseEpoch }));
  const closed = await waitFor(a.inbox, (m) => m.type === "error");
  assert.equal(closed.code, "CHAT_CLOSED");

  // 只读端的周期快照静默忽略（不是用户动作，不该在只读页点亮错误图标），
  // 但绝不能改服务端位置：下面的广播里角色坐标必须还是原值
  b.inbox.length = 0;
  b.ws.send(JSON.stringify({ protocolVersion: 1, type: "state_snapshot", snapshot: { x: 1.234, z: 0, yawDeg: 0 } }));
  await sleep(150);
  assert.equal(b.inbox.filter((m) => m.type === "error").length, 0, "只读端快照不应报错");
  // 写操作必须带当前租约代际；缺字段也要被拒绝
  a.ws.send(JSON.stringify({ protocolVersion: 1, type: "chat_opened" }));
  await sleep(150);
  a.ws.send(JSON.stringify({ protocolVersion: 1, type: "chat_opened", leaseEpoch: aState.leaseEpoch }));
  const afterState = await waitFor(b.inbox, (m) => m.type === "session_state");
  assert.ok(afterState, "带代际的请求应当被接受");
  assert.notEqual(afterState.character?.x, 1.234, "只读端不能改位置");

  b.ws.send(JSON.stringify({ protocolVersion: 1, type: "chat_opened" }));
  await sleep(150);
  b.ws.send(JSON.stringify({ protocolVersion: 1, type: "user_message", text: "挥挥手" }));
  const denied = await waitFor(b.inbox, (m) => m.type === "error" && m.code === "NOT_EXECUTOR");
  assert.equal(denied.code, "NOT_EXECUTOR");

  // 打开聊天后执行端拿计划
  a.ws.send(JSON.stringify({ protocolVersion: 1, type: "chat_opened" }));
  a.ws.send(JSON.stringify({ protocolVersion: 1, type: "user_message", text: "挥挥手", leaseEpoch: aState.leaseEpoch }));
  const plan = await waitFor(a.inbox, (m) => m.type === "execute_plan");
  assert.ok(plan, "应收到 execute_plan");
  assert.ok(plan.planId, "计划必须带 planId");
  assert.ok(typeof plan.generation === "number", "计划必须带 generation");

  // 同一个 planId 提交两次：只应产生一条公开回复
  const payload = {
    protocolVersion: 1,
    type: "plan_result",
    taskId: plan.taskId,
    planId: plan.planId,
    generation: plan.generation,
    leaseEpoch: aState.leaseEpoch,
    result: { status: "completed", steps: [{ status: "succeeded" }], stopped: true },
  };
  a.ws.send(JSON.stringify(payload));
  await sleep(200);
  a.ws.send(JSON.stringify(payload));

  await sleep(1200);
  const replies = a.inbox.filter((m) => m.type === "public_reply");
  assert.equal(replies.length, 1, "重复结果不得重复回复");

  // 旧代际结果必须被忽略
  a.ws.send(
    JSON.stringify({ ...payload, planId: "stale-plan", generation: plan.generation - 1 }),
  );
  await sleep(600);
  const after = a.inbox.filter((m) => m.type === "public_reply");
  assert.equal(after.length, 1, "旧代际结果不得影响当前任务");
});
