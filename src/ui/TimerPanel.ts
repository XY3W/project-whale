type Timer = {id:string;name:string;next_at:number;interval_seconds:number|null;skip_at:number|null;total_occurrences:number|null;occurrences:number};
export class TimerPanel {
  private timers:Timer[]=[];
  private clockOffset=0;
  private panel:HTMLDivElement;
  private list:HTMLDivElement;
  private banner:HTMLDivElement;
  constructor(private readonly skip:(id:string,at:number)=>void){
    const style=document.createElement('style');style.textContent=`
    .timer-panel{position:relative;width:100%;color:#edf4ff;font:14px/1.5 system-ui,sans-serif;pointer-events:auto}
    .timer-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid rgba(136,181,239,.24);border-radius:12px;background:rgba(94,143,207,.12);color:#d8e9ff;padding:10px 11px;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer}
    .timer-toggle:hover{background:rgba(109,164,232,.23);border-color:rgba(161,205,255,.5)}
    .timer-toggle:focus-visible,.timer-skip:focus-visible{outline:2px solid #a4d4ff;outline-offset:2px}
    .timer-chevron{width:23px;height:23px;border-radius:7px;background:rgba(125,174,234,.18);display:grid;place-items:center;font-size:15px;transition:transform .2s}
    .timer-toggle[aria-expanded="true"] .timer-chevron{transform:rotate(180deg)}
    .timer-list{max-height:28vh;overflow:auto;margin-top:8px;padding:10px 12px;border:1px solid rgba(144,185,235,.14);border-radius:12px;background:rgba(7,19,37,.55);color:#a8bdd8}
    .timer-list[hidden]{display:none}.timer-entry{padding:8px 0;border-bottom:1px solid rgba(255,255,255,.1);overflow-wrap:anywhere;color:#edf4ff}.timer-entry:last-child{border:0}.timer-meta{font-size:12px;color:#a7bedb}
    .timer-banner{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:101;max-width:min(650px,calc(100vw - 24px));max-height:30vh;overflow:auto;display:flex;flex-direction:column;gap:5px;color:white;font:15px/1.4 system-ui,sans-serif}.timer-alert{display:flex;gap:10px;align-items:center;padding:10px 14px;border:1px solid #d6a36d;border-radius:14px;background:#704326;box-shadow:0 2px 12px #0008}.timer-alert span{flex:1}.timer-alert button{white-space:nowrap}.timer-skip{border:0;border-radius:10px;background:#f4dfc4;color:#4e2c18;padding:8px 12px;font:inherit;cursor:pointer}
    `;document.head.append(style);
    this.panel=document.createElement('div');this.panel.className='timer-panel';const toggle=document.createElement('button');toggle.className='timer-toggle';this.list=document.createElement('div');this.list.className='timer-list';this.list.hidden=window.innerWidth<820;
    this.list.id='timer-task-list';toggle.setAttribute('aria-controls',this.list.id);const label=()=>{const open=!this.list.hidden;toggle.setAttribute('aria-expanded',String(open));toggle.innerHTML=`<span>◷ &nbsp;定时任务</span><span class="timer-chevron" aria-hidden="true">⌄</span>`;toggle.setAttribute('aria-label',open?'收起定时任务':'展开定时任务')};toggle.onclick=()=>{this.list.hidden=!this.list.hidden;label()};label();this.panel.append(toggle,this.list);(document.querySelector('.left-dock')??document.body).append(this.panel);this.banner=document.createElement('div');this.banner.className='timer-banner';document.body.append(this.banner);setInterval(()=>this.render(),250);this.render();
  }
  update(raw:unknown[], serverNow:number){this.clockOffset=serverNow-Date.now();this.timers=raw.filter((x):x is Timer=>!!x&&typeof x==='object'&&typeof (x as Timer).id==='string'&&Number.isFinite((x as Timer).next_at));this.render()}
  private render(){
    this.list.replaceChildren();if(!this.timers.length){this.list.textContent='暂无定时任务';}
    for(const t of this.timers){const row=document.createElement('div');row.className='timer-entry';const name=document.createElement('div');name.textContent=t.name;const meta=document.createElement('div');meta.className='timer-meta';meta.textContent=`${new Date(t.next_at).toLocaleString()} · ${t.interval_seconds ? `每 ${t.interval_seconds} 秒`:'单次'}${t.skip_at===t.next_at?' · 本次已取消':''}`;row.append(name,meta);this.list.append(row)}
    this.banner.replaceChildren();const now=Date.now()+this.clockOffset;for(const t of this.timers){const remaining=t.next_at-now;if(remaining<=0||remaining>10000||t.skip_at===t.next_at)continue;const row=document.createElement('div');row.className='timer-alert';const label=document.createElement('span');label.textContent=`${t.name}即将触发（${Math.ceil(remaining/1000)} 秒），会打断当前行为；不操作将自动触发。`;const button=document.createElement('button');button.className='timer-skip';button.textContent='取消本次';button.onclick=()=>this.skip(t.id,t.next_at);row.append(label,button);this.banner.append(row)}
  }
}
