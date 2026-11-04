/**
 * 自主漫游的总闸。
 *
 * 坐/躺是"持续状态"：只要她还坐在沙发上、躺在床上（或者正在起身的过渡里），
 * 就绝不能进入漫游，否则会出现"躺着被拖到场地另一头"的情况。
 * 这里做成纯函数，方便回归测试；主循环只负责喂状态。
 */

import { resources } from '../../shared/resources.mjs';

interface ActionNode { action: string; items?: ActionNode[] }
export function needsStanding(steps: ActionNode[]): boolean {
  return steps.some(step => step.action === 'parallel' ? needsStanding(step.items ?? []) :
    step.action !== 'use_furniture' && (resources(step).includes('body_locomotion') || ['stow_scoop','unstow_scoop'].includes(step.action)));
}

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
  /** 当前是否处于"持续动作"状态（坐下/躺下等，见 shared/persistent-actions.mjs） */
  persistentActionActive: boolean;
  /** 持续动作的退出过渡权重：起身过程里也还不允许漫游 */
  persistentWeight: number;
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
    // 持续动作：坐/躺/以后的状态类动作，以及退出的过渡里都不许漫游
    !input.persistentActionActive &&
    input.persistentWeight === 0
  );
}
