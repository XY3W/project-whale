import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { roomFootprint, type RoomLayoutItem } from '../../shared/room-furniture.mjs';

const palette = {
  wood: 0xa27650, edge: 0x684b36, lightWood: 0xc99b6b,
  blue: 0x7d9cba, navy: 0x456584, cream: 0xf0e6d2, seam: 0xc6d7df,
};
const materials = new Map<number, THREE.MeshStandardMaterial>();
function material(color: number) {
  if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: .88 }));
  return materials.get(color)!;
}
function block(parent: THREE.Group, size: number[], at: number[], color: number, radius = .015, solid = true) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(size[0], size[1], size[2], 2, radius), material(color));
  mesh.position.set(at[0], at[1], at[2]);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData.solid = solid;
  parent.add(mesh); return mesh;
}
function cylinder(parent: THREE.Group, top: number, bottom: number, height: number, at: number[], color: number) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, height, 24), material(color));
  mesh.position.set(at[0], at[1], at[2]); mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}
/** All ground silhouettes fit the grid footprint; bevels/details never change its dimensions. */
export function buildFurniture(spec: RoomLayoutItem) {
  const group = new THREE.Group(), f = roomFootprint(spec.grid);
  group.name = `furniture:${spec.id}`;
  group.position.set(f.x, 0, f.z); group.rotation.y = spec.yaw;
  group.userData.grid = { ...spec.grid };
  const w = f.width, d = f.depth, p = palette;
  if (spec.kind === 'sofa') {
    for (const x of [-w / 2 + .09, w / 2 - .09]) for (const z of [-d / 2 + .09, d / 2 - .09])
      block(group, [.075, .09, .075], [x, .045, z], p.edge);
    block(group, [w, .075, d - .12], [0, .10, -.06], p.wood, .025);
    block(group, [w - .20, .17, .14], [0, .245, -d / 2 + .07], p.navy, .035);
    const seatWidth = (w - .24) / 2;
    for (const x of [-seatWidth / 2 - .006, seatWidth / 2 + .006]) {
      block(group, [seatWidth - .012, .07, d - .20], [x, .165, .04], p.blue, .03);
      block(group, [seatWidth - .012, .24, .14], [x, .34, -d / 2 + .15], p.blue, .04);
      // Pale piping along each back cushion, decorative only.
      block(group, [seatWidth - .08, .009, .01], [x, .43, -d / 2 + .225], p.seam, .004, false);
    }
    for (const x of [-w / 2 + .065, w / 2 - .065]) {
      block(group, [.13, .23, d], [x, .245, 0], p.navy, .04);
      block(group, [.13, .04, d - .10], [x, .36, 0], p.blue, .015);
    }
    // Corner bolsters stay above the seat, leaving the middle free for the character.
    for (const x of [-.48, .48]) block(group, [.17, .14, .14], [x, .265, -.20], p.cream, .04);
  } else if (spec.kind === 'bed') {
    for (const x of [-w / 2 + .055, w / 2 - .055]) for (const z of [-d / 2 + .055, d / 2 - .055])
      block(group, [.09, .12, .09], [x, .06, z], p.edge);
    block(group, [w, .075, d], [0, .08, 0], p.wood, .02);
    block(group, [w - .06, .055, d - .10], [0, .1265, .015], p.cream, .025);
    block(group, [w, .34, .065], [0, .23, -d / 2 + .0325], p.wood, .025);
    block(group, [w - .13, .20, .02], [0, .245, -d / 2 + .073], p.blue, .01);
    // Blanket top remains at the interaction surface height (0.16 m).
    block(group, [w - .07, .022, d * .57], [0, .149, d * .16], p.blue, .012);
    block(group, [w - .075, .008, .09], [0, .164, -d * .095], p.cream, .003, false);
    for (let i = -3; i <= 3; i++)
      block(group, [.008, .003, d * .48], [i * .12, .1615, d * .17], p.seam, .001, false);
    block(group, [w - .28, .055, .24], [0, .184, -d * .31], p.cream, .025);
    block(group, [w - .38, .004, .01], [0, .213, -d * .31], p.seam, .001, false);
  } else if (spec.kind === 'table') {
    for (const x of [-w / 2 + .055, w / 2 - .055]) for (const z of [-d / 2 + .055, d / 2 - .055])
      block(group, [.06, .12, .06], [x, .06, z], p.edge);
    block(group, [w - .025, .20, d - .025], [0, .20, 0], p.wood);
    block(group, [w, .035, d], [0, .3175, 0], p.lightWood, .015);
    for (const y of [.16, .25]) {
      block(group, [w - .075, .075, .018], [0, y, d / 2 - .02], p.lightWood, .009);
      block(group, [.10, .012, .022], [0, y, d / 2 - .012], p.edge, .005, false);
    }
    cylinder(group, .095, .10, .018, [0, .344, 0], p.navy);
    cylinder(group, .012, .012, .16, [0, .43, 0], p.edge);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(.105, .145, .15, 32),
      new THREE.MeshStandardMaterial({ color: p.cream, emissive: 0xffbc70, emissiveIntensity: .35, roughness: 1 }));
    shade.position.set(0, .56, 0); shade.castShadow = true; group.add(shade);
    const light = new THREE.PointLight(0xffce92, .6, 2.2, 2); light.position.set(0, .49, .03); group.add(light);
  } else if (spec.kind === 'shelf') {
    // Long face runs along Z, opening toward the centre of the room (-X).
    block(group, [.035, 1.05, d], [w / 2 - .0175, .525, 0], p.wood);
    for (const z of [-d / 2 + .025, d / 2 - .025]) block(group, [w, 1.05, .05], [0, .525, z], p.wood);
    for (const y of [.06, .38, .70, 1.025]) block(group, [w, .05, d], [0, y, 0], p.lightWood);
    for (const z of [-.25, .25]) block(group, [w - .04, .94, .025], [.01, .55, z], p.wood);
    const bookColors = [p.navy, p.cream, p.blue, 0xb98a71];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      for (let b = 0; b < 4; b++) {
        const h = .17 + ((row + col + b) % 3) * .025;
        const z = -.65 + col * .49 + b * .07;
        block(group, [.28, h, .055], [-.015, .085 + row * .32 + h / 2, z], bookColors[(row + col + b) % 4], .005, false);
        block(group, [.003, .009, .043], [-.157, .11 + row * .32, z], p.cream, .001, false);
      }
    }
  } else if (spec.kind === 'rug') {
    block(group, [w, .008, d], [0, .005, 0], p.navy, .004, false);
    block(group, [w - .08, .003, d - .08], [0, .0105, 0], p.cream, .001, false);
    block(group, [w - .18, .003, d - .18], [0, .0135, 0], p.blue, .001, false);
    for (const x of [-w / 2 + .18, w / 2 - .18]) block(group, [.02, .001, d - .30], [x, .0155, 0], p.seam, .0004, false);
    for (const z of [-d / 2 + .18, d / 2 - .18]) block(group, [w - .30, .001, .02], [0, .0155, z], p.seam, .0004, false);
  }
  return group;
}
