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

const PORT = 8097;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-test-"));
  const proc = spawn(process.execPath, [path.resolve("server/index.mjs")], {
    cwd: dir,
    env: { ...process.env, BRAIN_PORT: String(PORT), DEEPSEEK_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await sleep(600);
  return { proc, dir };
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
  t.after(() => {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const a = await connect();
  const aState = await waitFor(a.inbox, (m) => m.type === "session_state");
  assert.equal(aState.readOnly, false, "首个连接应取得执行权");
  assert.ok(aState.leaseEpoch >= 1);

  const b = await connect();
  const bState = await waitFor(b.inbox, (m) => m.type === "session_state");
  assert.equal(bState.readOnly, true, "第二个连接应只读");

  // 只读端发消息被拒绝
  b.ws.send(JSON.stringify({ protocolVersion: 1, type: "user_message", text: "挥挥手" }));
  const denied = await waitFor(b.inbox, (m) => m.type === "error");
  assert.equal(denied.code, "NOT_EXECUTOR");

  // 执行端拿计划
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
