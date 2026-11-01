import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildTrackOwnership, regionClip } from '../src/character/TrackOwnership.ts';

const track = name => new THREE.VectorKeyframeTrack(name, [0, 1], [0, 0, 0, 1, 1, 1]);
const clip = (name, names) => new THREE.AnimationClip(name, 1, names.map(track));

test('authored tracks have one owner; a gesture can target the head without changing held arms', () => {
  const clips = [clip('walk.lower', ['leg.position']), clip('tail_idle', ['WhaleTail_01.position']),
    clip('walk.upperBase', ['spine.position', 'handl.position', 'handr.position', 'head.position', 'Hair_Back_00.position'])];
  const ownership = buildTrackOwnership(clips);
  assert.equal(ownership.get('handl.position'), 'leftArm');
  assert.equal(ownership.get('handr.position'), 'rightArm');
  assert.equal(ownership.get('head.position'), 'head');
  assert.equal(ownership.get('Hair_Back_00.position'), 'head');
  const gesture = clip('look', ['head.position', 'handl.position', 'handr.position']);
  const result = regionClip(gesture, 'head-only', ownership, new Set(['head']));
  assert.deepEqual(result.tracks.map(t => t.name), ['head.position']);
  assert.equal(gesture.tracks.length, 3);
  assert.notEqual(result.tracks[0], gesture.tracks[0]);
});

test('conflicting ownership is rejected before composing animations', () => {
  assert.throws(() => buildTrackOwnership([
    clip('walk.lower', ['joint.position']), clip('walk.upperBase', ['joint.position']), clip('tail_idle', ['tail.position']),
  ]), /Conflicting track ownership/);
});
