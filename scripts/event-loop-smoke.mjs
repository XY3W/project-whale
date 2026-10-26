/**
 * 事件循环验收：用本地假模型跑通「按钮开局 → 自主思考 → 挖一格 → 棋盘事件合并审核」。
 *
 * 不连真实 Key：DEEPSEEK_BASE_URL 指向本进程内的 stub，请求体全部留档，
 * 用来断言提示词里到底带了什么（棋盘、槽位、事件、执行报告）。
 *
 *   node scripts/event-loop-smoke.mjs
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STUB_PORT = 18098;
const BRAIN_PORT = 18099;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "whale-event-"));

const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requests = [];

/** 从模型消息里还原 REQUEST_CONTEXT_JSON（大括号配对，后面还跟着输出契约） */
function contextOf(body) {
  const content = body?.messages?.[1]?.content ?? "";
  const at = content.indexOf("REQUEST_CONTEXT_JSON:");
  if (at < 0) return null;
  const start = content.indexOf("{", at);
  if (start < 0) return null;
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

/** 假模型：按阶段和执行上下文返回固定计划，并把看到的 context 记下来 */
function reply(body) {
  const ctx = contextOf(body);
  requests.push({ phase: ctx?.phase, ctx, at: Date.now() });
  const board = ctx?.board ?? null;
  const events = ctx?.attentionEvents ?? [];
  const report = ctx?.executionReport ?? null;
  const digged = (report?.steps ?? []).some((s) => s.action === "dig" && s.status === "succeeded");

  if (ctx?.phase === "planning" && events.some((e) => e.type === "game_started")) {
    // 自主回合也要能真的下指令：先看一眼棋盘，不说话
    return { type: "execute_plan", speech: "", steps: [{ action: "play", action_id: "notice" }], memory_proposals: [] };
  }
  if (ctx?.phase === "review" && !digged && !ctx?.userMessage && ctx?.goal?.origin === "event") {
    return { type: "finish_task", outcome: "completed", speech: "", memory_proposals: [] };
  }
  if (ctx?.phase === "review" && digged && board?.status === "playing" && !ctx.__secondDig) {
    // 第一次挖掘之后：用最新棋盘再挖一格（验证 review 拿到了 board_updated）
    return {
      type: "execute_plan",
      speech: "",
      steps: [{ action: "dig", game_id: board.gameId, row: 0, col: 0, expected_revision: board.revision }],
      memory_proposals: [],
    };
  }
  if (ctx?.phase === "planning" && ctx?.userMessage) {
    return {
      type: "execute_plan",
      speech: "我挖一格。",
      steps: [{ action: "dig", game_id: board?.gameId, row: 5, col: 5, expected_revision: board?.revision ?? 0 }],
      memory_proposals: [],
    };
  }
  return { type: "finish_task", outcome: "completed", speech: "", memory_proposals: [] };
}

const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    if (!body) {
      res.writeHead(400).end("{}");
      return;
    }
    let out;
    try {
      out = reply(body);
    } catch (err) {
      console.error("[stub] reply failed", err);
      out = { type: "finish_task", outcome: "completed", speech: "", memory_proposals: [] };
    }
    console.error(`[stub] hit phase=${requests.at(-1)?.ctx?.phase} events=${(requests.at(-1)?.ctx?.attentionEvents ?? []).length} → ${out.type}`);
    // 第二份 dig 计划只能出现一次：用一个标记避免假模型在后续审核里重复挖
    const ctx = requests.at(-1)?.ctx;
    if (out.steps?.[0]?.action === "dig" && ctx) ctx.__secondDig = true;
    const payload = {
      id: "stub",
      choices: [{ message: { content: JSON.stringify(out) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
});

/** 全量收件箱：晚到的消息也能被后面的断言拿到，不依赖监听时机 */
const inbox = [];
function listen(ws) {
  ws.on("message", (raw) => {
    try {
      inbox.push(JSON.parse(String(raw)));
    } catch {}
  });
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const t0 = Date.now();
  let cursor = 0;
  while (Date.now() - t0 < timeoutMs) {
    for (; cursor < inbox.length; cursor++) {
      if (predicate(inbox[cursor])) return inbox[cursor];
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const send = (ws, type, payload = {}) => ws.send(JSON.stringify({ protocolVersion: 1, type, ...payload }));

function boardOf(msg) {
  return msg.board ?? msg.game ?? null;
}

async function main() {
  await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
    cwd: TMP,
    env: {
      ...process.env,
      BRAIN_PORT: String(BRAIN_PORT),
      DEEPSEEK_API_KEY: "stub-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${STUB_PORT}/chat/completions`,
      DEEPSEEK_MODEL: "stub-model",
      DEEPSEEK_THINKING: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  await sleep(700);
  const ws = new WebSocket(`ws://127.0.0.1:${BRAIN_PORT}/ws`);
  const failures = [];
  const check = (cond, message) => {
    if (cond) log(`  ✔ ${message}`);
    else {
      failures.push(message);
      log(`  ✘ ${message}`);
    }
  };

  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    listen(ws);
    await waitFor((m) => m.type === "session_state", "session_state");
    const initial = await waitFor((m) => m.type === "session_state", "initial state");
    send(ws, "chat_opened", {});

    log("\n[1] 按钮开局 → 服务端自主唤醒模型");
    send(ws, "game_start", { requestId: "smoke-1" });
    const gameState = await waitFor((m) => m.type === "game_state", "game_state");
    const board0 = boardOf(gameState);
    check(board0?.cells?.length === 256, "棋盘 256 格（16×16）");
    check(board0?.cells?.every((c) => c.state === "hidden" && c.value === undefined), "开局未揭示格没有 value");

    const firstPlan = await waitFor((m) => m.type === "execute_plan", "autonomous execute_plan");
    const autonomy = requests.find((r) => r.ctx?.attentionEvents?.some((e) => e.type === "game_started"));
    check(!!autonomy, "game_started 事件触发了模型调用");
    check(autonomy?.ctx?.board?.rows?.length === 16 && autonomy.ctx.board.rows.every((r) => r.length === 16), "规划上下文带 16×16 字符网格");
    check(autonomy?.ctx?.props?.slots?.left_hand === null || autonomy?.ctx?.props?.slots, "规划上下文带双手槽位");
    check(!JSON.stringify(autonomy?.ctx ?? {}).includes('"mines"'), "上下文不含雷表字段");
    check(firstPlan.taskId === autonomy?.ctx?.taskId, "自主计划与这次调用的任务一致");

    // 自主回合结束（假模型 finish_task），服务端应回到 idle
    const idle = await waitFor((m) => m.type === "session_state" && m.phase === "idle", "idle after event turn");
    check(!!idle, "自主回合结束后回到 idle");

    log("\n[2] 用户消息 → 挖一格 → dig_commit → plan_result");
    const before = requests.length;
    send(ws, "user_message", {
      text: "挖一格试试",
      leaseEpoch: idle.leaseEpoch,
      snapshot: {
        x: 0.4,
        z: -0.4,
        yawDeg: 0,
        objects: [
          { object_id: "basin", state: "resting", position: [2.4, 0.134, 1.6], quaternion: [0, 0, 0, 1], upright: true },
          { object_id: "rice_scoop", state: "held", holder: "right_hand", position: [0.4, 0.9, -0.4], quaternion: [0, 0, 0, 1], upright: true },
        ],
      },
    });
    const plan1 = await waitFor((m) => m.type === "execute_plan" && m !== firstPlan, "dig plan");
    const digStep = plan1.plan.steps.find((s) => s.action === "dig");
    check(!!digStep, "计划里有 dig");
    const planningTurn = requests.slice(before).find((r) => r.ctx?.phase === "planning");
    check(planningTurn?.ctx?.props?.slots?.right_hand === "rice_scoop", "上下文看到右手持勺");

    // 客户端执行：走到格心后提交 dig_commit，再回 plan_result
    const cellSize = board0.cellSize ?? 0.5;
    const center = { x: -4 + (digStep.col + 0.5) * cellSize, z: -4 + (digStep.row + 0.5) * cellSize };
    send(ws, "dig_commit", {
      actionInstanceId: "d1",
      gameId: digStep.game_id,
      row: digStep.row,
      col: digStep.col,
      expectedRevision: digStep.expected_revision,
      x: center.x,
      z: center.z,
      leaseEpoch: idle.leaseEpoch,
    });
    const digResult = await waitFor((m) => m.type === "dig_result", "dig_result");
    check(digResult.ok === true, `服务端结算成功（changed=${digResult.changedCells?.length}）`);
    check(digResult.revision === 1, "revision 增长到 1");

    send(ws, "plan_result", {
      taskId: plan1.taskId,
      generation: plan1.generation,
      planId: plan1.planId,
      leaseEpoch: idle.leaseEpoch,
      result: {
        status: "completed",
        steps: [
          {
            stepId: "s1",
            action: "dig",
            status: "succeeded",
            requested: { row: digStep.row, col: digStep.col },
            actual: { ok: true, revision: digResult.revision },
            startState: {},
            endState: {},
            reasonCode: "OK",
            durationMs: 1200,
          },
        ],
      },
      snapshot: {
        x: center.x,
        z: center.z,
        yawDeg: 0,
        objects: [
          { object_id: "basin", state: "resting", position: [2.4, 0.134, 1.6], quaternion: [0, 0, 0, 1], upright: true },
          { object_id: "rice_scoop", state: "held", holder: "right_hand", position: [center.x, 0.9, center.z], quaternion: [0, 0, 0, 1], upright: true },
        ],
      },
    });

    log("\n[3] 审核合并 board_updated");
    await sleep(1500);
    const reviewTurn = requests.find((r) => r.ctx?.phase === "review" && r.ctx?.executionReport);
    check(!!reviewTurn, "dig 之后发生了 review");
    check(
      (reviewTurn?.ctx?.attentionEvents ?? []).some((e) => e.type === "board_updated" && e.revision === 1),
      "review 同时收到 board_updated@1（与 plan_result 合并）",
    );
    check(reviewTurn?.ctx?.board?.revision === 1, "review 看到最新棋盘 revision");
    check(reviewTurn?.ctx?.board?.rows?.some((row) => /[0-9*]/.test(row)), "review 棋盘包含已揭示格");

    // review 里的后续 dig 计划应当到达客户端
    const plan2 = await waitFor((m) => m.type === "execute_plan" && m.taskId === plan1.taskId && m.planId !== plan1.planId, "second dig plan", 8000);
    check(plan2.planId !== plan1.planId, "第二次挖掘是同一任务的新计划");
    check(plan2.plan.steps.at(-1).action === "dig", "后续计划仍以 dig 收尾");

    // 同一批事件不会被重复投喂
    const dupes = requests.filter((r) => (r.ctx?.attentionEvents ?? []).some((e) => e.type === "board_updated" && e.revision === 1));
    check(dupes.length === 1, `board_updated@1 只消费一次（实际 ${dupes.length} 次）`);
  } catch (err) {
    failures.push(String(err));
    log("  ✘", err);
  } finally {
    ws.close();
    child.kill();
    stub.close();
  }

  if (failures.length) {
    console.log(`\n✘ ${failures.length} 项失败`);
    console.log(logs.join(""));
    process.exitCode = 1;
  } else {
    console.log("\n✔ 事件循环冒烟通过");
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
