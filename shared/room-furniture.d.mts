export interface GridFootprint { col: number; row: number; cols: number; rows: number }
export interface RoomLayoutItem {
  id: string;
  kind: 'sofa' | 'bed' | 'table' | 'shelf' | 'rug';
  label: string;
  grid: GridFootprint;
  position: [number, number];
  yaw: number;
  useCell?: { col: number; row: number };
  use?: { x: number; z: number; yaw: number };
  rest?: { x: number; z: number };
  interact?: 'sit' | 'lie';
  surfaceY?: number;
}
export interface RoomFurniture extends RoomLayoutItem {
  id: 'sofa' | 'bed';
  kind: 'sofa' | 'bed';
  use: { x: number; z: number; yaw: number };
  rest: { x: number; z: number };
  interact: 'sit' | 'lie';
  surfaceY: number;
}
export const ROOM_GRID: { cellSize: number; columns: number; rows: number; half: number };
export const ROOM_LAYOUT: RoomLayoutItem[];
export const ROOM_FURNITURE: RoomFurniture[];
export const FURNITURE_USE_RANGE_M: number;
export function roomCell(col: number, row: number): { x: number; z: number };
export function roomFootprint(grid: GridFootprint): {
  x: number; z: number; width: number; depth: number;
  minX: number; maxX: number; minZ: number; maxZ: number;
};
export function furnitureById(id: string): RoomFurniture | null;
