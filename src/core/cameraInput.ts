import { MOUSE } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** 左键用于场景交互，按住滚轮旋转；wheel 和触屏手势仍由 OrbitControls 处理。 */
export function configureCameraInput(controls: OrbitControls) {
  controls.mouseButtons.LEFT = null;
  controls.mouseButtons.MIDDLE = MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = null;
}
