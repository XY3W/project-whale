import * as THREE from 'three';

type Base = 'idle_stand' | 'walk_start' | 'walk' | 'walk_stop';
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
  /** Distance in metres advanced by the most recent update. Apply along character forward. */
  movementDelta = 0;
  get speed() { return this.rate; }
  set speed(value: number) { this.rate = THREE.MathUtils.clamp(value, .75, 1.25); }
  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
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
    this.walking = value;
    if (value && this.base === 'idle_stand') this.setBase('walk_start');
    // Stop at the next left-foot landing, then use the authored gathering step.
  }
  gesture(name: string) {
    if (!['greet','notice','nod','look_left','look_right','think'].includes(name)) throw new Error('Unknown upper action');
    if (this.upper && this.upper !== name) { this.queuedUpper=name; this.upperEnding=true; return; }
    if (this.upper === name) return;
    this.upper=name; this.upperEnding=false; this.get(name).reset().play().setEffectiveWeight(0);
  }
  clearGesture() { this.queuedUpper=null; this.upperEnding=true; }
  setTail(big: boolean) { this.tail=big?'tail_swish':'tail_idle'; }
  get state() { return {walking:this.walking,base:this.base,walkWeight:this.base==='idle_stand'?0:1,upper:this.upper,upperWeight:this.upperWeight,tail:this.tail}; }
  private weights() {
    for (const base of ['idle_stand','walk_start','walk','walk_stop'] as Base[]) {
      const w=base===this.base?1:0;
      this.get(`${base}.lower`).setEffectiveWeight(w).setEffectiveTimeScale(base==='idle_stand'?1:this.rate);
      this.get(`${base}.upperBase`).setEffectiveWeight(w*(1-this.upperWeight)).setEffectiveTimeScale(base==='idle_stand'?1:this.rate);
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
  update(dt: number) {
    this.movementDelta=0;let remaining=Math.max(0,dt);
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
  }
}
