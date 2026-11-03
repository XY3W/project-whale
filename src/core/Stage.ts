import * as THREE from "three";
import { fitShadowBounds } from "./shadowBounds";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { configureCameraInput } from "./cameraInput";
import type { CameraPreset } from "../scene/types";

/**
 * 舞台：渲染器、相机、灯光、地面、环境贴图。
 * 只负责"场景长什么样"，不关心角色怎么动。
 */
export class Stage {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  /** 场地半边长（米）；象棋模式会临时放大到 5.75，退出时还原 */
  roomHalf = 4;
  private static readonly ROOM_HALF_DEFAULT = 4;
  /** 场地场景（playground）：尺寸由它自己维护，Stage 只负责在 setArena 时转达 */
  private arena?: { setHalf(half: number): void };
  /** 主光：阴影范围要跟着场地尺寸重算，否则放大的场角会没有影子 */
  private keyLight!: THREE.DirectionalLight;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearAlpha(0);
    container.appendChild(this.renderer.domElement);

    // 中长焦透视：保留自然透视，同时把整个场地收进画面
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    this.camera.position.set(6, 12, 10);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // 左键留给棋子/角色交互；按住滚轮旋转，滚动滚轮仍缩放。
    configureCameraInput(this.controls);
    this.controls.target.set(0, 0.62, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 5.2;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = Math.PI * 0.56;
    this.controls.rotateSpeed = 0.55;

    this.buildEnvironment();
    this.buildLights();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  private buildEnvironment() {
    // 室内 HDR 近似，给皮肤/布料一点柔和高光
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.06);
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.28;
    pmrem.dispose();
  }

  private buildLights() {
    const hemi = new THREE.HemisphereLight(0xd8e4ff, 0x2b2338, 0.55);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff0e2, 2.2);
    // 把灯拉远（方向不变）：阴影相机架在灯的位置上，灯太近时场地远端会落到
    // 近平面前面，那块地方就没有影子。3 倍距离后整个场地都在近平面之后。
    const keyTarget = new THREE.Vector3(0, 0.65, 0);
    key.position.copy(keyTarget).add(new THREE.Vector3(3.8, 1.55, 1.9).multiplyScalar(3));
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    // 阴影相机范围由 fitShadowBounds 按场地尺寸算，见 applyShadowBounds()
    key.shadow.camera.far = 14;
    key.shadow.camera.left = -4.2;
    key.shadow.camera.right = 4.2;
    key.shadow.camera.top = 4.2;
    key.shadow.camera.bottom = -4.2;
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.022;
    key.shadow.radius = 3;
    key.target.position.copy(keyTarget);
    this.scene.add(key, key.target);
    this.keyLight = key;
    this.applyShadowBounds();

    const rim = new THREE.DirectionalLight(0x8ab4ff, 1.6);
    rim.position.set(-2.4, 1.9, -2.7);
    rim.target.position.set(0, 0.7, 0);
    this.scene.add(rim, rim.target);

    const fill = new THREE.PointLight(0xffc9a8, 2.0, 6, 2);
    fill.position.set(2.1, 1.0, -1.4);
    this.scene.add(fill);

    // 正前方补光：避免刘海把整张脸压进阴影
    const face = new THREE.DirectionalLight(0xcfdcff, 0.45);
    face.position.set(0.2, 1.5, 3.4);
    face.target.position.set(0, 0.72, 0);
    this.scene.add(face, face.target);
  }

  /**
   * 切换场地尺寸（米）。象棋 11.5m、其余模式 8m。
   * 台座和地板平面一起重建，相机按新外接圆重新取景；已注册的棋盘会在 update 时换贴图。
   */
  setArena(size: number) {
    const half = size / 2;
    this.arena?.setHalf(half);
    if (Math.abs(half - this.roomHalf) < 1e-6) return;
    this.roomHalf = half;
    this.applyShadowBounds();
    this.setRoomCamera();
  }

  /** 场地场景挂上来之后，setArena 才能改它的台座与地板。 */
  attachArena(arena: { setHalf(half: number): void }) {
    this.arena = arena;
  }

  /** 把场景（playground / room）或角色挂到舞台根上。 */
  mount(root: THREE.Object3D) {
    this.scene.add(root);
  }

  /** 只改场地半径与阴影范围，不动相机（切场景时用）。 */
  setActiveHalf(half: number) {
    if (Math.abs(half - this.roomHalf) < 1e-6) return;
    this.roomHalf = half;
    this.applyShadowBounds();
  }

  /**
   * 按当前场地尺寸重算主光阴影相机：把场地四角投到灯光视图空间反算正交范围。
   * 场地放大到 11.5m 后仍然是全覆盖，不会出现"某个角落没有影子"。
   */
  private applyShadowBounds() {
    if (!this.keyLight) return;
    const fit = fitShadowBounds({
      lightPosition: [this.keyLight.position.x, this.keyLight.position.y, this.keyLight.position.z],
      target: [this.keyLight.target.position.x, this.keyLight.target.position.y, this.keyLight.target.position.z],
      roomHalf: this.roomHalf,
    });
    const camera = this.keyLight.shadow.camera;
    camera.left = -fit.extent;
    camera.right = fit.extent;
    camera.top = fit.extent;
    camera.bottom = -fit.extent;
    camera.near = fit.near;
    camera.far = fit.far;
    camera.updateProjectionMatrix();
    this.keyLight.shadow.needsUpdate = true;
  }

  /** 还原默认 8m 场地 */
  resetArena() {
    this.setArena(Stage.ROOM_HALF_DEFAULT * 2);
  }

  /** 固定房间视角：按场地外接圆反算距离，整个区域完整入画 */
  /** 预设对应的相机位置（沿固定俯视方向拉距离）。 */
  cameraPositionFor(preset: CameraPreset): THREE.Vector3 {
    const target = new THREE.Vector3(...preset.target);
    const dir = new THREE.Vector3(0.42, 0.92, 0.95).normalize();
    return target.clone().addScaledVector(dir, preset.distance);
  }

  /** 套用场景相机预设：位置、朝向、fov 与轨道限制一起换。 */
  applyCameraPreset(preset: CameraPreset) {
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    const target = new THREE.Vector3(...preset.target);
    this.camera.position.copy(this.cameraPositionFor(preset));
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
    this.controls.target.copy(target);
    this.controls.enabled = true;
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = preset.distance * 0.55;
    this.controls.maxDistance = preset.distance * 1.7;
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minPolarAngle = preset.minPolar;
    this.controls.maxPolarAngle = preset.maxPolar;
  }

  setRoomCamera() {
    const target = new THREE.Vector3(0, 0.42, 0);
    const dir = new THREE.Vector3(0.42, 0.92, 0.95).normalize();
    this.camera.fov = 32;
    this.camera.updateProjectionMatrix();
    const radius = this.roomHalf * Math.SQRT2;
    const distance = (radius * 1.12) / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position.copy(target).addScaledVector(dir, distance);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
    this.controls.target.copy(target);
    this.controls.enabled = true;
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = distance * 0.55;
    this.controls.maxDistance = distance * 1.7;
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.25;
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (!this.controls.enabled) this.setRoomCamera();
  }

  update() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
