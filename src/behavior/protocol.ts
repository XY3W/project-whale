/** 行为协议：原因码、步骤结果、计划结构。字段命名对齐 NEXT_PHASE_LLM_PLAN.md §7.3。 */

export type StepStatus = "succeeded" | "failed" | "cancelled" | "unsupported" | "timeout" | "unknown";

export type ReasonCode =
  | "OK"
  | "OUT_OF_BOUNDS"
  | "BLOCKED"
  | "UNSUPPORTED_DISTANCE"
  | "CAPABILITY_DISABLED"
  | "PRECONDITION_FAILED"
  | "SUPERSEDED"
  | "CLIENT_DISCONNECTED"
  | "CANCELLED"
  | "TIMEOUT"
  | "DISPLACEMENT_MISMATCH"
  | "ANGLE_MISMATCH";

export interface StepResult {
  stepId: string;
  action: string;
  status: StepStatus;
  requested: Record<string, unknown>;
  actual: Record<string, unknown> | null;
  startState: Record<string, unknown>;
  endState: Record<string, unknown> | null;
  reasonCode: ReasonCode;
  durationMs: number;
}

export interface PlanResult {
  status: "completed" | "cancelled" | "failed";
  steps: StepResult[];
  stopped: boolean;
}

export type Step =
  | { action: "turn"; angle_deg: number }
  | { action: "walk"; distance_m: number }
  | { action: "play"; action_id: string }
  | { action: "tail"; style: "tail_idle" | "tail_swish"; duration_s: number }
  | { action: "wait"; duration_s: number }
  | { action: "parallel"; items: Step[] };

export interface Plan {
  steps: Step[];
}

/** 执行器依赖的运动/表演能力，由主场景实现；测试里用假的实现。 */
export interface Locomotion {
  yaw(): number;
  position(): { x: number; z: number };
  walk(meters: number): Promise<void>;
  turn(deg: number): Promise<void>;
  play(actionId: string): Promise<void>;
  tail(style: "tail_idle" | "tail_swish", durationS: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** 可选：身体是否仍在运动，用于 stopped 证据 */
  isMoving?(): boolean;
}
