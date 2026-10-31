import { supportedDistances } from "../behavior/distances.ts";

/** 角色站位到盆的水平距离由拾取参考姿态决定 */
export interface PickupReference {
  x: number;
  z: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface ApproachRequest {
  character: Vec2;
  basin: Vec2;
  yawDeg: number;
  reference: PickupReference;
  half: number;
  margin?: number;
}

export interface ApproachPlan {
  /** 需要的正面转向（有符号度） */
  turn1Deg: number;
  /** 支持的精确步行距离（0.09 + 0.18n） */
  distanceM: number;
  /** 步行结束后应处的精确位置 */
  stand: Vec2;
  /** 步行后的转向（有符号度） */
  turn2Deg: number;
  /** 最终朝向（度） */
  finalYawDeg: number;
  /** 站位到盆的距离，等于参考半径 */
  reach: number;
  /** 走完 distanceM 后还需要用 walk_adjust 补的零头（0.9 档位之间的残差） */
  adjustM?: number;
  /** true = 精确解不存在（贴墙/角），用“连线站位 + 微调补齐”的近似解 */
  approx?: boolean;
}

export type ApproachError = "TOO_CLOSE" | "TOO_FAR" | "NO_SUPPORTED_DISTANCE" | "OUT_OF_BOUNDS" | "TURN_OVER_180";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function signedDeltaDeg(from: number, to: number): number {
  return normalizeDeg(to - from);
}

const bearingDeg = (from: Vec2, to: Vec2) => Math.atan2(to.x - from.x, to.z - from.z) * DEG;

/**
 * 计算“先转向、精确走一段、再转向”的拾取站位。
 *
 * 盆在角色根局部的偏移固定（catalog.pickupReference），所以站位必须落在以盆为圆心、
 * 半径 reach 的圆上；同时步行距离只能取 0.09 + 0.18n。两个圆的交点就是精确解，
 * 因此不需要“距离够近就凑合抓”的容差。
 */
export function planApproach(req: ApproachRequest): ApproachPlan | { error: ApproachError; reach: number; direct: number } {
  const { character, basin, reference } = req;
  const margin = req.margin ?? 0.3;
  const reach = Math.hypot(reference.x, reference.z);
  const direct = Math.hypot(basin.x - character.x, basin.z - character.z);
  const offsetBearing = Math.atan2(reference.x, reference.z) * DEG;

  if (direct < 0.12) return { error: "TOO_CLOSE", reach, direct };
  if (direct > 8) return { error: "TOO_FAR", reach, direct };

  let best: ApproachPlan | null = null;
  let bestScore = Infinity;

  for (const distanceM of supportedDistances()) {
    if (direct > distanceM + reach + 1e-9 || direct < Math.abs(distanceM - reach) - 1e-9) continue;
    // 两圆交点：以 C 为原点、C→B 为极轴
    const a = (distanceM * distanceM - reach * reach + direct * direct) / (2 * direct);
    const hSq = distanceM * distanceM - a * a;
    if (hSq < -1e-9) continue;
    const h = Math.sqrt(Math.max(0, hSq));
    const bx = (basin.x - character.x) / direct;
    const bz = (basin.z - character.z) / direct;
    for (const sign of [1, -1]) {
      const stand = { x: character.x + a * bx - sign * h * bz, z: character.z + a * bz + sign * h * bx };
      if (Math.abs(stand.x) > req.half - margin || Math.abs(stand.z) > req.half - margin) continue;
      const walkBearing = bearingDeg(character, stand);
      const finalYawDeg = bearingDeg(stand, basin) - offsetBearing;
      const turn1Deg = signedDeltaDeg(req.yawDeg, walkBearing);
      const turn2Deg = signedDeltaDeg(walkBearing, finalYawDeg);
      if (Math.abs(turn1Deg) > 180 || Math.abs(turn2Deg) > 180) continue;
      const score = Math.abs(turn1Deg) + Math.abs(turn2Deg) + distanceM * 2;
      if (score < bestScore) {
        bestScore = score;
        best = {
          turn1Deg,
          distanceM,
          stand,
          turn2Deg,
          finalYawDeg: normalizeDeg(finalYawDeg),
          reach,
        };
      }
    }
  }

  if (!best) {
    // 精确解不存在时（典型：盆贴墙/贴角，两个交点都落在可行走范围外，或没有档位能同时满足）：
    // 沿“以盆为圆心、半径 reach”的圆采样，找一个在场地内、且步行距离能用
    // walk（0.09+0.18n）+ walk_adjust（≤0.18 残差）凑出来的站位。
    const distances = supportedDistances();
    let fallback: ApproachPlan | null = null;
    let fallbackScore = Infinity;
    for (let i = 0; i < 72; i++) {
      const ang = (i / 72) * Math.PI * 2;
      const stand = { x: basin.x + Math.sin(ang) * reach, z: basin.z + Math.cos(ang) * reach };
      if (Math.abs(stand.x) > req.half - margin || Math.abs(stand.z) > req.half - margin) continue;
      const D = Math.hypot(stand.x - character.x, stand.z - character.z);
      if (D < 0.09) continue;
      const distanceM = distances.filter((d) => d <= D + 1e-9).at(-1);
      if (distanceM === undefined) continue;
      const adjustM = D - distanceM;
      if (adjustM > 0.18 + 1e-9) continue;
      const walkBearing = bearingDeg(character, stand);
      const finalYawDeg = normalizeDeg(bearingDeg(stand, basin) - offsetBearing);
      const turn1Deg = signedDeltaDeg(req.yawDeg, walkBearing);
      const turn2Deg = signedDeltaDeg(walkBearing, finalYawDeg);
      if (Math.abs(turn1Deg) > 180 || Math.abs(turn2Deg) > 180) continue;
      const score = Math.abs(turn1Deg) + Math.abs(turn2Deg) + adjustM * 40;
      if (score < fallbackScore) {
        fallbackScore = score;
        fallback = { turn1Deg, distanceM, stand, turn2Deg, finalYawDeg, reach, adjustM, approx: true };
      }
    }
    if (!fallback) return { error: "NO_SUPPORTED_DISTANCE", reach, direct };
    return fallback;
  }
  // 转向必须能由单次 turn 完成（|deg| <= 180），否则拆成两次
  if (Math.abs(best.turn1Deg) > 180 || Math.abs(best.turn2Deg) > 180) {
    return { error: "TURN_OVER_180", reach, direct };
  }
  return best;
}

/** 复算：给定最终位置与朝向，盆应处的世界位置（用于站位验证） */
export function expectedBasin(stand: Vec2, yawDeg: number, reference: PickupReference): Vec2 {
  const s = Math.sin(yawDeg * RAD);
  const c = Math.cos(yawDeg * RAD);
  return {
    x: stand.x + reference.x * c + reference.z * s,
    z: stand.z - reference.x * s + reference.z * c,
  };
}
