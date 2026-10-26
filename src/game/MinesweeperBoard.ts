import * as THREE from "three";

export interface PublicCell {
  row: number;
  col: number;
  state: "hidden" | "revealed";
  value?: number | "mine";
}

export interface PublicBoard {
  gameId: string;
  revision: number;
  status: "playing" | "won" | "lost";
  size: number;
  cellSize?: number;
  mineCount: number;
  cells: PublicCell[];
  revealedSafe: number;
  remainingSafe: number;
}

const SIZE_M = 8;
/** 开局扫光时长（毫秒） */
const PULSE_MS = 1300;

/**
 * 扫雷盘面：8m × 8m 地面上的 16×16 网格（每格 0.5m），用一张 canvas 纹理绘制。
 * 只渲染服务端下发的公开棋盘，未揭示格不携带任何数值。
 */
export class MinesweeperBoard {
  readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private board: PublicBoard | null = null;
  private hover: { row: number; col: number } | null = null;
  /** 进入新一局的时间点：用来播“开局扫光” */
  private pulseStart = 0;
  private lastGameId: string | null = null;

  constructor(parent: THREE.Object3D) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1024;
    this.canvas.height = 1024;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // 贴地：地板顶面在 y=0.002。棋盘只抬高 0.5mm（polygonOffset 保证压过地板纹理），
    // 否则 5mm 的平面会切进盆/角色贴地的那一截，看起来像“网格线有厚度、盆陷进去了”。
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE_M, SIZE_M), material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.0025;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    parent.add(this.mesh);
    this.draw();
  }

  get visible() {
    return this.mesh.visible;
  }

  /** 调试/探针：当前悬停格与盘面数据 */
  get state() {
    return { board: this.board, hover: this.hover, visible: this.mesh.visible };
  }

  show(visible: boolean) {
    this.mesh.visible = visible;
    if (!visible) this.draw();
  }

  update(board: PublicBoard | null) {
    this.board = board;
    if (board) {
      this.mesh.visible = true;
      if (board.gameId !== this.lastGameId) {
        this.lastGameId = board.gameId;
        this.pulseStart = performance.now();
      }
    }
    this.draw();
  }

  /** 每帧调用：只在开局扫光期间重绘，平时不花 CPU */
  tick() {
    if (!this.pulseStart) return;
    if (performance.now() - this.pulseStart > PULSE_MS) {
      this.pulseStart = 0;
      this.draw();
      return;
    }
    this.draw();
  }

  private get pulse(): number {
    if (!this.pulseStart) return 0;
    const t = (performance.now() - this.pulseStart) / PULSE_MS;
    return t >= 1 ? 0 : 1 - t;
  }

  setHover(cell: { row: number; col: number } | null) {
    const same = (a: typeof cell, b: typeof cell) => (a && b ? a.row === b.row && a.col === b.col : a === b);
    if (same(cell, this.hover)) return;
    this.hover = cell;
    this.draw();
  }

  private draw() {
    const ctx = this.ctx;
    const px = this.canvas.width;
    const size = this.board?.size ?? 16;
    const cell = px / size;
    const pulse = this.pulse;
    const status = this.board?.status ?? "playing";
    const accent = status === "won" ? "74, 222, 128" : status === "lost" ? "255, 95, 109" : "88, 166, 255";
    ctx.clearRect(0, 0, px, px);

    // 底盘：几乎不透明的深靛蓝，和地板那张 16×16 装饰网格一眼区分开
    ctx.fillStyle = `rgba(9, 21, 40, ${0.9 + pulse * 0.08})`;
    ctx.fillRect(0, 0, px, px);
    // 棋盘底纹：交替深浅，格子一眼可数
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if ((r + c) % 2 !== 0) continue;
        ctx.fillStyle = "rgba(130, 190, 255, 0.045)";
        ctx.fillRect(c * cell, r * cell, cell, cell);
      }
    }

    // 网格线
    ctx.strokeStyle = `rgba(104, 172, 255, ${0.34 + pulse * 0.3})`;
    ctx.lineWidth = Math.max(2, px / 512);
    for (let i = 0; i <= size; i++) {
      const p = Math.round(i * cell);
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, px); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(px, p); ctx.stroke();
    }

    if (this.board) {
      for (const c of this.board.cells) {
        const x = c.col * cell;
        const y = c.row * cell;
        if (c.state !== "revealed") continue;
        ctx.fillStyle = c.value === "mine" ? "rgba(196, 62, 62, 0.92)" : "rgba(233, 241, 252, 0.94)";
        ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
        ctx.font = `bold ${Math.round(cell * 0.52)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        if (c.value === "mine") {
          ctx.fillStyle = "#fff";
          ctx.fillText("✳", x + cell / 2, y + cell / 2 + 2);
        } else if (typeof c.value === "number" && c.value > 0) {
          ctx.fillStyle = ["#22304a", "#2f6fd0", "#1f8a4c", "#c0392b", "#6b3fa0", "#a8621b", "#0f7b8a", "#333", "#555"][c.value] ?? "#22304a";
          ctx.fillText(String(c.value), x + cell / 2, y + cell / 2 + 2);
        }
      }
    }

    // 开局扫光：一道斜向高光扫过盘面，明确“新的一局开始了”
    if (pulse > 0) {
      const t = 1 - pulse;
      const band = px * 0.28;
      const cx = -band + t * (px + band * 2);
      const grad = ctx.createLinearGradient(cx - band / 2, 0, cx + band / 2, px);
      grad.addColorStop(0, "rgba(120, 200, 255, 0)");
      grad.addColorStop(0.5, `rgba(150, 215, 255, ${0.28 * pulse})`);
      grad.addColorStop(1, "rgba(120, 200, 255, 0)");
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, px, px);
      ctx.restore();
    }

    if (this.hover) {
      // 悬停格显示坐标，方便对照提示词里的 row/col
      ctx.save();
      ctx.font = `${Math.round(cell * 0.26)}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillText(`${this.hover.row},${this.hover.col}`, this.hover.col * cell + 10, this.hover.row * cell + 10);
      ctx.restore();
      ctx.strokeStyle = "rgba(255, 210, 120, 0.95)";
      ctx.lineWidth = 5;
      ctx.strokeRect(this.hover.col * cell + 3, this.hover.row * cell + 3, cell - 6, cell - 6);
    }

    // 外框：状态色 + 辉光，胜负也靠它表达
    ctx.save();
    ctx.strokeStyle = `rgba(${accent}, ${0.75 + pulse * 0.25})`;
    ctx.lineWidth = Math.max(6, px / 128);
    ctx.shadowColor = `rgba(${accent}, ${0.55 + pulse * 0.45})`;
    ctx.shadowBlur = px / 26 + pulse * px / 12;
    const inset = ctx.lineWidth / 2 + 2;
    ctx.strokeRect(inset, inset, px - inset * 2, px - inset * 2);
    ctx.restore();

    if (this.board && status !== "playing") {
      ctx.fillStyle = status === "won" ? "rgba(40, 160, 90, 0.28)" : "rgba(170, 40, 40, 0.3)";
      ctx.fillRect(0, 0, px, px);
    }
    this.texture.needsUpdate = true;
  }
}
