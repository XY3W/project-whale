/**
 * 自主漫游的总闸。
 *
 * 坐/躺是"持续状态"：只要她还坐在沙发上、躺在床上（或者正在起身的过渡里），
 * 就绝不能进入漫游，否则会出现"躺着被拖到场地另一头"的情况。
 * 这里做成纯函数，方便回归测试；主循环只负责喂状态。
 */

export interface RoamGateInput {
  stateApplied: boolean;
  errorActive: boolean;
  readOnly: boolean;
  connected: boolean;
  /** 当前位移是否被别的执行器占用（任务/表演） */
  motionOwner: string;
  hasDestination: boolean;
  roamBusy: boolean;
  taskActive: boolean;
  gameInProgress: boolean;
  phase: string;
  walking: boolean;
  resting: boolean;
  /** 是否处于坐/躺姿态 */
  furniturePoseActive: boolean;
  /** 坐/躺插值权重：起身过渡期间也还不允许漫游 */
  furnitureWeight: number;
}

export function canRoamNow(input: RoamGateInput): boolean {
  return (
    input.stateApplied &&
    !input.errorActive &&
    !input.readOnly &&
    input.connected &&
    input.motionOwner === "none" &&
    !input.hasDestination &&
    !input.roamBusy &&
    !input.taskActive &&
    !input.gameInProgress &&
    input.phase === "idle" &&
    !input.walking &&
    input.resting &&
    // 持续状态：坐着、躺着、或者正在起身的过程里都不许漫游
    !input.furniturePoseActive &&
    input.furnitureWeight === 0
  );
}

/** 坐/躺的休息时长：到点自动起身，避免"躺着过日子"。 */
export const FURNITURE_REST_MS = 60_000;

/** 休息是否结束（restUntil 为 0 表示没在休息）。 */
export function shouldEndFurnitureRest(now: number, restUntil: number): boolean {
  return restUntil > 0 && now >= restUntil;
}
