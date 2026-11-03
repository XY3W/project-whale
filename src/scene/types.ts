/** 场景（场地）定义：playground 下棋玩小游戏，room 是生活房间。 */

export type SceneId = "playground" | "room";

/** 道具在该场景的"重置点"：不在身上时切场景落到这里。 */
export interface PropAnchor {
  x: number;
  z: number;
  yaw: number;
}

export interface CameraPreset {
  target: [number, number, number];
  /** 相机到目标的距离（米） */
  distance: number;
  fov: number;
  minPolar: number;
  maxPolar: number;
}

export interface SceneSpawn {
  x: number;
  z: number;
  yaw: number;
}

export interface SceneDef {
  id: SceneId;
  label: string;
  /** 场地半边长（米） */
  half: number;
  spawn: SceneSpawn;
  camera: CameraPreset;
  propAnchors: Record<"basin" | "rice_scoop", PropAnchor>;
}
