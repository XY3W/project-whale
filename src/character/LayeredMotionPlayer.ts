import * as THREE from 'three';
import { PoseOverlay } from './PoseOverlay';


export interface PerformanceEvent {
  time: number;
  type: string;
}

type Performance = {
  name: string;
  action: THREE.AnimationAction;
  events: PerformanceEvent[];
  next: number;
  onEvent: (type: string) => void;
  ending: boolean;
  cancelled: boolean;
  fade: number;
  layer: string;
  resolve: (completed: boolean) => void;
};

const PERF_FADE = 0.15;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (u: number) => 3 * u * u - 2 * u * u * u;

/** 基础位移片段：时长与位移曲线来自资产交付（catalog.locomotion） */
export const MOVE_CLIPS: Record<string, { duration: number; distance: (t: number) => number }> = {
  walk_start: { duration: 0.8, distance: (t) => 0.045 * clamp01(t / 0.8) ** 2 },
  walk: { duration: 1.6, distance: (t) => 0.1125 * t },
  walk_stop: { duration: 0.8, distance: (t) => 0.045 * (2 * clamp01(t / 0.8) - clamp01(t / 0.8) ** 2) },
  run_start: { duration: 0.4, distance: (t) => 0.08 * clamp01(t / 0.4) ** 2 },
  run: { duration: 0.8, distance: (t) => 0.4 * t },
  run_stop: { duration: 0.4, distance: (t) => 0.064 * (2 * clamp01(t / 0.4) - clamp01(t / 0.4) ** 2) },
  walk_adjust_02: { duration: 0.8, distance: (t) => 0.02 * smoothstep(clamp01(t / 0.8)) },
  walk_adjust_04: { duration: 0.8, distance: (t) => 0.04 * smoothstep(clamp01(t / 0.8)) },
  walk_adjust_06: { duration: 0.8, distance: (t) => 0.06 * smoothstep(clamp01(t / 0.8)) },
  walk_adjust_08: { duration: 0.8, distance: (t) => 0.08 * smoothstep(clamp01(t / 0.8)) },
};

export const ADJUST_DISTANCES = [0.02, 0.04, 0.06, 0.08];
/** run 的合法距离：0.144 + 0.32N（N=1..11） */
export const RUN_DISTANCES = Array.from({ length: 11 }, (_, i) => Math.round((0.144 + 0.32 * (i + 1)) * 1000) / 1000);
const BASE_CLIPS = ['idle_stand','walk_start','walk','walk_stop','run_start','run','run_stop',
  'walk_adjust_02','walk_adjust_04','walk_adjust_06','walk_adjust_08'];
type MoveKind = 'walk' | 'run' | 'adjust';

/** Baked poses only. Locomotion transitions are authored; no runtime bone solving. */
export class LayeredMotionPlayer {
  readonly mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private base = 'idle_stand';
  private baseTime = 0;
  private moveKind: MoveKind | null = null;
  private cyclesLeft = 0;
  private halted = false;
  private upper: string | null = null;
  private upperWeight = 0;
  private upperEnding = false;
  private queuedUpper: string | null = null;
  private tail = 'tail_idle';
  private tailMix = 0;
  private rate = 1;
  private perf: Performance | null = null;
  private holds = new Map<string, { overlay: PoseOverlay; enabled: boolean; time: number }>();
  private soloAction: THREE.AnimationAction | null = null;
  private soloName: string | null = null;
  private soloPaused = false;
  private soloLoop = false;
  /** Distance in metres advanced by the most recent update. Apply along character forward. */
  movementDelta = 0;
  /** 调试用：这一帧持仓层实际作用/让位了哪些槽位 */
  holdStats: { applied: string[]; skipped: string[]; layer: string | null } = { applied: [], skipped: [], layer: null };
  get speed() { return this.rate; }
  set speed(value: number) { this.rate = THREE.MathUtils.clamp(value, .75, 1.25); }
  constructor(private readonly root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const clip of clips) {
      const a = this.mixer.clipAction(clip); a.setEffectiveWeight(0); a.play();
      if (['greet', 'notice', 'nod', 'look_left', 'look_right'].includes(clip.name) || clip.name.startsWith('walk_start.') || clip.name.startsWith('walk_stop.')) {
        a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
      }
      this.actions.set(clip.name, a);
    }
    this.weights(); this.mixer.update(0);
  }
  private get(name: string) { const a = this.actions.get(name); if (!a) throw new Error(`Missing baked clip: ${name}`); return a; }
  private setBase(base: string) {
    this.base = base; this.baseTime = 0;
    for (const suffix of ['lower','upperBase']) this.actions.get(`${base}.${suffix}`)?.reset().play();
  }
  private baseDistance(time: number): number {
    const spec = MOVE_CLIPS[this.base];
    return spec ? spec.distance(time) : 0;
  }
  private get baseDuration(): number {
    const spec = MOVE_CLIPS[this.base];
    return spec ? spec.duration : Infinity;
  }

  get moving(): boolean { return this.moveKind !== null; }

  /** 精确走：只接受 0.09 + 0.18n 米，返回是否接受 */
  walkDistance(meters: number): boolean {
    if (this.perf) return false;
    if (this.soloAction) this.stopSolo();
    const n = Math.round((meters - 0.09) / 0.18);
    if (!Number.isFinite(meters) || n < 0 || n > 10) return false;
    if (Math.abs(0.09 + 0.18 * n - meters) > 1e-6) return false;
    if (this.moveKind) return false;
    this.moveKind = 'walk';
    this.halted = false;
    // n 是完整步周期数：起步之后要真的走满 n 圈，n=0（0.09m）直接收步
    this.cyclesLeft = n;
    this.setBase('walk_start');
    return true;
  }

  /** 跑动：距离必须是 0.144 + 0.32N，起步/收步固定在片段首尾 */
  runDistance(meters: number): boolean {
    if (this.perf) return false;
    if (this.soloAction) this.stopSolo();
    if (!Number.isFinite(meters) || this.moveKind) return false;
    const n = Math.round((meters - 0.144) / 0.32);
    if (n < 1 || n > 11) return false;
    if (Math.abs(0.144 + 0.32 * n - meters) > 1e-6) return false;
    this.moveKind = 'run';
    this.halted = false;
    this.cyclesLeft = n;
    this.setBase('run_start');
    return true;
  }

  /** 短步微调：0.02 / 0.04 / 0.06 / 0.08 米，一次一段 */
  adjustDistance(meters: number): boolean {
    if (this.perf) return false;
    if (this.soloAction) this.stopSolo();
    if (!Number.isFinite(meters) || this.moveKind) return false;
    const match = ADJUST_DISTANCES.find((d) => Math.abs(d - meters) < 1e-9);
    if (match === undefined) return false;
    this.moveKind = 'adjust';
    this.halted = false;
    this.cyclesLeft = 0;
    this.setBase(`walk_adjust_${String(Math.round(match * 100)).padStart(2, '0')}`);
    return true;
  }

  /** 立即禁止继续世界位移（取消/失去执行权），动画仍安全收势 */
  haltMovement() {
    this.halted = true;
    this.moveKind = null;
    this.clearGesture();
  }

  setWalking(value: boolean) {
    if (this.perf) return;
    if (!value) this.haltMovement();
    else if (!this.moveKind && this.base === 'idle_stand') { this.moveKind = 'walk'; this.cyclesLeft = Infinity; this.setBase('walk_start'); }
  }
  gesture(name: string) {
    if (this.perf) return;
    if (!['greet','notice','nod','look_left','look_right','think'].includes(name)) throw new Error('Unknown upper action');
    if (this.upper && this.upper !== name) { this.queuedUpper=name; this.upperEnding=true; return; }
    if (this.upper === name) return;
    this.upper=name; this.upperEnding=false; this.get(name).reset().play().setEffectiveWeight(0);
  }
  clearGesture() { this.queuedUpper=null; this.upperEnding=true; }
  setTail(big: boolean) { this.tail=big?'tail_swish':'tail_idle'; }

  /** 持物层：slot 用 catalog 的 left_hand / right_hand / head */
  setHold(slot: string, clip: THREE.AnimationClip | null) {
    if (!clip) { this.holds.delete(slot); return; }
    this.holds.set(slot, { overlay: new PoseOverlay(this.root, clip), enabled: true, time: 0 });
  }
  /** 兼容旧调用：setHoldEnabled(true/false) 等价于控制左手持物层 */
  setHoldEnabled(slotOrEnabled: string | boolean, maybeEnabled?: boolean) {
    const slot = typeof slotOrEnabled === 'string' ? slotOrEnabled : 'left_hand';
    const enabled = typeof slotOrEnabled === 'boolean' ? slotOrEnabled : !!maybeEnabled;
    const hold = this.holds.get(slot);
    if (!hold) return;
    hold.enabled = enabled;
    if (!enabled) hold.time = 0;
  }
  /** 兼容旧调用：当前左手持物层的片段名与轨道数 */
  setHoldClip(clip: THREE.AnimationClip | null) { this.setHold('left_hand', clip); }
  get holdEnabled(): boolean { return this.holds.get('left_hand')?.enabled ?? false; }
  get holdTrackCount(): number { return this.holds.get('left_hand')?.overlay.trackCount ?? 0; }
  get holdSlots(): string[] { return [...this.holds.keys()]; }

  /**
   * 播放一次性全身互动片段（拾取/戴上/取下/投掷/挖掘）。
   * 片段独占身体骨骼；事件在精确时刻触发，掉帧跨过事件也会补发一次。
   * layer 来自 catalog：full_except_left_arm 时右手持物层继续生效，反之亦然。
   */
  perform(name: string, events: PerformanceEvent[], onEvent: (type: string) => void, layer = 'full_body'): Promise<boolean> {
    const action = this.actions.get(name);
    if (!action) return Promise.resolve(false);
    if (this.perf) return Promise.resolve(false);
    if (this.soloAction) this.stopSolo();
    this.clearGesture();
    this.moveKind = null;
    this.halted = false;
    for (const base of BASE_CLIPS) {
      for (const suffix of ['lower','upperBase']) this.actions.get(`${base}.${suffix}`)?.setEffectiveWeight(0);
    }
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.play();
    const sorted = [...events].sort((a, b) => a.time - b.time);
    return new Promise<boolean>((resolve) => {
      this.perf = { name, action, events: sorted, next: 0, onEvent, ending: false, cancelled: false, fade: 1, layer, resolve };
      this.weights();
      this.mixer.update(0);
    });
  }

  /** 取消当前互动片段：淡出后按未完成收尾 */
  cancelPerformance(): boolean {
    if (!this.perf || this.perf.ending) return false;
    this.perf.cancelled = true;
    this.perf.ending = true;
    return true;
  }

  get performing(): string | null { return this.perf?.name ?? null; }
  get performanceTime(): number { return this.perf?.action.time ?? 0; }
  get performanceEnding(): boolean { return this.perf?.ending ?? false; }
  get performanceLayer(): string | null { return this.perf?.layer ?? null; }

  /**
   * 调试用：独占播放任意片段，不经过分层状态机。
   */
  soloClip(name: string, options: { loop?: boolean; time?: number } = {}): boolean {
    const action = this.actions.get(name);
    if (!action) return false;
    if (this.perf) {
      const running = this.perf;
      this.perf = null;
      running.action.stop();
      running.action.setEffectiveWeight(0);
      running.resolve(false);
    }
    for (const base of BASE_CLIPS) {
      for (const suffix of ['lower','upperBase']) this.actions.get(`${base}.${suffix}`)?.setEffectiveWeight(0);
    }
    if (this.upper) this.get(this.upper).setEffectiveWeight(0);
    this.get('tail_idle').setEffectiveWeight(0);
    this.get('tail_swish').setEffectiveWeight(0);
    this.upper = null;
    this.upperWeight = 0;
    this.moveKind = null;
    if (this.soloAction && this.soloAction !== action) {
      this.soloAction.stop();
      this.soloAction.setEffectiveWeight(0);
    }
    this.soloLoop = options.loop ?? false;
    action.reset();
    action.setLoop(this.soloLoop ? THREE.LoopRepeat : THREE.LoopOnce, this.soloLoop ? Infinity : 1);
    action.clampWhenFinished = !this.soloLoop;
    action.enabled = true;
    action.paused = false;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.time = options.time ?? 0;
    action.play();
    this.soloAction = action;
    this.soloName = name;
    this.soloPaused = false;
    this.mixer.update(0);
    return true;
  }

  stopSolo() {
    if (this.soloAction) {
      this.soloAction.stop();
      this.soloAction.setEffectiveWeight(0);
    }
    this.soloAction = null;
    this.soloName = null;
    this.soloPaused = false;
    this.weights();
    this.mixer.update(0);
  }

  setSoloTime(time: number) {
    if (!this.soloAction) return;
    const duration = this.soloAction.getClip().duration;
    this.soloAction.time = THREE.MathUtils.clamp(time, 0, duration);
    this.soloPaused = true;
    this.soloAction.paused = true;
    this.soloAction.setEffectiveWeight(1);
    this.mixer.update(0);
  }

  setSoloPaused(paused: boolean) {
    this.soloPaused = paused;
    if (this.soloAction) this.soloAction.paused = paused;
  }

  get solo(): { name: string; time: number; duration: number; paused: boolean; loop: boolean } | null {
    if (!this.soloAction || !this.soloName) return null;
    return {
      name: this.soloName,
      time: this.soloAction.time,
      duration: this.soloAction.getClip().duration,
      paused: this.soloPaused,
      loop: this.soloLoop,
    };
  }

  get state() {
    return {
      walking: this.moveKind === 'walk',
      running: this.moveKind === 'run',
      base: this.base,
      walkWeight: this.base === 'idle_stand' ? 0 : 1,
      upper: this.upper,
      upperWeight: this.upperWeight,
      tail: this.tail,
      performing: this.perf?.name ?? null,
      held: [...this.holds.entries()].filter(([, h]) => h.enabled).map(([slot]) => slot),
    };
  }

  private weights() {
    const perf = this.perf;
    for (const base of BASE_CLIPS) {
      let w = base === this.base ? 1 : 0;
      if (perf) w *= perf.ending ? 1 - perf.fade : 0;
      const lower = this.actions.get(`${base}.lower`);
      const upperBase = this.actions.get(`${base}.upperBase`);
      lower?.setEffectiveWeight(w).setEffectiveTimeScale(base === 'idle_stand' ? 1 : this.rate);
      upperBase?.setEffectiveWeight(w * (1 - this.upperWeight)).setEffectiveTimeScale(base === 'idle_stand' ? 1 : this.rate);
    }
    if (perf) {
      perf.action.setEffectiveWeight(perf.ending ? perf.fade : 1);
      if (this.upper) this.get(this.upper).setEffectiveWeight(0);
    }
    this.get('tail_idle').setEffectiveWeight(1 - this.tailMix);
    this.get('tail_swish').setEffectiveWeight(this.tailMix);
  }

  /**
   * 动作是否接管了这只手。命名语义：full_except_left_arm = 全身动作但不含左臂，
   * 所以它接管的是**右手**。之前这里写反了，挖掘时右手的持勺姿势被覆盖，右臂偏离原动画约 36°。
   */
  private perfOwnsArm(layer: string | null, slot: string): boolean {
    if (!layer) return false;
    if (layer === 'full_body') return true;
    if (layer === 'left_arm') return slot === 'left_hand';
    if (layer === 'right_arm') return slot === 'right_hand';
    if (layer === 'full_except_left_arm') return slot === 'right_hand';
    if (layer === 'full_except_right_arm') return slot === 'left_hand';
    return false;
  }

  /** 持物层：只写各自手臂的骨骼，顺序在 mixer 之后；动作接管某只手时让位 */
  private applyHolds(dt: number) {
    const perf = this.perf;
    const layer = perf?.layer ?? null;
    this.holdStats = { applied: [], skipped: [], layer };
    for (const [slot, hold] of this.holds) {
      if (!hold.enabled) continue;
      // 收尾淡出阶段把手臂交回持仓层，避免 0.15s 淡出把持物姿势拉回 idle
      if (this.perfOwnsArm(layer, slot) && !perf!.ending) {
        this.holdStats.skipped.push(slot);
        continue;
      }
      hold.time += dt;
      hold.overlay.apply(hold.time);
      this.holdStats.applied.push(slot);
    }
  }

  private advance(dt: number) {
    const approach=(v:number,target:number,duration=.25)=>v+Math.sign(target-v)*Math.min(Math.abs(target-v),dt/duration);
    if(this.upper){
      const a=this.get(this.upper);
      if(a.loop===THREE.LoopOnce && a.time>=a.getClip().duration-.25)this.upperEnding=true;
      this.upperWeight=approach(this.upperWeight,this.upperEnding?0:1);a.setEffectiveWeight(this.upperWeight);
      if(this.upperEnding && this.upperWeight<=1e-8){a.setEffectiveWeight(0);this.upper=null;this.upperWeight=0;this.upperEnding=false;const next=this.queuedUpper;this.queuedUpper=null;if(next)this.gesture(next);}
    }
    this.tailMix=approach(this.tailMix,this.tail==='tail_swish'?1:0,.4);
    const old=this.baseTime;
    this.baseTime+=dt*(this.base==='idle_stand'?1:this.rate);
    if(!this.halted) this.movementDelta+=this.baseDistance(this.baseTime)-this.baseDistance(old);
    this.weights();this.mixer.update(dt);
  }

  /** 基础片段结束时的状态转移 */
  private completeBase() {
    const base = this.base;
    if (base === 'walk_start') { this.setBase(this.cyclesLeft > 0 ? 'walk' : 'walk_stop'); return; }
    if (base === 'run_start') { this.setBase(this.cyclesLeft > 0 ? 'run' : 'run_stop'); return; }
    if (base === 'walk' || base === 'run') {
      this.cyclesLeft--;
      // 点击地面这种连续行走用 Infinity 表示无限循环；haltMovement 之后不再续圈
      if (this.halted || this.moveKind === null) { this.setBase(base === 'walk' ? 'walk_stop' : 'run_stop'); return; }
      if (this.cyclesLeft > 0) { this.setBase(base); return; }
      this.setBase(base === 'walk' ? 'walk_stop' : 'run_stop');
      return;
    }
    this.moveKind = null;
    this.halted = false;
    this.setBase('idle_stand');
  }

  /** 互动片段推进：事件前先求值到事件时刻，再继续吃掉本帧剩余时间 */
  private advancePerformance(dt: number) {
    const perf = this.perf!;
    let remaining = Math.max(0, dt);
    if (!perf.ending) {
      const duration = perf.action.getClip().duration;
      let guard = 0;
      while (remaining > 1e-9 && guard++ < 32) {
        const event = perf.events[perf.next];
        const until = event ? Math.max(0, event.time - perf.action.time) : remaining;
        const step = Math.min(remaining, until);
        if (step > 1e-9) { this.mixer.update(step); remaining -= step; }
        if (event && perf.action.time >= event.time - 1e-6) {
          perf.next++;
          perf.onEvent(event.type);
          continue;
        }
        if (step <= 1e-9) break;
        if (perf.action.time >= duration - 1e-6) break;
      }
      if (perf.action.time >= perf.action.getClip().duration - 1e-6) {
        perf.action.paused = true;
        perf.ending = true;
      }
    } else {
      this.mixer.update(remaining);
    }
    if (perf.ending) {
      perf.fade = Math.max(0, perf.fade - dt / PERF_FADE);
      if (perf.fade <= 1e-9) {
        const { resolve, cancelled } = perf;
        perf.action.setEffectiveWeight(0);
        perf.action.paused = false;
        this.perf = null;
        this.weights();
        this.mixer.update(0);
        resolve(!cancelled);
      }
    }
    this.weights();
    this.applyHolds(dt);
  }

  update(dt: number) {
    this.movementDelta=0;
    if (this.soloAction) {
      if (!this.soloPaused) this.mixer.update(dt);
      return;
    }
    if (this.perf) { this.advancePerformance(dt); return; }
    let remaining=Math.max(0,dt);
    let guard=0;
    while(remaining>1e-9 && guard++<64){
      const duration=this.baseDuration;
      const until=Number.isFinite(duration)?(duration-this.baseTime)/this.rate:remaining;
      const step=Math.min(remaining,Math.max(0,until));
      if(step>0){this.advance(step);remaining-=step;}
      if(Number.isFinite(duration)&&this.baseTime>=duration-1e-8){
        this.completeBase();
        this.weights();this.mixer.update(0);
      }
    }
    this.applyHolds(dt);
  }
}
