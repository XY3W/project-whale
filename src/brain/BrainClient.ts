/**
 * 浏览器端与大脑的连接。
 * 只负责协议收发；执行由 ActionExecutor 完成，模型回复只走公开字段。
 */

export interface PlanMessage {
  taskId: string;
  turnId: number;
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
  onError?: (code: string, message: string) => void;
  onConnection?: (connected: boolean) => void;
};

export class BrainClient {
  private ws: WebSocket | null = null;
  private handlers: Handlers = {};
  private retry = 0;

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
    });
    this.ws.addEventListener("close", () => {
      this.handlers.onConnection?.(false);
      this.scheduleRetry();
    });
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
        case "error":
          this.handlers.onError?.(String(msg.code), String(msg.message));
          break;
      }
    });
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
    return this.send("user_message", { text, snapshot });
  }

  sendPlanResult(taskId: string, result: unknown) {
    return this.send("plan_result", { taskId, result });
  }

  sendStateSnapshot(snapshot: Record<string, unknown>) {
    return this.send("state_snapshot", { snapshot });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
