import type { BrainClient } from '../brain/BrainClient';
import { attachAudioAutostart, type PropAudio } from '../audio/PropAudio';
export function mountControls(client:BrainClient,audio:PropAudio){
  const box=document.createElement('div');box.className='world-controls';
  const sound=document.createElement('button'),memory=document.createElement('button'),skillBtn=document.createElement('button');
  const volume=document.createElement('input');volume.type='range';volume.min='0';volume.max='1';volume.step='.05';volume.value=String(audio.volume);volume.title='音量';volume.setAttribute('aria-label','音量');
  const setPending=(count:number)=>{memory.textContent=count>0?`记忆 · ${count}待确认`:'记忆';};
  skillBtn.textContent='技能';skillBtn.title='查看、编辑、启停大肥鱼自己写的经验';
  setPending(0);sound.textContent='关闭声音';sound.title='声音默认开启；浏览器可能需要先点击页面';box.append(sound,volume,memory,skillBtn);document.body.append(box);
  let current:{mode:string;expiresAt?:number;remainingMs?:number}={mode:'quiet'};
  // Best effort before interaction; browsers may keep the context suspended until a gesture.
  try { void audio.prepare().catch(() => {}); } catch { /* Retry after the first interaction. */ }
  attachAudioAutostart(audio);
  sound.onclick=()=>{
    audio.muted=!audio.muted;
    sound.textContent=audio.muted?'开启声音':'关闭声音';
    sound.title=audio.muted?'点击开启声音':'点击关闭声音';
    if(!audio.muted)void audio.unlock().catch(()=>{sound.title='声音加载失败，点击页面重试';});
  };
  volume.oninput=()=>{audio.volume=Number(volume.value);};
  const dialog=document.createElement('dialog');dialog.className='memory-dialog';document.body.append(dialog);
  const request=async(body?:unknown)=>{const r=await fetch('/api/memory',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();if(!r.ok)throw Error(data.error??'记忆操作失败');return data;};
  const render=async()=>{dialog.replaceChildren();const title=document.createElement('h2');title.textContent='记忆与聊天';dialog.append(title);
    const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>dialog.close();dialog.append(close);
    try{const data=await request();setPending(data.memories.filter((m:{status:string})=>m.status==='candidate').length);
      const description=document.createElement('p');description.textContent='长期记忆保存稳定的称呼和偏好，待确认的内容需要你同意。普通聊天保存在近期对话中，并不会自动变成长期记忆。';dialog.append(description);
      const memoryHeading=document.createElement('h3');memoryHeading.textContent='长期记忆';dialog.append(memoryHeading);
      for(const item of data.memories){const row=document.createElement('div');row.className='memory-row';const label=document.createElement('span');const names:Record<string,string>={preferred_name:'称呼',response_language:'语言',response_style:'表达方式',ordinary_interest:'兴趣'};label.textContent=`${item.status==='confirmed'?'已记住':'待确认'} · ${names[item.key]??'偏好'}`;const input=document.createElement('input');input.value=item.value;input.maxLength=60;
      const save=document.createElement('button');save.textContent=item.status==='confirmed'?'保存修改':'确认';save.onclick=async()=>{await request({op:'edit',id:item.id,value:input.value});await render();};
      const del=document.createElement('button');del.textContent='删除';del.onclick=async()=>{await request({op:'delete',id:item.id});await render();};row.append(label,input,save,del);dialog.append(row);}
      if(!data.memories.length){const empty=document.createElement('p');empty.textContent='还没有长期记忆。可以说“以后叫我小蓝”或“我喜欢鲸鱼”，如果提取到偏好候选，会在这里等待确认。';dialog.append(empty);}
      const recentHeading=document.createElement('h3');recentHeading.textContent='近期对话';dialog.append(recentHeading);
      const summary=data.conversationSummary;if(typeof summary==='string'&&summary){const note=document.createElement('p');note.textContent=`对话摘要：${summary}`;dialog.append(note);}
      const recent=Array.isArray(data.recentConversation)?data.recentConversation:[];
      if(!recent.length){const empty=document.createElement('p');empty.textContent='还没有近期对话。';dialog.append(empty);}
      const list=document.createElement('div');list.className='memory-conversation';
      for(const item of recent){if(!['user','assistant'].includes(item.role)||typeof item.content!=='string')continue;
        const row=document.createElement('p');row.textContent=`${item.role==='user'?'你':'大肥鱼'}：${item.content}`;list.append(row);}
      dialog.append(list);
      for(const [op,text]of [['clear_history','清空聊天记录'],['clear_memory','清空长期记忆']]){const b=document.createElement('button');b.textContent=text;b.onclick=async()=>{await request({op});if(op==='clear_history')document.querySelector('.chat-list')?.replaceChildren();await render();};dialog.append(b);}
    }catch(err){const error=document.createElement('p');error.textContent=String(err);dialog.append(error);}
  };
  // ---- 技能管理：列表 / 新建 / 编辑 / 启停 / 删除（删除只在这里有） ----
  type Skill = { id:string; title:string; trigger:string; body:string; status:string; version:number; kind?:string; script?:string; usage?:{injected?:number;succeeded?:number;failed?:number} };
  let skillCache: { skills: Skill[]; stats: { enabled:number; disabled:number; max:number } } = { skills: [], stats: { enabled:0, disabled:0, max:100 } };
  const skillDialog=document.createElement('dialog');skillDialog.className='memory-dialog skill-dialog';document.body.append(skillDialog);
  const el=(tag:string,cls?:string,text?:string)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const renderSkills=()=>{
    skillDialog.replaceChildren();
    const head=el('h2',undefined,`技能 · 启用 ${skillCache.stats.enabled}/${skillCache.stats.max}（停用 ${skillCache.stats.disabled}）`);
    const close=el('button',undefined,'关闭');close.onclick=()=>skillDialog.close();
    skillDialog.append(head,close);
    skillDialog.append(el('p',undefined,'这些是她自己写的经验：标题和用途会进 system prompt，正文只在用到时读取。她可以自己新建/修改/停用；删除只在 here 由你操作。'));
    for(const skill of skillCache.skills){
      const row=el('div','skill-row');
      const on=skill.status==='enabled';
      const kindTag = skill.kind==='script' ? ' 〔脚本〕' : '';
      const head2=el('div','skill-head',`${on?'🟢':'⚪'} ${skill.title}${kindTag}${on?'':'（已停用）'} · v${skill.version}`);
      const trig=el('div','skill-trigger',`用途：${skill.trigger}`);
      const use=skill.usage??{};
      const stat=el('div','skill-stat',`读取 ${use.injected??0} 次 · 成功 ${use.succeeded??0} / 失败 ${use.failed??0}`);
      const bodyEl=el('pre','skill-body',skill.body);
      const scriptEl = skill.kind==='script' ? el('pre','skill-body skill-script',`脚本：\n${skill.script ?? ''}`) : null;
      const actions=el('div','skill-actions');
      const toggle=el('button',undefined,on?'停用':'启用');
      toggle.onclick=()=>{client.setSkill(skill.id,!on);setTimeout(()=>client.getSkills(),200);};
      const edit=el('button','disclosure-btn','收起详情 ⌃');edit.setAttribute('aria-expanded','true');edit.onclick=()=>{const hide=bodyEl.style.display!=='none';bodyEl.style.display=hide?'none':'block';if(scriptEl)scriptEl.style.display=hide?'none':'block';edit.textContent=hide?'展开详情 ⌄':'收起详情 ⌃';edit.setAttribute('aria-expanded',String(!hide));};
      const del=el('button',undefined,'删除');
      del.onclick=()=>{if(!confirm(`确定删除「${skill.title}」？她以后不能再调用它。`))return;client.deleteSkill(skill.id);setTimeout(()=>client.getSkills(),200);};
      actions.append(toggle,edit,del);
      row.append(head2,trig,stat,bodyEl);
      if(scriptEl) row.append(scriptEl);
      row.append(actions);
      skillDialog.append(row);
    }
    // 新建表单
    const form=el('div','skill-new');
    const t=document.createElement('input');t.placeholder='名称（≤24字）';t.maxLength=24;
    const g=document.createElement('input');g.placeholder='什么时候用（≤40字）';g.maxLength=40;
    const b=document.createElement('textarea');b.placeholder='正文：具体步骤、注意什么（≤2000字）';b.maxLength=2000;b.rows=4;
    const isScript=document.createElement('input');isScript.type='checkbox';
    const isScriptLabel=el('label','skill-kind','脚本型（可在沙箱里执行）');isScriptLabel.prepend(isScript);
    const scriptBox=document.createElement('textarea');scriptBox.placeholder='脚本：用 input 读入参，用 emit(value) 返回结果；没有文件/网络权限';scriptBox.rows=5;scriptBox.maxLength=3000;scriptBox.style.display='none';
    isScript.onchange=()=>{scriptBox.style.display=isScript.checked?'block':'none';};
    const add=el('button',undefined,'新建技能');
    add.onclick=()=>{
      if(!t.value.trim()||!g.value.trim()||!b.value.trim()){alert('名称、用途、说明都要填');return;}
      if(isScript.checked&&!scriptBox.value.trim()){alert('脚本型需要填脚本');return;}
      client.saveSkill({title:t.value,trigger:g.value,body:b.value,kind:isScript.checked?'script':'text',script:isScript.checked?scriptBox.value:undefined});
      t.value=g.value=b.value='';scriptBox.value='';isScript.checked=false;scriptBox.style.display='none';
      setTimeout(()=>client.getSkills(),250);
    };
    form.append(el('h3',undefined,'新建一条'),t,g,b,isScriptLabel,scriptBox,add);
    skillDialog.append(form);
  };
  skillBtn.onclick=()=>{skillDialog.showModal();renderSkills();client.getSkills();};
  const onSkills=(payload:unknown)=>{const data=payload as {skills?:Skill[];stats?:typeof skillCache.stats}|undefined;if(!data?.skills)return;skillCache={skills:data.skills,stats:data.stats??skillCache.stats};if(skillDialog.open)renderSkills();};
  client.onSkills(onSkills);

  memory.onclick=()=>{dialog.showModal();void render();};
  void request().then(data=>setPending(data.memories.filter((m:{status:string})=>m.status==='candidate').length)).catch(()=>{});
  return {updatePending:setPending,updateMode(value:unknown){current=value as typeof current;},readOnly(value:boolean){sound.disabled=value;memory.disabled=value;skillBtn.disabled=value;audio.allowed=!value;}};
}
