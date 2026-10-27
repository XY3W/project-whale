import * as THREE from "three";
import type { GomokuStone, GomokuView } from "../behavior/protocol";

/** 15×15 铺满 8m 场地；交点在每格中心，四周留半格边距 */
export const GOMOKU_SIZE = 15;
export const GOMOKU_CELL_M = 8 / GOMOKU_SIZE;
const BOARD_HALF = 4;
const PX = 1024;
const CELL_PX = PX / GOMOKU_SIZE;

/** 进行中=琥珀、有人赢=绿、和棋/收局=中性灰蓝（与扫雷配色保持一致） */
const ACCENT_CSS: Record<string, string> = {
  playing: "255, 184, 40",
  won: "74, 222, 128",
  draw: "160, 171, 194",
  ended: "160, 171, 194",
};
const PULSE_MS = 1100;

export const gomokuCellCenter = (row: number, col: number) => ({
  x: -BOARD_HALF + (col + 0.5) * GOMOKU_CELL_M,
  z: -BOARD_HALF + (row + 0.5) * GOMOKU_CELL_M,
});

/** 世界坐标 → 最近的交点；超出 0.46 格或越界返回 null */
export function gomokuCellAt(x: number, z: number): { row: number; col: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const col = Math.round((x + BOARD_HALF - GOMOKU_CELL_M / 2) / GOMOKU_CELL_M);
  const row = Math.round((z + BOARD_HALF - GOMOKU_CELL_M / 2) / GOMOKU_CELL_M);
  if (row < 0 || col < 0 || row >= GOMOKU_SIZE || col >= GOMOKU_SIZE) return null;
  const center = gomokuCellCenter(row, col);
  if (Math.hypot(x - center.x, z - center.z) > GOMOKU_CELL_M * 0.46) return null;
  return { row, col };
}

/**
 * 五子棋盘面：和扫雷一样直接把画布贴到 8×8 地板材质上，不叠加第二层平面。
 * 只渲染服务端下发的公开棋局。
 */
export class GomokuBoard {
  readonly mesh: THREE.Mesh;
  private readonly floor: THREE.Mesh | null = null;
  private readonly floorMap: THREE.Texture | null = null;
  private active = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private board: GomokuView | null = null;
  private hover: { row: number; col: number } | null = null;
  private pulseStart = 0;
  private lastGameId: string | null = null;

  constructor(parent: THREE.Object3D, floor?: THREE.Mesh) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = PX;
    this.canvas.height = PX;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    if (floor) {
      this.floor = floor;
      const mat = floor.material as THREE.MeshStandardMaterial;
      this.floorMap = mat.map;
      this.mesh = floor;
    } else {
      const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false });
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), material);
      this.mesh.rotation.x = -Math.PI / 2;
      this.mesh.position.y = 0.0025;
      this.mesh.visible = false;
      this.mesh.renderOrder = 1;
      parent.add(this.mesh);
    }
    this.draw();
  }

  get visible() {
    return this.active;
  }

  get state() {
    return { board: this.board, hover: this.hover, visible: this.active };
  }

  update(board: GomokuView | null) {
    // 心跳会反复送 null：没有局的时候什么都不用做
    if (!board && !this.board) return;
    this.board = board;
    this.active = !!board;
    this.hover = null;
    if (!this.floor) this.mesh.visible = !!board;
    this.syncFloor();
    if (board) {
      if (board.gameId !== this.lastGameId) {
        this.lastGameId = board.gameId;
        this.pulseStart = performance.now();
      }
    } else {
      this.pulseStart = 0;
    }
    this.draw();
  }

  show(visible: boolean) {
    this.active = visible && !!this.board;
    if (!this.floor) this.mesh.visible = this.active;
    this.syncFloor();
    this.draw();
  }

  private syncFloor() {
    if (!this.floor) return;
    const mat = this.floor.material as THREE.MeshStandardMaterial;
    const next = this.active ? this.texture : this.floorMap;
    if (mat.map === next) return;
    // 地板是共享资源：另一块棋盘正占着时，不要把它抢回来
    if (!this.active && mat.map !== this.texture) return;
    mat.map = next;
    mat.needsUpdate = true;
  }

  setHover(cell: { row: number; col: number } | null) {
    const same = (a: typeof cell, b: typeof cell) => (a && b ? a.row === b.row && a.col === b.col : a === b);
    if (same(cell, this.hover)) return;
    this.hover = cell;
    this.draw();
  }

  /** 开局扫光期间每帧重绘 */
  tick() {
    if (!this.active || !this.pulseStart) return;
    if (performance.now() - this.pulseStart > PULSE_MS) this.pulseStart = 0;
    this.draw();
  }

  private get pulse(): number {
    if (!this.pulseStart) return 0;
    const t = (performance.now() - this.pulseStart) / PULSE_MS;
    return t >= 1 ? 0 : 1 - t;
  }

  private stoneAt(row: number, col: number): GomokuStone | undefined {
    return this.board?.stones.find((s) => s.row === row && s.col === col);
  }

  private draw() {
    const ctx = this.ctx;
    const pulse = this.pulse;
    const status = this.board?.status ?? "ended";
    const accent = ACCENT_CSS[status] ?? ACCENT_CSS.playing;
    const half = GOMOKU_CELL_M / 2;
    const px = (col: number) => (col + 0.5) * CELL_PX;
    const py = (row: number) => (row + 0.5) * CELL_PX;

    ctx.clearRect(0, 0, PX, PX);
    // 底：和扫雷一致的深靛蓝，一眼看出“地上摆了一盘棋”
    ctx.fillStyle = `rgba(10, 21, 38, ${0.93 + pulse * 0.05})`;
    ctx.fillRect(0, 0, PX, PX);

    // 网格：只在交点之间连线（四周留半格），不像扫雷那样切满整块
    ctx.strokeStyle = `rgba(150, 185, 235, ${0.42 + pulse * 0.2})`;
    ctx.lineWidth = Math.max(2, PX / 512);
    const x0 = px(0);
    const x1 = px(GOMOKU_SIZE - 1);
    for (let i = 0; i < GOMOKU_SIZE; i++) {
      ctx.beginPath(); ctx.moveTo(x0, py(i)); ctx.lineTo(x1, py(i)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px(i), x0); ctx.lineTo(px(i), x1); ctx.stroke();
    }
    // 星位
    ctx.fillStyle = "rgba(180, 205, 240, 0.75)";
    for (const [r, c] of [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]) {
      ctx.beginPath();
      ctx.arc(px(c), py(r), Math.max(3, CELL_PX * 0.07), 0, Math.PI * 2);
      ctx.fill();
    }

    // 棋子
    const stoneR = CELL_PX * 0.42;
    for (const stone of this.board?.stones ?? []) {
      const cx = px(stone.col);
      const cy = py(stone.row);
      // 投影：让黑子在深色棋盘上也立得起来
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
      ctx.shadowBlur = stoneR * 0.5;
      ctx.shadowOffsetY = stoneR * 0.12;
      ctx.beginPath();
      ctx.arc(cx, cy, stoneR, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, cy, stoneR, 0, Math.PI * 2);
      if (stone.color === "black") {
        const g = ctx.createRadialGradient(cx - stoneR * 0.35, cy - stoneR * 0.4, stoneR * 0.15, cx, cy, stoneR);
        g.addColorStop(0, "#9aa9bd");
        g.addColorStop(0.35, "#4a5668");
        g.addColorStop(0.8, "#1d2634");
        g.addColorStop(1, "#0e151f");
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = "rgba(186, 206, 232, 0.55)";
      } else {
        const g = ctx.createRadialGradient(cx - stoneR * 0.35, cy - stoneR * 0.4, stoneR * 0.15, cx, cy, stoneR);
        g.addColorStop(0, "#ffffff");
        g.addColorStop(0.7, "#eef2f8");
        g.addColorStop(1, "#c3ccd9");
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = "rgba(120,135,155,0.85)";
      }
      ctx.lineWidth = Math.max(1.5, PX / 680);
      ctx.stroke();
    }

    // 最后一手：小圆环标记
    const last = this.board?.lastMove;
    if (last) {
      ctx.beginPath();
      ctx.arc(px(last.col), py(last.row), stoneR * 0.42, 0, Math.PI * 2);
      ctx.strokeStyle = last.color === "black" ? "rgba(255, 210, 120, 0.95)" : "rgba(60, 110, 190, 0.95)";
      ctx.lineWidth = Math.max(2.5, PX / 400);
      ctx.stroke();
    }

    // 五连高亮
    const line = this.board?.line;
    if (line && line.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(px(line[0].col), py(line[0].row));
      ctx.lineTo(px(line.at(-1)!.col), py(line.at(-1)!.row));
      ctx.strokeStyle = `rgba(${accent}, 0.9)`;
      ctx.lineWidth = Math.max(5, PX / 200);
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.lineCap = "butt";
    }

    // 悬停预落子：只在用户回合、空点、且是自己颜色时显示
    if (this.hover && this.board?.status === "playing" && this.board.turn === "white" && !this.stoneAt(this.hover.row, this.hover.col)) {
      const cx = px(this.hover.col);
      const cy = py(this.hover.row);
      ctx.beginPath();
      ctx.arc(cx, cy, stoneR, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(240, 245, 255, 0.35)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.lineWidth = Math.max(2, PX / 512);
      ctx.stroke();
      // 坐标提示
      ctx.font = `${Math.round(CELL_PX * 0.3)}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(`${this.hover.row},${this.hover.col}`, cx + stoneR * 1.1, cy - stoneR * 1.6);
    }

    // 外框：状态色 + 辉光；收局时整盘压暗
    ctx.save();
    ctx.strokeStyle = `rgba(${accent}, ${0.7 + pulse * 0.3})`;
    ctx.lineWidth = Math.max(6, PX / 128);
    ctx.shadowColor = `rgba(${accent}, ${0.5 + pulse * 0.5})`;
    ctx.shadowBlur = PX / 30 + pulse * PX / 14;
    const inset = ctx.lineWidth / 2 + 2;
    ctx.strokeRect(inset, inset, PX - inset * 2, PX - inset * 2);
    ctx.restore();

    if (this.board && status !== "playing") {
      ctx.fillStyle = status === "won" ? "rgba(40, 160, 90, 0.16)" : "rgba(120, 130, 150, 0.18)";
      ctx.fillRect(0, 0, PX, PX);
    }
    void half;
    this.texture.needsUpdate = true;
  }
}
