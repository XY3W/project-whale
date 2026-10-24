import * as THREE from 'three';
/** Baked poses only. Locomotion transitions are authored; no runtime bone solving. */
export class LayeredMotionPlayer {
    mixer;
    actions = new Map();
    walking = false;
    base = 'idle_stand';
    baseTime = 0;
    upper = null;
    upperWeight = 0;
    upperEnding = false;
    queuedUpper = null;
    tail = 'tail_idle';
    tailMix = 0;
    rate = 1;
    /** Distance in metres advanced by the most recent update. Apply along character forward. */
    movementDelta = 0;
    get speed() { return this.rate; }
    set speed(value) { this.rate = THREE.MathUtils.clamp(value, .75, 1.25); }
    constructor(root, clips) {
        this.mixer = new THREE.AnimationMixer(root);
        for (const clip of clips) {
            const a = this.mixer.clipAction(clip);
            a.setEffectiveWeight(0);
            a.play();
            if (['greet', 'notice', 'nod', 'look_left', 'look_right'].includes(clip.name) || clip.name.startsWith('walk_start.') || clip.name.startsWith('walk_stop.')) {
                a.setLoop(THREE.LoopOnce, 1);
                a.clampWhenFinished = true;
            }
            this.actions.set(clip.name, a);
        }
        this.weights();
        this.mixer.update(0);
    }
    get(name) { const a = this.actions.get(name); if (!a)
        throw new Error(`Missing baked clip: ${name}`); return a; }
    setBase(base) {
        this.base = base;
        this.baseTime = 0;
        for (const suffix of ['lower', 'upperBase'])
            this.get(`${base}.${suffix}`).reset().play();
    }
    setWalking(value) {
        this.walking = value;
        if (value && this.base === 'idle_stand')
            this.setBase('walk_start');
        // Stop at the next left-foot landing, then use the authored gathering step.
    }
    gesture(name) {
        if (!['greet', 'notice', 'nod', 'look_left', 'look_right', 'think'].includes(name))
            throw new Error('Unknown upper action');
        if (this.upper && this.upper !== name) {
            this.queuedUpper = name;
            this.upperEnding = true;
            return;
        }
        if (this.upper === name)
            return;
        this.upper = name;
        this.upperEnding = false;
        this.get(name).reset().play().setEffectiveWeight(0);
    }
    clearGesture() { this.queuedUpper = null; this.upperEnding = true; }
    setTail(big) { this.tail = big ? 'tail_swish' : 'tail_idle'; }
    get state() { return { walking: this.walking, base: this.base, walkWeight: this.base === 'idle_stand' ? 0 : 1, upper: this.upper, upperWeight: this.upperWeight, tail: this.tail }; }
    weights() {
        for (const base of ['idle_stand', 'walk_start', 'walk', 'walk_stop']) {
            const w = base === this.base ? 1 : 0;
            this.get(`${base}.lower`).setEffectiveWeight(w).setEffectiveTimeScale(base === 'idle_stand' ? 1 : this.rate);
            this.get(`${base}.upperBase`).setEffectiveWeight(w * (1 - this.upperWeight)).setEffectiveTimeScale(base === 'idle_stand' ? 1 : this.rate);
        }
        this.get('tail_idle').setEffectiveWeight(1 - this.tailMix);
        this.get('tail_swish').setEffectiveWeight(this.tailMix);
    }
    advance(dt) {
        const approach = (v, target, duration = .25) => v + Math.sign(target - v) * Math.min(Math.abs(target - v), dt / duration);
        if (this.upper) {
            const a = this.get(this.upper);
            if (a.loop === THREE.LoopOnce && a.time >= a.getClip().duration - .25)
                this.upperEnding = true;
            this.upperWeight = approach(this.upperWeight, this.upperEnding ? 0 : 1);
            a.setEffectiveWeight(this.upperWeight);
            if (this.upperEnding && this.upperWeight <= 1e-8) {
                a.setEffectiveWeight(0);
                this.upper = null;
                this.upperWeight = 0;
                this.upperEnding = false;
                const next = this.queuedUpper;
                this.queuedUpper = null;
                if (next)
                    this.gesture(next);
            }
        }
        this.tailMix = approach(this.tailMix, this.tail === 'tail_swish' ? 1 : 0, .4);
        const old = this.baseTime;
        this.baseTime += dt * (this.base === 'idle_stand' ? 1 : this.rate);
        const distance = (time) => { const u = THREE.MathUtils.clamp(time / .8, 0, 1); return this.base === 'walk_start' ? .045 * u * u : this.base === 'walk_stop' ? .045 * (2 * u - u * u) : this.base === 'walk' ? .1125 * time : 0; };
        this.movementDelta += distance(this.baseTime) - distance(old);
        this.weights();
        this.mixer.update(dt);
    }
    update(dt) {
        this.movementDelta = 0;
        let remaining = Math.max(0, dt);
        while (remaining > 1e-9) {
            const duration = this.base === 'walk' ? 1.6 : this.base === 'idle_stand' ? Infinity : .8;
            const until = (duration - this.baseTime) / this.rate;
            const step = Math.min(remaining, Math.max(0, until));
            if (step > 0) {
                this.advance(step);
                remaining -= step;
            }
            if (this.baseTime >= duration - 1e-8) {
                if (this.base === 'walk_stop')
                    this.setBase(this.walking ? 'walk_start' : 'idle_stand');
                else if (this.walking)
                    this.setBase('walk');
                else
                    this.setBase('walk_stop');
                this.weights();
                this.mixer.update(0);
            }
        }
    }
}
