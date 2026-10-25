import * as THREE from "three";

type Property = "quaternion" | "position" | "scale" | "morph";

interface Entry {
  node: THREE.Object3D;
  property: Property;
  index: number;
  interpolant: THREE.Interpolant;
}

/**
 * 单片段绝对姿势覆盖层。
 *
 * 用于“持盆”这类只包含右臂骨骼轨道的片段：mixer 按权重混合无法让某一层完全赢过
 * 基础层，所以在 mixer 求值之后直接写入这些骨骼，其它骨骼保持 idle/walk 的结果。
 */
export class PoseOverlay {
  private readonly entries: Entry[] = [];
  readonly duration: number;

  constructor(root: THREE.Object3D, clip: THREE.AnimationClip) {
    this.duration = clip.duration;
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const node = THREE.PropertyBinding.findNode(root, parsed.nodeName) as THREE.Object3D | null;
      if (!node) continue;
      const size = track.getValueSize();
      const interpolant =
        track instanceof THREE.QuaternionKeyframeTrack
          ? new THREE.QuaternionLinearInterpolant(track.times, track.values, size)
          : new THREE.LinearInterpolant(track.times, track.values, size);
      const morph = parsed.propertyName === "morphTargetInfluences";
      if (morph) {
        this.entries.push({ node, property: "morph", index: Number(parsed.propertyIndex ?? 0), interpolant });
        continue;
      }
      if (parsed.propertyName !== "quaternion" && parsed.propertyName !== "position" && parsed.propertyName !== "scale") continue;
      this.entries.push({ node, property: parsed.propertyName, index: 0, interpolant });
    }
  }

  get trackCount(): number {
    return this.entries.length;
  }

  apply(time: number) {
    const t = this.duration > 0 ? time % this.duration : 0;
    for (const entry of this.entries) {
      const values = entry.interpolant.evaluate(t) as Float32Array;
      if (entry.property === "quaternion") (entry.node as THREE.Bone).quaternion.fromArray(values);
      else if (entry.property === "position") entry.node.position.fromArray(values);
      else if (entry.property === "scale") entry.node.scale.fromArray(values);
      else {
        const mesh = entry.node as THREE.Mesh;
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[entry.index] = values[0];
      }
    }
  }
}
