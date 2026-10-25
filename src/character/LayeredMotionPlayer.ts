import * as THREE from 'three';
import { PoseOverlay } from './PoseOverlay';

type Base = 'idle_stand' | 'walk_start' | 'walk' | 'walk_stop';

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
  resolve: (completed: boolean) => void;
};

const PERF_FADE = 0.15;

/** Baked poses only. Locomotion transitions are authored; no runtime bone solving. */
export class LayeredMotionPlayer {
  readonly mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private walking = false;
  private base: Base = 'idle_stand';
  private baseTime = 0;
  private upper: string | null = null;
  private upperWeight = 0;
  private upperEnding = false;
  private queuedUpper: string | null = null;
  private tail = 'tail_idle';
  private tailMix = 0;
  private rate = 1;
  private cyclesLeft = -1;
  private perf: Performance | null = null;
  private soloAction: THREE.AnimationAction | null = null;
  private soloName: string | null = null;
  private soloPaused = false;
  private soloLoop = false;
  private hold: PoseOverlay | null = null;
  private holdTime = 0;
  /** Distance in metres advanced by the most recent update. Apply along character forward. */
  movementDelta = 0;
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
  private setBase(base: Base) {
    this.base = base; this.baseTime = 0;
    for (const suffix of ['lower','upperBase']) this.get(`${base}.${suffix}`).reset().play();
  }
  /** 精确走：只接受 0.09 + 0.18n 米，返回是否接受 */
  walkDistance(meters: number): boolean {
    if (this.perf) return false;
    if (this.soloAction) this.stopSolo();
    const n = Math.round((meters - 0.09) / 0.18);
    if (!Number.isFinite(meters) || n < 0 || n > 10) return false;
    if (Math.abs(0.09 + 0.18 * n - meters) > 1e-6) return false;
    // 循环边界在每圈结束时判定：n 圈需要 n-1 次“继续”
    this.cyclesLeft = n - 1;
    this.setWalking(true);
    if (n === 0) this.setWalking(false); // 起步后直接收步：0.045 + 0.045
    return true;
  }

  setWalking(value: boolean) {
    if (this.perf) return;
    this.walking = value;
    if (value && this.base === 'idle_stand') this.setBase('walk_start');
    // Stop at the next left-foot landing, then use the authored gathering step.
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

  /**
   * 播放一次性全身互动片段（拾取/戴上/取下/投掷）。
   * 片段独占身体骨骼；事件在精确时刻触发，掉帧跨过事件也会补发一次。
   */
  perform(name: string, events: PerformanceEvent[], onEvent: (type: string) => void): Promise<boolean> {
    const action = this.actions.get(name);
    if (!action) return Promise.resolve(false);
    if (this.perf) return Promise.resolve(false);
    if (this.soloAction) this.stopSolo();
    this.clearGesture();
    this.walking = false;
    for (const base of ['idle_stand','walk_start','walk','walk_stop'] as Base[]) {
      for (const suffix of ['lower','upperBase']) this.get(`${base}.${suffix}`).setEffectiveWeight(0);
    }
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.play();
    const sorted = [...events].sort((a, b) => a.time - b.time);
    return new Promise<boolean>((resolve) => {
      this.perf = { name, action, events: sorted, next: 0, onEvent, ending: false, cancelled: false, fade: 1, resolve };
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

  /**
   * 调试用：独占播放任意片段，不经过分层状态机。
   * 用于逐个检查烘焙片段本身（含 .lower/.upperBase 这类分层片段）。
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
    for (const base of ['idle_stand','walk_start','walk','walk_stop'] as Base[]) {
      for (const suffix of ['lower','upperBase']) this.get(`${base}.${suffix}`).setEffectiveWeight(0);
    }
    if (this.upper) this.get(this.upper).setEffectiveWeight(0);
    this.get('tail_idle').setEffectiveWeight(0);
    this.get('tail_swish').setEffectiveWeight(0);
    this.upper = null;
    this.upperWeight = 0;
    this.walking = false;
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

  get performing(): string | null { return this.perf?.name ?? null; }
  get performanceTime(): number { return this.perf?.action.time ?? 0; }
  get performanceEnding(): boolean { return this.perf?.ending ?? false; }

  /** 持盆循环姿态：按绝对姿势覆盖右臂骨骼（在 mixer 求值之后写入） */
  setHoldClip(clip: THREE.AnimationClip | null) {
    this.hold = clip ? new PoseOverlay(this.root, clip) : null;
    this.holdTime = 0;
  }
  get holdTrackCount(): number { return this.hold?.trackCount ?? 0; }
  setHoldEnabled(enabled: boolean) {
    if (!enabled) this.holdTime = 0;
    if (this.hold) this.holdEnabled = enabled;
  }
  holdEnabled = false;

  get state() { return {walking:this.walking,base:this.base,walkWeight:this.base==='idle_stand'?0:1,upper:this.upper,upperWeight:this.upperWeight,tail:this.tail,performing:this.perf?.name ?? null}; }
  private weights() {
    const perf = this.perf;
    for (const base of ['idle_stand','walk_start','walk','walk_stop'] as Base[]) {
      let w = base === this.base ? 1 : 0;
      if (perf) w *= perf.ending ? 1 - perf.fade : 0;
      this.get(`${base}.lower`).setEffectiveWeight(w).setEffectiveTimeScale(base==='idle_stand'?1:this.rate);
      this.get(`${base}.upperBase`).setEffectiveWeight(w*(1-this.upperWeight)).setEffectiveTimeScale(base==='idle_stand'?1:this.rate);
    }
    if (perf) {
      perf.action.setEffectiveWeight(perf.ending ? perf.fade : 1);
      if (this.upper) { this.get(this.upper).setEffectiveWeight(0); }
    }
    this.get('tail_idle').setEffectiveWeight(1-this.tailMix);this.get('tail_swish').setEffectiveWeight(this.tailMix);
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
    const old=this.baseTime;this.baseTime+=dt*(this.base==='idle_stand'?1:this.rate);
    const distance=(time:number)=>{const u=THREE.MathUtils.clamp(time/.8,0,1);return this.base==='walk_start'?.045*u*u:this.base==='walk_stop'?.045*(2*u-u*u):this.base==='walk'?.1125*time:0;};
    this.movementDelta+=distance(this.baseTime)-distance(old);this.weights();this.mixer.update(dt);
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
    if (this.hold) {
      this.holdTime += dt;
      if (this.holdEnabled) this.hold.apply(this.holdTime);
    }
  }

  update(dt: number) {
    this.movementDelta=0;
    if (this.soloAction) {
      if (!this.soloPaused) this.mixer.update(dt);
      return;
    }
    if (this.perf) { this.advancePerformance(dt); return; }
    let remaining=Math.max(0,dt);
    while(remaining>1e-9){
      const duration=this.base==='walk'?1.6:this.base==='idle_stand'?Infinity:.8;
      const until=(duration-this.baseTime)/this.rate;
      const step=Math.min(remaining,Math.max(0,until));
      if(step>0){this.advance(step);remaining-=step;}
      if(this.baseTime>=duration-1e-8){
        if(this.base==='walk_stop')this.setBase(this.walking?'walk_start':'idle_stand');
        else if(this.walking){
          if(this.base==='walk'&&this.cyclesLeft>=0){this.cyclesLeft--;if(this.cyclesLeft<0)this.walking=false;}
          this.setBase(this.walking?'walk':'walk_stop');
        }
        else this.setBase('walk_stop');
        this.weights();this.mixer.update(0);
      }
    }
    if (this.hold && this.holdEnabled) {
      this.holdTime += dt;
      this.hold.apply(this.holdTime);
    }
  }
}
