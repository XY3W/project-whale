import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

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
  /** 台座（slab），setArena 时要跟着换尺寸 */
  private slab!: THREE.Mesh;
  /** 地板顶面（默认 8×8）。扫雷期间棋盘直接换它的贴图，避免多一层悬空平面 */
  readonly groundTop!: THREE.Mesh;
  /** 地板原本的装饰网格贴图，棋盘关掉时要还原 */
  readonly groundMap!: THREE.Texture;

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
    this.buildGround();

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
    key.position.set(3.8, 2.2, 1.9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    // 覆盖整个 6x6 场地：之前只框住角色，走到边上就没有影子
    key.shadow.camera.far = 14;
    key.shadow.camera.left = -4.2;
    key.shadow.camera.right = 4.2;
    key.shadow.camera.top = 4.2;
    key.shadow.camera.bottom = -4.2;
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.022;
    key.shadow.radius = 3;
    key.target.position.set(0, 0.65, 0);
    this.scene.add(key, key.target);

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

  /** 固定大小的方形场地：整个区域始终完整可见 */
  private buildGround() {
    const AREA = this.roomHalf * 2;

    // 台座：给区域一个明确的边界
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(AREA, 0.14, AREA),
      new THREE.MeshStandardMaterial({ color: 0x0e131d, roughness: 0.95, metalness: 0.0 }),
    );
    slab.position.y = -0.07;
    this.slab = slab;
    slab.receiveShadow = true;
    this.scene.add(slab);

    // 顶面网格
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
    // 边框
    ctx.strokeStyle = "rgba(150, 185, 255, 0.35)";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, size - 6, size - 6);
    const gridTex = new THREE.CanvasTexture(canvas);
    gridTex.colorSpace = THREE.SRGBColorSpace;

    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(AREA, AREA),
      new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.9, metalness: 0.0 }),
    );
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.002;
    top.receiveShadow = true;
    this.scene.add(top);
    (this as { groundTop: THREE.Mesh }).groundTop = top;
    (this as { groundMap: THREE.Texture }).groundMap = gridTex;
  }

  /**
   * 切换场地尺寸（米）。象棋 11.5m、其余模式 8m。
   * 台座和地板平面一起重建，相机按新外接圆重新取景；已注册的棋盘会在 update 时换贴图。
   */
  setArena(size: number) {
    const half = size / 2;
    if (Math.abs(half - this.roomHalf) < 1e-6) return;
    this.roomHalf = half;
    // 台座
    if (this.slab) {
      this.slab.geometry.dispose();
      this.slab.geometry = new THREE.BoxGeometry(size, 0.14, size);
    }
    // 地板平面：扫雷/五子棋会把贴图直接换到这块平面上，尺寸必须跟着变
    this.groundTop.geometry.dispose();
    this.groundTop.geometry = new THREE.PlaneGeometry(size, size);
    for (const child of this.scene.children) {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry?.type === "PlaneGeometry" && mesh.position.y > 0 && mesh.position.y < 0.01) {
        mesh.geometry.dispose();
        mesh.geometry = new THREE.PlaneGeometry(size, size);
      }
    }
    this.setRoomCamera();
  }

  /** 还原默认 8m 场地 */
  resetArena() {
    this.setArena(Stage.ROOM_HALF_DEFAULT * 2);
  }

  /** 固定房间视角：按场地外接圆反算距离，整个区域完整入画 */
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
