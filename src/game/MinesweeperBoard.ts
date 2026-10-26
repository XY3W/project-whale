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
  mineCount: number;
  cells: PublicCell[];
  revealedSafe: number;
  remainingSafe: number;
}

const SIZE_M = 8;

/**
 * 扫雷盘面：8m × 8m 的 10×10 网格，用一张 canvas 纹理画在贴地平面上。
 * 只渲染服务端下发的公开棋盘，未揭示格不携带任何数值。
 */
export class MinesweeperBoard {
  readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private board: PublicBoard | null = null;
  private hover: { row: number; col: number } | null = null;

  constructor(parent: THREE.Object3D) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1024;
    this.canvas.height = 1024;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE_M, SIZE_M), material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.005;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    parent.add(this.mesh);
    this.draw();
  }

  get visible() {
    return this.mesh.visible;
  }

  show(visible: boolean) {
    this.mesh.visible = visible;
    if (!visible) this.draw();
  }

  update(board: PublicBoard | null) {
    this.board = board;
    if (board) this.mesh.visible = true;
    this.draw();
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
    const cell = px / 10;
    ctx.clearRect(0, 0, px, px);
    // 底：淡蓝灰玻璃
    ctx.fillStyle = "rgba(24, 38, 62, 0.55)";
    ctx.fillRect(0, 0, px, px);
    ctx.strokeStyle = "rgba(140, 180, 240, 0.35)";
    ctx.lineWidth = 2;
    for (let i = 0; i <= 10; i++) {
      ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, px); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(px, i * cell); ctx.stroke();
    }
    if (this.board) {
      for (const c of this.board.cells) {
        const x = c.col * cell;
        const y = c.row * cell;
        if (c.state === "revealed") {
          ctx.fillStyle = c.value === "mine" ? "rgba(190, 60, 60, 0.85)" : "rgba(232, 240, 252, 0.9)";
          ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
          ctx.fillStyle = "#22304a";
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
    }
    if (this.hover) {
      ctx.strokeStyle = "rgba(255, 210, 120, 0.95)";
      ctx.lineWidth = 5;
      ctx.strokeRect(this.hover.col * cell + 3, this.hover.row * cell + 3, cell - 6, cell - 6);
    }
    if (this.board && this.board.status !== "playing") {
      ctx.fillStyle = this.board.status === "won" ? "rgba(40, 160, 90, 0.35)" : "rgba(170, 40, 40, 0.35)";
      ctx.fillRect(0, 0, px, px);
    }
    this.texture.needsUpdate = true;
  }
}
