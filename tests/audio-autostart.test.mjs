import test from 'node:test';
import assert from 'node:assert/strict';
import { PropAudio,attachAudioAutostart } from '../src/audio/PropAudio.ts';

let current,starts=0;
class FakeAudioContext {
  state='suspended';currentTime=0;destination={};resumeCount=0;
  constructor(){current=this;}
  resume(){this.resumeCount++;this.state='running';return Promise.resolve();}
  decodeAudioData(){return Promise.resolve({});}
  createBufferSource(){return {playbackRate:{value:1},connect(){return this;},disconnect(){},start(){starts++},stop(){}};}
  createGain(){return {gain:{value:0,setTargetAtTime(){}},connect(){return this;},disconnect(){}};}
}
globalThis.AudioContext=FakeAudioContext;
globalThis.document={hidden:false};
globalThis.fetch=async url=>({ok:true,json:async()=>({eventGroups:{basin_floor:{files:['basin_collision_01.wav','basin_collision_02.wav']},metal_knock:{files:['metal_knock_01.wav']}}}),arrayBuffer:async()=>new ArrayBuffer(1)});

test('默认开启：首次页面交互解锁，未解锁的旧事件不会补播',async()=>{
 const audio=new PropAudio(),target=new EventTarget();
 assert.equal(audio.enabled,true);assert.equal(audio.muted,false);
 const loaded=audio.prepare();const detach=attachAudioAutostart(audio,target);
 audio.play('knock','before');assert.equal(starts,0);
 target.dispatchEvent(new Event('pointerdown'));await loaded;await Promise.resolve();
 assert.equal(current.resumeCount,1);assert.equal(starts,0);
 audio.play('knock','after');assert.equal(starts,1);
 audio.play('knock','after');assert.equal(starts,1);
 audio.muted=true;target.dispatchEvent(new Event('keydown'));audio.play('knock','muted');assert.equal(starts,1);
 detach();
});

test('第一次加载失败后，下次交互可重试',async()=>{
 const previousFetch=globalThis.fetch;let requests=0;
 globalThis.fetch=async url=>{requests++;if(requests===1)throw Error('offline');return previousFetch(url);};
 try{const audio=new PropAudio();await assert.rejects(audio.prepare());await audio.unlock();audio.play('knock','retry');assert.equal(starts,2);}finally{globalThis.fetch=previousFetch;}
});
