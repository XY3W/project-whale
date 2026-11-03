/**
 * 房间家具的唯一来源：客户端建场景、服务端写上下文、家具桥校验都用这一份，
 * 避免"模型以为沙发在左边、画面在右边"。
 *
 * 尺寸按角色身材定（她站着约 0.7m、坐着髋高约 0.15m）：
 * 沙发座面 0.20m、床面 0.16m。
 */

export const FURNITURE_USE_RANGE_M = 1.2;

export const ROOM_FURNITURE = [
  {
    id: "sofa",
    kind: "sofa",
    label: "沙发",
    position: [-1.7, -3.1],
    yaw: 0,
    /** 角色走过来站着的位置 */
    use: { x: -1.7, z: -2.55, yaw: 0 },
    /** 坐下之后身体所在的位置 */
    rest: { x: -1.7, z: -2.95 },
    interact: "sit",
    surfaceY: 0.2,
  },
  {
    id: "bed",
    kind: "bed",
    label: "床",
    position: [1.9, -2.95],
    yaw: 0,
    use: { x: 2.75, z: -2.95, yaw: 0 },
    rest: { x: 1.9, z: -2.95 },
    interact: "lie",
    surfaceY: 0.16,
  },
];

export const furnitureById = (id) => ROOM_FURNITURE.find((item) => item.id === id) ?? null;
