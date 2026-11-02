import * as THREE from 'three';
import { PORTRAIT, portraitPose } from './portraitCamera';

/**
 * 左下角的"正面小窗"：一台跟着角色、永远站在她面前的相机。
 *
 * 用同一个 renderer 画：主画面画完后开 scissor，把左下角这块区域清掉再单独
 * 渲染一次，所以不是第二套 WebGL 上下文；DOM 只负责画边框和标签。
 */
export class PortraitWindow {
  readonly camera = new THREE.PerspectiveCamera(PORTRAIT.fov, PORTRAIT.aspect, 0.05, 12);
  readonly frame: HTMLDivElement;
  visible = true;

  /** CSS 像素：左下角的位置与大小（WebGL 视口原点在左下，y 直接就是 bottom 值） */
  private rect = { x: 16, y: 16, w: 150, h: 192 };
  private readonly position = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private first = true;
  private dockObserver: ResizeObserver | null = null;

  constructor() {
    this.frame = document.createElement('div');
    this.frame.className = 'portrait-window';
    this.frame.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'portrait-label';
    label.textContent = '正面';
    this.frame.appendChild(label);
    document.body.appendChild(this.frame);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // 侧栏高度会随内容变（定时任务展开/收起），布局变化时重新排小窗，避免压到边栏底下
    const dock = document.querySelector('.left-dock');
    if (dock && typeof ResizeObserver !== 'undefined') {
      this.dockObserver = new ResizeObserver(() => this.resize());
      this.dockObserver.observe(dock);
    }
    // 首帧布局稳定后再算一次（构造时侧栏可能还没排版）
    requestAnimationFrame(() => this.resize());
  }

  /**
   * 宽度与左侧边栏对齐（读 .left-dock 的实际宽度，窄屏自动跟着变），
   * 高度取 0.78 竖构图；如果边栏把下半屏占得太满，就压到剩下的空间里。
   */
  resize() {
    const dock = document.querySelector('.left-dock') as HTMLElement | null;
    const box = dock?.getBoundingClientRect();
    const width = box && box.width > 0 ? Math.round(box.width) : 220;
    const margin = box ? Math.max(8, Math.round(box.left)) : 16;
    const topLimit = box ? Math.round(box.bottom + 12) : 0;
    const available = Math.max(150, (window.innerHeight || 720) - margin - Math.max(margin, topLimit));
    const w = width;
    // 高度取 0.78 竖构图，但必须让开侧栏：顶部不能压到边栏底下
    const h = Math.max(150, Math.min(Math.round(w / 0.78), available));
    this.rect = { x: margin, y: margin, w, h };
    this.frame.style.width = `${w}px`;
    this.frame.style.height = `${h}px`;
    this.frame.style.left = `${margin}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // 状态条别压在小窗上
    document.documentElement.style.setProperty('--portrait-h', `${h + margin}px`);
  }

  /** 相机永远站在角色正前方 2m、胸高；跟随时按真实 dt 收敛，瞬移就立刻贴上去 */
  update(characterRoot: THREE.Object3D, dt = 1 / 60) {
    if (!this.visible) return;
    const { position: desired, target } = portraitPose(characterRoot.position, characterRoot.rotation.y);
    // 距离过大（传送/重连/第一次）直接贴上去，否则按 dt 指数收敛
    const k = this.first || this.position.distanceTo(desired) > 3 ? 1 : 1 - Math.exp(-8 * Math.max(dt, 1 / 240));
    this.position.lerp(desired, k);
    this.look.lerp(target, k);
    this.first = false;
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.look);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    if (!this.visible) return;
    const { x, y, w, h } = this.rect;
    const prevViewport = renderer.getViewport(new THREE.Vector4());
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    // 小窗自己铺一层深色底，不然透过去看到的是页面背景
    renderer.setClearColor(0x0a1220, 0.92);
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    renderer.render(scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(prevViewport);
    renderer.setClearColor(prevClear, prevAlpha);
  }
}
