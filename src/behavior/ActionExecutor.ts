import type { Locomotion, Plan, PlanResult, ReasonCode, Step, StepResult } from "./protocol.ts";
import { cyclesFor, nearestSupported, round, supportedDistances } from "./distances.ts";

const PLAYABLE = new Set(["greet", "notice", "nod", "look_left", "look_right", "think"]);
const TAIL_STYLES = new Set(["tail_idle", "tail_swish"]);
const BASIN_ACTIONS = new Set(["walk_to_basin", "pickup", "wear", "unwear", "throw"]);
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
      case "turn": {
        const deg = step.angle_deg;
        if (typeof deg !== "number" || !Number.isFinite(deg) || Math.abs(deg) > 180) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        const before = this.state().yawDeg;
        // 转向按帧推进，低帧率下墙钟会被拉长；卡死由 locomotion 的进度看门狗负责
        const raced = await this.withTimeout(this.loco.turn(deg), 60000);
        const after = this.state().yawDeg;
        const actual = round(signedDeltaDeg(before, after));
        if (!raced.ok) {
          return done("timeout", { angle_deg: actual, partial: true }, "TIMEOUT");
        }
        if (this.cancelled) {
          return done("cancelled", { angle_deg: actual, partial: true }, "CANCELLED");
        }
        if (Math.abs(actual - deg) > 0.5) {
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
          return done("failed", { target }, "OUT_OF_BOUNDS");
        }
        // 预算：起步 0.8 + n 圈 * 1.6 + 收步 0.8 的动画时间；墙钟留足余量，
        // 真正的“卡住”由 walk 的进度看门狗在 8 秒无进展时判定
        const budget = 60000 + n * 5000;
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
        if (Math.abs(moved - meters) > 0.001) {
          return done("failed", { requested_m: meters, ...actual }, "DISPLACEMENT_MISMATCH");
        }
        return done("succeeded", actual, "OK");
      }

      case "play": {
        if (!PLAYABLE.has(step.action_id)) {
          return done("unsupported", { supported: [...PLAYABLE] }, "CAPABILITY_DISABLED");
        }
        const raced = await this.withTimeout(this.loco.play(step.action_id), 30000);
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
        return done("succeeded", { style: step.style, duration_s: dur }, "OK");
      }

      case "wait": {
        if (typeof step.duration_s !== "number" || !Number.isFinite(step.duration_s) || step.duration_s < 0 || step.duration_s > MAX_WAIT_S) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        const dur = step.duration_s;
        const raced = await this.withTimeout(this.loco.sleep(dur * 1000), dur * 1000 + 800);
        if (!raced.ok) return done("timeout", { duration_s: dur }, "TIMEOUT");
        return done("succeeded", { duration_s: dur }, "OK");
      }

      case "walk_to_basin": {
        const bridge = this.loco.basin;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        const view = bridge.snapshot();
        if (view.state !== "resting") return done("failed", { basin: view }, "BASIN_STATE_MISMATCH");
        // 侧躺/倒扣也能走近，扶正发生在 pickup 内
        // 动画按帧推进而非墙钟：低帧率机器上一段 3 秒的片段可能跑更久，
        // 这里只做“卡死”兜底，真正的完成判定由片段自身的事件与结束回调给出。
        const raced = await this.withTimeout(bridge.align(), 90000);
        if (!raced.ok) return done("timeout", { alignment: bridge.alignment() }, "TIMEOUT");
        const outcome = raced.value;
        if (this.cancelled) return done("cancelled", { alignment: bridge.alignment() }, "CANCELLED");
        if (!outcome.ok) {
          return done("failed", { plan: outcome.plan, alignment: bridge.alignment(), error: outcome.error }, outcome.error === "NOT_ALIGNED" ? "NOT_ALIGNED" : "PRECONDITION_FAILED");
        }
        return done("succeeded", { plan: outcome.plan, alignment: bridge.alignment() }, "OK");
      }

      case "pickup": {
        const bridge = this.loco.basin;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        if (step.object_id !== "basin") return done("unsupported", { object_id: step.object_id }, "OBJECT_NOT_FOUND");
        const view = bridge.snapshot();
        if (view.state !== "resting") return done("failed", { basin: view }, "BASIN_STATE_MISMATCH");
        if (!view.available) return done("failed", { basin: view }, "OBJECT_UNAVAILABLE");
        const alignment = bridge.alignment();
        if (!alignment.ok) return done("failed", { alignment }, "NOT_ALIGNED");
        // 侧躺或倒扣：先平滑扶正到当前站位的标准姿态，再播拾取
        let upright: { ok: boolean; moved: number; rotatedDeg: number } | null = null;
        if (!view.upright) {
          upright = await bridge.upright();
          if (!upright.ok) {
            return done("failed", { upright, basin: bridge.snapshot() }, "NOT_ALIGNED");
          }
        }
        const raced = await this.withTimeout(bridge.perform("pickup_basin"), 60000);
        const after = bridge.snapshot();
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
        if (step.object_id !== "basin") return done("unsupported", { object_id: step.object_id }, "OBJECT_NOT_FOUND");
        const view = bridge.snapshot();
        if (view.state !== "held") return done("failed", { basin: view }, "BASIN_STATE_MISMATCH");
        const raced = await this.withTimeout(bridge.perform("wear_basin"), 60000);
        const after = bridge.snapshot();
        if (!raced.ok) return done("timeout", { basin: after }, "TIMEOUT");
        if (this.cancelled) return done("cancelled", { basin: after }, "CANCELLED");
        if (!raced.value || after.state !== "worn") return done("failed", { basin: after }, "BASIN_STATE_MISMATCH");
        return done("succeeded", { basin: after }, "OK");
      }

      case "unwear": {
        const bridge = this.loco.basin;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        if (step.object_id !== "basin") return done("unsupported", { object_id: step.object_id }, "OBJECT_NOT_FOUND");
        const view = bridge.snapshot();
        if (view.state !== "worn") return done("failed", { basin: view }, "BASIN_STATE_MISMATCH");
        const raced = await this.withTimeout(bridge.perform("unwear_basin"), 60000);
        const after = bridge.snapshot();
        if (!raced.ok) return done("timeout", { basin: after }, "TIMEOUT");
        if (this.cancelled) return done("cancelled", { basin: after }, "CANCELLED");
        if (!raced.value || after.state !== "held") return done("failed", { basin: after }, "BASIN_STATE_MISMATCH");
        return done("succeeded", { basin: after }, "OK");
      }

      case "throw": {
        const bridge = this.loco.basin;
        if (!bridge) return done("unsupported", null, "CAPABILITY_DISABLED");
        if (step.object_id !== "basin") return done("unsupported", { object_id: step.object_id }, "OBJECT_NOT_FOUND");
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
        const view = bridge.snapshot();
        if (view.state !== "held") return done("failed", { basin: view }, "BASIN_STATE_MISMATCH");
        const raced = await this.withTimeout(bridge.perform("throw_basin", { directionDeg: direction, speed, spin: 180, elevationDeg: elevation }), 60000);
        const after = bridge.snapshot();
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
        const channels = items.map((i) => i.action);
        const hasMove = channels.filter((c) => c === "turn" || c === "walk").length > 1;
        const hasPlay = channels.filter((c) => c === "play").length > 1;
        const hasTail = channels.filter((c) => c === "tail").length > 1;
        const hasBasin = channels.some((c) => BASIN_ACTIONS.has(c));
        if (hasMove || hasPlay || hasTail || hasBasin) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        const results = await Promise.all(items.map((item, idx) => this.runStep(`${stepId}.${idx + 1}`, item)));
        const ok = results.every((r) => r.status === "succeeded");
        return done(ok ? "succeeded" : "failed", { items: results }, ok ? "OK" : "PRECONDITION_FAILED");
      }

      default:
        return done("unsupported", null, "CAPABILITY_DISABLED");
    }
  }
}
