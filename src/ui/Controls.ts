import type { BrainClient } from '../brain/BrainClient';
import type { PropAudio } from '../audio/PropAudio';
export function mountControls(client:BrainClient,audio:PropAudio){
  const box=document.createElement('div');box.className='world-controls';
  const mode=document.createElement('button'),sound=document.createElement('button'),memory=document.createElement('button');
  const volume=document.createElement('input');volume.type='range';volume.min='0';volume.max='1';volume.step='.05';volume.value=String(audio.volume);volume.title='音量';volume.setAttribute('aria-label','音量');
  memory.textContent='记忆';sound.textContent='开启声音';mode.textContent='活跃10分钟';box.append(mode,sound,volume,memory);document.body.append(box);
  let current:{mode:string;expiresAt?:number;remainingMs?:number}={mode:'quiet'};
  mode.onclick=()=>client.setMode(current.mode==='active'?'quiet':'active');
  sound.onclick=async()=>{try{if(!audio.enabled)await audio.unlock();else audio.muted=!audio.muted;sound.textContent=audio.muted?'声音已静音':'关闭声音';}catch{sound.textContent='点击重试声音';}};
  volume.oninput=()=>{audio.volume=Number(volume.value);};
  setInterval(()=>{const remain=current.expiresAt?Math.max(0,current.expiresAt-Date.now()):0;mode.textContent=current.mode==='active'&&remain>0?`活跃 ${Math.ceil(remain/60000)}分钟 · 切回安静`:'活跃10分钟';},1000);
  const dialog=document.createElement('dialog');dialog.className='memory-dialog';document.body.append(dialog);
  const request=async(body?:unknown)=>{const r=await fetch('/api/memory',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();if(!r.ok)throw Error(data.error??'记忆操作失败');return data;};
  const render=async()=>{dialog.replaceChildren();const title=document.createElement('h2');title.textContent='记忆与聊天';dialog.append(title);
    const close=document.createElement('button');close.textContent='关闭';close.onclick=()=>dialog.close();dialog.append(close);
    try{const data=await request();for(const item of data.memories){const row=document.createElement('div');row.className='memory-row';const label=document.createElement('span');label.textContent=`${item.status==='confirmed'?'已记住':'待确认'} · ${item.key}`;const input=document.createElement('input');input.value=item.value;input.maxLength=60;
      const save=document.createElement('button');save.textContent=item.status==='confirmed'?'保存修改':'确认';save.onclick=async()=>{await request({op:'edit',id:item.id,value:input.value});await render();};
      const del=document.createElement('button');del.textContent='删除';del.onclick=async()=>{await request({op:'delete',id:item.id});await render();};row.append(label,input,save,del);dialog.append(row);}
      if(!data.memories.length){const empty=document.createElement('p');empty.textContent='还没有记忆。明确说“以后叫我…”可记录称呼，其他偏好需在这里确认。';dialog.append(empty);}
      for(const [op,text]of [['clear_history','清空聊天记录'],['clear_memory','清空长期记忆']]){const b=document.createElement('button');b.textContent=text;b.onclick=async()=>{await request({op});if(op==='clear_history')document.querySelector('.chat-list')?.replaceChildren();await render();};dialog.append(b);}
    }catch(err){const error=document.createElement('p');error.textContent=String(err);dialog.append(error);}
  };
  memory.onclick=()=>{dialog.showModal();void render();};
  return {updateMode(value:unknown){current=value as typeof current;},readOnly(value:boolean){mode.disabled=value;audio.allowed=!value;}};
}
