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
import { createStore, reconcileOnLoad } from "./store.mjs";
import { contextBudget, estimateRequest } from "./context.mjs";
import { addCandidates, confirmedMemories, validateProposals } from "./memory.mjs";
import { CAPABILITY_VERSION, ModelError, SYSTEM_PROMPT, callModel, describeCapabilities, describeDisabled, hasKey, planningMessages, reviewMessages } from "./llm.mjs";

const PORT = Number(process.env.BRAIN_PORT ?? 8091);
const ROOT = path.resolve(process.cwd(), "dist");
const PROTOCOL = 1;
const HEARTBEAT_MS = 8_000;
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
const STATE_FILE = path.join(process.cwd(), "data", "state.json");
function loadCharacter() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (typeof raw.x === "number" && typeof raw.z === "number" && typeof raw.yawDeg === "number") return raw;
  } catch {}
  return { x: 0, z: 0, yawDeg: 0, updatedAt: 0 };
}
let character = loadCharacter();
let lastSave = 0;
/** 用客户端上报的快照刷新角色状态（坐标越界时夹到可走范围） */
function applyClientSnapshot(snap) {
  if (!snap || !Number.isFinite(snap.x) || !Number.isFinite(snap.z) || !Number.isFinite(snap.yawDeg)) return false;
  character = {
    x: Math.max(-3.7, Math.min(3.7, snap.x)),
    z: Math.max(-3.7, Math.min(3.7, snap.z)),
    yawDeg: snap.yawDeg,
    updatedAt: Date.now(),
  };
  saveCharacter();
  return true;
}

function saveCharacter() {
  if (Date.now() - lastSave < 1500) return;
  lastSave = Date.now();
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...character, updatedAt: Date.now() }));
  } catch (err) {
    console.error("state save failed", err.message);
  }
}

const session = {
  id: `s${Date.now()}`,
  lease: null,          // 当前执行端 ws
  leaseEpoch: 0,        // 逐次授予递增，用于 fencing
  generation: 0,        // 任务代际
  ledger: new Map(),    // planId -> { state, result, reply }
  leaseAt: 0,
  task: null,           // { id, text, rounds, startedAt, superseded, plan }
  phase: "idle",
  chatOpen: false,
  lastResult: null,     // { taskId, round } 用于去重
  history: [],          // 最近对话（限 12 条）
};


const store = createStore(path.join(process.cwd(), "data", "brain-state.json"));
const storeSeed = reconcileOnLoad(store.state);
for (const [planId, entry] of Object.entries(storeSeed.ledger ?? {})) session.ledger.set(planId, entry);
session.history = Array.isArray(storeSeed.history) ? storeSeed.history.slice(-12) : [];
if (storeSeed.session?.phase === "unknown") {
  session.phase = "unknown";
  if (storeSeed.task) {
    session.task = { ...storeSeed.task, unknown: true, superseded: false, startedAt: Date.now(), rounds: storeSeed.task.rounds ?? 0, originWs: null };
    console.log(`[reconcile] restored unknown task ${storeSeed.task.id}`);
  }
}

function persist() {
  store.update((st) => {
    st.memories = st.memories ?? [];
    st.history = session.history.slice(-12);
    st.ledger = Object.fromEntries(session.ledger);
    st.session = { id: session.id, phase: session.phase, taskId: session.task?.id ?? null };
    st.task = session.task
      ? { id: session.task.id, generation: session.task.generation, text: session.task.text, rounds: session.task.rounds, planId: session.task.planId ?? null }
      : null;
  });
}

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ protocolVersion: PROTOCOL, type, ...payload, seq: ++ws._seq }));
}

const isLease = (ws) => session.lease === ws;
const isLeaseAlive = () =>
  !!session.lease && session.lease.readyState === 1 && Date.now() - session.leaseAt < HEARTBEAT_MS;

function grantLease(ws) {
  session.chatOpen = false; // 聊天状态绑定执行端，换人即失效
  session.lease = ws;
  session.leaseEpoch += 1;
  session.leaseAt = Date.now();
  console.log(`[lease] grant epoch=${session.leaseEpoch} to ${ws._connId ?? "?"}`);
  return session.leaseEpoch;
}

function statePayload(ws) {
  return {
    sessionId: session.id,
    phase: session.phase,
    taskId: session.task?.id ?? null,
    generation: session.generation,
    leaseEpoch: session.leaseEpoch,
    readOnly: ws !== session.lease,
    hasExecutor: isLeaseAlive(),
    character,
    needsReconcile: !!session.task && ws === session.lease && (session.task.unknown || session.task.originWs !== ws),
  };
}

function broadcastState() {
  const payload = {
    sessionId: session.id,
    phase: session.phase,
    taskId: session.task?.id ?? null,
  };
  for (const ws of wss.clients) send(ws, "session_state", { ...payload, ...statePayload(ws) });
}

function endTask(reason) {
  if (session.budgetTimer) { clearTimeout(session.budgetTimer); session.budgetTimer = null; }
  session.task = null;
  session.phase = "idle";
  persist();
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

function absorbMemory(task, out) {
  const { accepted, rejected } = validateProposals(out.memoryProposals ?? [], task.messageId);
  if (accepted.length) {
    store.update((st) => { st.memories = addCandidates(st.memories, accepted); });
    persist();
  }
  if (rejected.length) console.warn("[memory] rejected", JSON.stringify(rejected));
}

function applyOutput(ws, task, out) {
  if (!session.task || session.task.id !== task.id) return;
  absorbMemory(task, out);
  if (out.type === "finish_task") {
    const speech = out.speech || (out.outcome === "completed" ? "好了。" : "这个我还做不到。");
    send(ws, "public_reply", { taskId: task.id, speech });
    session.history.push({ role: "assistant", content: speech });
    if (task.planId) session.ledger.set(task.planId, { state: "done", reply: speech });
    persist();
    endTask();
    return;
  }
  if (task.rounds >= MAX_ROUNDS) {
    session.phase = "blocked";
    send(ws, "public_reply", { taskId: task.id, speech: "已经到最大执行轮数，需要新的指示。" });
    endTask("round budget");
    return;
  }
  task.plan = out.plan;
  task.rounds += 1;
  task.planId = `${task.id}-p${task.rounds}-g${task.generation}`;
  session.ledger.set(task.planId, { state: "dispatched" });
  persist();
  session.phase = "executing";
  broadcastState();
  if (out.speech) session.history.push({ role: "assistant", content: out.speech });
  send(ws, "execute_plan", {
    taskId: task.id,
    generation: task.generation,
    planId: task.planId,
    leaseEpoch: session.leaseEpoch,
    turnId: task.rounds,
    speech: out.speech ?? "",
    plan: out.plan,
  });
}

function fail(ws, task, err) {
  if (!session.task || session.task.id !== task?.id || session.task.generation !== task?.generation) {
    console.log("[model] stale error ignored");
    return;
  }
  const code = err instanceof ModelError ? err.code : "INTERNAL";
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[model] ${code}: ${message}`);
  send(ws, "error", { code, message });
  send(ws, "task_state", { taskId: task?.id ?? null, phase: "error" });
  endTask("model error");
}

let connSeq = 0;
wss.on("connection", (ws, req) => {
  ws._seq = 0;
  ws._connId = `c${++connSeq}`;
  console.log(`[lease] connect ${ws._connId} from ${req?.socket?.remoteAddress ?? "?"}`);

  // 租约：只有当前执行端存活时才允许新连接只读
  if (!isLeaseAlive()) grantLease(ws);
  send(ws, "session_state", statePayload(ws));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.protocolVersion && msg.protocolVersion !== PROTOCOL) {
      send(ws, "error", { code: "PROTOCOL_MISMATCH", message: "协议版本不一致" });
      return;
    }

    switch (msg.type) {
      case "hello":
        if (!isLeaseAlive()) grantLease(ws);
        send(ws, "session_state", statePayload(ws));
        break;

      case "heartbeat":
        if (isLease(ws)) session.leaseAt = Date.now();
        else send(ws, "session_state", statePayload(ws));
        break;

      case "state_snapshot": {
        if (!isLease(ws)) { send(ws, "error", { code: "NOT_EXECUTOR", message: "只读连接不能更新状态" }); break; }
        if (msg.leaseEpoch !== undefined && msg.leaseEpoch !== session.leaseEpoch) {
          send(ws, "error", { code: "STALE_LEASE", message: "执行权已过期" });
          break;
        }
        // 重连后对账：执行端报告实际状态，服务器不盲重播任务
        // 只有“不是本连接创建的任务”才需要对账结束；否则会把刚发的消息杀掉
        if (isLease(ws) && session.task && msg.reconciled && (session.task.unknown || session.task.originWs !== ws)) {
          endTask("reconciled after restart/reconnect");
        }
        applyClientSnapshot(msg.snapshot);
        break;
      }

      case "user_message": {
        if (!isLease(ws)) {
          send(ws, "error", { code: "NOT_EXECUTOR", message: "另一个页面正在执行角色" });
          return;
        }
        if (msg.leaseEpoch !== undefined && msg.leaseEpoch !== session.leaseEpoch) {
          send(ws, "error", { code: "STALE_LEASE", message: "执行权已过期，请刷新" });
          return;
        }
        if (!msg.text || typeof msg.text !== "string") return;
        // 用户消息里带着客户端此刻的真实位姿：先刷新，再基于它规划
        applyClientSnapshot(msg.snapshot);
        if (!session.chatOpen) {
          send(ws, "error", { code: "CHAT_CLOSED", message: "聊天框没有打开，不能发送消息" });
          return;
        }

        // 抢占：取消旧任务未执行步骤，旧结果随后被丢弃
        if (session.task) {
          session.task.superseded = true;
          send(ws, "cancel_plan", {
            taskId: session.task.id,
            generation: session.task.generation,
            planId: session.task.planId ?? null,
          });
        }

        const taskId = `t${nextTask++}`;
        const generation = ++session.generation;
        session.budgetTimer = setTimeout(() => {
          if (session.task?.id !== taskId) return;
          session.phase = "blocked";
          send(ws, "public_reply", { taskId, speech: "这个任务超过时间预算了，先停在这里。" });
          endTask("budget timer");
        }, BUDGET_MS);
        session.task = { id: taskId, generation, text: msg.text, messageId: `msg-${taskId}`, rounds: 0, startedAt: Date.now(), superseded: false, plan: null, planId: null, originWs: ws };
        session.history.push({ role: "user", content: msg.text });
        if (session.history.length > 12) session.history = session.history.slice(-12);
        persist();
        session.phase = "thinking";
        broadcastState();

        setTimeout(async () => {
          const task = session.task;
          if (!task || task.id !== taskId || task.superseded) return;
          if (!hasKey()) {
            // 没有 Key：走本地 FakeBrain，不装作在线
            const plan = planFor(msg.text);
            session.phase = plan ? "executing" : "checking";
            broadcastState();
            if (plan) {
              task.plan = plan;
              task.rounds = 1;
              task.planId = `${taskId}-p1-g${generation}`;
              session.ledger.set(task.planId, { state: "dispatched" });
  persist();
              send(ws, "execute_plan", {
                taskId, generation, planId: task.planId, leaseEpoch: session.leaseEpoch,
                turnId: 1, speech: plan.speech, plan: { steps: plan.steps },
              });
            } else {
              send(ws, "public_reply", { taskId, speech: `我听到了：${msg.text}` });
              endTask();
            }
            return;
          }
          try {
            const planningContext = {
                taskId,
                userMessage: msg.text,
                characterState: character,
                world: { walkableHalf: 3.7, coordinateSystem: "glTF +Y up, +Z forward" },
                capabilities: describeCapabilities(),
                disabledCapabilities: describeDisabled(),
                capabilityVersion: CAPABILITY_VERSION,
              ...contextBudget({ history: session.history }),
              memory: confirmedMemories(storeSeed.memories),
              clientSnapshot: msg.snapshot ?? null,
            };
            const budget = estimateRequest({
              system: SYSTEM_PROMPT,
              capabilities: describeCapabilities(),
              context: planningContext,
            });
            if (!budget.ok) {
              send(ws, "error", {
                code: "CONTEXT_TOO_LARGE",
                message: `请求估算 ${budget.total} tokens，超过 ${budget.maxInputTokens} 上限`,
              });
              endTask("context too large");
              return;
            }
            const out = await callModel(planningMessages(planningContext));
            applyOutput(ws, task, out);
          } catch (err) {
            fail(ws, task, err);
          }
        }, 300);
        break;
      }

      case "plan_result": {
        const task = session.task;
        if (!isLease(ws)) return;
        if (typeof msg.generation !== "number" || !msg.planId || typeof msg.leaseEpoch !== "number") {
          send(ws, "error", { code: "PROTOCOL_FIELD_MISSING", message: "结果缺少 generation/planId/leaseEpoch" });
          return;
        }
        if (!task || task.id !== msg.taskId) return;                       // 旧任务结果
        if (msg.generation !== undefined && msg.generation !== task.generation) return; // 旧代际
        if (msg.leaseEpoch !== undefined && msg.leaseEpoch !== session.leaseEpoch) return; // 旧租约
        if (task.superseded) return;
        if (msg.planId && task.planId && msg.planId !== task.planId) return; // 不属于当前计划

        // 结果里带着执行完之后的真实位姿：审核阶段必须看到它，而不是旧坐标
        applyClientSnapshot(msg.snapshot);
        const entry = msg.planId ? session.ledger.get(msg.planId) : null;
        if (entry && entry.state === "done") {
          // 重复投递：回放已缓存的回复，不再次执行
          send(ws, "public_reply", { taskId: task.id, speech: entry.reply ?? "" });
          return;
        }
        if (entry && entry.state === "processing") return; // 首次结果正在处理，忽略重复
        if (msg.planId) session.ledger.set(msg.planId, { state: "processing", result: msg.result });

        if (Date.now() - task.startedAt > BUDGET_MS) {
          session.phase = "blocked";
          send(ws, "public_reply", { taskId: task.id, speech: "这个任务超过时间预算了，需要新的指示。" });
          endTask("budget exceeded");
          return;
        }
        session.phase = "checking";
        broadcastState();
        setTimeout(async () => {
          const task = session.task;
          if (!task || task.id !== msg.taskId) return;
          if (Date.now() - task.startedAt > BUDGET_MS) {
            send(ws, "public_reply", { taskId: task.id, speech: "这个任务超过时间预算了，需要新的指示。" });
            endTask("budget exceeded");
            return;
          }
          if (task.rounds >= MAX_ROUNDS) {
            send(ws, "public_reply", { taskId: task.id, speech: "已经到最大执行轮数，需要新的指示。" });
            endTask("round budget");
            return;
          }
          if (!hasKey()) {
            send(ws, "public_reply", { taskId: task.id, speech: summary(msg.result) });
            endTask();
            return;
          }
          try {
            const out = await callModel(
              reviewMessages({
                taskId: task.id,
                turn: task.rounds,
                executionReport: msg.result,
                characterState: character,
                clientSnapshot: msg.snapshot ?? null,
                capabilities: describeCapabilities(),
                disabledCapabilities: describeDisabled(),
                capabilityVersion: CAPABILITY_VERSION,
                ...contextBudget({ history: session.history }),
                memory: confirmedMemories(storeSeed.memories),
              }),
            );
            applyOutput(ws, task, out);
          } catch (err) {
            fail(ws, task, err);
          }
        }, 250);
        break;
      }

      case "chat_opened":
        if (!isLease(ws)) { send(ws, "error", { code: "NOT_EXECUTOR", message: "只读连接不能打开聊天" }); break; }
        if (msg.leaseEpoch !== undefined && msg.leaseEpoch !== session.leaseEpoch) {
          send(ws, "error", { code: "STALE_LEASE", message: "执行权已过期" });
          break;
        }
        session.chatOpen = true;
        session.chatEpoch = session.leaseEpoch;
        broadcastState();
        break;
      case "chat_closed":
        if (!isLease(ws)) break;
        session.chatOpen = false;
        broadcastState();
        break;
    }
  });

  ws.on("close", () => {
    console.log(`[lease] close ${ws._connId ?? "?"} lease=${session.lease === ws}`);
    if (session.lease === ws) {
      session.lease = null;
      session.leaseAt = 0;
      session.leaseEpoch += 1; // 旧 epoch 立即失效
      // 执行端断开：任务状态未知，等待重连对账，不自动续跑
      if (session.task) session.phase = "unknown";
      broadcastState();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`whale brain on :${PORT} (ws /ws)`));
