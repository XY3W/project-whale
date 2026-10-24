/**
 * M3：最小服务端闭环（FakeBrain）。
 * - 同源托管 dist（存在时）与 /ws
 * - 会话 + 单任务 + execute_plan → plan_result → review → public_reply
 * - 不接真实模型：M4 才替换 brain
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.BRAIN_PORT ?? 8091);
const ROOT = path.resolve(process.cwd(), "dist");
const PROTOCOL = 1;

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
const sessions = new Map();

function send(ws, type, payload = {}) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ protocolVersion: PROTOCOL, type, ...payload, seq: ++ws._seq }));
}

/** FakeBrain：只按关键词给一个安全计划，不做自然语言理解。 */
function planFor(text) {
  if (/挥手|打招呼|hello|hi/i.test(text)) {
    return { speech: "好呀。", steps: [{ action: "play", action_id: "greet" }] };
  }
  if (/转|转身/.test(text)) {
    return { speech: "我转一下。", steps: [{ action: "turn", angle_deg: 45 }] };
  }
  if (/走|过来|靠近|近一点/.test(text)) {
    return { speech: "我走过去一点。", steps: [{ action: "walk", distance_m: 0.27 }] };
  }
  if (/摆尾|尾巴/.test(text)) {
    return { speech: "尾巴动一动。", steps: [{ action: "tail", style: "tail_swish", duration_s: 2 }] };
  }
  return null;
}

function summary(result) {
  const steps = result?.steps ?? [];
  const done = steps.filter((s) => s.status === "succeeded").length;
  const failed = steps.find((s) => s.status !== "succeeded");
  if (failed) {
    return `动作没有完成（${failed.reasonCode}）。`;
  }
  return `做好了（${done} 个动作）。`;
}

wss.on("connection", (ws) => {
  ws._seq = 0;
  const session = {
    id: `s${Date.now()}`,
    task: null,
    pending: null,
    phase: "idle",
  };
  sessions.set(ws, session);
  send(ws, "session_state", { sessionId: session.id, phase: "idle" });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.protocolVersion && msg.protocolVersion !== PROTOCOL) {
      send(ws, "error", { code: "PROTOCOL_MISMATCH", message: "协议版本不一致" });
      return;
    }

    switch (msg.type) {
      case "hello":
        send(ws, "session_state", { sessionId: session.id, phase: "idle" });
        break;

      case "user_message": {
        if (session.phase !== "idle") {
          send(ws, "error", { code: "BUSY", message: "上一个任务还没结束" });
          return;
        }
        const taskId = `t${nextTask++}`;
        session.task = { id: taskId, text: msg.text, turn: 0 };
        session.phase = "thinking";
        send(ws, "task_state", { taskId, phase: "thinking" });

        setTimeout(() => {
          const plan = planFor(msg.text || "");
          if (!plan) {
            session.phase = "checking";
            send(ws, "task_state", { taskId, phase: "checking" });
            setTimeout(() => {
              send(ws, "public_reply", { taskId, speech: `我听到了：${msg.text}` });
              session.phase = "idle";
              session.task = null;
              send(ws, "task_state", { taskId, phase: "idle" });
            }, 250);
            return;
          }
          session.phase = "executing";
          session.task.plan = plan;
          send(ws, "task_state", { taskId, phase: "executing" });
          send(ws, "execute_plan", { taskId, turnId: 1, speech: plan.speech, plan: { steps: plan.steps } });
        }, 300);
        break;
      }

      case "plan_result": {
        const task = session.task;
        if (!task || task.id !== msg.taskId) return; // 过期结果直接丢弃
        session.phase = "checking";
        send(ws, "task_state", { taskId: task.id, phase: "checking" });
        setTimeout(() => {
          const speech = summary(msg.result);
          send(ws, "public_reply", { taskId: task.id, speech });
          session.phase = "idle";
          session.task = null;
          send(ws, "task_state", { taskId: task.id, phase: "idle" });
        }, 250);
        break;
      }

      case "state_snapshot":
        break;

      case "chat_opened":
      case "chat_closed":
        send(ws, "session_state", { sessionId: session.id, phase: session.phase });
        break;
    }
  });

  ws.on("close", () => sessions.delete(ws));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`whale brain on :${PORT} (ws /ws)`);
});
