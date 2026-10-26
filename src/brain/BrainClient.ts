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
  speech: string;
  plan: { steps: unknown[] };
}

export interface ReplyMessage {
  taskId: string;
  speech: string;
}

type Handlers = {
  onPlan?: (msg: PlanMessage) => void;
  onReply?: (msg: ReplyMessage) => void;
  onTaskState?: (phase: string) => void;
  onCancel?: (taskId: string) => void;
  onReadOnly?: (readOnly: boolean) => void;
  onReconcile?: () => void;
  onSnapshot?: (s: { x: number; z: number; yawDeg: number }) => void;
  onBasin?: (basin: Record<string, unknown>) => void;
  onGame?: (board: unknown) => void;
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
      this.send("hello", {});
      this.startHeartbeat();
    });
    this.ws.addEventListener("close", () => {
      this.handlers.onConnection?.(false);
      this.scheduleRetry();
    });
    // 页面重新可见/聚焦时重新申请执行权（后台节流会导致心跳断档）
    const reclaim = () => {
      if (document.visibilityState === "visible") this.send("hello", {});
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
        case "execute_plan":
          this.handlers.onPlan?.(msg as unknown as PlanMessage);
          break;
        case "public_reply":
          this.handlers.onReply?.(msg as unknown as ReplyMessage);
          break;
        case "task_state":
          this.handlers.onTaskState?.(String(msg.phase));
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
          if (msg.needsReconcile) this.handlers.onReconcile?.();
          // session_state 也携带任务阶段：任务结束后必须清除“思考中”
          if (typeof msg.phase === "string") this.handlers.onTaskState?.(msg.phase);
          const ch = msg.character as { x: number; z: number; yawDeg: number } | undefined;
          if (ch && Number.isFinite(ch.x) && Number.isFinite(ch.z) && Number.isFinite(ch.yawDeg)) {
            this.handlers.onSnapshot?.(ch);
          }
          if (msg.basin) this.handlers.onBasin?.(msg.basin as Record<string, unknown>);
          if (msg.game) this.handlers.onGame?.(msg.game);
          break;
        }
        case "game_state":
          this.handlers.onGame?.(msg.board);
          break;
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
    return this.send("state_snapshot", { snapshot, reconciled: true });
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
    meta: { generation?: number; planId?: string } = {},
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
      leaseEpoch: this.leaseEpoch,
    });
  }

  setChatOpen(open: boolean) {
    return this.send(open ? "chat_opened" : "chat_closed", {});
  }

  /** 开局：同一 requestId 幂等 */
  startGame(requestId = `r${Date.now()}`) {
    return this.send("game_start", { requestId, leaseEpoch: this.leaseEpoch });
  }

  /** 挖掘提交：由执行器在 dig_contact 时刻调用，等待服务端结算 */
  commitDig(payload: Record<string, unknown>, timeoutMs = 6000): Promise<Record<string, unknown>> {
    const actionInstanceId = `d${++this.digSeq}`;
    return new Promise((resolve) => {
      this.digWaiters.set(actionInstanceId, resolve);
      this.send("dig_commit", { ...payload, actionInstanceId, leaseEpoch: this.leaseEpoch });
      setTimeout(() => {
        if (this.digWaiters.delete(actionInstanceId)) resolve({ ok: false, reason: "TIMEOUT" });
      }, timeoutMs);
    });
  }

  sendStateSnapshot(snapshot: Record<string, unknown>) {
    return this.send("state_snapshot", { snapshot });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
