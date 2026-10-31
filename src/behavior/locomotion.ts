/**
 * 走位分段：把"要走多远"拆成宿主支持的档位。
 *
 * 素材把步长量化了（走 0.09+0.18n、微调 0.02/0.04/0.06/0.08、跑 0.144+0.32N），
 * 所以这里只做档位选择，不自己编速度。远距离先跑：跑 0.4m/s，走只有 0.1125m/s。
 */

export const WALK_LADDER = [1.89, 1.71, 1.53, 1.35, 1.17, 0.99, 0.81, 0.63, 0.45, 0.27, 0.09];
export const ADJUST_LADDER = [0.08, 0.06, 0.04, 0.02];
export const RUN_LADDER = Array.from({ length: 11 }, (_, i) => Math.round((0.144 + 0.32 * (i + 1)) * 1000) / 1000);

export type Leg = { kind: "run" | "walk" | "adjust"; meters: number };

/** 短于 0.75m 仍用走路；较远目标跑完后仅补实际残差。
 * run_stop 本身已包含减速，不必再固定慢走 0.6m（原实现额外耗时至少 5 秒）。
 */
const RUN_APPROACH_THRESHOLD = 0.75;

export function planWalkLegs(distance: number, { allowRun = true } = {}): Leg[] {
  if (!Number.isFinite(distance) || distance <= 0) return [];
  const legs: Leg[] = [];
  let rest = Math.max(0, distance);
  if (allowRun && distance >= RUN_APPROACH_THRESHOLD) {
    while (rest >= RUN_LADDER[0] - 1e-9) {
      const fits = RUN_LADDER.filter((d) => d <= rest + 1e-9);
      if (!fits.length) break;
      const meters = fits[fits.length - 1];
      legs.push({ kind: "run", meters });
      rest -= meters;
    }
  }
  while (rest >= 0.09 - 1e-9) {
    const meters = WALK_LADDER.find((v) => v <= rest + 1e-6);
    if (meters === undefined) break;
    legs.push({ kind: "walk", meters });
    rest -= meters;
  }
  while (rest >= 0.02 - 1e-9) {
    const meters = ADJUST_LADDER.find((v) => v <= rest + 1e-6);
    if (meters === undefined) break;
    legs.push({ kind: "adjust", meters });
    rest -= meters;
  }
  return legs;
}
