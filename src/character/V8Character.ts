import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { enableMultiWeight } from "./multiWeight";
import { AXIS } from "./Character";

/**
 * V8 静态模型：多网格 + 外部参考姿态，没有动画片段。
 * 只用于替换模型做静态加载与表演层验证；走/跑/跳在接入动画前不可用。
 */

const norm = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "");

// Blender(Z-up) → glTF(Y-up)
const R = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const Rinv = R.clone().invert();

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _q2 = new THREE.Quaternion();

interface PoseBone {
  rest: number[];
  pose: number[];
}

function mat4(flat: number[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  m.set(flat[0], flat[1], flat[2], flat[3], flat[4], flat[5], flat[6], flat[7],
        flat[8], flat[9], flat[10], flat[11], flat[12], flat[13], flat[14], flat[15]);
  return m;
}

export class V8Character {
  readonly root = new THREE.Group();
  readonly bones = new Map<string, THREE.Bone>();
  readonly meshes: THREE.SkinnedMesh[] = [];
  readonly morphs: Record<string, number> = {};
  readonly forward = new THREE.Vector3(0, 0, 1);
  height = 1.12;

  private boneList: THREE.Bone[] = [];
  private clean: THREE.Quaternion[] = [];
  private mixer: THREE.AnimationMixer | null = null;
  private motion = new Map<string, THREE.AnimationClip>();

  private constructor(scene: THREE.Object3D, pose: { bones: Record<string, PoseBone> }) {
    this.root.add(scene);
    scene.traverse((obj) => {
      if ((obj as THREE.Bone).isBone) this.bones.set(norm(obj.name), obj as THREE.Bone);
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) this.meshes.push(mesh as THREE.SkinnedMesh);
      }
    });

    this.root.updateMatrixWorld(true);

    // 静止世界矩阵 + 参考姿态（相对静止姿态的增量，兼容导出器的骨骼轴向转换）
    const restWorld = new Map<string, THREE.Matrix4>();
    for (const [name, bone] of this.bones) restWorld.set(name, bone.matrixWorld.clone());

    const poseG = new Map<string, THREE.Matrix4>();
    for (const [name, info] of Object.entries(pose.bones)) {
      const key = norm(name);
      const restB = mat4(info.rest);
      const poseB = mat4(info.pose);
      const deltaB = new THREE.Matrix4().multiplyMatrices(poseB, restB.clone().invert());
      const deltaG = new THREE.Matrix4().multiplyMatrices(R, deltaB).multiply(Rinv);
      const w = restWorld.get(key);
      if (w) poseG.set(key, new THREE.Matrix4().multiplyMatrices(deltaG, w));
    }

    const I = new THREE.Matrix4();
    for (const [name, bone] of this.bones) {
      const g = poseG.get(name);
      if (!g) continue;
      const parentWorld = bone.parent && (bone.parent as THREE.Bone).isBone
        ? poseG.get(norm(bone.parent.name)) ?? bone.parent.matrixWorld
        : bone.parent ? bone.parent.matrixWorld : I;
      const local = new THREE.Matrix4().multiplyMatrices(parentWorld.clone().invert(), g);
      local.decompose(bone.position, bone.quaternion, bone.scale);
    }

    this.root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(scene);
    this.height = Math.max(0.1, box.max.y - box.min.y);
    this.root.position.y -= box.min.y;

    this.boneList = [...this.bones.values()];
    this.clean = this.boneList.map((b) => b.quaternion.clone());
  }

  static async load(modelUrl: string, poseUrl: string, onProgress?: (r: number) => void): Promise<V8Character> {
    const loader = new GLTFLoader();
    const [gltf, pose] = await Promise.all([
      loader.loadAsync(modelUrl, (e) => {
        if (e.total > 0) onProgress?.(e.loaded / e.total);
      }),
      fetch(poseUrl).then((r) => r.json()),
    ]);
    const character = new V8Character(gltf.scene, pose);
    await enableMultiWeight(gltf, character.meshes);
    return character;
  }

  getBone(name: string): THREE.Bone | undefined {
    return this.bones.get(norm(name));
  }

  rotateWorld(boneName: string, axis: THREE.Vector3, angle: number) {
    if (angle === 0) return;
    const bone = this.getBone(boneName);
    if (!bone) return;
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(_q);
    _v.copy(axis).applyQuaternion(_q.invert());
    if (_v.lengthSq() < 1e-8) return;
    _v.normalize();
    bone.quaternion.multiply(_q2.setFromAxisAngle(_v, angle));
  }

  setMorph() {
    /* 表情形态键损坏，V8 阶段不开放 */
  }

  play(): null {
    return null;
  }

  stand() {
    /* 无片段 */
  }

  get currentClipName(): string {
    return "stand";
  }

  /** 载入外部动作片段（GPT 制作的四组动作），按骨骼名绑定到当前骨架 */
  async loadMotions(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const clip of gltf.animations) this.motion.set(clip.name, clip);
  }

  get motionNames(): string[] {
    return [...this.motion.keys()];
  }

  /** 播放一个动作片段（一次性），结束后回到参考姿态 */
  playMotion(name: string, fade = 0.2) {
    const clip = this.motion.get(name);
    if (!clip || !this.mixer) return false;
    this.mixer.stopAllAction();
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;
    action.fadeIn(fade);
    action.play();
    return true;
  }

  /** 每帧恢复参考姿态 → 动作片段求值 → 表演层再叠加 */
  update(dt: number) {
    for (let i = 0; i < this.boneList.length; i++) {
      this.boneList[i].quaternion.copy(this.clean[i]);
    }
    if (this.mixer) this.mixer.update(dt);
  }

  /** 供拾取使用的可交互网格 */
  get pickables(): THREE.Object3D[] {
    return this.meshes;
  }
}

export { AXIS };
