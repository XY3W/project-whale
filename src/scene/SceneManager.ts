import * as THREE from "three";
import type { Stage } from "../core/Stage";
import type { PlaygroundScene } from "./playground";
import type { RoomScene } from "./room";
import type { SceneDef, SceneId } from "./types";

/**
 * 场景管理：两个场景各一个 group，转场时一起平移，相机不参与（避免和 OrbitControls 打架）。
 * 时间轴（默认 1000ms）：
 *   0–150ms   角色 poof-out（外部回调）
 *   150–850ms 世界左移一个场地间距：旧场景滑出、新场景从右滑入
 *   500ms     交换：角色瞬移到新场景 spawn（外部回调）
 *   850–1000ms 角色 poof-in，相机插值到新场景预设
 */

const TRANSITION_MS = 1000;
const GAP = 4;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export interface SceneManagerHooks {
  onHide?: () => void;
  onSwap?: (to: SceneId) => void;
  onShow?: () => void;
  onDone?: (to: SceneId) => void;
}

export class SceneManager {
  readonly worldRoot = new THREE.Group();
  active: SceneId = "playground";
  transitioning = false;

  private readonly stage: Stage;
  private readonly roots: Record<SceneId, THREE.Group>;
  private readonly defs: Record<SceneId, SceneDef>;
  private readonly room: RoomScene;
  private readonly hooks: SceneManagerHooks;

  private elapsed = 0;
  private target: SceneId = "playground";
  private hidden = false;
  private swapped = false;
  private shown = false;
  private cameraFrom: { position: THREE.Vector3; target: THREE.Vector3; fov: number } | null = null;

  constructor(stage: Stage, playground: PlaygroundScene, room: RoomScene, defs: Record<SceneId, SceneDef>, hooks: SceneManagerHooks = {}) {
    this.stage = stage;
    this.roots = { playground: playground.root, room: room.root };
    this.defs = defs;
    this.room = room;
    this.hooks = hooks;

    this.worldRoot.name = "world";
    this.worldRoot.add(playground.root, room.root);
    this.roots.room.visible = false;
    stage.mount(this.worldRoot);
    stage.setActiveHalf(defs.playground.half);
  }

  get activeHalf(): number {
    return this.defs[this.active].half;
  }

  get progress(): number { return this.transitioning ? this.elapsed / (TRANSITION_MS / 1000) : 1; }

  get definition(): SceneDef {
    return this.defs[this.active];
  }

  get furniture() {
    return this.active === "room" ? this.room.furniture : [];
  }

  /** 立刻切到某个场景（初始化 / 重连对齐用，不播动画）。 */
  setActive(id: SceneId) {
    this.active = id;
    this.target = id;
    this.transitioning = false;
    this.worldRoot.position.x = 0;
    for (const key of ["playground", "room"] as SceneId[]) {
      this.roots[key].position.x = 0;
      this.roots[key].visible = key === id;
    }
    this.stage.setActiveHalf(this.defs[id].half);
    if (id === "room") this.stage.applyCameraPreset(this.defs.room.camera);
    else this.stage.setRoomCamera();
  }

  /** 开始转场；返回 false 表示正在转场或已经在目标场景。 */
  transitionTo(to: SceneId): boolean {
    if (this.transitioning || to === this.active) return false;
    this.transitioning = true;
    this.target = to;
    this.elapsed = 0;
    this.hidden = false;
    this.swapped = false;
    this.shown = false;
    this.cameraFrom = null;
    this.stage.controls.enabled = false;

    // 新场景先摆在右/左侧，旧场景留在原地
    const direction = to === "room" ? 1 : -1;
    const distance = this.defs.playground.half * 2 + GAP;
    this.roots[to].visible = true;
    this.roots[to].position.x = direction * distance;
    this.roots[this.active].position.x = 0;
    return true;
  }

  update(dt: number) {
    if (!this.transitioning) return;
    this.elapsed += dt;
    const total = TRANSITION_MS / 1000;
    const t = Math.min(1, this.elapsed / total);

    if (!this.hidden && t >= 0.15) {
      this.hidden = true;
      this.hooks.onHide?.();
    }

    const distance = this.defs.playground.half * 2 + GAP;
    const direction = this.target === "room" ? 1 : -1;
    const slide = Math.min(1, Math.max(0, (t - 0.15) / 0.7));
    this.worldRoot.position.x = -direction * distance * easeInOutCubic(slide);

    if (!this.swapped && t >= 0.5) {
      this.swapped = true;
      this.hooks.onSwap?.(this.target);
      this.cameraFrom = {
        position: this.stage.camera.position.clone(),
        target: this.stage.controls.target.clone(),
        fov: this.stage.camera.fov,
      };
    }

    if (!this.shown && t >= 0.85) {
      this.shown = true;
      this.hooks.onShow?.();
    }

    // 后半段把相机差值到新场景预设
    if (this.cameraFrom && this.target === "room") {
      const k = easeInOutCubic(Math.min(1, (t - 0.5) / 0.5));
      const preset = this.defs.room.camera;
      const to = this.stage.cameraPositionFor(preset);
      this.stage.camera.position.lerpVectors(this.cameraFrom.position, to, k);
      this.stage.controls.target.lerpVectors(this.cameraFrom.target, new THREE.Vector3(...preset.target), k);
      this.stage.camera.fov = this.cameraFrom.fov + (preset.fov - this.cameraFrom.fov) * k;
      this.stage.camera.updateProjectionMatrix();
      this.stage.camera.lookAt(this.stage.controls.target);
    }

    if (t >= 1) this.finish();
  }

  private finish() {
    const to = this.target;
    this.transitioning = false;
    this.active = to;
    this.worldRoot.position.x = 0;
    for (const key of ["playground", "room"] as SceneId[]) {
      this.roots[key].position.x = 0;
      this.roots[key].visible = key === to;
    }
    this.stage.setActiveHalf(this.defs[to].half);
    this.stage.controls.enabled = true;
    if (to === "room") this.stage.applyCameraPreset(this.defs.room.camera);
    else this.stage.setRoomCamera();
    this.hooks.onDone?.(to);
  }
}
