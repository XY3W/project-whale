import * as THREE from 'three';

export type BodyRegion = 'lower' | 'torso' | 'leftArm' | 'rightArm' | 'head' | 'tail';

/** The authored walk partition is the authority for lower-body ownership.
 * Track names include both a node and a property, so rotations, positions and
 * scales are checked independently. Hair and neck belong to the head region.
 */
export function buildTrackOwnership(clips: THREE.AnimationClip[]): Map<string, BodyRegion> {
  const source = (name: string) => clips.find(clip => clip.name === name);
  const lower = source('walk.lower'), upper = source('walk.upperBase'), tail = source('tail_idle');
  if (!lower || !upper || !tail) throw new Error('Missing authored locomotion or tail partition');
  const regions = new Map<string, BodyRegion>();
  const assign = (track: THREE.KeyframeTrack, region: BodyRegion) => {
    const existing = regions.get(track.name);
    if (existing && existing !== region) throw new Error(`Conflicting track ownership: ${track.name}`);
    regions.set(track.name, region);
  };
  for (const track of lower.tracks) assign(track, 'lower');
  for (const track of tail.tracks) assign(track, 'tail');
  for (const track of upper.tracks) {
    const node = String(THREE.PropertyBinding.parseTrackName(track.name).nodeName ?? '')
      .replace(/[^a-z0-9]/gi, '').toLowerCase();
    let region: BodyRegion = 'torso';
    if (/^(shoulder|arm|forearm|hand|carm)/.test(node) && node.endsWith('l')) region = 'leftArm';
    else if (/^(shoulder|arm|forearm|hand|carm)/.test(node) && node.endsWith('r')) region = 'rightArm';
    else if (/^(head|neck|subneck|hair|ahoge)/.test(node)) region = 'head';
    assign(track, region);
  }
  return regions;
}

/** Filter an authored clip without modifying its tracks or the source asset. */
export function regionClip(clip: THREE.AnimationClip, name: string, ownership: Map<string, BodyRegion>, allowed: ReadonlySet<BodyRegion>): THREE.AnimationClip {
  return new THREE.AnimationClip(name, clip.duration, clip.tracks
    .filter(track => { const region = ownership.get(track.name); return region !== undefined && allowed.has(region); })
    .map(track => track.clone()));
}
