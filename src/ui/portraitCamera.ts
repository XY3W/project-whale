import * as THREE from 'three';

/** 正面小窗的取景参数：相机站在她正前方，看向胸口略上方 */
export const PORTRAIT = {
  fov: 26,
  /** 宽高比（竖构图），与 PortraitWindow 的 DOM 比例一致 */
  aspect: 0.78,
  distance: 2.8,
  /** 相机比注视点高一点，稍稍俯看 */
  eyeLift: 0.15,
  /** 注视点高度（从脚底算起） */
  lookHeight: 0.6,
} as const;

/**
 * 给定角色位置与朝向，算出"正面视角"相机该站在哪、看哪。
 * 抽出纯函数是为了能测：角色必须完整落在取景框里，且居中。
 */
export function portraitPose(
  position: { x: number; y: number; z: number },
  yaw: number,
  cfg: typeof PORTRAIT = PORTRAIT,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  const target = new THREE.Vector3(position.x, position.y + cfg.lookHeight, position.z);
  const eye = new THREE.Vector3(
    target.x + Math.sin(yaw) * cfg.distance,
    target.y + cfg.eyeLift,
    target.z + Math.cos(yaw) * cfg.distance,
  );
  return { position: eye, target };
}
