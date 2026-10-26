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
  | "ANGLE_MISMATCH"
  | "OBJECT_NOT_FOUND"
  | "OBJECT_UNAVAILABLE"
  | "NOT_ALIGNED"
  | "BASIN_STATE_MISMATCH"
  | "OBJECT_POSE_UNSUPPORTED";

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
  | { action: "walk_to_basin" }
  | { action: "pickup"; object_id: string }
  | { action: "wear"; object_id: string }
  | { action: "unwear"; object_id: string }
  | { action: "throw"; object_id: string; yaw_deg: number; elevation_deg: number; speed_mps: number }
  | { action: "run"; distance_m: number }
  | { action: "walk_adjust"; distance_m: number }
  | { action: "dig"; game_id: string; row: number; col: number; expected_revision: number }
  | { action: "parallel"; items: Step[] };

export interface Plan {
  steps: Step[];
}

/** 执行器依赖的运动/表演能力，由主场景实现；测试里用假的实现。 */
export interface Locomotion {
  yaw(): number;
  position(): { x: number; z: number };
  walk(meters: number): Promise<void>;
  /** 短步微调：0.02 / 0.04 / 0.06 / 0.08 米 */
  adjust?(meters: number): Promise<void>;
  /** 跑动：0.144 + 0.32N 米 */
  run?(meters: number): Promise<void>;
  turn(deg: number): Promise<void>;
  play(actionId: string): Promise<void>;
  tail(style: "tail_idle" | "tail_swish", durationS: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** 可选：身体是否仍在运动，用于 stopped 证据 */
  isMoving?(): boolean;
  /** 可选：钢盆互动能力。未接线时相关步骤返回 CAPABILITY_DISABLED。 */
  basin?: BasinBridge;
  /** 可选：扫雷挖掘能力 */
  dig?: DigBridge;
}

export interface BasinView {
  id: string;
  object_id?: string;
  revision?: number;
  state: string;
  position: [number, number, number];
  upright: boolean;
  stationary: boolean;
  available: boolean;
}

export interface BasinAlignment {
  /** 站位到“正确半径”的径向误差，米 */
  distanceError: number;
  /** 朝向误差，度 */
  yawErrorDeg: number;
  ok: boolean;
}

export interface ThrowRequest {
  directionDeg: number;
  speed: number;
  spin: number;
  elevationDeg?: number;
}

export interface UprightReport {
  ok: boolean;
  /** 扶正时被挪动的水平距离（米）与旋转角度（度） */
  moved: number;
  rotatedDeg: number;
}

export interface BasinBridge {
  /** 所有物品的公开快照 */
  items(): BasinView[];
  snapshot(objectId: string): BasinView | null;
  alignment(objectId: string): BasinAlignment;
  /** 把静止但姿态不支持的物品摆正；返回实际挪动量 */
  upright(objectId: string): Promise<UprightReport>;
  /** 把指定物品放回场地中心 */
  reset(objectId?: string): void;
  /** 走到拾取站位并对准朝向；返回是否到位 */
  align(objectId: string): Promise<{ ok: boolean; plan: ApproachSummary | null; error?: string }>;
  /** 播放互动片段，返回是否到达终态 */
  perform(objectId: string, actionId: string, spec?: ThrowRequest): Promise<boolean>;
  /** 当前状态能否开始该动作 */
  canStart(objectId: string, actionId: string): boolean;
  cancel(): void;
}

export interface DigOutcome {
  ok: boolean;
  reason?: string;
  status?: "playing" | "won" | "lost";
  revision?: number;
  changedCells?: { row: number; col: number; value: number | "mine" }[];
}

export interface GameView {
  gameId: string;
  revision: number;
  status: "playing" | "won" | "lost" | "ended";
  size: number;
  /** 每格边长（米）：16×16 仍占 8m 场地，所以是 0.5 */
  cellSize: number;
  boardHalf?: number;
  mineCount: number;
  cells: { row: number; col: number; state: "hidden" | "revealed"; value?: number | "mine" }[];
  revealedSafe: number;
  remainingSafe: number;
}

export interface DigPrecheck {
  ok: boolean;
  reason?: ReasonCode;
  /** 给模型看的具体原因：NO_GAME / NO_SCOOP / NOT_IN_CELL / STALE_REVISION ... */
  detail?: Record<string, unknown>;
}

export interface DigBridge {
  current(): GameView | null;
  /** 挖掘前置条件：右手持勺、站在目标格 0.12m 内、棋盘版本一致 */
  precheck?(step: { game_id: string; row: number; col: number; expected_revision: number }): DigPrecheck;
  /** 播放挖掘并在接触点提交，返回服务端结算结果 */
  perform(step: { game_id: string; row: number; col: number; expected_revision: number }): Promise<DigOutcome>;
}

export interface ApproachSummary {
  distanceM: number;
  turn1Deg: number;
  turn2Deg: number;
  stand: { x: number; z: number };
  finalYawDeg: number;
  reach: number;
}
