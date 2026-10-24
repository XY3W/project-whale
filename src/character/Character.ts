import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

type BoneMap = Map<string, THREE.Bone>;
type MorphMap = Record<string, number>;

/** three.js 的 GLTFLoader 会清洗节点名（去掉点号等），这里做归一化查找 */
const norm = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "");

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _q2 = new THREE.Quaternion();

export const AXIS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/**
 * 角色：一个 GLB、一套骨架、若干动画片段、5 个表情 morph。
 *
 * 设计要点：所有"叠加动作"都在 mixer 求值之后逐帧乘进骨骼，
 * 这样 LLM（或规则导演）给出的意图可以叠加在走路/跳跃之上，
 * 而不是互相覆盖。
 */
export class Character {
  readonly root = new THREE.Group();
  readonly bones: BoneMap = new Map();
  readonly morphs: MorphMap = {};
  readonly mixer: THREE.AnimationMixer;
  readonly clips = new Map<string, THREE.AnimationClip>();
  readonly actions = new Map<string, THREE.AnimationAction>();

  mesh!: THREE.SkinnedMesh;
  height = 1.12;
  /** 角色面向（水平方向，来自脚踝→脚尖），用于视线换算 */
  readonly forward = new THREE.Vector3(0, 0, 1);

  private current: THREE.AnimationAction | null = null;
  private readonly missingBones = new Set<string>();
  private boneList: THREE.Bone[] = [];
  private clean: THREE.Quaternion[] = [];

  private constructor(scene: THREE.Object3D, animations: THREE.AnimationClip[]) {
    this.root.add(scene);
    this.mixer = new THREE.AnimationMixer(scene);

    scene.traverse((obj) => {
      if ((obj as THREE.Bone).isBone) {
        this.bones.set(norm(obj.name), obj as THREE.Bone);
      }
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
          this.mesh = mesh as THREE.SkinnedMesh;
        }
      }
    });

    const dict = this.mesh.morphTargetDictionary ?? {};
    for (const [name, index] of Object.entries(dict)) this.morphs[name] = index;

    for (const clip of animations) this.clips.set(clip.name, clip);

    for (const [name, clip] of this.clips) {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      if (name === "jump") {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
      }
      this.actions.set(name, action);
    }

    // 静止站姿：取慢走动画里手臂最自然的相位。
    //
    // 这份资产的绑定姿态是 T-Pose；跳跃首帧是蓄力姿势（手臂外张、肘部前顶），
    // 拿来当待机会让手显得很怪。而走路时手臂是自然下垂的，腿又基本被长裙挡住，
    // 所以借用一个中间相位当站姿最省事。
    const baseClip = this.clips.get("walk") ?? [...this.clips.values()][0];
    if (baseClip) {
      const t = 0.6;
      for (const track of baseClip.tracks) {
        const dot = track.name.lastIndexOf(".");
        const prop = track.name.slice(dot + 1);
        if (prop !== "quaternion" && prop !== "position" && prop !== "scale") continue;
        const boneName = norm(track.name.slice(0, dot));
        // 腿部保持绑定姿态：走路的相位里有抬腿，会让人悬空站着。
        // 长裙本来就把腿挡住了，直立反而更自然。
        if (/^(c_thigh|thigh|c_leg|leg_|foot|toes|c_root|rootx|c_kilt|kilt|Skirt)/i.test(boneName)) continue;
        const bone = this.bones.get(boneName);
        if (!bone) continue;
        const times = track.times;
        let idx = 0;
        for (let i = 1; i < times.length; i++) {
          if (Math.abs(times[i] - t) < Math.abs(times[idx] - t)) idx = i;
        }
        const size = track.getValueSize();
        const off = idx * size;
        // 位置/缩放也要采样：手臂的扭转与拉伸辅助骨靠它们工作，
        // 只抄旋转会让手腕、上臂看起来是拧着的。
        if (prop === "quaternion" && size === 4) bone.quaternion.fromArray(track.values as Float32Array, off);
        else if (prop === "position" && size === 3) bone.position.fromArray(track.values as Float32Array, off);
        else if (prop === "scale" && size === 3) bone.scale.fromArray(track.values as Float32Array, off);
      }
    }

    // 动画姿态缓存：mixer 求值后、叠加表演层之前的"干净"姿势。
    this.boneList = [...this.bones.values()];
    this.clean = this.boneList.map((bone) => bone.quaternion.clone());

    this.mixer.addEventListener("finished", (event) => {
      const action = (event as unknown as { action: THREE.AnimationAction }).action;
      if (action === this.current) this.stand(0.25);
    });
  }

  static async load(url: string, onProgress?: (ratio: number) => void): Promise<Character> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url, (event) => {
      if (event.total > 0) onProgress?.(event.loaded / event.total);
    });

    const character = new Character(gltf.scene, gltf.animations);

    const box = new THREE.Box3().setFromObject(gltf.scene);
    character.height = Math.max(0.1, box.max.y - box.min.y);
    character.root.position.y -= box.min.y;
    character.computeForward();

    return character;
  }

  private computeForward() {
    const foot = this.getBone("foot.l") ?? this.getBone("foot.r");
    const toe = this.getBone("toes_01.l") ?? this.getBone("toes_01.r");
    if (!foot || !toe) return;
    this.root.updateMatrixWorld(true);
    const a = foot.getWorldPosition(new THREE.Vector3());
    const b = toe.getWorldPosition(new THREE.Vector3());
    const dir = b.sub(a).setY(0);
    if (dir.lengthSq() > 1e-8) this.forward.copy(dir.normalize());
  }

  /** 淡入某个片段；当前片段同时淡出，淡出到 0 后姿势自然回到绑定位。 */
  play(name: string, fade = 0.45): THREE.AnimationAction | null {
    const next = this.actions.get(name);
    if (!next) return null;
    if (this.current === next && next.isRunning()) return next;

    if (this.current && this.current !== next) this.current.fadeOut(fade);

    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.fadeIn(fade);
    next.play();

    this.current = next;
    return next;
  }

  /** 淡出当前片段，回到静止站姿。 */
  stand(fade = 0.45) {
    if (!this.current) return;
    this.current.fadeOut(fade);
    this.current = null;
  }

  listBones(): string[] {
    return [...this.bones.keys()];
  }

  get currentClipName(): string {
    return this.current?.getClip().name ?? "stand";
  }

  /**
   * 在骨骼局部空间叠加一个"世界轴"旋转。
   * 做法：把世界轴换算到该骨骼当前的局部坐标系，再右乘。
   * 这样调用方只需要关心"绕世界上方转 5 度"，不用管骨骼朝向。
   */
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

  getBone(name: string): THREE.Bone | undefined {
    const bone = this.bones.get(norm(name));
    if (!bone && !this.missingBones.has(name)) {
      this.missingBones.add(name);
      console.warn(`[rig] 找不到骨骼: ${name}`);
    }
    return bone;
  }

  /** 直接设置表情权重（0–1）。 */
  setMorph(name: string, value: number) {
    const index = this.morphs[name];
    if (index === undefined) return;
    const influences = this.mesh.morphTargetInfluences;
    if (!influences) return;
    influences[index] = THREE.MathUtils.clamp(value, 0, 1);
  }

  /**
   * 每帧先把骨骼恢复到"纯动画姿态"，再让 mixer 求值，最后缓存结果。
   *
   * 为什么需要这一步：three 的 PropertyMixer 只在片段值发生变化时才写回骨骼
   * （PropertyMixer.apply 里的比较），所以静止片段不会每帧重置骨骼。
   * 不手动还原，表演层的叠加旋转就会一帧帧累积，头会越转越多。
   */
  update(dt: number) {
    const bones = this.boneList;
    for (let i = 0; i < bones.length; i++) bones[i].quaternion.copy(this.clean[i]);
    this.mixer.update(dt);
    for (let i = 0; i < bones.length; i++) this.clean[i].copy(bones[i].quaternion);
  }
}
