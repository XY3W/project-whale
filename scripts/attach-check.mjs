// Offline check of the hand/head attach math: load the character GLB in Node,
// sample the clip at the event time, and compute bone.matrixWorld * attach.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const BASE = new URL("../public/models/basin-v2/", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("catalog.json", BASE), "utf8"));
const buf = readFileSync(new URL("character_basin_actions.glb", BASE));

globalThis.self ??= globalThis;
const loader = new GLTFLoader();
const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");

const norm = (n) => n.replace(/[^A-Za-z0-9_]/g, "");
const bones = new Map();
gltf.scene.traverse((o) => { if (o.isBone) bones.set(norm(o.name), o); });

const mixer = new THREE.AnimationMixer(gltf.scene);
const clipById = new Map(gltf.animations.map((c) => [c.name, c]));

function sample(id, time) {
  const clip = clipById.get(id);
  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.update(time);
  gltf.scene.updateMatrixWorld(true);
  return { clip, action };
}

function attachWorld(boneName, mArr) {
  const bone = bones.get(norm(boneName));
  const m = new THREE.Matrix4().fromArray(mArr);
  return new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, m);
}

const rest = new THREE.Vector3(...catalog.pickupReference.position);
console.log("bones:", bones.size, "clips:", gltf.animations.length);
console.log("rest:", rest.toArray().map((v) => +v.toFixed(4)).join(", "));

for (const [id, t, kind] of [
  ["pickup_basin", 1.05, "hand"],
  ["hold_basin", 1.0, "hand"],
  ["wear_basin", 1.95, "head"],
  ["unwear_basin", 2.0, "hand"],
]) {
  const { action } = sample(id, t);
  const binding = catalog.bindings[kind];
  const world = attachWorld(binding.bone, binding.matrixColumnMajor);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  world.decompose(p, q, s);
  const bone = bones.get(norm(binding.bone));
  console.log(
    `${id}@${t} bone=${bone.name} actionTime=${action.time.toFixed(3)}`,
    "attachPos=", p.toArray().map((v) => +v.toFixed(4)).join(", "),
    "scale=", s.toArray().map((v) => +v.toFixed(4)).join(", "),
    "bonePos=", bone.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(4)).join(", "),
  );
  if (kind === "hand" && id === "pickup_basin") {
    console.log("  delta vs rest:", p.clone().sub(rest).toArray().map((v) => +v.toFixed(4)).join(", "));
  }
}
