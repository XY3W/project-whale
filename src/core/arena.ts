/**
 * 场地尺寸（客户端）：Stage.setArena 改的是 roomHalf，角色夹取必须跟着它走。
 * 普通房间 8m（半 4），象棋 11.5m（半 5.75），与 server/arena.mjs 保持一致。
 */
export const WALK_MARGIN = 0.3;

export const walkableHalfOf = (roomHalf: number) => Math.max(0.5, roomHalf - WALK_MARGIN);
