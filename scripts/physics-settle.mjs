import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BasinPhysics, hullPoints } from "../src/prop/basinPhysics.ts";

globalThis.self ??= globalThis;
const BASE = new URL("../public/models/basin-v2/", import.meta.url);
const buf = readFileSync(new URL("steel_basin_v2.glb", BASE));
const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
const hull = hullPoints(gltf.scene);
console.log("hull points:", hull.length / 3);
const physics = await BasinPhysics.create(hull);
const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4, 1.2));
physics.launch({
  position: new THREE.Vector3(0, 0.42, 0),
  quaternion: q,
  velocity: new THREE.Vector3(0.2, 1.2, 2.4),
  angularVelocity: new THREE.Vector3(0, 3.1, 0),
});
let t = 0;
for (let i = 1; i <= 1800; i++) {
  const out = physics.step(1 / 60);
  t += 1 / 60;
  if (i % 60 === 0) console.log(`t=${t.toFixed(1)} y=${out.pose.position.y.toFixed(3)} v=${out.speed} w=${out.spin} calm=${out.calm.toFixed(2)} resting=${out.resting}`);
  if (out.resting) { console.log("RESTING at", t.toFixed(2)); break; }
}
