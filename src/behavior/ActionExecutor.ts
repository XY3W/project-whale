import type { Locomotion, Plan, PlanResult, ReasonCode, Step, StepResult } from "./protocol.ts";
import { cyclesFor, nearestSupported, round, supportedDistances } from "./distances.ts";

const PLAYABLE = new Set(["greet", "notice", "nod", "look_left", "look_right", "think"]);
const TAIL_STYLES = new Set(["tail_idle", "tail_swish"]);
const MAX_STEPS = 6;
const MAX_PARALLEL = 3;
const MAX_WAIT_S = 5;

/** 角度归一化到 (-180, 180] */
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

    return {
      status: this.cancelled ? "cancelled" : failed ? "failed" : "completed",
      steps: results,
      stopped: true,
    };
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
        if (!Number.isFinite(deg) || Math.abs(deg) > 180) {
          return done("failed", null, "PRECONDITION_FAILED");
        }
        const before = this.state().yawDeg;
        await this.loco.turn(deg);
        const after = this.state().yawDeg;
        const actual = round(normalizeDeg(after - before));
        return done("succeeded", { angle_deg: actual }, "OK");
      }

      case "walk": {
        const meters = step.distance_m;
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
        await this.loco.walk(meters);
        const after = this.loco.position();
        const moved = Math.hypot(after.x - before.x, after.z - before.z);
        return done("succeeded", { distance_m: round(moved), dx: round(after.x - before.x), dz: round(after.z - before.z) }, "OK");
      }

      case "play": {
        if (!PLAYABLE.has(step.action_id)) {
          return done("unsupported", { supported: [...PLAYABLE] }, "CAPABILITY_DISABLED");
        }
        await this.loco.play(step.action_id);
        return done("succeeded", { action_id: step.action_id }, "OK");
      }

      case "tail": {
        if (!TAIL_STYLES.has(step.style)) {
          return done("unsupported", { supported: [...TAIL_STYLES] }, "CAPABILITY_DISABLED");
        }
        const dur = Math.max(0, Math.min(step.duration_s, 10));
        await this.loco.tail(step.style, dur);
        return done("succeeded", { style: step.style, duration_s: dur }, "OK");
      }

      case "wait": {
        const dur = Math.max(0, Math.min(step.duration_s, MAX_WAIT_S));
        await this.loco.sleep(dur * 1000);
        return done("succeeded", { duration_s: dur }, "OK");
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
        if (hasMove || hasPlay || hasTail) {
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
