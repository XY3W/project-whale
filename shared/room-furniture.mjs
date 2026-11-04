/** All floor footprints use complete 0.5 m cells, counted from the back-left corner. */
export const ROOM_GRID = { cellSize: 0.5, columns: 16, rows: 16, half: 4 };
export const FURNITURE_USE_RANGE_M = 1.2;

export function roomCell(col, row) {
  const { half, cellSize } = ROOM_GRID;
  return { x: -half + (col + .5) * cellSize, z: -half + (row + .5) * cellSize };
}

export function roomFootprint(grid) {
  const { half, cellSize } = ROOM_GRID;
  const width = grid.cols * cellSize, depth = grid.rows * cellSize;
  const minX = -half + grid.col * cellSize, minZ = -half + grid.row * cellSize;
  return { x: minX + width / 2, z: minZ + depth / 2, width, depth, minX, maxX: minX + width, minZ, maxZ: minZ + depth };
}

const specs = [
  { id: 'sofa', kind: 'sofa', label: '沙发', grid: { col: 2, row: 1, cols: 3, rows: 2 },
    useCell: { col: 3, row: 3 }, interact: 'sit', surfaceY: .2, restOffsetZ: .42 },
  { id: 'bed', kind: 'bed', label: '床', grid: { col: 10, row: 1, cols: 2, rows: 3 },
    useCell: { col: 13, row: 3 }, interact: 'lie', surfaceY: .16, restOffsetZ: 0 },
  { id: 'bedside', kind: 'table', label: '床头柜与台灯', grid: { col: 13, row: 1, cols: 1, rows: 1 } },
  { id: 'shelf', kind: 'shelf', label: '书架', grid: { col: 14, row: 7, cols: 1, rows: 3 } },
  { id: 'rug', kind: 'rug', label: '地毯', grid: { col: 5, row: 6, cols: 6, rows: 4 } },
];

export const ROOM_LAYOUT = specs.map(spec => {
  const f = roomFootprint(spec.grid);
  return {
    ...spec, position: [f.x, f.z], yaw: 0,
    ...(spec.useCell ? {
      use: { ...roomCell(spec.useCell.col, spec.useCell.row), yaw: 0 },
      rest: { x: f.x, z: f.z + spec.restOffsetZ },
    } : {}),
  };
});
/** Only these pieces currently support character interaction. */
export const ROOM_FURNITURE = ROOM_LAYOUT.filter(item => item.interact);
export const furnitureById = id => ROOM_FURNITURE.find(item => item.id === id) ?? null;
