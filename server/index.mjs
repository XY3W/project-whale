/**
 * M3：服务端闭环（FakeBrain）+ 租约、抢占、预算、去重。
 *
 * 规则来源 NEXT_PHASE_LLM_PLAN.md §3 / §11 / §12：
 * - 同一角色会话只允许一个执行浏览器（lease + heartbeat）
 * - 新消息抢占旧任务：撤销未执行步骤，保留部分结果，丢弃晚到的旧结果
 * - 每个任务最多 4 轮 execute→review、180 秒活动预算，超限 blocked
 * - 重复 plan_result 只忽略，不重复回复、不重复执行
 * - 执行端断开后任务标记 unknown，重连先对账，不盲重播
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.BRAIN_PORT ?? 8091);
const ROOT = path.resolve(process.cwd(), "dist");
const PROTOCOL = 1;
const HEARTBEAT_MS = 6_000;
const MAX_ROUNDS = 4;
const BUDGET_MS = 180_000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res) {
  if (!fs.existsSync(ROOT)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("whale brain is running (no dist yet)\n");
    return;
  }
  const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "");
  let file = path.resolve(ROOT, rel || "index.html");
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  const ext = path.extname(file);
  res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: "/ws" });

let nextTask = 100;
const session = {
  id: `s${Date.now()}`,
  lease: null,          // 当前执行端 ws
  leaseAt: 0,
  task: null,           // { id, text, rounds, startedAt, superseded, plan }
  phase: "idle",
  lastResult: null,     // { taskId, round } 用于去重
};

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ protocolVersion: PROTOCOL, type, ...payload, seq: ++ws._seq }));
}

const isLease = (ws) => session.lease === ws;
const isLeaseAlive = () => session.lease && Date.now() - session.leaseAt < HEARTBEAT_MS;

function broadcastState() {
  const payload = {
    sessionId: session.id,
    phase: session.phase,
    taskId: session.task?.id ?? null,
    hasExecutor: isLeaseAlive(),
  };
  for (const ws of wss.clients) send(ws, "session_state", { ...payload, readOnly: false });
}

function endTask(reason) {
  session.task = null;
  session.phase = "idle";
  broadcastState();
  if (reason) console.log(`[task] ${reason}`);
}

function planFor(text) {
  if (/挥手|打招呼|hello|hi/i.test(text)) return { speech: "好呀。", steps: [{ action: "play", action_id: "greet" }] };
  if (/转|转身/.test(text)) return { speech: "我转一下。", steps: [{ action: "turn", angle_deg: 45 }] };
  if (/走|过来|靠近|近一点/.test(text)) return { speech: "我走过去一点。", steps: [{ action: "walk", distance_m: 0.27 }] };
  if (/摆尾|尾巴/.test(text)) return { speech: "尾巴动一动。", steps: [{ action: "tail", style: "tail_swish", duration_s: 2 }] };
  return null;
}

function summary(result) {
  const steps = result?.steps ?? [];
  const failed = steps.find((s) => s.status !== "succeeded");
  if (failed) return `动作没有完成（${failed.reasonCode}）。`;
  return `做好了（${steps.filter((s) => s.status === "succeeded").length} 个动作）。`;
}

wss.on("connection", (ws) => {
  ws._seq = 0;

  // 租约：没有活着的执行端就接管；否则只读
  session.lease = ws;
  session.leaseAt = Date.now();
  send(ws, "session_state", {
    sessionId: session.id,
    phase: session.phase,
    taskId: session.task?.id ?? null,
    hasExecutor: true,
    readOnly: false,
    needsReconcile: !!session.task && ws === session.lease,
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.protocolVersion && msg.protocolVersion !== PROTOCOL) {
      send(ws, "error", { code: "PROTOCOL_MISMATCH", message: "协议版本不一致" });
      return;
    }

    switch (msg.type) {
      case "hello":
        session.lease = ws;
        session.leaseAt = Date.now();
        send(ws, "session_state", {
          sessionId: session.id,
          phase: session.phase,
          taskId: session.task?.id ?? null,
          hasExecutor: true,
          readOnly: false,
          needsReconcile: !!session.task && ws === session.lease,
        });
        break;

      case "heartbeat":
        if (isLease(ws)) session.leaseAt = Date.now();
        break;

      case "state_snapshot":
        // 重连后对账：执行端报告实际状态，服务器不盲重播任务
        if (isLease(ws) && session.task && msg.reconciled) {
          endTask("reconciled after reconnect");
        }
        break;

      case "user_message": {
        if (!isLease(ws)) {
          send(ws, "error", { code: "NOT_EXECUTOR", message: "另一个页面正在执行角色" });
          return;
        }
        if (!msg.text || typeof msg.text !== "string") return;

        // 抢占：取消旧任务未执行步骤，旧结果随后被丢弃
        if (session.task) {
          session.task.superseded = true;
          send(ws, "cancel_plan", { taskId: session.task.id });
        }

        const taskId = `t${nextTask++}`;
        session.task = { id: taskId, text: msg.text, rounds: 0, startedAt: Date.now(), superseded: false, plan: null };
        session.phase = "thinking";
        broadcastState();

        setTimeout(() => {
          if (!session.task || session.task.id !== taskId || session.task.superseded) return;
          const plan = planFor(msg.text);
          if (!plan) {
            session.phase = "checking";
            broadcastState();
            setTimeout(() => {
              if (!session.task || session.task.id !== taskId) return;
              send(ws, "public_reply", { taskId, speech: `我听到了：${msg.text}` });
              endTask();
            }, 250);
            return;
          }
          session.phase = "executing";
          session.task.plan = plan;
          session.task.rounds = 1;
          broadcastState();
          send(ws, "execute_plan", { taskId, turnId: 1, speech: plan.speech, plan: { steps: plan.steps } });
        }, 300);
        break;
      }

      case "plan_result": {
        const task = session.task;
        if (!task || task.id !== msg.taskId) return;           // 过期/已取消的结果直接丢弃
        if (task.superseded) return;
        if (session.lastResult?.taskId === msg.taskId && session.lastResult?.round === task.rounds) return; // 重复投递
        session.lastResult = { taskId: msg.taskId, round: task.rounds };

        if (Date.now() - task.startedAt > BUDGET_MS) {
          session.phase = "blocked";
          send(ws, "public_reply", { taskId: task.id, speech: "这个任务超过时间预算了，需要新的指示。" });
          endTask("budget exceeded");
          return;
        }
        if (task.rounds >= MAX_ROUNDS) {
          session.phase = "blocked";
          send(ws, "public_reply", { taskId: task.id, speech: "已经到最大执行轮数，需要新的指示。" });
          endTask("round budget");
          return;
        }

        session.phase = "checking";
        broadcastState();
        setTimeout(() => {
          if (!session.task || session.task.id !== task.id) return;
          send(ws, "public_reply", { taskId: task.id, speech: summary(msg.result) });
          endTask();
        }, 250);
        break;
      }

      case "chat_opened":
      case "chat_closed":
        broadcastState();
        break;
    }
  });

  ws.on("close", () => {
    if (session.lease === ws) {
      session.lease = null;
      session.leaseAt = 0;
      // 执行端断开：任务状态未知，等待重连对账，不自动续跑
      if (session.task) session.phase = "unknown";
      broadcastState();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`whale brain on :${PORT} (ws /ws)`));
