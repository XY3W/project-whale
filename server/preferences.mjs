import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const KEYS = new Set(['preferred_name','response_language','response_style','ordinary_interest']);
export function ownerIdentity(req, res, dir) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,'owner-secret');
  let secret; try { secret=fs.readFileSync(file,'utf8'); } catch { secret=randomUUID()+randomUUID(); fs.writeFileSync(file,secret,{mode:0o600}); }
  const sign=id=>createHmac('sha256',secret).update(id).digest('hex');
  const raw=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('whale_owner='))?.slice(12)??'';
  const [id,sig]=raw.split('.');
  if (/^[a-f0-9-]{36}$/.test(id??'') && sig?.length===64 && timingSafeEqual(Buffer.from(sig),Buffer.from(sign(id)))) return id;
  const next=randomUUID(); res.setHeader('Set-Cookie',`whale_owner=${next}.${sign(next)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`); return next;
}
export function recordMessage(st,ownerScope,sessionId,role,content) {
  const msg={messageId:randomUUID(),ownerScope,sessionId,role,content:String(content).slice(0,8000),createdAt:Date.now()};
  const cutoff=Date.now()-Number(process.env.MESSAGE_RETENTION_DAYS??30)*86400000;
  st.messages=[...(st.messages??[]).filter(m=>m.createdAt>=cutoff),msg]; return msg;
}
export function propose(st,owner,proposals,allowedSources) {
  st.preferences??=[]; st.memoryRevision??={};
  let count=0;
  for (const p of Array.isArray(proposals)?proposals:[]) {
    if(count>=2)break;
    const value=String(p.value??'').trim(),quote=String(p.sourceQuote??p.source_quote??'').trim();
    const source=(st.messages??[]).find(m=>m.messageId===p.sourceMessageId && m.ownerScope===owner && m.role==='user' && allowedSources.includes(m.messageId));
    if(!KEYS.has(p.key)||!value||value.length>60||!source||!quote||!source.content.includes(quote)||!quote.includes(value))continue;
    if(/密码|密钥|身份证|病历|诊断|银行卡|银行账号|收入|余额|API.?KEY|token/i.test(quote))continue;
    if(!/我|以后|记住|叫我/.test(quote)||/如果|假如|例如|比如|他说|她说|朋友|举例|「|“|"/.test(quote))continue;
    if(st.preferences.some(m=>m.ownerScope===owner&&m.key===p.key&&m.value===value))continue;
    const explicit=/记住|以后.*(?:叫我|回答|回复|使用)|以后叫我/.test(quote);
    const confirmed=st.preferences.filter(m=>m.ownerScope===owner&&m.status==='confirmed');
    const replacing=explicit&&p.key!=='ordinary_interest'&&confirmed.some(m=>m.key===p.key);
    if(explicit&&confirmed.length>=20&&!replacing)continue;
    if(explicit && p.key!=='ordinary_interest')st.preferences=st.preferences.filter(m=>!(m.ownerScope===owner&&m.key===p.key));
    if(!explicit && st.preferences.filter(m=>m.ownerScope===owner&&m.status==='candidate').length>=20)continue;
    st.preferences.push({id:randomUUID(),ownerScope:owner,key:p.key,value,status:explicit?'confirmed':'candidate',sourceMessageId:source.messageId,sourceQuote:quote,createdAt:Date.now()});count++;
  }
}
export function editMemory(st,owner,{op,id,key,value}) {
  st.preferences??=[];st.memoryRevision??={}; st.summaries??={};
  const item=st.preferences.find(m=>m.ownerScope===owner&&m.id===id);
  if(op==='clear_history') {st.messages=(st.messages??[]).filter(m=>m.ownerScope!==owner); delete st.summaries[owner];st.memoryRevision[owner]=(st.memoryRevision[owner]??0)+1;return;}
  if(op==='clear_memory') {const values=st.preferences.filter(m=>m.ownerScope===owner).map(m=>m.value);st.messages=(st.messages??[]).filter(m=>!(m.ownerScope===owner&&values.some(v=>m.content.includes(v))));st.preferences=st.preferences.filter(m=>m.ownerScope!==owner);}
  else if(op==='delete'&&item){st.messages=(st.messages??[]).filter(m=>!(m.ownerScope===owner&&(m.messageId===item.sourceMessageId||m.content.includes(item.value))));st.preferences=st.preferences.filter(m=>m!==item);}
  else if((op==='confirm'||op==='edit')&&item){
    const next=String(value??item.value).trim();const nextKey=key??item.key;
    if(!KEYS.has(nextKey)||!next||next.length>60)throw Error('记忆字段不合法');
    if(nextKey!=='ordinary_interest')st.preferences=st.preferences.filter(m=>!(m!==item&&m.ownerScope===owner&&m.key===nextKey));
    if(item.status!=='confirmed'&&st.preferences.filter(m=>m.ownerScope===owner&&m.status==='confirmed').length>=20)throw Error('已确认记忆最多20条');
    Object.assign(item,{key:nextKey,value:next,status:'confirmed',updatedAt:Date.now()});
  } else throw Error('记忆不存在或操作不合法');
  st.memoryRevision[owner]=(st.memoryRevision[owner]??0)+1;delete st.summaries[owner];
}
export function memoryView(st,owner) {return (st.preferences??[]).filter(m=>m.ownerScope===owner).map(({ownerScope,...m})=>m);}
export function relevantMemory(st,owner) {let used=0;return memoryView(st,owner).filter(m=>{if(m.status!=='confirmed')return false;const n=JSON.stringify(m).length*.7;if(used+n>800)return false;used+=n;return true;}).map(({key,value,id})=>({key,value,id}));}
export function acceptSummary(st,owner,p,allowed) {
  if(!p||typeof p.text!=='string'||p.text.length>750||!Array.isArray(p.sourceMessageIds)||!p.sourceMessageIds.length)return;
  if(!p.sourceMessageIds.every(id=>allowed.includes(id)&&(st.messages??[]).some(m=>m.ownerScope===owner&&m.messageId===id)))return;
  st.summaries??={};st.summaries[owner]={text:p.text,sourceMessageIds:p.sourceMessageIds,derived:true,updatedAt:Date.now()};
}

/** Recent dialogue is separate from confirmed long-term preferences. */
export function recentConversation(st,owner,now=Date.now()) {
  const days=Number(process.env.MESSAGE_RETENTION_DAYS??30);
  const cutoff=now-(Number.isFinite(days)&&days>0?days:30)*86400000;
  return (st.messages??[]).filter(m=>m.ownerScope===owner&&m.createdAt>=cutoff&&['user','assistant'].includes(m.role))
    .slice(-24).map(({role,content,createdAt})=>({role,content,createdAt}));
}
