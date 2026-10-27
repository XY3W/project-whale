// Measured from character_playful.glb/dig @ 0.72 and the metal bowl collision proxy.
export const DIG_TIP_LOCAL={x:-0.23349058477014467,z:0.30985648067934773};
export function digAim(character){const yaw=(character.yawDeg??0)*Math.PI/180;const dx=Math.cos(yaw)*DIG_TIP_LOCAL.x+Math.sin(yaw)*DIG_TIP_LOCAL.z,dz=-Math.sin(yaw)*DIG_TIP_LOCAL.x+Math.cos(yaw)*DIG_TIP_LOCAL.z;return {tip:{x:character.x+dx,z:character.z+dz},standOffset:{x:Math.max(-.23,Math.min(.23,dx))-dx,z:Math.max(-.23,Math.min(.23,dz))-dz}};}
