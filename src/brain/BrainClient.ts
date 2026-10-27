/**
 * 浏览器端与大脑的连接。
 * 只负责协议收发；执行由 ActionExecutor 完成，模型回复只走公开字段。
 */

export interface PlanMessage {
  taskId: string;
  turnId: number;
  generation?: number;
  planId?: string;
  leaseEpoch?: number;
  /** 服务端为这次 dig 发放的授权 id，提交时必须原样带回 */
  digAuthId?: string | null;
  /** 服务端为这次 place_stone 发放的授权 id */
  stoneAuthId?: string | null;
  speech: string;
  plan: { steps: unknown[] };
}

export interface ReplyMessage {
  taskId: string;
  speech: string;
}

type Handlers = {
  onReasoningStart?: (taskId: string) => void;
  onReasoningDelta?: (taskId: string, text: string) => void;
  onPlan?: (msg: PlanMessage) => void;
  onReply?: (msg: ReplyMessage) => void;
  onTaskState?: (phase: string, taskId?:string) => void;
  onMode?:(mode:unknown)=>void;
  onMemoryUpdated?:(pendingCount:number)=>void;
  onCancel?: (taskId: string) => void;
  onReadOnly?: (readOnly: boolean) => void;
  onReconcile?: () => void;
  onSnapshot?: (s: { x: number; z: number; yawDeg: number }) => void;
  onBasin?: (basin: Record<string, unknown>) => void;
  onGame?: (board: unknown) => void;
  onGomoku?: (board: unknown) => void;
  onError?: (code: string, message: string) => void;
  onConnection?: (connected: boolean) => void;
};

export class BrainClient {
  private ws: WebSocket | null = null;
  private handlers: Handlers = {};
  private retry = 0;
  leaseEpoch = 0;
  private digSeq = 0;
  private digWaiters = new Map<string, (msg: Record<string, unknown>) => void>();
  private stoneWaiters = new Map<string, (msg: Record<string, unknown>) => void>();
  private takeover: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`) {}

  on(handlers: Handlers) {
    this.handlers = handlers;
  }

  connect() {
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws.addEventListener("open", () => {
      this.retry = 0;
      this.handlers.onConnection?.(true);
      this.send("hello", {stopReadyProtocol:1,runtimeVersion:"playful-v2-count32"});
      this.startHeartbeat();
    });
    this.ws.addEventListener("close", () => {
      this.handlers.onConnection?.(false);
      this.scheduleRetry();
    });
    // 页面重新可见/聚焦时重新申请执行权（后台节流会导致心跳断档）
    const reclaim = () => {
      if (document.visibilityState === "visible") this.send("hello", {stopReadyProtocol:1,runtimeVersion:"playful-v2-count32"});
    };
    document.addEventListener("visibilitychange", reclaim);
    window.addEventListener("focus", () => this.send("hello", {}));
    this.ws.addEventListener("message", (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (msg.type) {
        case "reasoning_start":
          this.handlers.onReasoningStart?.(String(msg.taskId));
          break;
        case "reasoning_delta":
          if (typeof msg.text === "string") this.handlers.onReasoningDelta?.(String(msg.taskId), msg.text);
          break;
        case "execute_plan":
          this.handlers.onPlan?.(msg as unknown as PlanMessage);
          break;
        case "public_reply":
          this.handlers.onReply?.(msg as unknown as ReplyMessage);
          break;
        case "task_state":
          this.handlers.onTaskState?.(String(msg.phase),String(msg.taskId??""));
          break;
        case "cancel_plan":
          this.handlers.onCancel?.(String(msg.taskId));
          break;
        case "session_state": {
          const ro = !!msg.readOnly;
          if (typeof msg.leaseEpoch === "number") this.leaseEpoch = msg.leaseEpoch;
          this.handlers.onReadOnly?.(ro);
          if (ro && !this.takeover) {
            // 只读时定期重新申请：旧执行端心跳过期后可以接管
            this.takeover = setInterval(() => this.send("hello", {}), 3000);
          } else if (!ro && this.takeover) {
            clearInterval(this.takeover);
            this.takeover = null;
          }

          // session_state 也携带任务阶段：任务结束后必须清除“思考中”
          if (typeof msg.phase === "string") this.handlers.onTaskState?.(msg.phase,String(msg.taskId??""));
          const ch = msg.character as { x: number; z: number; yawDeg: number } | undefined;
          if (ch && Number.isFinite(ch.x) && Number.isFinite(ch.z) && Number.isFinite(ch.yawDeg)) {
            this.handlers.onSnapshot?.(ch);
          }
          if (msg.basin) this.handlers.onBasin?.(msg.basin as Record<string, unknown>);
          if ("game" in msg) this.handlers.onGame?.(msg.game);
          if ("gomoku" in msg) this.handlers.onGomoku?.(msg.gomoku);
          if(msg.behaviorMode)this.handlers.onMode?.(msg.behaviorMode);
          if (msg.needsReconcile) this.handlers.onReconcile?.();
          break;
        }
        case "memory_updated":
          this.handlers.onMemoryUpdated?.(Number(msg.pendingCount)||0);
          break;
        case "game_state":
          this.handlers.onGame?.(msg.board);
          break;
        case "gomoku_state":
          this.handlers.onGomoku?.(msg.board);
          break;
        case "stone_result": {
          const resolve = this.stoneWaiters.get(String(msg.stoneAuthId));
          if (resolve) { this.stoneWaiters.delete(String(msg.stoneAuthId)); resolve(msg); }
          break;
        }
        case "dig_result": {
          const resolve = this.digWaiters.get(String(msg.actionInstanceId));
          if (resolve) { this.digWaiters.delete(String(msg.actionInstanceId)); resolve(msg); }
          break;
        }
        case "error":
          this.handlers.onError?.(String(msg.code), String(msg.message));
          break;
      }
    });
  }

  private startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.send("heartbeat", {}), 5000);
  }

  sendReconciled(snapshot: Record<string, unknown>) {
    return this.send("state_snapshot", { snapshot, reconciled: true, leaseEpoch: this.leaseEpoch });
  }

  private scheduleRetry() {
    const delay = Math.min(8000, 1000 * 2 ** this.retry++);
    setTimeout(() => this.connect(), delay);
  }

  private send(type: string, payload: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ protocolVersion: 1, type, ...payload }));
    return true;
  }

  sendUserMessage(text: string, snapshot: Record<string, unknown>) {
    return this.send("user_message", { text, snapshot, leaseEpoch: this.leaseEpoch });
  }

  sendPlanResult(
    taskId: string,
    result: unknown,
    meta: { generation?: number; planId?: string;leaseEpoch?:number } = {},
    snapshot?: Record<string, unknown>,
  ) {
    // 快照随结果一起上报：审核阶段必须看到“执行完之后的真实位置”，
    // 不能再用服务端缓存的旧坐标
    return this.send("plan_result", {
      taskId,
      result,
      snapshot,
      generation: meta.generation,
      planId: meta.planId,
      leaseEpoch: meta.leaseEpoch??this.leaseEpoch,
    });
  }

  ready(taskId:string,snapshot:Record<string,unknown>){return this.send("executor_ready",{taskId,snapshot,leaseEpoch:this.leaseEpoch});}
  setMode(mode:string){return this.send('mode_set',{mode,leaseEpoch:this.leaseEpoch});}
  acknowledgeStop(taskId:string,snapshot:Record<string,unknown>){return this.send('stop_ack',{taskId,snapshot,leaseEpoch:this.leaseEpoch});}
  setChatOpen(open: boolean) {
    return this.send(open ? "chat_opened" : "chat_closed", { leaseEpoch: this.leaseEpoch });
  }

  /** 开局：同一 requestId 幂等 */
  startGame(requestId = `r${Date.now()}`) {
    return this.send("game_start", { requestId, leaseEpoch: this.leaseEpoch });
  }

  /** 用户主动结束当前局（按钮变成「扫雷结束」时调用） */
  endGame() {
    return this.send("game_end", { leaseEpoch: this.leaseEpoch });
  }

  /** 五子棋开局：她执黑先行 */
  startGomoku(requestId = `gm${Date.now()}`) {
    return this.send("gomoku_start", { requestId, leaseEpoch: this.leaseEpoch });
  }

  /** 用户（白方）点交点落子 */
  gomokuMove(payload: { gameId: string; row: number; col: number; expectedRevision: number; moveId?: string }) {
    return this.send("gomoku_move", { ...payload, leaseEpoch: this.leaseEpoch });
  }

  /** 五子棋结束/收起 */
  endGomoku() {
    return this.send("gomoku_end", { leaseEpoch: this.leaseEpoch });
  }

  /** 五子棋落子提交：走到位、做完落子动作后调用，等待服务端复检结算 */
  commitStone(payload: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const authId = String(payload.stoneAuthId ?? "");
    return new Promise((resolve) => {
      if (!authId) { resolve({ ok: false, reason: "NO_AUTH" }); return; }
      this.stoneWaiters.set(authId, resolve);
      this.send("gomoku_commit", { ...payload, leaseEpoch: payload.leaseEpoch ?? this.leaseEpoch });
      setTimeout(() => {
        if (this.stoneWaiters.delete(authId)) resolve({ ok: false, reason: "UNKNOWN_COMMIT" });
      }, timeoutMs);
    });
  }

  /** 挖掘提交：由执行器在 dig_contact 时刻调用，等待服务端结算 */
  commitDig(payload: Record<string, unknown>, timeoutMs = 6000): Promise<Record<string, unknown>> {
    const actionInstanceId = `d${++this.digSeq}`;
    return new Promise((resolve) => {
      this.digWaiters.set(actionInstanceId, resolve);
      this.send("dig_commit", { ...payload, actionInstanceId, leaseEpoch: payload.leaseEpoch??this.leaseEpoch });
      setTimeout(() => {
        if(!this.digWaiters.has(actionInstanceId))return;
        this.send('dig_query',{digAuthId:payload.digAuthId,actionInstanceId,leaseEpoch:payload.leaseEpoch??this.leaseEpoch});
        setTimeout(()=>{if(this.digWaiters.delete(actionInstanceId))resolve({ok:false,reason:'UNKNOWN_COMMIT'});},timeoutMs);
      }, timeoutMs);
    });
  }

  sendStateSnapshot(snapshot: Record<string, unknown>) {
    // 写操作必须带当前租约代际，服务端会拒绝没有代际的快照
    return this.send("state_snapshot", { snapshot, leaseEpoch: this.leaseEpoch });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
