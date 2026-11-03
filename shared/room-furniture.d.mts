export interface RoomFurniture {
  id: "sofa" | "bed";
  kind: "sofa" | "bed";
  label: string;
  position: [number, number];
  yaw: number;
  use: { x: number; z: number; yaw: number };
  rest: { x: number; z: number };
  interact: "sit" | "lie";
  surfaceY: number;
}

export const ROOM_FURNITURE: RoomFurniture[];
export const FURNITURE_USE_RANGE_M: number;
export function furnitureById(id: string): RoomFurniture | null;
