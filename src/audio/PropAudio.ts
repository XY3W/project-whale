/** User-approved takes: collisions 1/2, deliberate spoon contact 3. No historical replay. */
export class PropAudio {
  private context:AudioContext|null=null;
  private buffers=new Map<string,AudioBuffer>();
  private voices:{source:AudioBufferSourceNode;gain:GainNode}[]=[];
  private seen=new Set<string>();
  private collisionPool:string[]=[];private knockPool:string[]=[];
  enabled=false;muted=false;volume=.7;allowed=true;private previous=0;
  async unlock(){
    if(!this.context)this.context=new AudioContext();
    await this.context.resume();this.enabled=true;
    const catalog=await(await fetch('/audio/basin-v3/audio_catalog.json')).json();
    const safe=(group:string)=>(catalog.eventGroups?.[group]?.files??[]).filter((file:unknown):file is string=>typeof file==='string'&&/^[A-Za-z0-9_]+\.wav$/.test(file));
    this.collisionPool=safe('basin_floor');this.knockPool=safe('metal_knock');
    await Promise.all([...new Set([...this.collisionPool,...this.knockPool])].map(async name=>{
      if(this.buffers.has(name))return;const r=await fetch(`/audio/basin-v3/${name}`);if(!r.ok)throw Error('音效加载失败');this.buffers.set(name,await this.context!.decodeAudioData(await r.arrayBuffer()));
    }));
  }
  play(kind:'collision'|'knock',id:string,strength=1){
    if(this.seen.has(id))return;this.seen.add(id);if(this.seen.size>512)this.seen.delete(this.seen.values().next().value!);
    if(!this.enabled||this.muted||!this.allowed||document.hidden||this.context?.state!=='running')return;
    let name=this.knockPool[0];if(kind==='collision'){const choices=this.collisionPool.map((_,i)=>i).filter(i=>this.collisionPool.length===1||i!==this.previous);this.previous=choices[Math.floor(Math.random()*choices.length)];name=this.collisionPool[this.previous];}
    const buffer=this.buffers.get(name);if(!buffer)return;
    const source=this.context.createBufferSource(),gain=this.context.createGain();source.buffer=buffer;source.playbackRate.value=1;
    gain.gain.value=this.volume*Math.min(1,Math.max(0,strength));source.connect(gain).connect(this.context.destination);
    if(this.voices.length>=6){const old=this.voices.shift()!;old.gain.gain.setTargetAtTime(0,this.context.currentTime,.025);old.source.stop(this.context.currentTime+.12);}
    const voice={source,gain};this.voices.push(voice);source.onended=()=>{this.voices=this.voices.filter(v=>v!==voice);source.disconnect();gain.disconnect();};source.start();
  }
}
