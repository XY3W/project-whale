import * as THREE from 'three';
import type { SceneDef } from './types';
import { ROOM_GRID, ROOM_LAYOUT, roomCell, roomFootprint, type RoomLayoutItem } from '../../shared/room-furniture.mjs';
import { buildFurniture } from './roomFurniture.ts';
import type { Obstacle, SceneCollider } from './navigation';

export type FurnitureSpec = RoomLayoutItem;
export interface RoomScene {
  root: THREE.Group;
  furniture: FurnitureSpec[];
  obstacles: Obstacle[];
  colliders: SceneCollider[];
}
export const ROOM_DEF: SceneDef = {
  id: 'room', label: '房间', half: ROOM_GRID.half,
  spawn: { ...roomCell(8, 11), yaw: 0 },
  camera: { target: [0, .65, -.6], distance: 17, fov: 33, minPolar: .55, maxPolar: 1.28 },
  propAnchors: {
    basin: { ...roomCell(4, 10), yaw: 0 },
    rice_scoop: { ...roomCell(11, 10), yaw: 0 },
  },
};
function box(w: number, h: number, d: number, color: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: .94 }));
  mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
}
export function buildRoom(): RoomScene {
  const root = new THREE.Group(); root.name = 'scene:room';
  const half = ROOM_GRID.half;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), new THREE.MeshStandardMaterial({ color: 0xb08c68, roughness: .95 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; root.add(floor);
  // Visible construction grid: same origin/cell size as the placement and navigation registry.
  const grid = new THREE.GridHelper(half * 2, ROOM_GRID.columns, 0x705841, 0x705841);
  grid.name = 'room:grid'; grid.position.y = .002;
  const gridMat = grid.material as THREE.LineBasicMaterial;
  gridMat.transparent = true; gridMat.opacity = .3; gridMat.depthWrite = false; root.add(grid);
  const back = box(half * 2, 2.6, .10, 0xded4c3); back.position.set(0, 1.3, -half); root.add(back);
  for (const x of [-half, half]) {
    const wall = box(.10, 2.6, half * 2, 0xd0d4cd); wall.position.set(x, 1.3, 0); root.add(wall);
    const trim = box(.07, .10, half * 2, 0xa77e55); trim.position.set(x - Math.sign(x) * .06, .05, 0); root.add(trim);
  }
  const trim = box(half * 2, .10, .07, 0xa77e55); trim.position.set(0, .05, -half + .06); root.add(trim);
  const frame = box(2, 1.5, .08, 0xf1e9db); frame.position.set(0, 1.6, -half + .09); root.add(frame);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.3), new THREE.MeshStandardMaterial({ color: 0x83afc5, emissive: 0x7496b4, emissiveIntensity: .3, roughness: .35 }));
  glass.position.set(0, 1.6, -half + .135); root.add(glass);
  const crossV = box(.04, 1.3, .03, 0xf1e9db); crossV.position.set(0, 1.6, -half + .15); root.add(crossV);
  const crossH = box(1.8, .04, .03, 0xf1e9db); crossH.position.set(0, 1.6, -half + .15); root.add(crossH);
  const sill = box(2.1, .06, .20, 0xa77e55); sill.position.set(0, .83, -half + .10); root.add(sill);

  const solids: THREE.Group[] = [];
  for (const spec of ROOM_LAYOUT) {
    const object = buildFurniture(spec); root.add(object);
    if (spec.kind !== 'rug') solids.push(object);
  }
  const ceiling = new THREE.PointLight(0xffedcf, 7, 10, 2); ceiling.position.set(0, 3, -1); root.add(ceiling);
  root.add(new THREE.HemisphereLight(0xa9c1d8, 0x65523e, .5));
  root.updateMatrixWorld(true);
  // Footprints are intentionally conservative, covering furniture legs and rounded corners.
  // Physical supports use individual visible meshes, so props can land on the actual surfaces.
  const obstacles: Obstacle[] = ROOM_LAYOUT.filter(s => s.kind !== 'rug').map(spec => {
    const f = roomFootprint(spec.grid); return { minX: f.minX, maxX: f.maxX, minZ: f.minZ, maxZ: f.maxZ };
  });
  const colliders: SceneCollider[] = [];
  for (const object of solids) object.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.solid === false) return;
    const bounds = new THREE.Box3().setFromObject(mesh);
    const center = bounds.getCenter(new THREE.Vector3()), h = bounds.getSize(new THREE.Vector3()).multiplyScalar(.5);
    colliders.push({ x: center.x, y: center.y, z: center.z, hx: h.x, hy: h.y, hz: h.z });
  });
  return { root, furniture: ROOM_LAYOUT, obstacles, colliders };
}
