import * as THREE from "three";
import type { SceneDef } from "./types";

/**
 * playground：原来的台座 + 网格地板。
 * 从 Stage.buildGround 搬出来，尺寸仍由 setHalf 控制（象棋会临时放大到 5.75）。
 */
export interface PlaygroundScene {
  root: THREE.Group;
  groundTop: THREE.Mesh;
  groundMap: THREE.Texture;
  setHalf(half: number): void;
}

export const PLAYGROUND_DEF: SceneDef = {
  id: "playground",
  label: "场地",
  half: 4,
  spawn: { x: 0, z: 0.6, yaw: 0 },
  camera: { target: [0, 0.42, 0], distance: 0, fov: 32, minPolar: 0.35, maxPolar: Math.PI * 0.56 },
  propAnchors: {
    basin: { x: -1.5, z: 1.5, yaw: 0 },
    rice_scoop: { x: 1.5, z: 1.5, yaw: 0 },
  },
};

export function buildPlayground(initialHalf = PLAYGROUND_DEF.half): PlaygroundScene {
  const root = new THREE.Group();
  root.name = "scene:playground";
  let half = initialHalf;

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(half * 2, 0.14, half * 2),
    new THREE.MeshStandardMaterial({ color: 0x0e131d, roughness: 0.95, metalness: 0.0 }),
  );
  slab.position.y = -0.07;
  slab.receiveShadow = true;
  root.add(slab);

  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#131a26";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(120, 155, 220, 0.16)";
  ctx.lineWidth = 2;
  const cells = 16;
  for (let i = 0; i <= cells; i++) {
    const p = Math.round((i / cells) * size) + 0.5;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(150, 185, 255, 0.35)";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, size - 6, size - 6);
  const groundMap = new THREE.CanvasTexture(canvas);
  groundMap.colorSpace = THREE.SRGBColorSpace;

  const groundTop = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2, half * 2),
    new THREE.MeshStandardMaterial({ map: groundMap, roughness: 0.9, metalness: 0.0 }),
  );
  groundTop.rotation.x = -Math.PI / 2;
  groundTop.position.y = 0.002;
  groundTop.receiveShadow = true;
  root.add(groundTop);

  /** 场地尺寸变化：台座、地板、棋盘自带的贴地平面一起换。 */
  const setHalf = (next: number) => {
    if (Math.abs(next - half) < 1e-6) return;
    half = next;
    const side = half * 2;
    slab.geometry.dispose();
    slab.geometry = new THREE.BoxGeometry(side, 0.14, side);
    groundTop.geometry.dispose();
    groundTop.geometry = new THREE.PlaneGeometry(side, side);
    // 棋盘会把贴图换到自己的贴地平面上，这些平面也要跟着场地尺寸走
    for (const child of root.children) {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry?.type === "PlaneGeometry" && mesh !== groundTop && mesh.position.y > 0 && mesh.position.y < 0.01) {
        mesh.geometry.dispose();
        mesh.geometry = new THREE.PlaneGeometry(side, side);
      }
    }
  };

  return { root, groundTop, groundMap, setHalf };
}
