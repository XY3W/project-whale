import { parallelConflict } from "../../shared/resources.mjs";
import type { BasinView, Locomotion, Plan, PlanResult, ReasonCode, Step, StepResult } from "./protocol.ts";
import { cyclesFor, nearestSupported, round, supportedDistances } from "./distances.ts";

const PLAYABLE = new Set(["greet", "notice", "nod", "look_left", "look_right", "think"]);
const TAIL_STYLES = new Set(["tail_idle", "tail_swish"]);


/** LLM 工具 ID → 资产动作 ID（盆与饭勺共用 pickup / throw 工具） */
function propAction(tool: string, objectId: string): string | null {
  if (tool === "pickup") return objectId === "basin" ? "pickup_basin" : objectId === "rice_scoop" ? "pickup_scoop" : null;
  if (tool === "throw") return objectId === "basin" ? "throw_basin" : objectId === "rice_scoop" ? "throw_scoop" : null;
  if (tool === "wear") return objectId === "basin" ? "wear_basin" : null;
  if (tool === "unwear") return objectId === "basin" ? "unwear_basin" : null;
  return null;
}
const MAX_STEPS = 6;
const MAX_PARALLEL = 3;
const MAX_WAIT_S = 5;

/** 角度归一化到 (-180, 180] */
/** 有符号角差：保留 -180 与 180 的区别，用于验证转动方向 */
export function signedDeltaDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export interface ExecutorOptions {
  half: number;
  margin?: number;
  now?: () => number;
}

/**
 * M2 执行器：把计划拆成步骤，逐条执行并记录 requested / actual。
 * 不做静默取整、不越界 clamp 冒充成功；失败会停止后续步骤。
 */
export class ActionExecutor {
  private cancelled = false;
  private cancelHooks: Array<() => void> = [];
  private readonly half: number;
  private readonly margin: number;
  private readonly now: () => number;

  private readonly loco: Locomotion;
  /** 服务端为本次象棋搬棋签发的一次性 token（execute_plan 下发） */
  xiangqiToken: string | undefined;

  constructor(loco: Locomotion, opts: ExecutorOptions) {
    this.loco = loco;
    this.half = opts.half;
    this.margin = opts.margin ?? 0.3;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 注册取消钩子：用于打断正在等待的 locomotion（收步、清手势） */
  onCancel(fn: () => void) {
    this.cancelHooks.push(fn);
  }

  cancel() {
    this.cancelled = true;
    for (const fn of this.cancelHooks) fn();
  }

  get distances(): number[] {
    return supportedDistances();
  }

  async run(plan: Plan): Promise<PlanResult> {
    this.cancelled = false;
    const steps = plan.steps ?? [];
    const results: StepResult[] = [];
    let failed = false;

    if (steps.length > MAX_STEPS) {
      return {
        status: "failed",
        steps: [],
        stopped: true,
      };
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepId = `s${i + 1}`;
      if (this.cancelled || failed) {
        results.push(this.voidResult(stepId, step, this.cancelled ? "CANCELLED" : "SUPERSEDED"));
        continue;
      }
      const r = await this.runStep(stepId, step);
      results.push(r);
      if (r.status !== "succeeded") failed = true;
    }

    const moving = this.loco.isMoving?.() ?? false;
    return {
      status: this.cancelled ? "cancelled" : failed ? "failed" : "completed",
      steps: results,
      stopped: !moving,
    };
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.cancel();
        resolve({ ok: false });
      }, ms);
      p.then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      }).catch(() => {
        if (settled) return;
        settled = true;
        this.cancel();
        clearTimeout(timer);
        resolve({ ok: false });
      });
    });
  }

  private voidResult(stepId: string, step: Step, reason: ReasonCode): StepResult {
    return {
      stepId,
      action: step.action,
      status: "cancelled",
      requested: step as unknown as Record<string, unknown>,
      actual: null,
      startState: {},
      endState: null,
      reasonCode: reason,
      durationMs: 0,
    };
  }

  private state() {
    const p = this.loco.position();
    const yaw = this.loco.yaw();
    return { x: round(p.x), z: round(p.z), yawDeg: round((yaw * 180) / Math.PI) };
  }

  /**
   * 沿着当前朝向，到场地边界还能走多远。
   * 边界是 |x|、|z| ≤ half - margin（主循环还会 clamp 一次，多走的部分会被截掉）。
   */
  private forwardRoom(before: { x: number; z: number }, yaw: number): number {
    const limit = this.half - this.margin;
    const sx = Math.sin(yaw);
    const cz = Math.cos(yaw);
    let room = Infinity;
    if (sx > 1e-9) room = Math.min(room, (limit - before.x) / sx);
    else if (sx < -1e-9) room = Math.min(room, (-limit - before.x) / sx);
    if (cz > 1e-9) room = Math.min(room, (limit - before.z) / cz);
    else if (cz < -1e-9) room = Math.min(room, (-limit - before.z) / cz);
    return Math.max(0, room);
  }

  /** 被边界挡住时的统一回报：让模型知道“直走不通”，而不是只看到位移不符 */
  private blocked(before: { x: number; z: number }, yaw: number, requested: number): StepResult["actual"] {
    const limit = this.half - this.margin;
    return {
      error: "WALL_BLOCKED",
      requested_m: round(requested),
      available_m: round(this.forwardRoom(before, yaw)),
      boundary_m: round(limit),
      position: { x: round(before.x), z: round(before.z) },
      hint: `前方 ${round(this.forwardRoom(before, yaw))}m 就到场地边界（可走范围 ±${round(limit)}m）。先 turn 换个方向，或用更小的 walk/walk_adjust 挪；不要重复同一条走不通的指令。`,
    };
  }

  private async runStep(stepId: string, step: Step): Promise<StepResult> {
    const t0 = this.now();
    const startState = this.state();
    const base: Omit<StepResult, "status" | "actual" | "reasonCode" | "durationMs"> = {
      stepId,
      action: step.action,
      requested: step as unknown as Record<string, unknown>,
      startState,
      endState: null,
    };

    const done = (
      status: StepResult["status"],
      actual: Record<string, unknown> | null,
      reasonCode: ReasonCode,
    ): StepResult => ({
      ...base,
      status,
      actual,
      reasonCode,
      endState: this.state(),
      durationMs: Math.round(this.now() - t0),
    });

    switch (step.action) {
      case "set_basin_grip": {
        const bridge=this.loco.basin,view=bridge?.snapshot("basin");
        if(!bridge?.setGrip)return done("unsupported",null,"CAPABILITY_DISABLED");
        if(view?.state!=="held"||this.loco.isMoving?.())return done("failed",null,"PRECONDITION_FAILED");
        if(view.grip===step.grip)return done("succeeded",{grip:step.grip},"OK");
        const r=await this.withTimeout(bridge.setGrip(step.grip),15000);
        if(this.cancelled)return done("cancelled",{basin:bridge.snapshot("basin")},"CANCELLED");
        return done(r.ok&&r.value?"succeeded":"failed",{basin:bridge.snapshot("basin")},r.ok&&r.value?"OK":"PRECONDITION_FAILED");
      }
      case "knock_basin": {
        const bridge=this.loco.basin;
        if(!bridge?.knock)return done("unsupported",null,"CAPABILITY_DISABLED");
        if(!Number.isInteger(step.count)||step.count<1||step.count>32||step.tempo!=="normal"||step.tool_id!=="rice_scoop"||step.object_id!=="basin")return done("failed",null,"PRECONDITION_FAILED");
        const r=await this.withTimeout(bridge.knock(step.count,stepId),45000);
        const actual=r.ok?r.value:{requestedCount:step.count,committedCount:0,stopReason:"TIMEOUT"};
        if(this.cancelled)return done("cancelled",actual,"CANCELLED");
        return done(actual.committedCount===step.count?"succeeded":"failed",actual,actual.committedCount===step.count?"OK":"PRECONDITION_FAILED");
      }
      case "turn": {
        const deg = step.angle_deg;
        if (typeof deg !== "number" || !Number.isFinite(deg) || Math.abs(deg) > 180) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        const before = this.state().yawDeg;
        // 转向按帧推进，低帧率下墙钟会被拉长；卡死由 locomotion 的进度看门狗负责
        const raced = await this.withTimeout(this.loco.turn(deg), 60000);
        const after = this.state().yawDeg;
        const actual = round(raced.ok&&typeof raced.value==="number"?raced.value:signedDeltaDeg(before, after));
        if (!raced.ok) {
          return done("timeout", { angle_deg: actual, partial: true }, "TIMEOUT");
        }
        if (this.cancelled) {
          return done("cancelled", { angle_deg: actual, partial: true }, "CANCELLED");
        }
        // 转向只看“最终朝向对不对”：+180° 和 -180° 是同一个朝向，
        // 直接比较数值会把正确的结果判成 ANGLE_MISMATCH（线上就是这么卡住的）。
        if (Math.abs(typeof (raced.ok?raced.value:undefined)==="number"?deg-actual:signedDeltaDeg(deg,actual)) > 0.5) {
          return done("failed", { requested_deg: deg, angle_deg: actual }, "ANGLE_MISMATCH");
        }
        return done("succeeded", { angle_deg: actual }, "OK");
      }

      case "walk": {
        const meters = step.distance_m;
        if (typeof meters !== "number" || !Number.isFinite(meters)) {
          return done("unsupported", null, "UNSUPPORTED_DISTANCE");
        }
        const n = cyclesFor(meters);
        if (n === null) {
          return done("unsupported", { supported: this.distances, nearest: nearestSupported(meters) }, "UNSUPPORTED_DISTANCE");
        }
        const before = { ...this.loco.position() };
        const yaw = this.loco.yaw();
        const target = {
          x: before.x + Math.sin(yaw) * meters,
          z: before.z + Math.cos(yaw) * meters,
        };
        const limit = this.half - this.margin;
        if (Math.abs(target.x) > limit || Math.abs(target.z) > limit) {
          return done("failed", { target, ...this.blocked(before, yaw, meters) }, "BLOCKED");
        }
        // 预算只是“卡死”兜底：动画按帧推进，headless/低端设备上 17 秒的 1.89m
        // 可能跑三四分钟。真正的卡住由 walk 的进度看门狗（8 秒无进展）判定。
        const budget = 180000 + n * 15000;
        const raced = await this.withTimeout(this.loco.walk(meters), budget);
        const after = this.loco.position();
        const moved = Math.hypot(after.x - before.x, after.z - before.z);
        const actual = { distance_m: round(moved), dx: round(after.x - before.x), dz: round(after.z - before.z) };
        if (!raced.ok) {
          return done("unknown", { ...actual, partial: true }, "TIMEOUT");
        }
        if (this.cancelled) {
          return done("cancelled", { ...actual, partial: moved > 0 }, "CANCELLED");
        }
        if (Math.abs(moved - meters) > 0.001 || Math.hypot(after.x-target.x,after.z-target.z)>.001) {
          // 目标在界内却走不满：几乎只可能是被主循环的边界 clamp 截断
          const atWall = Math.abs(after.x) > limit - 0.002 || Math.abs(after.z) > limit - 0.002;
          if (atWall) return done("failed", { ...this.blocked(after, yaw, meters), distance_m: round(moved) }, "BLOCKED");
          return done("failed", { requested_m: meters, ...actual }, "DISPLACEMENT_MISMATCH");
        }
        return done("succeeded", actual, "OK");
      }

      case "play": {
        if(["greet","notice","think"].includes(step.action_id)&&this.loco.basin?.items().some(item=>item.state==="held"))return done("failed",{error:"HELD_ARM_CONFLICT"},"PRECONDITION_FAILED");
        if (!PLAYABLE.has(step.action_id)) {
          return done("unsupported", { supported: [...PLAYABLE] }, "CAPABILITY_DISABLED");
        }
        const raced = await this.withTimeout(this.loco.play(step.action_id), 60000);
        if (!raced.ok) return done("timeout", { action_id: step.action_id }, "TIMEOUT");
        if (this.cancelled) return done("cancelled", { action_id: step.action_id }, "CANCELLED");
        return done("succeeded", { action_id: step.action_id }, "OK");
      }

      case "tail": {
        if (!TAIL_STYLES.has(step.style)) {
          return done("unsupported", { supported: [...TAIL_STYLES] }, "CAPABILITY_DISABLED");
        }
        if (typeof step.duration_s !== "number" || !Number.isFinite(step.duration_s) || step.duration_s < 0 || step.duration_s > 10) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        const dur = step.duration_s;
        const raced = await this.withTimeout(this.loco.tail(step.style, dur), dur * 1000 + 1500);
        if (!raced.ok) return done("timeout", { style: step.style, duration_s: dur }, "TIMEOUT");
        if(this.cancelled)return done("cancelled",{style:step.style,duration_s:dur},"CANCELLED");
        return done("succeeded", { style: step.style, duration_s: dur }, "OK");
      }

      case "wait": {
        if (typeof step.duration_s !== "number" || !Number.isFinite(step.duration_s) || step.duration_s < 0 || step.duration_s > MAX_WAIT_S) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        const dur = step.duration_s;
        const raced = await this.withTimeout(this.loco.sleep(dur * 1000), dur * 1000 + 800);
        if (!raced.ok) return done("timeout", { duration_s: dur }, "TIMEOUT");
        if(this.cancelled)return done("cancelled",{duration_s:dur},"CANCELLED");
        return done("succeeded", { duration_s: dur }, "OK");
      }

      case "run": {
        if(!Array.from({length:11},(_,i)=>Math.round((.144+.32*(i+1))*1000)/1000).includes(step.distance_m))return done("failed",null,"UNSUPPORTED_DISTANCE");
        const meters = step.distance_m;
        if (typeof meters !== "number" || !Number.isFinite(meters)) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        const before = { ...this.loco.position() };
        const yaw = this.loco.yaw();
        const target = { x: before.x + Math.sin(yaw) * meters, z: before.z + Math.cos(yaw) * meters };
        const limit = this.half - this.margin;
        if (Math.abs(target.x) > limit || Math.abs(target.z) > limit) {
          return done("failed", { target, ...this.blocked(before, yaw, meters) }, "BLOCKED");
        }
        const cycles = Math.round((meters - 0.144) / 0.32);
        if (meters > this.forwardRoom(before, yaw) + 1e-9) {
          return done("failed", this.blocked(before, yaw, meters), "BLOCKED");
        }
        // 与 walk 同样的预算思路：动画按帧推进，卡住由 loco 的进度看门狗判定
        const raced = await this.withTimeout(this.loco.run ? this.loco.run(meters) : Promise.reject(new Error("no run")), 180000 + cycles * 15000);
        const after = this.loco.position();
        const moved = Math.hypot(after.x - before.x, after.z - before.z);
        const actual = { distance_m: round(moved) };
        if (!raced.ok) return done("unknown", { ...actual, partial: true }, "TIMEOUT");
        if (this.cancelled) return done("cancelled", { ...actual, partial: moved > 0 }, "CANCELLED");
        if (Math.abs(moved - meters) > 0.004 || Math.hypot(after.x-target.x,after.z-target.z)>.004) return done("failed", { requested_m: meters, ...actual }, "DISPLACEMENT_MISMATCH");
        return done("succeeded", actual, "OK");
      }

      case "walk_adjust": {
        const meters = step.distance_m;
        if (![0.02, 0.04, 0.06, 0.08].some((d) => Math.abs(d - meters) < 1e-9) || !this.loco.adjust) {
          return done("unsupported", { supported: [0.02, 0.04, 0.06, 0.08] }, "CAPABILITY_DISABLED");
        }
        const before = { ...this.loco.position() };
        const yaw = this.loco.yaw();
        const target={x:before.x+Math.sin(yaw)*meters,z:before.z+Math.cos(yaw)*meters};
        if (meters > this.forwardRoom(before, yaw) + 1e-9) {
          return done("failed", this.blocked(before, yaw, meters), "BLOCKED");
        }
        const raced = await this.withTimeout(this.loco.adjust(meters), 90000);
        const after = this.loco.position();
        const moved = Math.hypot(after.x - before.x, after.z - before.z);
        if (!raced.ok) return done("unknown", { distance_m: round(moved), partial: true }, "TIMEOUT");
        if (this.cancelled) return done("cancelled", { distance_m: round(moved) }, "CANCELLED");
        if (Math.abs(moved - meters) > 0.004 || Math.hypot(after.x-target.x,after.z-target.z)>.004) {
          const limit = this.half - this.margin;
          const atWall = Math.abs(after.x) > limit - 0.002 || Math.abs(after.z) > limit - 0.002;
          if (atWall) return done("failed", { ...this.blocked(after, yaw, meters), distance_m: round(moved) }, "BLOCKED");
          return done("failed", { requested_m: meters, distance_m: round(moved) }, "DISPLACEMENT_MISMATCH");
        }
        return done("succeeded", { distance_m: round(moved) }, "OK");
      }

      // 五子棋落子：和 dig 一样，站位/回合/版本先过 precheck，
      // 再由 perform 做完落子动作后带着服务端授权提交。
      case "place_stone": {
        const bridge = this.loco.stone;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        const pre = bridge.precheck?.(step);
        if (pre && !pre.ok) return done("failed", pre.detail ?? null, pre.reason ?? "PRECONDITION_FAILED");
        const raced = await this.withTimeout(bridge.perform(step, stepId), 45000);
        if (!raced.ok) return done("unknown", { partial: true }, "TIMEOUT");
        const outcome = raced.value;
        if (this.cancelled) return done("cancelled", outcome as unknown as Record<string, unknown>, "CANCELLED");
        if (!outcome.ok) {
          const reason = outcome.reason === "NOT_ALIGNED" ? "NOT_ALIGNED" : "PRECONDITION_FAILED";
          return done("failed", outcome as unknown as Record<string, unknown>, reason);
        }
        return done("succeeded", outcome as unknown as Record<string, unknown>, "OK");
      }

      case "dig": {
        const bridge = this.loco.dig;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        // 主场景的 precheck 是权威：右手持勺、站在格心 0.12m 内、棋盘版本一致、已经站稳
        const pre = bridge.precheck?.(step);
        if (pre && !pre.ok) return done("failed", pre.detail ?? null, pre.reason ?? "PRECONDITION_FAILED");
        if (!pre) {
          const board = bridge.current();
          if (!board) return done("failed", null, "PRECONDITION_FAILED");
          if (board.status !== "playing") return done("failed", { status: board.status }, "PRECONDITION_FAILED");
          if (board.gameId !== step.game_id) return done("failed", { game_id: step.game_id, actual: board.gameId }, "PRECONDITION_FAILED");
          if (Number.isInteger(step.expected_revision) && step.expected_revision !== board.revision) {
            return done("failed", { expected_revision: step.expected_revision, actual: board.revision }, "PRECONDITION_FAILED");
          }
          const cell = board.cells.find((c) => c.row === step.row && c.col === step.col);
          if (!cell) return done("failed", { row: step.row, col: step.col }, "PRECONDITION_FAILED");
          if (cell.state === "revealed") return done("failed", { row: step.row, col: step.col }, "PRECONDITION_FAILED");
        }
        // 挖掘按帧推进：低帧率机器上一段 2.5 秒的片段可能要跑几十秒墙钟，
        // 这里只做“卡死”兜底，真正的完成判定由片段的结束回调给出。
        const raced = await this.withTimeout(bridge.perform(step, stepId), 90000);
        if (!raced.ok) return done("unknown", { partial: true }, "TIMEOUT");
        const outcome = raced.value;
        if(this.cancelled)return done("cancelled",outcome as unknown as Record<string,unknown>,"CANCELLED");
        if (!outcome.ok) return done("failed", outcome as unknown as Record<string, unknown>, "PRECONDITION_FAILED");
        return done(outcome.status === "lost" ? "failed" : "succeeded", outcome as unknown as Record<string, unknown>, outcome.status === "lost" ? "PRECONDITION_FAILED" : "OK");
      }

      case "walk_to_basin": {
        const bridge = this.loco.basin;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        const view = bridge.snapshot("basin");
        if (!view) return done("failed", { object_id: "basin" }, "OBJECT_NOT_FOUND");
        if (view.state !== "resting") return done("failed", { basin: view }, "BASIN_STATE_MISMATCH");
        // 侧躺/倒扣也能走近，扶正发生在 pickup 内
        // 动画按帧推进而非墙钟：低帧率机器上一段 3 秒的片段可能跑更久，
        // 这里只做“卡死”兜底，真正的完成判定由片段自身的事件与结束回调给出。
        const raced = await this.withTimeout(bridge.align("basin"), 90000);
        if (!raced.ok) return done("timeout", { alignment: bridge.alignment("basin") }, "TIMEOUT");
        const outcome = raced.value;
        if (this.cancelled) return done("cancelled", { alignment: bridge.alignment("basin") }, "CANCELLED");
        if (!outcome.ok) {
          return done("failed", { plan: outcome.plan, alignment: bridge.alignment("basin"), error: outcome.error }, outcome.error === "NOT_ALIGNED" ? "NOT_ALIGNED" : "PRECONDITION_FAILED");
        }
        return done("succeeded", { plan: outcome.plan, alignment: bridge.alignment("basin") }, "OK");
      }

      // 走到指定坐标：转向/步数由宿主算好，模型只给目标点
      case "xiangqi_move": {
        const bridge = this.loco.xiangqiMove;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        const raced = await this.withTimeout(bridge(step as never, { token: this.xiangqiToken, isCancelled: () => this.cancelled }), 300000);
        if (!raced.ok) return done("unknown", { partial: true }, "TIMEOUT");
        const outcome = raced.value;
        if (this.cancelled) return done("cancelled", outcome as unknown as Record<string, unknown>, "CANCELLED");
        if (!outcome.ok) return done("failed", outcome as unknown as Record<string, unknown>, (outcome.reason as "NOT_ALIGNED") ?? "NOT_ALIGNED");
        return done("succeeded", outcome as unknown as Record<string, unknown>, "OK");
      }

      // 饭勺腰挂：素材事件在整段落臂动画中间（0.9s / 0.5s），到点才换父级
      case "stow_scoop":
      case "unstow_scoop": {
        const bridge = step.action === "stow_scoop" ? this.loco.stowScoop : this.loco.unstowScoop;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        const raced = await this.withTimeout(bridge(), 60000);
        if (!raced.ok) return done("unknown", { partial: true }, "TIMEOUT");
        const outcome = raced.value;
        if (this.cancelled) return done("cancelled", outcome as unknown as Record<string, unknown>, "CANCELLED");
        if (!outcome.ok) return done("failed", outcome as unknown as Record<string, unknown>, "PRECONDITION_FAILED");
        return done("succeeded", outcome as unknown as Record<string, unknown>, "OK");
      }

      case "walk_to": {
        const walkTo = this.loco.walkTo;
        if (!walkTo) return done("unsupported", null, "CAPABILITY_DISABLED");
        const raced = await this.withTimeout(walkTo(step.x, step.z, step.tolerance_m ?? 0.1), 180000);
        if (!raced.ok) return done("unknown", { partial: true }, "TIMEOUT");
        const outcome = raced.value;
        if (this.cancelled) return done("cancelled", outcome as unknown as Record<string, unknown>, "CANCELLED");
        if (!outcome.ok) {
          return done("failed", outcome as unknown as Record<string, unknown>, outcome.error === "BLOCKED" ? "BLOCKED" : "NOT_ALIGNED");
        }
        return done("succeeded", outcome as unknown as Record<string, unknown>, "OK");
      }

      case "pickup": {
        const bridge = this.loco.basin;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        const objectId = String(step.object_id ?? "");
        const actionId = propAction("pickup", objectId);
        if (!actionId) return done("unsupported", { object_id: step.object_id }, "OBJECT_NOT_FOUND");
        const view = bridge.snapshot(objectId);
        if (!view) return done("failed", { object_id: objectId }, "OBJECT_NOT_FOUND");
        if (view.state !== "resting") return done("failed", { object: view }, "BASIN_STATE_MISMATCH");
        if (!view.available) return done("failed", { object: view }, "OBJECT_UNAVAILABLE");
        const alignment = bridge.alignment(objectId);
        if (!alignment.ok) return done("failed", { alignment }, "NOT_ALIGNED");
        // 侧躺或倒扣：先平滑扶正到当前站位的标准姿态，再播拾取（只对盆）
        let upright: { ok: boolean; moved: number; rotatedDeg: number } | null = null;
        if (!view.upright && objectId === "basin") {
          upright = await bridge.upright(objectId);
          if (!upright.ok) {
            return done("failed", { upright, object: bridge.snapshot(objectId) }, "NOT_ALIGNED");
          }
        }
        if(this.cancelled)return done("cancelled",{object:bridge.snapshot(objectId)},"CANCELLED");
        // 落地姿态不支持（饭勺平躺以外的姿态）时明确拒绝，不悄悄扶正
        if (bridge.canStart && !bridge.canStart(objectId, actionId)) {
          return done("failed", { object: view, error: "POSE_UNSUPPORTED" }, "OBJECT_POSE_UNSUPPORTED");
        }
        const raced = await this.withTimeout(bridge.perform(objectId, actionId), 60000);
        const after = bridge.snapshot(objectId) as BasinView;
        if(this.cancelled)return done("cancelled",{basin:after},"CANCELLED");
        if (!raced.ok) return done("timeout", { basin: after }, "TIMEOUT");
        if (this.cancelled) return done("cancelled", { basin: after }, "CANCELLED");
        if (!raced.value || after.state !== "held") {
          return done("failed", { basin: after, upright }, "BASIN_STATE_MISMATCH");
        }
        return done("succeeded", { basin: after, ...(upright ? { upright } : {}) }, "OK");
      }

      case "wear": {
        const bridge = this.loco.basin;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        const objectId = String(step.object_id ?? "");
        const actionId = propAction("wear", objectId);
        if (!actionId) return done("unsupported", { object_id: step.object_id }, "OBJECT_NOT_FOUND");
        const view = bridge.snapshot(objectId);
        if (!view) return done("failed", { object_id: objectId }, "OBJECT_NOT_FOUND");
        if (view.state !== "held" || (objectId === "basin" && view.grip === "outward")) return done("failed", { basin: view }, "BASIN_STATE_MISMATCH");
        const raced = await this.withTimeout(bridge.perform(objectId, actionId), 60000);
        const after = bridge.snapshot(objectId) as BasinView;
        if(this.cancelled)return done("cancelled",{basin:after},"CANCELLED");
        if (!raced.ok) return done("timeout", { basin: after }, "TIMEOUT");
        if (this.cancelled) return done("cancelled", { basin: after }, "CANCELLED");
        if (!raced.value || after.state !== "worn") return done("failed", { basin: after }, "BASIN_STATE_MISMATCH");
        return done("succeeded", { basin: after }, "OK");
      }

      case "unwear": {
        const bridge = this.loco.basin;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        const objectId = String(step.object_id ?? "");
        const actionId = propAction("unwear", objectId);
        if (!actionId) return done("unsupported", { object_id: step.object_id }, "OBJECT_NOT_FOUND");
        const view = bridge.snapshot(objectId);
        if (!view) return done("failed", { object_id: objectId }, "OBJECT_NOT_FOUND");
        if (view.state !== "worn") return done("failed", { basin: view }, "BASIN_STATE_MISMATCH");
        const raced = await this.withTimeout(bridge.perform(objectId, actionId), 60000);
        const after = bridge.snapshot(objectId) as BasinView;
        if(this.cancelled)return done("cancelled",{basin:after},"CANCELLED");
        if (!raced.ok) return done("timeout", { basin: after }, "TIMEOUT");
        if (this.cancelled) return done("cancelled", { basin: after }, "CANCELLED");
        if (!raced.value || after.state !== "held") return done("failed", { basin: after }, "BASIN_STATE_MISMATCH");
        return done("succeeded", { basin: after }, "OK");
      }

      case "throw": {
        const bridge = this.loco.basin;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        const objectId = String(step.object_id ?? "");
        const actionId = propAction("throw", objectId);
        if (!actionId) return done("unsupported", { object_id: step.object_id }, "OBJECT_NOT_FOUND");
        const direction = step.yaw_deg;
        const speed = step.speed_mps;
        const elevation = step.elevation_deg;
        if (typeof elevation !== "number" || !Number.isFinite(elevation) || elevation < 0 || elevation > 45) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        if (typeof direction !== "number" || !Number.isFinite(direction) || Math.abs(direction) > 180) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 1 || speed > 6) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        const view = bridge.snapshot(objectId);
        if (!view) return done("failed", { object_id: objectId }, "OBJECT_NOT_FOUND");
        if (view.state !== "held" || (objectId === "basin" && view.grip === "outward")) return done("failed", { basin: view }, "BASIN_STATE_MISMATCH");
        const raced = await this.withTimeout(bridge.perform(objectId, actionId, { directionDeg: direction, speed, spin: 180, elevationDeg: elevation }), 60000);
        const after = bridge.snapshot(objectId) as BasinView;
        if(this.cancelled)return done("cancelled",{basin:after},"CANCELLED");
        if (!raced.ok) return done("timeout", { basin: after }, "TIMEOUT");
        if (!raced.value || (after.state !== "flying" && after.state !== "resting")) {
          return done("failed", { basin: after }, "BASIN_STATE_MISMATCH");
        }
        return done("succeeded", { basin: after }, "OK");
      }

      case "parallel": {
        const items = step.items ?? [];
        if (items.length > MAX_PARALLEL || items.some((i) => i.action === "parallel")) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        if (parallelConflict(items) || items.some(i=>i.action==="dig")) return done("failed",null,"PRECONDITION_FAILED");
        const results = await Promise.all(items.map(async (item, idx) => {const r=await this.runStep(`${stepId}.${idx+1}`,item);if(r.status!=="succeeded")this.cancel();return r;}));
        const ok = results.every((r) => r.status === "succeeded");
        return done(ok ? "succeeded" : "failed", { items: results }, ok ? "OK" : "PRECONDITION_FAILED");
      }

      default:
        return done("unsupported", null, "CAPABILITY_DISABLED");
    }
  }
}
