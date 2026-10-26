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
import { GameService } from "./game.mjs";
import { cellCenter } from "./minesweeper.mjs";
import { contextBudget, estimateRequest } from "./context.mjs";
import { addCandidates, confirmedMemories, validateProposals } from "./memory.mjs";
import { createGameEventQueue } from "./events.mjs";
import { boardContext, characterContext, propIdOf, propsContext, sanitizeProp, slotsOf, trimExecutionReport } from "./public-state.mjs";
import { CAPABILITY_VERSION, ModelError, SYSTEM_PROMPT, callModel, describeCapabilities, describeDisabled, hasKey, planningMessages, reviewMessages } from "./llm.mjs";
import { validatePlan } from "./capabilities.mjs";

const PORT = Number(process.env.BRAIN_PORT ?? 8091);
const ROOT = path.resolve(process.cwd(), "dist");
const PROTOCOL = 1;
const HEARTBEAT_MS = 8_000;
const MAX_ROUNDS = 4;
const BUDGET_MS = Number(process.env.BRAIN_BUDGET_MS ?? 180_000);
/** 场地事件的合并窗口：同一批动作只唤醒一次模型 */
const EVENT_COALESCE_MS = 400;
/**
 * 整轮输入预算（估算 token）。扫雷棋盘 100 格是主要开销，
 * 8000 会把“带棋盘的合法请求”误判成超限，这里按实测留出余量。
 */
const MAX_INPUT_TOKENS = 14_000;
/**
 * 扫雷是她自己玩的：宿主负责开局和“续玩”，模型只负责这一局怎么走。
 * AUTO_MINESWEEPER=0 可以整体关掉；三个间隔都可以用环境变量覆盖。
 */
const AUTO_PLAY = (process.env.AUTO_MINESWEEPER ?? "1") !== "0";
const AUTO_CONTINUE_IDLE_MS = Number(process.env.AUTO_CONTINUE_IDLE_MS ?? 45_000);
const AUTO_START_IDLE_MS = Number(process.env.AUTO_START_IDLE_MS ?? 90_000);
/**
 * 每小时最多派几个自主回合（一个回合 = 一次 planning + 最多 3 次 review）。
 * 思考模式下每次调用约 7k 输入 + 7k 输出，这个上限就是给钱包用的刹车。
 */
const AUTO_MAX_TURNS_PER_HOUR = Number(process.env.AUTO_MAX_TURNS ?? 6);
const AUTO_MAX_BACKOFF_MS = 600_000;
/** 用户点了「扫雷结束」之后，别马上又自己开一局 */
const AUTO_AFTER_MANUAL_END_MS = Number(process.env.AUTO_AFTER_MANUAL_END_MS ?? 1_800_000);

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
const games = new GameService(path.join(process.cwd(), "data", "minesweeper.json"));
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (typeof raw.x === "number" && typeof raw.z === "number" && typeof raw.yawDeg === "number") return raw;
  } catch {}
  return { x: 0, z: 0, yawDeg: 0, updatedAt: 0 };
}

const loaded = loadState();
let character = { x: loaded.x, z: loaded.z, yawDeg: loaded.yawDeg, updatedAt: loaded.updatedAt ?? 0 };
/** 物品注册表：basin 与 rice_scoop 各一份，刷新后按稳定状态恢复现场 */
const props = new Map();
for (const raw of Array.isArray(loaded.props) ? loaded.props : loaded.basin ? [loaded.basin] : []) {
  const record = sanitizeProp(raw);
  if (record) props.set(record.object_id, record);
}
let lastSave = 0;

/** 客户端上报的快照是位姿与槽位的唯一实时来源；越界坐标夹回可走范围 */
function applyClientSnapshot(snap) {
  if (!snap) return false;
  let changed = false;
  let propsChanged = false;
  if (Number.isFinite(snap.x) && Number.isFinite(snap.z) && Number.isFinite(snap.yawDeg)) {
    character = {
      x: Math.max(-3.7, Math.min(3.7, snap.x)),
      z: Math.max(-3.7, Math.min(3.7, snap.z)),
      yawDeg: snap.yawDeg,
      updatedAt: Date.now(),
    };
    changed = true;
  }
  if (Array.isArray(snap.objects)) {
    for (const object of snap.objects) {
      const objectId = propIdOf(object);
      if (!objectId) continue;
      const next = sanitizeProp(object, props.get(objectId) ?? null);
      if (next) {
        props.set(objectId, next);
        changed = true;
        propsChanged = true;
      }
    }
  }
  if (changed) saveState(propsChanged);
  return changed;
}

function saveState(force = false) {
  if (!force && Date.now() - lastSave < 1500) return;
  lastSave = Date.now();
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const list = [...props.values()];
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ ...character, props: list, basin: props.get("basin") ?? null, updatedAt: Date.now() }),
    );
  } catch (err) {
    console.error("state save failed", err.message);
  }
}

/** 给客户端的物品状态：顶层是盆（兼容旧恢复路径），同时带全部物品与槽位 */
function propPayload() {
  const slots = slotsOf(props);
  const objects = [...props.values()];
  const basinRecord = props.get("basin") ?? null;
  return {
    basin: basinRecord ? { ...basinRecord, objects } : objects.length ? { objects } : null,
    objects,
    slots,
  };
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
  /** dig 授权表：只有服务端下发的计划才能提交挖掘（authId -> 授权记录） */
  digAuth: new Map(),
  digSeq: 0,
};


const store = createStore(path.join(process.cwd(), "data", "brain-state.json"));
const storeSeed = reconcileOnLoad(store.state);
for (const [planId, entry] of Object.entries(storeSeed.ledger ?? {})) session.ledger.set(planId, entry);
// 任务号不能和上次进程撞车（否则账本里 t100-p1-g1 会被覆盖）
for (const planId of Object.keys(storeSeed.ledger ?? {})) {
  const match = /^t(\d+)-/.exec(planId);
  if (match) nextTask = Math.max(nextTask, Number(match[1]) + 1);
}
if (Number.isFinite(storeSeed.session?.generation)) session.generation = storeSeed.session.generation;
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
    st.session = { id: session.id, phase: session.phase, taskId: session.task?.id ?? null, generation: session.generation };
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
/** 写操作必须带当前租约代际：缺字段不再放行（旧代码 undefined 也能过） */
const epochOk = (msg) => typeof msg.leaseEpoch === "number" && msg.leaseEpoch === session.leaseEpoch;
const isLeaseAlive = () =>
  !!session.lease && session.lease.readyState === 1 && Date.now() - session.leaseAt < HEARTBEAT_MS;

function grantLease(ws) {
  session.chatOpen = false; // 聊天状态绑定执行端，换人即失效
  session.lease = ws;
  session.leaseEpoch += 1;
  session.leaseAt = Date.now();
  // 页面刚打开时给场景几秒稳定，再自己开局
  if (!autoplay.nextAt || autoplay.nextAt < Date.now()) autoplay.nextAt = Date.now() + Math.min(AUTO_START_IDLE_MS, 8000);
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
    ...propPayload(),
    game: games.public(),
    readOnly: ws !== session.lease,
    hasExecutor: isLeaseAlive(),
    character,
    needsReconcile: !!session.task && ws === session.lease && (session.task.unknown || session.task.originWs !== ws),
  };
}

/* ---------------- 自主开局 / 续玩 ---------------- */

let autoGameSeq = 0;
const autoplay = {
  /** 下一次可以自主体回合的绝对时间 */
  nextAt: 0,
  /** 没有进展时的退避倍数 */
  backoff: 1,
  /** 最近一小时的自主体回合时间戳 */
  turns: [],
  /** 用户手动「扫雷结束」后的硬暂停：普通退避不许缩短它 */
  manualPauseUntil: 0,
};

function noteAutoPlayDelay(ms) {
  // 手动收摊的暂停优先：任何普通退避都不能把它缩短
  autoplay.nextAt = Math.max(Date.now() + ms, autoplay.manualPauseUntil);
}

/**
 * 条件全满足时给自己派一个回合：没有进行中的局就开一局，
 * 局还没结束就发 self_play 请她继续。用户聊天、任务进行中、没有执行端都不打扰。
 */
function tickAutoPlay() {
  if (!AUTO_PLAY || !hasKey()) return;
  const now = Date.now();
  if (Date.now() < autoplay.manualPauseUntil) return;
  if (session.task || !isLeaseAlive() || session.chatOpen || session.phase === "unknown") {
    if (process.env.AUTOPLAY_DEBUG) console.log(`[autoplay] skip task=${!!session.task} lease=${isLeaseAlive()} chat=${session.chatOpen} phase=${session.phase}`);
    return;
  }
  if (now < autoplay.nextAt) {
    if (process.env.AUTOPLAY_DEBUG) console.log(`[autoplay] wait ${Math.round((autoplay.nextAt - now) / 1000)}s`);
    return;
  }
  autoplay.turns = autoplay.turns.filter((t) => now - t < 3_600_000);
  if (autoplay.turns.length >= AUTO_MAX_TURNS_PER_HOUR) {
    noteAutoPlayDelay(AUTO_MAX_BACKOFF_MS);
    console.log("[autoplay] 每小时上限到了，冷却 5 分钟");
    return;
  }
  const board = games.public();
  console.log(`[autoplay] tick board=${board?.status ?? "none"} revision=${board?.revision ?? "-"}`);
  autoplay.turns.push(now);
  if (board && board.status === "playing") {
    noteAutoPlayDelay(AUTO_CONTINUE_IDLE_MS * autoplay.backoff);
    gameEvents.push({
      eventId: `ev${++eventSeq}`,
      type: "self_play",
      gameId: board.gameId,
      revision: board.revision,
      status: board.status,
      at: new Date().toISOString(),
    });
    scheduleEventTurn();
    return;
  }
  noteAutoPlayDelay(AUTO_START_IDLE_MS);
  const started = games.start(`auto${++autoGameSeq}`);
  console.log(`[autoplay] 自己开了一局 ${started.gameId}`);
  broadcastState();
  noteGameEvent("game_started", started, { trigger: "self" });
}

/** 场地事件：先入队去重，再由模型回合合并处理 */
const gameEvents = createGameEventQueue();
let eventSeq = 0;
let eventTurnTimer = null;

function noteGameEvent(type, board, extra = {}) {
  if (!board) return;
  // 没有 Key 时不驱动模型，事件只留在权威棋盘里
  if (!hasKey()) return;
  gameEvents.push({
    eventId: `ev${++eventSeq}`,
    type,
    gameId: board.gameId,
    revision: board.revision,
    status: board.status,
    at: new Date().toISOString(),
    ...extra,
  });
  scheduleEventTurn();
}

/**
 * 没有进行中的任务时，场地事件自己唤醒一轮 planning。
 * 有任务时不动：事件留给该任务下一次 planning/review 合并，不打断用户指令。
 */
function scheduleEventTurn() {
  if (session.task || eventTurnTimer || !gameEvents.size()) return;
  if (!isLeaseAlive()) return;
  eventTurnTimer = setTimeout(() => {
    eventTurnTimer = null;
    if (session.task || !gameEvents.size()) return;
    startEventTask();
  }, EVENT_COALESCE_MS);
}

function broadcastState() {
  const payload = {
    sessionId: session.id,
    phase: session.phase,
    taskId: session.task?.id ?? null,
  };
  for (const ws of wss.clients) send(ws, "session_state", { ...payload, ...statePayload(ws) });
}

/**
 * 结束/打断一个已下发但还没跑完的计划：告诉执行端停下，并把账本从 dispatched 挪走，
 * 不能只把任务置 idle 让动作继续在场上跑。
 */
function cancelCurrentPlan(reason) {
  const task = session.task;
  if (!task?.planId) return;
  const entry = session.ledger.get(task.planId);
  if (entry && entry.state === "dispatched") session.ledger.set(task.planId, { state: "cancelled", reason });
  send(session.lease, "cancel_plan", { taskId: task.id, generation: task.generation, planId: task.planId, reason });
  console.log(`[plan] cancel ${task.planId} (${reason})`);
}

function endTask(reason, opts = {}) {
  const finished = session.task;
  if (session.budgetTimer) { clearTimeout(session.budgetTimer); session.budgetTimer = null; }
  session.task = null;
  session.phase = "idle";
  persist();
  broadcastState();
  if (reason) console.log(`[task] ${reason}`);
  // 自主回合按“这一轮有没有真的推进棋盘”决定下一轮的间隔：
  // 挖到了就按正常节奏继续，原地打转就指数退避，避免空转烧 API
  if (opts.retryMs != null) {
    // 模型抽风/截断这类瞬时问题：很快再试一次，不进退避
    autoplay.backoff = 1;
    noteAutoPlayDelay(opts.retryMs);
  } else if (finished && finished.origin === "event") {
    const board = games.public();
    const progressed = finished.gameRevision != null && board && board.revision > finished.gameRevision;
    autoplay.backoff = progressed ? 1 : Math.min(autoplay.backoff * 2, 8);
    const base = board && board.status === "playing" ? AUTO_CONTINUE_IDLE_MS : AUTO_START_IDLE_MS;
    noteAutoPlayDelay(Math.min(base * autoplay.backoff, 120_000));
  } else if (finished) {
    autoplay.backoff = 1;
    noteAutoPlayDelay(AUTO_START_IDLE_MS);
  }
  // 任务结束后如果还有没被消化的场地事件，再唤醒一轮，让模型看见最终棋盘
  scheduleEventTurn();
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

/* ---------------- 任务与模型回合 ---------------- */

let snapshotSeq = 0;

/**
 * 统一的任务入口：用户消息和场地事件走同一套预算、代际与租约规则，
 * 游戏事件不能私建一条不受聊天/预算控制的循环。
 */
function beginTask({ text, messageId, origin = "user", events = [], snapshot = null, ws }) {
  const taskId = `t${nextTask++}`;
  const generation = ++session.generation;
  if (session.budgetTimer) clearTimeout(session.budgetTimer);
  session.budgetTimer = setTimeout(() => {
    if (session.task?.id !== taskId) return;
    session.phase = "blocked";
    if (origin !== "event") send(ws, "public_reply", { taskId, speech: "这个任务超过时间预算了，先停在这里。" });
    // 预算到期必须先让执行端停下，不能只把任务置 idle
    cancelCurrentPlan("budget");
    endTask("budget timer", { retryMs: null });
  }, BUDGET_MS);
  session.task = {
    id: taskId,
    generation,
    text,
    messageId,
    origin,
    originalText: origin === "user" ? text : null,
    rounds: 0,
    startedAt: Date.now(),
    superseded: false,
    plan: null,
    planId: null,
    originWs: ws,
    pendingEvents: events,
    snapshot,
    gameRevision: games.public()?.revision ?? null,
  };
  if (text) {
    session.history.push({ role: "user", content: text });
    if (session.history.length > 12) session.history = session.history.slice(-12);
  }
  persist();
  session.phase = "thinking";
  broadcastState();
  return session.task;
}

function takeTaskEvents(task) {
  const out = task.pendingEvents ?? [];
  task.pendingEvents = [];
  return out;
}

/** 模型的每次调用都带同样的公开快照结构，只是触发原因和执行报告不同 */
function modelContext(task, phase, extra = {}) {
  const board = games.public();
  // 自主回合没有用户指令：显式写清楚，并且不带历史对话，
  // 否则模型会把 history 里上一句旧指令（比如“把勺扔出去”）当成这一轮的目标。
  const selfPlay = task.origin === "event";
  return {
    phase,
    snapshotId: `snap${++snapshotSeq}`,
    timestamp: new Date().toISOString(),
    taskId: task.id,
    goal: selfPlay
      ? {
          originalText: null,
          origin: "event",
          note: eventNote(extra.attentionEvents),
        }
      : { originalText: task.originalText, origin: task.origin },
    userMessage: task.text || null,
    leaseAndBudget: {
      leaseEpoch: session.leaseEpoch,
      hasExecutor: isLeaseAlive(),
      roundsUsed: task.rounds,
      maxRounds: MAX_ROUNDS,
      budgetMs: BUDGET_MS,
      remainingMs: Math.max(0, BUDGET_MS - (Date.now() - task.startedAt)),
    },
    capabilities: describeCapabilities(),
    disabledCapabilities: describeDisabled(),
    capabilityVersion: CAPABILITY_VERSION,
    world: {
      walkableHalf: 3.7,
      stageHalf: 4,
      coordinateSystem: "glTF +Y up, +Z forward; yaw=0 指向 +Z",
    },
    characterState: characterContext(character),
    props: propsContext(props),
    board: boardContext(board, character),
    ...(selfPlay ? { history: [], historyOmitted: true } : contextBudget({ history: session.history })),
    memory: confirmedMemories(store.state.memories),
    ...extra,
  };
}

/** 自主回合的触发原因，写进 goal.note 让模型一眼看到这一轮为什么被叫醒 */
function eventNote(events) {
  const types = [...new Set((events ?? []).map((e) => e.type))];
  const head = types.length ? `本轮触发：${types.join(" / ")}。` : "";
  return `${head}没有新的用户指令，这是你自己那一局扫雷的自主回合；历史对话已省略，不要引用旧对话里的目标。`;
}

function checkBudget(ctx) {
  const budget = estimateRequest({
    system: SYSTEM_PROMPT,
    capabilities: ctx.capabilities,
    context: ctx,
    maxInputTokens: MAX_INPUT_TOKENS,
  });
  if (ctx.executionReport && JSON.stringify(ctx.executionReport).length > 5000) {
    const rep = ctx.executionReport;
    console.log("[ctx] report breakdown", JSON.stringify((rep.steps ?? []).map((st) => ({
      action: st.action,
      requested: JSON.stringify(st.requested ?? null).length,
      actual: JSON.stringify(st.actual ?? null).length,
      startState: JSON.stringify(st.startState ?? null).length,
      endState: JSON.stringify(st.endState ?? null).length,
      ...(st.action === "dig" ? { keys: Object.keys(st.actual ?? {}), changed: st.actual?.changedCells?.length ?? null } : {}),
    }))));
  }
  if (budget.total > 10_000) {
    const sizes = Object.fromEntries(
      Object.entries(ctx).map(([k, v]) => [k, JSON.stringify(v)?.length ?? 0]).sort((a, b) => b[1] - a[1]).slice(0, 6),
    );
    console.log(`[ctx] ${ctx.snapshotId} ~${budget.total} tokens · biggest fields ${JSON.stringify(sizes)}`);
  }
  return { ...budget, ok: budget.ok };
}

/** 没有 Key：本地 FakeBrain，不装作在线，也不驱动自主回合 */
function fakeBrain(task, ws) {
  if (task.origin === "event") {
    endTask("event turn skipped without key");
    return;
  }
  const plan = planFor(task.text);
  if (!plan) {
    send(ws, "public_reply", { taskId: task.id, speech: `我听到了：${task.text}` });
    endTask();
    return;
  }
  task.plan = plan;
  task.rounds = 1;
  task.planId = `${task.id}-p1-g${task.generation}`;
  session.ledger.set(task.planId, { state: "dispatched" });
  persist();
  session.phase = "executing";
  broadcastState();
  send(ws, "execute_plan", {
    taskId: task.id,
    generation: task.generation,
    planId: task.planId,
    leaseEpoch: session.leaseEpoch,
    turnId: 1,
    speech: plan.speech,
    plan: { steps: plan.steps },
  });
}

async function runPlanning(task, ws) {
  if (!session.task || session.task.id !== task.id) return;
  if (!hasKey()) {
    fakeBrain(task, ws);
    return;
  }
  try {
    const ctx = modelContext(task, "planning", {
      attentionEvents: takeTaskEvents(task),
      executionReport: null,
      clientSnapshot: task.snapshot ?? null,
    });
    const budget = checkBudget(ctx);
    if (!budget.ok) {
      send(ws, "error", {
        code: "CONTEXT_TOO_LARGE",
        message: `请求估算 ${budget.total} tokens，超过 ${budget.maxInputTokens} 上限`,
      });
      endTask("context too large");
      return;
    }
    console.log(`[ctx] planning ${ctx.snapshotId} ~${budget.total} tokens · events=${ctx.attentionEvents.length}`);
    const out = await callModel(planningMessages(ctx));
    applyOutput(ws, task, out);
  } catch (err) {
    fail(ws, task, err);
  }
}

/** 事件驱动的自主回合：没有用户消息，目标来自棋盘变化 */
function startEventTask() {
  const ws = session.lease;
  if (!ws) return;
  const events = gameEvents.take();
  const task = beginTask({ text: "", messageId: null, origin: "event", events, ws });
  console.log(`[event] turn ${task.id} ← ${events.map((e) => `${e.type}@${e.revision}`).join(",")}`);
  runPlanning(task, ws);
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
    // 自主回合允许完全沉默：没有值得说的就不发 public_reply
    const speech = out.speech || (task.origin === "event" ? "" : out.outcome === "completed" ? "好了。" : "这个我还做不到。");
    if (speech) {
      send(ws, "public_reply", { taskId: task.id, speech });
      session.history.push({ role: "assistant", content: speech });
      if (task.planId) session.ledger.set(task.planId, { state: "done", reply: speech });
    }
    persist();
    endTask();
    return;
  }
  if (task.rounds >= MAX_ROUNDS) {
    session.phase = "blocked";
    if (task.origin !== "event") send(ws, "public_reply", { taskId: task.id, speech: "已经到最大执行轮数，需要新的指示。" });
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
  console.log(`[plan] ${task.id} turn=${task.rounds} steps=${out.plan.steps.map((s) => s.action).join(",")} speech=${out.speech ? "yes" : "no"}`);
  // 挖一个格子的授权：只有服务端下发的 dig 才能提交，客户端必须回传这个 id。
  // 授权绑定任务/代际/计划/局/格子/版本，提交时逐项复检。
  const digAuthId = issueDigAuth(task, out.plan);
  if (out.speech) session.history.push({ role: "assistant", content: out.speech });
  send(ws, "execute_plan", {
    taskId: task.id,
    generation: task.generation,
    planId: task.planId,
    leaseEpoch: session.leaseEpoch,
    turnId: task.rounds,
    speech: out.speech ?? "",
    digAuthId,
    plan: out.plan,
  });
}

/**
 * 为计划里的 dig 发放一次性授权。计划里没有 dig 就返回 null。
 * 旧的未使用授权立即作废，used 的保留少量用于幂等重放。
 */
function issueDigAuth(task, plan) {
  const digStep = (plan.steps ?? []).find((step) => step.action === "dig");
  if (!digStep) return null;
  const authId = `dig${++session.digSeq}-g${task.generation}`;
  session.digAuth.set(authId, {
    authId,
    taskId: task.id,
    generation: task.generation,
    planId: task.planId,
    gameId: digStep.game_id,
    row: digStep.row,
    col: digStep.col,
    expectedRevision: digStep.expected_revision,
    issuedAt: Date.now(),
    used: false,
    response: null,
  });
  // 只留一份未使用授权 + 少量已完成记录
  const unused = [...session.digAuth].filter(([, a]) => !a.used);
  for (const [id] of unused.slice(0, -1)) session.digAuth.delete(id);
  const used = [...session.digAuth].filter(([, a]) => a.used);
  for (const [id] of used.slice(0, Math.max(0, used.length - 8))) session.digAuth.delete(id);
  console.log(`[dig] auth ${authId} (${digStep.row},${digStep.col}) rev=${digStep.expected_revision}`);
  return authId;
}

function fail(ws, task, err) {
  if (!session.task || session.task.id !== task?.id || session.task.generation !== task?.generation) {
    console.log("[model] stale error ignored");
    return;
  }
  const code = err instanceof ModelError ? err.code : "INTERNAL";
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[model] ${code}: ${message}`);
  // 自主回合的模型报错（尤其输出被截断）不该在页面上点亮断连红图标：
  // 她自己没想出来，过一会儿再想就是了。
  if (task?.origin !== "event") {
    send(ws, "error", { code, message });
    send(ws, "task_state", { taskId: task?.id ?? null, phase: "error" });
  }
  endTask("model error", { retryMs: 20_000 });
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

      case "game_start": {
        if (!isLease(ws)) { send(ws, "error", { code: "NOT_EXECUTOR", message: "只读连接不能开局" }); break; }
        if (!epochOk(msg)) {
          send(ws, "error", { code: "STALE_LEASE", message: "执行权已过期" });
          break;
        }
        const previous = games.public()?.gameId ?? null;
        const board = games.start(msg.requestId);
        send(ws, "game_state", { board });
        broadcastState();
        // 用户主动点开局：解除“手动结束”的暂停
        autoplay.manualPauseUntil = 0;
        autoplay.nextAt = 0;
        // 只有真的换了局（而不是幂等重发）才算新局事件
        if (board && board.gameId !== previous) {
          noteGameEvent("game_started", board, { trigger: "user_button" });
        }
        break;
      }

      case "game_end": {
        if (!isLease(ws)) { send(ws, "error", { code: "NOT_EXECUTOR", message: "只读连接不能结束对局" }); break; }
        if (!epochOk(msg)) {
          send(ws, "error", { code: "STALE_LEASE", message: "执行权已过期" });
          break;
        }
        const before = games.public()?.gameId ?? null;
        const result = games.end();
        send(ws, "game_state", { board: games.public(), ended: result.ok });
        broadcastState();
        if (result.ok) {
          // 用户主动收摊：硬暂停，普通退避和任务收尾都不许把它缩短
          autoplay.manualPauseUntil = Date.now() + AUTO_AFTER_MANUAL_END_MS;
          autoplay.backoff = 1;
          noteAutoPlayDelay(0);
          console.log(result.cleared ? `[game] 用户收起了 ${before}` : `[game] 用户结束了 ${result.board?.gameId}`);
          // 只有“进行中→结束”才需要告诉模型；收摊已经被用户拿走了
          if (!result.cleared) noteGameEvent("game_finished", result.board, { result: "ended", trigger: "user_button" });
        }
        break;
      }

      // 仅本地验收用：BRAIN_DEV=1 时让探针注入一份“服务端计划”，
      // 这样浏览器验收也走真实的授权/任务/代际链路，而不是绕过它。
      case "debug_plan": {
        if (process.env.BRAIN_DEV !== "1") {
          send(ws, "error", { code: "DEBUG_DISABLED", message: "调试计划需要 BRAIN_DEV=1" });
          break;
        }
        if (!isLease(ws) || !epochOk(msg)) {
          send(ws, "error", { code: "STALE_LEASE", message: "执行权已过期" });
          break;
        }
        if (session.task) {
          send(ws, "error", { code: "BUSY", message: "已有任务在进行" });
          break;
        }
        try {
          const plan = validatePlan({ type: "execute_plan", speech: msg.speech ?? "", steps: msg.steps ?? [], memory_proposals: [] });
          const task = beginTask({ text: msg.text ?? "调试计划", messageId: null, origin: "user", events: [], ws });
          applyOutput(ws, task, plan);
        } catch (err) {
          fail(ws, session.task, err);
        }
        break;
      }

      case "dig_commit": {
        // 每一条回包都带回客户端给的 actionInstanceId，避免客户端只能等 6 秒超时
        const reply = (body) => send(ws, "dig_result", { actionInstanceId: msg.actionInstanceId, ...body });
        if (!isLease(ws)) return reply({ ok: false, reason: "NOT_EXECUTOR" });
        if (!isLeaseAlive()) return reply({ ok: false, reason: "LEASE_STALE" });
        if (!epochOk(msg)) return reply({ ok: false, reason: "STALE_LEASE" });

        const task = session.task;
        const auth = session.digAuth.get(String(msg.digAuthId ?? ""));
        if (!auth) return reply({ ok: false, reason: "NO_AUTH" });
        // 脱离当前任务/代际的迟到提交一律拒绝
        if (!task || task.id !== auth.taskId || task.generation !== auth.generation) {
          return reply({ ok: false, reason: "STALE_TASK", taskId: auth.taskId });
        }
        // 同一个实例重发：原样回放第一次的结算，不重复改棋盘
        if (auth.used) return reply(auth.response ?? { ok: false, reason: "ALREADY_COMMITTED" });
        if (!epochOk(msg) || (msg.planId && auth.planId && msg.planId !== auth.planId)) {
          return reply({ ok: false, reason: "STALE_PLAN" });
        }
        const board = games.public();
        if (!board) return reply({ ok: false, reason: "NO_GAME" });
        if (auth.gameId !== board.gameId || msg.gameId !== auth.gameId) return reply({ ok: false, reason: "STALE_GAME" });
        if (board.status !== "playing") return reply({ ok: false, reason: "GAME_OVER", status: board.status });
        if (Number(msg.expectedRevision) !== auth.expectedRevision) {
          return reply({ ok: false, reason: "STALE_REVISION", revision: board.revision });
        }
        const scoop = props.get("rice_scoop");
        if (!scoop || scoop.state !== "held" || scoop.holder !== "right_hand") {
          return reply({ ok: false, reason: "NO_SCOOP", scoop: scoop ?? null });
        }
        // 接触点复检：客户端上报的坑位坐标必须落在授权格子里，且离格心足够近
        const center = cellCenter(auth.row, auth.col);
        const dx = Number(msg.x) - center.x;
        const dz = Number(msg.z) - center.z;
        const distance = Math.hypot(dx, dz);
        if (!Number.isFinite(distance) || distance > 0.12) {
          return reply({ ok: false, reason: "NOT_IN_CELL", distance_m: Math.round(distance * 1000) / 1000, targetCellCenter: center });
        }
        const result = games.commit({ gameId: auth.gameId, row: auth.row, col: auth.col, expectedRevision: auth.expectedRevision });
        const response = { ...result, authId: auth.authId };
        auth.used = true;
        auth.response = response;
        reply(response);
        if (result.ok) {
          broadcastState();
          noteGameEvent("board_updated", result.board, { changedCells: result.changedCells?.length ?? 0 });
          if (result.status && result.status !== "playing") {
            noteGameEvent("game_finished", result.board, { result: result.status });
          }
        }
        break;
      }

      case "state_snapshot": {
        // 只读页面或旧页面的周期上报不是用户动作：静默忽略，不点亮断连红图标
        if (!isLease(ws)) break;
        if (!epochOk(msg)) break;
        // 重连后对账：执行端报告实际状态，服务器不盲重播任务
        // 只有“不是本连接创建的任务”才需要对账结束；否则会把刚发的消息杀掉
        if (isLease(ws) && session.task && msg.reconciled && (session.task.unknown || session.task.originWs !== ws)) {
          const plan = session.task.planId;
          if (plan && session.ledger.get(plan)?.state === "dispatched") {
            session.ledger.set(plan, { state: "unknown", reason: "reconciled" });
          }
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
        if (!epochOk(msg)) {
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
          cancelCurrentPlan("superseded");
        }

        // 用户指令优先级最高：同一轮里先回应人，再顺带处理攒下的场地事件
        const task = beginTask({
          text: msg.text,
          messageId: null,
          origin: "user",
          events: gameEvents.take(),
          snapshot: msg.snapshot ?? null,
          ws,
        });
        task.messageId = `msg-${task.id}`;

        setTimeout(() => runPlanning(task, ws), 300);
        break;
      }

      case "plan_result": {
        const task = session.task;
        if (!isLease(ws)) return;
        // 心跳断档后的迟到结果不再接受：此时角色可能已经换人/换代际
        if (!isLeaseAlive()) return;
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
        // 进入模型上下文前先瘦身：旧客户端可能把整张棋盘塞在 dig.actual 里
        msg.result = trimExecutionReport(msg.result);
        if (msg.planId) session.ledger.set(msg.planId, { state: "processing", result: msg.result });

        if (Date.now() - task.startedAt > BUDGET_MS) {
          session.phase = "blocked";
          send(ws, "public_reply", { taskId: task.id, speech: "这个任务超过时间预算了，需要新的指示。" });
          cancelCurrentPlan("budget");
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
            cancelCurrentPlan("budget");
            endTask("budget exceeded");
            return;
          }
          if (task.rounds >= MAX_ROUNDS) {
            if (task.origin !== "event") send(ws, "public_reply", { taskId: task.id, speech: "已经到最大执行轮数，需要新的指示。" });
            endTask("round budget");
            return;
          }
          if (!hasKey()) {
            send(ws, "public_reply", { taskId: task.id, speech: summary(msg.result) });
            endTask();
            return;
          }
          try {
            const ctx = modelContext(task, "review", {
              turn: task.rounds,
              executionReport: msg.result,
              // 执行期间攒下的棋盘事件和这次 plan_result 是同一批事实，一次调用合并处理
              attentionEvents: gameEvents.take(),
              clientSnapshot: msg.snapshot ?? null,
            });
            const budget = checkBudget(ctx);
            if (!budget.ok) {
              send(ws, "error", {
                code: "CONTEXT_TOO_LARGE",
                message: `请求估算 ${budget.total} tokens，超过 ${budget.maxInputTokens} 上限`,
              });
              endTask("context too large");
              return;
            }
            console.log(`[ctx] review ${ctx.snapshotId} ~${budget.total} tokens · events=${ctx.attentionEvents.length}`);
            const out = await callModel(reviewMessages(ctx));
            applyOutput(ws, task, out);
          } catch (err) {
            fail(ws, task, err);
          }
        }, 250);
        break;
      }

      case "chat_opened":
        if (!isLease(ws)) { send(ws, "error", { code: "NOT_EXECUTOR", message: "只读连接不能打开聊天" }); break; }
        if (!epochOk(msg)) {
          send(ws, "error", { code: "STALE_LEASE", message: "执行权已过期" });
          break;
        }
        session.chatOpen = true;
        session.chatEpoch = session.leaseEpoch;
        // 聊天期间 tickAutoPlay 会自己跳过；不用把时间表往后推，
        // 关掉聊天后她就能回到自己的局
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

setInterval(tickAutoPlay, Number(process.env.AUTO_TICK_MS ?? 5000)).unref();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`whale brain on :${PORT} (ws /ws)`);
  console.log(`[autoplay] ${AUTO_PLAY ? "开" : "关"} · 续玩 ${AUTO_CONTINUE_IDLE_MS}ms · 新局 ${AUTO_START_IDLE_MS}ms · 上限 ${AUTO_MAX_TURNS_PER_HOUR}/h`);
});
