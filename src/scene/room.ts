import * as THREE from "three";
import type { SceneDef } from "./types";
import { ROOM_FURNITURE } from "../../shared/room-furniture.mjs";
import type { Obstacle, SceneCollider } from './navigation';

/**
 * room：生活房间。家具先程序化搭（纯色块 + 灯光），尺寸按角色身材定
 * ——她站着约 0.7m、坐着髋高 0.15m，所以沙发座高 0.16m、床面 0.12m。
 * 等美术素材到位再逐件替换，接口保持 scene 自己的 group。
 */

export interface FurnitureSpec {
  id: string;
  kind: "sofa" | "bed" | "table" | "shelf" | "lamp" | "rug" | "window";
  /** 世界坐标（x,z），y 由构建函数决定 */
  position: [number, number];
  yaw: number;
  /** 互动点：角色站/坐的位置与朝向；没有就不是可互动家具 */
  use?: { x: number; z: number; yaw: number };
  /** 互动方式 */
  interact?: "sit" | "lie";
  /** 座面/床面高度，坐下/躺下时用来对齐 */
  surfaceY?: number;
}

export interface RoomScene {
  root: THREE.Group;
  furniture: FurnitureSpec[];
  obstacles: Obstacle[];
  colliders: SceneCollider[];
}

export const ROOM_DEF: SceneDef = {
  id: "room",
  label: "房间",
  half: 4,
  spawn: { x: 0, z: 1.6, yaw: 0 },
  camera: { target: [0, 0.95, -0.7], distance: 19, fov: 33, minPolar: 0.55, maxPolar: 1.28 },
  propAnchors: {
    basin: { x: -2.6, z: 0.6, yaw: 0 },
    rice_scoop: { x: 2.6, z: 0.6, yaw: 0 },
  },
};

const mat = (color: number, roughness = 0.85) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });

function box(w: number, h: number, d: number, color: number, roughness = 0.85) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, roughness));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildRoom(): RoomScene {
  const root = new THREE.Group();
  root.name = "scene:room";
  const half = ROOM_DEF.half;
  const furniture: FurnitureSpec[] = [];

  // 地板：木色
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), mat(0x6b4a33, 0.95));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // 三面墙（正面敞开给相机）
  const wallColor = 0xb9ac9a;
  const back = box(half * 2, 3.2, 0.12, wallColor);
  back.position.set(0, 1.6, -half);
  root.add(back);
  const left = box(0.12, 3.2, half * 2, wallColor);
  left.position.set(-half, 1.6, 0);
  root.add(left);
  const right = box(0.12, 3.2, half * 2, wallColor);
  right.position.set(half, 1.6, 0);
  root.add(right);

  // 后墙上的窗：夜里的一块冷光
  const windowFrame = box(1.9, 1.4, 0.06, 0xe8e2d6);
  windowFrame.position.set(0.1, 1.85, -half + 0.08);
  root.add(windowFrame);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 1.2),
    new THREE.MeshStandardMaterial({ color: 0x2b4a78, emissive: 0x1e3358, emissiveIntensity: 1.4, roughness: 0.4 }),
  );
  glass.position.set(0.1, 1.85, -half + 0.12);
  root.add(glass);

  // 地毯
  const rug = box(2.6, 0.012, 1.7, 0x7a4b52, 1.0);
  rug.position.set(0, 0.006, -0.9);
  root.add(rug);

  // 沙发：座面 0.16m，靠背朝后墙
  const sofa = new THREE.Group();
  sofa.name = "furniture:sofa";
  const seat = box(1.05, 0.1, 0.52, 0x3f5f8f);
  seat.position.set(0, 0.15, 0);
  const backRest = box(1.05, 0.3, 0.12, 0x37527d);
  backRest.position.set(0, 0.32, -0.2);
  const armL = box(0.1, 0.22, 0.52, 0x37527d);
  armL.position.set(-0.48, 0.24, 0);
  const armR = armL.clone();
  armR.position.x = 0.48;
  sofa.add(seat, backRest, armL, armR);
  sofa.position.set(-1.7, 0, -3.1);
  root.add(sofa);
  furniture.push(...ROOM_FURNITURE.filter((item) => item.id === "sofa".valueOf()) as unknown as FurnitureSpec[]);

  // 床：床面 0.12m，床头贴后墙
  const bed = new THREE.Group();
  bed.name = "furniture:bed";
  const mattress = box(0.78, 0.12, 1.3, 0xd7cfc2, 0.9);
  mattress.position.set(0, 0.1, 0);
  const headboard = box(0.78, 0.4, 0.08, 0x6d5545);
  headboard.position.set(0, 0.26, -0.66);
  const quilt = box(0.74, 0.06, 0.72, 0x4d6ea8, 0.95);
  quilt.position.set(0, 0.19, 0.28);
  bed.add(mattress, headboard, quilt);
  bed.position.set(1.9, 0, -2.95);
  root.add(bed);
  furniture.push(...ROOM_FURNITURE.filter((item) => item.id === "bed") as unknown as FurnitureSpec[]);

  // 床边小几 + 台灯
  const table = box(0.4, 0.26, 0.4, 0x7a5c43);
  table.position.set(3.1, 0.13, -3.3);
  root.add(table);
  const lampShade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.17, 0.16, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xf2d9b0, emissive: 0xffb867, emissiveIntensity: 1.2, side: THREE.DoubleSide }),
  );
  lampShade.position.set(3.1, 0.42, -3.3);
  root.add(lampShade);
  const lampLight = new THREE.PointLight(0xffb867, 2.4, 4.2, 2);
  lampLight.position.set(3.1, 0.4, -3.3);
  root.add(lampLight);
  furniture.push({ id: "lamp", kind: "lamp", position: [3.1, -3.3], yaw: 0 });

  // 书架：靠右墙
  const shelf = box(1.2, 1.0, 0.28, 0x6d5545);
  shelf.position.set(3.6, 0.5, 0.9);
  shelf.rotation.y = -Math.PI / 2;
  root.add(shelf);
  furniture.push({ id: "shelf", kind: "shelf", position: [3.6, 0.9], yaw: -Math.PI / 2 });

  // 房间灯：顶光偏暖，让家具和角色都有影子
  const ceiling = new THREE.PointLight(0xfff0d8, 9, 9, 2);
  ceiling.position.set(0, 3.0, -1.0);
  root.add(ceiling);
  const ambience = new THREE.HemisphereLight(0x8fa6cc, 0x3a2e28, 0.35);
  root.add(ambience);

  // Derive collision boxes from the rendered meshes rather than maintaining a second set of sizes.
  root.updateMatrixWorld(true);
  const obstacles: Obstacle[] = [];
  const colliders: SceneCollider[] = [];
  for (const object of [sofa, bed, table, shelf]) {
    const bounds = new THREE.Box3().setFromObject(object);
    obstacles.push({minX:bounds.min.x,maxX:bounds.max.x,minZ:bounds.min.z,maxZ:bounds.max.z});
    object.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3()), halfSize = box.getSize(new THREE.Vector3()).multiplyScalar(.5);
      colliders.push({x:center.x,y:center.y,z:center.z,hx:halfSize.x,hy:halfSize.y,hz:halfSize.z});
    });
  }
  return { root, furniture, obstacles, colliders };
}
