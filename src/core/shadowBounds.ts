import * as THREE from 'three';

/**
 * 主光阴影相机要覆盖整个场地。
 *
 * 之前把阴影相机写死成 ±4.2（8m 场地），象棋把场地放大到 11.5m 后，
 * 远侧角落落在阴影相机外面——那块地方就完全没有影子。
 * 这里按灯光位置/朝向把场地四角投到灯光视图空间，反算需要的正交范围，
 * 换场地尺寸时自动重算。
 */
export type ShadowFit = { extent: number; near: number; far: number };

export function fitShadowBounds(options: {
  lightPosition: [number, number, number];
  target: [number, number, number];
  roomHalf: number;
  /** 场地平面高度（默认地面 y=0） */
  planeY?: number;
  /** 最高的投影体（角色约 1.1m，留点富余）：影子的投射体比地面高，范围要一起算 */
  casterHeight?: number;
  /** 边缘余量，米 */
  margin?: number;
}): ShadowFit {
  const { lightPosition, target, roomHalf } = options;
  const planeY = options.planeY ?? 0;
  const casterHeight = options.casterHeight ?? 1.4;
  const margin = options.margin ?? 0.4;

  const eye = new THREE.Vector3(...lightPosition);
  const look = new THREE.Vector3(...target);
  // 阴影相机就架在灯的位置上：先旋转（lookAt 只给旋转），再平移到灯的位置，
  // 取逆得到世界→灯光视图的变换。
  const rotation = new THREE.Matrix4().lookAt(eye, look, new THREE.Vector3(0, 1, 0));
  const cameraWorld = new THREE.Matrix4().makeTranslation(eye.x, eye.y, eye.z).multiply(rotation);
  const inverse = cameraWorld.clone().invert();

  let maxX = 0;
  let maxY = 0;
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  const corner = new THREE.Vector3();
  for (const y of [planeY, planeY + casterHeight]) {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corner.set(sx * roomHalf, y, sz * roomHalf).applyMatrix4(inverse);
        maxX = Math.max(maxX, Math.abs(corner.x));
        maxY = Math.max(maxY, Math.abs(corner.y));
        // 相机看向 -Z：深度就是 -z
        minDepth = Math.min(minDepth, -corner.z);
        maxDepth = Math.max(maxDepth, -corner.z);
      }
    }
  }

  const extent = Math.ceil((Math.max(maxX, maxY) + margin) * 100) / 100;
  const near = Math.max(0.1, minDepth - 1);
  const far = Math.max(near + 1, maxDepth + 2);
  return { extent, near, far };
}
