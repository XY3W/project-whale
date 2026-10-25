export interface BasinEvent {
  time: number;
  type: string;
  from?: string;
  to?: string;
}

export interface BasinAction {
  id: string;
  duration: number;
  events?: BasinEvent[];
}

export interface BasinCatalog {
  assetVersion?: string;
  bindings: {
    hand: { bone: string; matrixColumnMajor: number[] };
    head: { bone: string; matrixColumnMajor: number[] };
  };
  pickupReference: { position: number[]; quaternion: number[]; time?: number };
  wearMorph: string;
  actions: BasinAction[];
}

export interface CurveSample {
  time: number;
  position: number[];
  quaternion: number[];
  wearMorph: number;
}

export interface PropMotion {
  space?: string;
  clips: Record<string, CurveSample[]>;
  interpolation?: Record<string, string>;
}

export interface BasinAssets {
  catalog: BasinCatalog;
  propMotion: PropMotion;
}

export async function loadBasinAssets(base = "/models/basin-v2"): Promise<BasinAssets> {
  const [catalog, propMotion] = await Promise.all([
    fetch(`${base}/catalog.json`).then((r) => {
      if (!r.ok) throw new Error(`catalog.json ${r.status}`);
      return r.json();
    }) as Promise<BasinCatalog>,
    fetch(`${base}/prop_motion.json`).then((r) => {
      if (!r.ok) throw new Error(`prop_motion.json ${r.status}`);
      return r.json();
    }) as Promise<PropMotion>,
  ]);
  return { catalog, propMotion };
}

/** 在 prop_motion 采样点之间做线性/slerp 插值（事件时刻在表里是精确采样点）。 */
export function sampleCurve(samples: CurveSample[], time: number): CurveSample | null {
  if (!samples.length) return null;
  if (time <= samples[0].time) return samples[0];
  const last = samples[samples.length - 1];
  if (time >= last.time) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.time - a.time;
  const t = span > 1e-9 ? (time - a.time) / span : 0;
  const lerp = (x: number, y: number) => x + (y - x) * t;
  const qa = { x: a.quaternion[0], y: a.quaternion[1], z: a.quaternion[2], w: a.quaternion[3] };
  const qb = { x: b.quaternion[0], y: b.quaternion[1], z: b.quaternion[2], w: b.quaternion[3] };
  // 最短路径 slerp
  let sign = 1;
  const dot = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w;
  if (dot < 0) sign = -1;
  const qy = { x: qb.x * sign, y: qb.y * sign, z: qb.z * sign, w: qb.w * sign };
  const lerpQ = (k: number) => {
    const x = qa.x + (qy.x - qa.x) * k;
    const y = qa.y + (qy.y - qa.y) * k;
    const z = qa.z + (qy.z - qa.z) * k;
    const w = qa.w + (qy.w - qa.w) * k;
    const len = Math.hypot(x, y, z, w) || 1;
    return [x / len, y / len, z / len, w / len];
  };
  return {
    time,
    position: [lerp(a.position[0], b.position[0]), lerp(a.position[1], b.position[1]), lerp(a.position[2], b.position[2])],
    quaternion: lerpQ(t),
    wearMorph: lerp(a.wearMorph, b.wearMorph),
  };
}
