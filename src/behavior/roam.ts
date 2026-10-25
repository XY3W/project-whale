/**
 * 机械漫游的朝向选择。
 * 规则：越靠近某个边缘，朝那个方向走的权重越低；进入边缘 0.5 米内权重为 0，
 * 避免角色在边界处反复顶墙卡死。
 */

export interface RoamInput {
  x: number;
  z: number;
  yaw: number; // 弧度
  half: number; // 场地半边长
  rng?: () => number;
}

const EDGE_ZERO = 0.5; // 距边缘该距离内权重为 0
const EDGE_FULL = 2.0; // 距边缘该距离以上权重为 1
const WALK_CLEARANCE = 0.25; // 走完后与边缘保留的余量
const DISTANCES = [0.27, 0.45, 0.63];

/** 从当前位置沿 heading 前进，到场地边界的距离（米） */
export function freeDistance(x: number, z: number, heading: number, half: number): number {
  const sx = Math.sin(heading);
  const sz = Math.cos(heading);
  const tx = sx > 1e-6 ? (half - x) / sx : sx < -1e-6 ? (-half - x) / sx : Infinity;
  const tz = sz > 1e-6 ? (half - z) / sz : sz < -1e-6 ? (-half - z) / sz : Infinity;
  return Math.max(0, Math.min(tx, tz));
}

/** 朝向权重：0.5 米内为 0，2 米以上为 1，中间线性 */
export function headingWeight(free: number): number {
  if (free <= EDGE_ZERO) return 0;
  return Math.min(1, (free - EDGE_ZERO) / (EDGE_FULL - EDGE_ZERO));
}

function pickWeighted<T>(items: T[], weights: number[], rng: () => number): T | null {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** 返回相对当前朝向的角度（度）与走路距离；无可行方向时返回 null */
export function pickRoamPlan(input: RoamInput): { angleDeg: number; distance: number } | null {
  const rng = input.rng ?? Math.random;
  const half = input.half;

  const candidates = (span: number) => {
    const out: { angleDeg: number; free: number }[] = [];
    for (let deg = -span; deg <= span; deg += 15) {
      const heading = input.yaw + (deg * Math.PI) / 180;
      out.push({ angleDeg: deg, free: freeDistance(input.x, input.z, heading, half) });
    }
    return out;
  };

  for (const span of [45, 180]) {
    const list = candidates(span);
    const weights = list.map((c) => headingWeight(c.free));
    const picked = pickWeighted(list, weights, rng);
    if (picked) {
      // 距离不能把角色送出边界
      const usable = DISTANCES.filter((d) => d <= picked.free - WALK_CLEARANCE);
      if (!usable.length) continue;
      const distance = usable[Math.floor(rng() * usable.length)];
      return { angleDeg: picked.angleDeg, distance };
    }
  }
  return null;
}
