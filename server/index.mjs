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
import {digAim} from "../shared/dig-aim.mjs";
import { randomUUID } from "node:crypto";
import { modeView, changeMode } from "./behavior-mode.mjs";
import { ownerIdentity, recordMessage, propose, editMemory, memoryView, relevantMemory, acceptSummary, recentConversation } from "./preferences.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createStore, reconcileOnLoad } from "./store.mjs";
import { GameService } from "./game.mjs";
import { DIG_TOLERANCE_M, cellCenter } from "./minesweeper.mjs";
import { contextBudget, estimateRequest, linkCurrentExecution, MAX_INPUT_TOKENS } from "./context.mjs";

import { createGameEventQueue } from "./events.mjs";
import { boardContext, characterContext, propIdOf, propsContext, sanitizeProp, slotsOf, trimExecutionReport } from "./public-state.mjs";
import { CAPABILITY_VERSION, ModelError, PROMPT_VERSION, callModel, describeCapabilities, describeDisabled, hasKey, planningMessages, reviewMessages } from "./llm.mjs";
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
 * 扫雷是她自己玩的：宿主负责开局和“续玩”，模型只负责这一局怎么走。
 * AUTO_MINESWEEPER=0 可以整体关掉；三个间隔都可以用环境变量覆盖。
 */
const AUTO_PLAY = (process.env.AUTO_MINESWEEPER ?? "1") !== "0";
const AUTO_CONTINUE_IDLE_MS = Number(process.env.AUTO_CONTINUE_IDLE_MS ?? 45_000);
const AUTO_START_IDLE_MS = Number(process.env.AUTO_START_IDLE_MS ?? 90_000);
/**
 * 自主回合的**模型调用**预算（不是回合数）：一个回合 = 1 次 planning + 最多 3 次 review，
 * 按回合计会把实际开销低估 4 倍。思考模式下每次调用约 7k 输入 + 3~7k 输出，
 * 一局之内尽量让她下完，所以默认给到 300；`AUTO_MAX_CALLS=0` 表示不限制。
 */
const AUTO_MAX_CALLS_PER_HOUR = Number(process.env.AUTO_MAX_CALLS ?? 300);
/**
 * 扫雷进行中但模型一分钟没动静 → 宿主主动发一条提醒把她叫醒。
 * 这是“活着”的兜底：退避、预算、模型报错之后都不该让棋盘一直晾着。
 */
const AUTO_STILL_PLAYING_MS = Number(process.env.AUTO_STILL_PLAYING_MS ?? 60_000);
const AUTO_MAX_BACKOFF_MS = 600_000;
/** 用户点了「扫雷结束」之后，别马上又自己开一局 */
const AUTO_AFTER_MANUAL_END_MS = Number(process.env.AUTO_AFTER_MANUAL_END_MS ?? Infinity);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
};

function serveStatic(req, res) {
  if (!fs.existsSync(ROOT)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("whale brain is running (no dist yet)\n");
    return;
  }
  const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "");
  let file = path.resolve(ROOT, rel || "index.html");
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  const ext = path.extname(file);
  res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req,res)=>{
  const owner=ownerIdentity(req,res,path.join(process.cwd(),"data"));
  if(req.url?.startsWith('/api/memory')){
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    if(req.method==='GET'){res.end(JSON.stringify({memories:memoryView(store.state,owner),recentConversation:recentConversation(store.state,owner),conversationSummary:store.state.summaries?.[owner]?.text??null}));return;}
    if(req.method!=='POST'||req.headers['content-type']?.split(';')[0]!=='application/json'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)){res.writeHead(403).end('{}');return;}
    try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)throw Error('请求过长');}
      store.update(st=>editMemory(st,owner,JSON.parse(raw)));store.flush();
      res.end(JSON.stringify({memories:memoryView(store.state,owner),recentConversation:recentConversation(store.state,owner),conversationSummary:store.state.summaries?.[owner]?.text??null}));
    }catch(err){res.writeHead(400).end(JSON.stringify({error:err.message}));}return;
  }
  serveStatic(req,res);
});
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
    const tmp=STATE_FILE+".tmp";
    fs.writeFileSync(
      tmp,
      JSON.stringify({ ...character, props: list, basin: props.get("basin") ?? null, updatedAt: Date.now() }),
    );fs.renameSync(tmp,STATE_FILE);
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
  id: `s${randomUUID()}`,
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
    st.history = []; // Legacy global chat is never injected across owners.
    st.ledger = Object.fromEntries([...session.ledger].slice(-200));
    st.autoplay={calls:autoplay.calls,manualPaused:autoplay.manualPauseUntil===Infinity,manualPauseUntil:Number.isFinite(autoplay.manualPauseUntil)?autoplay.manualPauseUntil:0,nextAt:Number.isFinite(autoplay.nextAt)?autoplay.nextAt:0};
    st.session = { id: session.id, phase: session.phase, taskId: session.task?.id ?? null, generation: session.generation };
    st.task = session.task
      ? { id: session.task.id, generation: session.task.generation, text: session.task.text, originalText:session.task.originalText, ownerScope:session.task.ownerScope, messageId:session.task.messageId, origin:session.task.origin, rounds: session.task.rounds, planId: session.task.planId ?? null }
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
  if(session.lease&&session.lease!==ws&&session.task){cancelCurrentPlan('lease_expired');session.task.unknown=true;session.phase='unknown';persist();}
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
    behaviorMode:modeView(store.state),
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
  /** 最近一小时自主体回合的模型调用时间戳 */
  calls: store.state.autoplay?.calls??[],
  /** 用户手动「扫雷结束」后的硬暂停：普通退避不许缩短它 */
  manualPauseUntil: store.state.autoplay?.manualPaused?Infinity:store.state.autoplay?.manualPauseUntil??0,
};

/** 最近一次模型调用的时间：看门狗用它判断“是不是真的没动静了” */
let lastLlmAt = Date.now();
const noteLlmActivity = () => { lastLlmAt = Date.now(); };

function noteAutoPlayDelay(ms) {
  // 手动收摊的暂停优先：任何普通退避都不能把它缩短
  autoplay.nextAt = Math.max(Date.now() + ms, autoplay.manualPauseUntil);
}

/**
 * 条件全满足时给自己派一个回合：没有进行中的局就开一局，
 * 局还没结束就发 self_play 请她继续。任务进行中或没有执行端时不触发。
 */
function tickAutoPlay() {
  if (!AUTO_PLAY || !hasKey()) return;
  const now = Date.now();
  if (Date.now() < autoplay.manualPauseUntil) return;
  if (session.task || !isLeaseAlive() || session.phase === "unknown" || session.phase === "stopping") {
    if (process.env.AUTOPLAY_DEBUG) console.log(`[autoplay] skip task=${!!session.task} lease=${isLeaseAlive()} chat=${session.chatOpen} phase=${session.phase}`);
    return;
  }
  if (now < autoplay.nextAt) {
    if (process.env.AUTOPLAY_DEBUG) console.log(`[autoplay] wait ${Math.round((autoplay.nextAt - now) / 1000)}s`);
    return;
  }
  autoplay.calls = autoplay.calls.filter((t) => now - t < 3_600_000);
  if (AUTO_MAX_CALLS_PER_HOUR > 0 && autoplay.calls.length >= AUTO_MAX_CALLS_PER_HOUR) {
    // 等到最早那次调用滑出 1 小时窗口，而不是固定冷却
    const oldest = autoplay.calls[0] ?? now;
    const waitMs = Math.max(30_000, oldest + 3_600_000 - now + 1_000);
    noteAutoPlayDelay(waitMs);
    console.log(`[autoplay] 自主调用预算用尽（${autoplay.calls.length}/${AUTO_MAX_CALLS_PER_HOUR} 次/小时），${Math.round(waitMs / 1000)}s 后恢复`);
    return;
  }
  const board = games.public();
  // 一局结束（通关/踩雷/已结束）之后不自动重开：必须由用户手动点「扫雷开局」。
  // 这样“一局”就是一个明确的成本边界。
  if (board && board.status !== "playing") return;
  console.log(`[autoplay] tick board=${board?.status ?? "none"} revision=${board?.revision ?? "-"}`);
  if (board) {
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

/**
 * 扫雷看门狗：只要还有一局在进行、又没人占用任务，超过一分钟没有模型活动
 * 就主动入队一条 game_still_active 提醒，把她叫回来继续。每分钟最多一次。
 */
function tickStillPlaying() {
  if (!AUTO_PLAY || !hasKey()) return;
  const board = games.public();
  if (!board || board.status !== "playing") return;
  if (session.task || !isLeaseAlive() || session.phase === "unknown" || session.phase === "stopping") return;
  if (Date.now() < autoplay.manualPauseUntil) return;
  const idleMs = Date.now() - lastLlmAt;
  if (idleMs < AUTO_STILL_PLAYING_MS) return;
  autoplay.calls = autoplay.calls.filter((t) => Date.now() - t < 3_600_000);
  if (AUTO_MAX_CALLS_PER_HOUR > 0 && autoplay.calls.length >= AUTO_MAX_CALLS_PER_HOUR) {
    if (Date.now() - (autoplay.stillWarnedAt ?? 0) > 60_000) {
      autoplay.stillWarnedAt = Date.now();
      console.log("[autoplay] 想唤醒但自主调用预算已用尽");
    }
    return;
  }
  autoplay.stillWarnedAt = 0;
  console.log(`[autoplay] 扫雷进行中已 ${Math.round(idleMs / 1000)}s 没有模型活动，主动唤醒`);
  gameEvents.push({
    eventId: `ev${++eventSeq}`,
    type: "game_still_active",
    gameId: board.gameId,
    revision: board.revision,
    status: board.status,
    at: new Date().toISOString(),
    idleMs,
  });
  scheduleEventTurn();
  // 先推一次时间，避免 5 秒的调度周期里重复入队；真正的调用会再刷新
  lastLlmAt = Date.now();
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
  if(!autonomousAllowed())return;
  if (session.task || eventTurnTimer || !gameEvents.size()) return;
  if (!isLeaseAlive()) return;
  eventTurnTimer = setTimeout(() => {
    eventTurnTimer = null;
    if (session.task || !gameEvents.size()) return;
    if(!autonomousAllowed())return;
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
  task?.abort?.abort();
  if (!task?.planId) return;
  const entry = session.ledger.get(task.planId);
  if (entry && entry.state === "dispatched") session.ledger.set(task.planId, { ...entry, state: "cancel_requested", reason });
  send(session.lease, "cancel_plan", { taskId: task.id, generation: task.generation, planId: task.planId, reason });
  console.log(`[plan] cancel ${task.planId} (${reason})`);
}

function endTask(reason, opts = {}) {
  const finished = session.task;
  if(finished?.origin==="active"){
    const results=[...session.ledger].filter(([id])=>id.startsWith(finished.id+'-')).map(([,e])=>e.result).filter(Boolean);
    const progress=results.some(r=>r.steps?.some(s=>s.status==='succeeded'&&s.action!=='wait'));
    activeNoProgress=progress?0:activeNoProgress+1;
    store.update(st=>{st.recentAutonomy=[...(st.recentAutonomy??[]),{taskId:finished.id,at:Date.now(),progress,actions:results.flatMap(r=>r.steps?.map(s=>({action:s.action,status:s.status}))??[])}].slice(-4);});
  }
  finished?.abort?.abort();
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
  const taskId = `t${nextTask++}-${randomUUID().slice(0,8)}`;
  const generation = ++session.generation;
  if (session.budgetTimer) clearTimeout(session.budgetTimer);
  session.budgetTimer = setTimeout(() => {
    if (session.task?.id !== taskId) return;
    session.phase = "blocked";
    if (origin !== "event") send(ws, "public_reply", { taskId, speech: "这个任务超过时间预算了，先停在这里。" });
    // 预算到期必须先让执行端停下，不能只把任务置 idle
    cancelCurrentPlan("budget");
    if(session.task?.planId){session.task.stopping=true;session.phase="stopping";persist();broadcastState();setTimeout(()=>{if(session.task?.id===taskId&&session.task.stopping){session.phase="unknown";session.task.unknown=true;persist();broadcastState();}},5000).unref();}else endTask("budget timer", { retryMs: null });
  }, BUDGET_MS);
  session.task = {
    id: taskId,
    generation,
    abort:new AbortController(),
    ownerScope:ws?.ownerScope??null,
    ready:!ws?.stopReadyProtocol,
    promptVersion:PROMPT_VERSION,capabilityVersion:CAPABILITY_VERSION,
    memoryRevision:store.state.memoryRevision?.[ws?.ownerScope]??0,
    modeEpoch:modeView(store.state).modeEpoch,
    autonomyDeadline:origin==="active"?modeView(store.state).expiresAt:null,
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
  if(text&&origin==='user'){
    store.update(st=>{const m=recordMessage(st,session.task.ownerScope,session.id,'user',text);session.task.messageId=m.messageId;});store.flush();
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
  const selfPlay = task.origin !== "user";
  const messages=(store.state.messages??[]).filter(m=>m.ownerScope===task.ownerScope);
  const recent=messages.slice(-24);task.contextSourceIds=recent.map(m=>m.messageId);
  return {
    phase,
    snapshotId: `snap${++snapshotSeq}`,
    timestamp: new Date().toISOString(),
    taskId: task.id,
    goal: selfPlay
      ? {
          originalText: null,
          origin: task.origin,
          note: task.origin==="active"?"活跃机会：自行选择一个短而有趣的行为，可沉默，无需重复旧任务。":eventNote(extra.attentionEvents),
        }
      : { originalText: task.originalText, origin: task.origin },
    userMessage: task.text || null,
    userMessageId:task.messageId,
    versions:{prompt:task.promptVersion??PROMPT_VERSION,capability:task.capabilityVersion??CAPABILITY_VERSION,schema:2},
    behaviorMode:{...modeView(store.state),drainTaskId:task.origin==="active"&&!modeView(store.state).acceptingNewAutonomy?task.id:null},
    recentAutonomy:store.state.recentAutonomy??[],
    finishOnly:(task.origin!=="user"&&AUTO_MAX_CALLS_PER_HOUR>0&&autoplay.calls.length>=AUTO_MAX_CALLS_PER_HOUR-1)||task.rounds>=MAX_ROUNDS||(task.origin==="active"&&(!modeView(store.state).acceptingNewAutonomy||task.modeEpoch!==modeView(store.state).modeEpoch||Date.now()>=task.autonomyDeadline)),
    taskEvidence:linkCurrentExecution(
      [...session.ledger].filter(([id])=>id.startsWith(task.id+"-")).map(([planId,e])=>({planId,state:e.state,result:e.result??null})),
      task.planId,extra.executionReport,
    ),
    conversationSummary:selfPlay?null:store.state.summaries?.[task.ownerScope]??null,
    leaseAndBudget: {
      leaseEpoch: session.leaseEpoch,
      hasExecutor: isLeaseAlive(),
      roundsUsed: task.rounds,
      maxRounds: MAX_ROUNDS,
      budgetMs: BUDGET_MS,
      remainingMs: Math.max(0, BUDGET_MS - (Date.now() - task.startedAt)),
    },
    capabilities: describeCapabilities().filter(cap=>task.originWs?.runtimeVersion==="playful-v2-count32"||!["set_basin_grip","knock_basin"].includes(cap.id)).map(cap=>cap.id==='play'&&[...props.values()].some(p=>p.state==='held')?{...cap,params:{action_id:{enum:['nod','look_left','look_right'],note:'持物时禁用未适配双臂的greet/notice/think'}}}:cap),
    disabledCapabilities: [...describeDisabled(),...(task.originWs?.runtimeVersion==="playful-v2-count32"?[]:[{id:"set_basin_grip",reason:"执行页面需刷新到playful-v2-count32"},{id:"knock_basin",reason:"执行页面需刷新到playful-v2-count32"}])],
    capabilityVersion: CAPABILITY_VERSION,
    world: {
      walkableHalf: 3.7,
      stageHalf: 4,
      coordinateSystem: "glTF +Y up, +Z forward; yaw=0 指向 +Z",
    },
    characterState: characterContext(character),
    props: propsContext(props),
    board: boardContext(board, character),
    ...(selfPlay ? { history: [], historyOmitted: true } : contextBudget({ history: recent })),
    memory: selfPlay?[]:relevantMemory(store.state,task.ownerScope),
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
  const messages=ctx.phase==='review'?reviewMessages(ctx):planningMessages(ctx);
  const budget=estimateRequest({messages,maxInputTokens:MAX_INPUT_TOKENS});
  // Trim only optional conversation facts. Goal, snapshot and cumulative commit evidence remain protected.
  while(!budget.ok&&ctx.history?.length){ctx.history.shift();while(ctx.history[0]?.role==='assistant')ctx.history.shift();Object.assign(budget,estimateRequest({messages:ctx.phase==='review'?reviewMessages(ctx):planningMessages(ctx),maxInputTokens:MAX_INPUT_TOKENS}));}
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
    const deadline=Date.now()+30000;
    while(!task.ready&&session.task===task&&!task.abort?.signal.aborted&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    if(session.task!==task||task.abort?.signal.aborted)return;
    if(!task.ready)throw new ModelError('EXECUTOR_NOT_READY','角色尚未停稳，停止规划',0);
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

    noteLlmActivity();
    if(task.origin!=="user"&&!claimAutoCall()){endTask("autonomous call budget");return;}
    send(ws, "reasoning_start", { taskId: task.id });
    const out = await callModel(planningMessages(ctx),task.abort?.signal, text => { if (session.task === task && !task.abort?.signal.aborted) send(ws, "reasoning_delta", { taskId: task.id, text }); });
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

function absorbMemory(task,out){
  if(task.origin!=="user"||!task.ownerScope||(store.state.memoryRevision?.[task.ownerScope]??0)!==task.memoryRevision)return;
  const before=memoryView(store.state,task.ownerScope).map(({id,status})=>`${id}:${status}`).join('|');
  store.update(st=>{propose(st,task.ownerScope,out.memoryProposals??[],task.contextSourceIds??[task.messageId]);acceptSummary(st,task.ownerScope,out.summaryProposal,task.contextSourceIds??[]);});store.flush();
  const after=memoryView(store.state,task.ownerScope);
  if(after.map(({id,status})=>`${id}:${status}`).join('|')!==before){
    send(task.originWs,'memory_updated',{pendingCount:after.filter(m=>m.status==='candidate').length});
  }
}

function applyOutput(ws, task, out) {
  if (!session.task || session.task.id !== task.id) return;
  absorbMemory(task, out);
  if(task.planId&&session.ledger.get(task.planId)?.state==="processing")session.ledger.set(task.planId,{...session.ledger.get(task.planId),state:"done"});
  if (out.type === "finish_task") {
    // 自主回合允许完全沉默：没有值得说的就不发 public_reply
    const speech = out.speech || "";
    if (speech) {
      send(ws, "public_reply", { taskId: task.id, speech });
      if(task.origin==="user")store.update(st=>recordMessage(st,task.ownerScope,session.id,"assistant",speech));
      if (task.planId) session.ledger.set(task.planId, { ...session.ledger.get(task.planId), state: "done", reply: speech });
    }
    persist();
    endTask();
    return;
  }
  if ((task.origin!=="user"&&AUTO_MAX_CALLS_PER_HOUR>0&&autoplay.calls.length>=AUTO_MAX_CALLS_PER_HOUR) || task.rounds >= MAX_ROUNDS || (task.origin==="active"&&(!modeView(store.state).acceptingNewAutonomy||task.modeEpoch!==modeView(store.state).modeEpoch||Date.now()>=task.autonomyDeadline))) {
    session.phase = "blocked";
    if (task.origin !== "event") send(ws, "public_reply", { taskId: task.id, speech: "已经到最大执行轮数，需要新的指示。" });
    endTask("round budget");
    return;
  }
  if(out.plan.steps.some(s=>['knock_basin','set_basin_grip'].includes(s.action))&&ws.runtimeVersion!=='playful-v2-count32'){
    send(ws,'error',{code:'RELOAD_REQUIRED',message:'请刷新页面后使用新动作'});endTask('old runtime');return;
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
  if(out.speech&&task.origin==="user")store.update(st=>recordMessage(st,task.ownerScope,session.id,"assistant",out.speech));
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
  const authId = `dig-${task.id}-${++session.digSeq}-g${task.generation}`;
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
  ws.ownerScope=ownerIdentity(req,{setHeader(){}},path.join(process.cwd(),"data"));
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
      case "executor_ready":
        if(isLease(ws)&&epochOk(msg)&&session.task?.id===msg.taskId){applyClientSnapshot(msg.snapshot);session.task.ready=true;}break;
      case "mode_set":
        if(!isLease(ws)||!epochOk(msg))break;
        changeMode(store.state,msg.mode);persist();store.flush();broadcastState();break;
      case "stop_ack":
        if(isLease(ws)&&epochOk(msg)&&session.task?.id===msg.taskId&&session.task?.stopping){applyClientSnapshot(msg.snapshot);endTask("stopped and reconciled");}break;
      case "hello":
        if(msg.stopReadyProtocol===1)ws.stopReadyProtocol=true;
        if(typeof msg.runtimeVersion==="string")ws.runtimeVersion=msg.runtimeVersion;
        if (!isLeaseAlive()) grantLease(ws);
        send(ws, "session_state", statePayload(ws));
        break;

      case "heartbeat":
        if (isLease(ws)&&isLeaseAlive()) session.leaseAt = Date.now();
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
        autoplay.manualPauseUntil = 0;persist();
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
          noteAutoPlayDelay(0);persist();store.flush();
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

      case "dig_query": {
        if(!isLease(ws)||!epochOk(msg))break;
        const result=games.lookup(String(msg.digAuthId??''));
        send(ws,'dig_result',{actionInstanceId:msg.actionInstanceId,...(result??{ok:false,reason:'UNKNOWN_COMMIT'})});break;
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
        if (!task || task.id !== auth.taskId || task.generation !== auth.generation || msg.taskId!==auth.taskId || msg.generation!==auth.generation) {
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
        if(msg.row!==auth.row||msg.col!==auth.col)return reply({ok:false,reason:'STALE_CELL'});
        const center = cellCenter(auth.row, auth.col);
        const dx = Number(msg.x) - center.x;
        const dz = Number(msg.z) - center.z;
        const distance = Math.hypot(dx, dz);
        if (!Number.isFinite(distance) || distance > DIG_TOLERANCE_M) {
          return reply({ ok: false, reason: "NOT_IN_CELL", distance_m: Math.round(distance * 1000) / 1000, targetCellCenter: center });
        }
        if(Math.hypot(character.x-center.x,character.z-center.z)>DIG_TOLERANCE_M||Math.hypot(Number(msg.x)-character.x,Number(msg.z)-character.z)>.025)return reply({ok:false,reason:'NOT_IN_CELL'});
        const aim=digAim(character),point=msg.toolPoint;
        if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.z)||Math.hypot(point.x-aim.tip.x,point.z-aim.tip.z)>.03||Math.abs(point.x-center.x)>.25||Math.abs(point.z-center.z)>.25)return reply({ok:false,reason:'TOOL_NOT_IN_CELL'});
        const result = games.commit({ actionInstanceId:auth.authId, gameId: auth.gameId, row: auth.row, col: auth.col, expectedRevision: auth.expectedRevision });
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

        if(task.stopping){endTask("cancelled plan settled");return;}
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

            noteLlmActivity();
            if(task.origin!=="user"&&!claimAutoCall()){endTask("autonomous call budget");return;}
            send(ws, "reasoning_start", { taskId: task.id });
            const out = await callModel(reviewMessages(ctx),task.abort?.signal, text => { if (session.task === task && !task.abort?.signal.aborted) send(ws, "reasoning_delta", { taskId: task.id, text }); });
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
        // 兼容旧客户端的界面状态；聊天栏是否显示不限制自主行动。
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
      if(session.task){session.task.abort?.abort();session.phase="unknown";session.task.unknown=true;persist();}
      broadcastState();
    }
  });
});


function autonomousAllowed(ignoreGamePause=false){
  autoplay.calls=autoplay.calls.filter(t=>Date.now()-t<3600000);
  return session.phase!=="unknown" && session.phase!=="stopping" && isLeaseAlive() && (ignoreGamePause||Date.now()>=autoplay.manualPauseUntil) && (AUTO_MAX_CALLS_PER_HOUR<=0||autoplay.calls.length<AUTO_MAX_CALLS_PER_HOUR);
}
function claimAutoCall(){
  autoplay.calls=autoplay.calls.filter(t=>Date.now()-t<3600000);
  if(AUTO_MAX_CALLS_PER_HOUR>0&&autoplay.calls.length>=AUTO_MAX_CALLS_PER_HOUR)return false;
  autoplay.calls.push(Date.now());persist();return true;
}
let nextActiveAt=Date.now()+45000;
let activeNoProgress=0;
function tickActive(){
  const before=store.state.behaviorMode?.mode;
  const mode=modeView(store.state);if(before!==mode.mode){persist();broadcastState();}
  if(session.lease&&!isLeaseAlive()){
    const old=session.lease;cancelCurrentPlan('heartbeat_expired');session.lease=null;session.leaseEpoch++;session.chatOpen=false;
    if(session.task){session.phase='unknown';session.task.unknown=true;persist();}
    send(old,'session_state',statePayload(old));broadcastState();
  }
  scheduleEventTurn();
  if(!mode.acceptingNewAutonomy||session.task||!hasKey()||!autonomousAllowed(true)||games.public()?.status==='playing'||gameEvents.size()||Date.now()<nextActiveAt)return;
  nextActiveAt=Date.now()+30000+Math.random()*30000;
  if(activeNoProgress>=2){nextActiveAt=Date.now()+120000;activeNoProgress=0;return;}
  const task=beginTask({text:'',messageId:null,origin:'active',ws:session.lease});
  runPlanning(task,session.lease);
}
const TICK_MS = Number(process.env.AUTO_TICK_MS ?? 5000);
setInterval(tickActive, 1000).unref();
setInterval(tickAutoPlay, TICK_MS).unref();
setInterval(tickStillPlaying, TICK_MS).unref();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`whale brain on :${PORT} (ws /ws)`);
  console.log(`[autoplay] ${AUTO_PLAY ? "开" : "关"} · 续玩 ${AUTO_CONTINUE_IDLE_MS}ms · 新局 ${AUTO_START_IDLE_MS}ms · 调用预算 ${AUTO_MAX_CALLS_PER_HOUR || "不限"}/h`);
});
