/**
 * 场地尺寸的唯一来源：渲染（客户端）、逐帧夹取、快照清洗、模型上下文、道具物理
 * 都从这里取，避免再出现"场地放大了、角色还被 3.7 夹着"。
 *
 * 象棋的 11.5m 来自 assets/xiangqi-v1 的棋盘尺寸（半 5.75），
 * 客户端 XQ_HALF 必须与这里一致。
 */
export const NORMAL_STAGE_HALF = 4;
export const XIANGQI_STAGE_HALF = 5.75;
/** 角色不能贴到台座边缘，留 0.3m */
export const WALK_MARGIN = 0.3;

export const stageHalfNow = (hasXiangqi) => (hasXiangqi ? XIANGQI_STAGE_HALF : NORMAL_STAGE_HALF);
export const walkableHalfNow = (hasXiangqi) => Math.max(0.5, stageHalfNow(hasXiangqi) - WALK_MARGIN);
