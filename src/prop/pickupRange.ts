/** Distance from character root to prop origin, in world metres. */
export { PICKUP_RANGE_M } from '../../shared/pickup-range.mjs';
import { PICKUP_RANGE_M } from '../../shared/pickup-range.mjs';
export type Point3 = { x: number; y: number; z: number };
export function pickupRange(character: Point3, object: Point3) {
  const distance_m = Math.hypot(object.x - character.x, object.y - character.y, object.z - character.z);
  return { ok: Number.isFinite(distance_m) && distance_m <= PICKUP_RANGE_M + 1e-6, distance_m, range_m: PICKUP_RANGE_M };
}
