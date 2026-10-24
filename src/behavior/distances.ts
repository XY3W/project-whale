/**
 * 距离子集：起步 0.045 + n 个完整循环 * 0.18 + 收步 0.045。
 * 资产不改的前提下，只有 d = 0.09 + 0.18n 能被精确执行。
 * 见 NEXT_PHASE_LLM_PLAN.md §8.1。
 */

export const START_DISTANCE = 0.045;
export const CYCLE_DISTANCE = 0.18;
export const STOP_DISTANCE = 0.045;
export const MAX_CYCLES = 10;

/** 支持的距离列表（米），从 0.09 到 1.89。 */
export function supportedDistances(maxCycles = MAX_CYCLES): number[] {
  const out: number[] = [];
  for (let n = 0; n <= maxCycles; n++) out.push(round(START_DISTANCE + STOP_DISTANCE + CYCLE_DISTANCE * n));
  return out;
}

/** 四舍五入到毫米，避免浮点噪声 */
export function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 返回循环数 n；不支持时返回 null。不静默取整。 */
export function cyclesFor(meters: number, maxCycles = MAX_CYCLES): number | null {
  if (!Number.isFinite(meters) || meters <= 0) return null;
  const n = (meters - START_DISTANCE - STOP_DISTANCE) / CYCLE_DISTANCE;
  const nearest = Math.round(n);
  if (nearest < 0 || nearest > maxCycles) return null;
  if (Math.abs(START_DISTANCE + STOP_DISTANCE + CYCLE_DISTANCE * nearest - meters) > 1e-6) return null;
  return nearest;
}

export function isSupportedDistance(meters: number): boolean {
  return cyclesFor(meters) !== null;
}

/** 最接近的两个候选，用于 UNSUPPORTED_DISTANCE 的提示 */
export function nearestSupported(meters: number): { below: number; above: number } {
  const list = supportedDistances();
  let below = list[0];
  let above = list[list.length - 1];
  for (const d of list) {
    if (d <= meters) below = d;
    if (d >= meters && above === list[list.length - 1]) above = d;
  }
  const idx = list.findIndex((d) => d >= meters);
  above = idx === -1 ? list[list.length - 1] : list[idx];
  return { below, above };
}
