import test from 'node:test';
import assert from 'node:assert/strict';
import {recentConversation} from '../server/preferences.mjs';
test('近期对话：只显示本人的未过期用户和角色消息，最多24条',()=>{
 const now=1800000000000,day=86400000;
 const st={messages:[{ownerScope:'a',role:'user',content:'过期',createdAt:now-31*day},...Array.from({length:30},(_,i)=>({ownerScope:'a',role:i%2?'assistant':'user',content:`${i}`,createdAt:now-i})),{ownerScope:'b',role:'user',content:'别人的对话',createdAt:now},{ownerScope:'a',role:'system',content:'内部信息',createdAt:now}]};
 const messages=recentConversation(st,'a',now);assert.equal(messages.length,24);assert.equal(messages[0].content,'6');assert.equal(messages.at(-1).content,'29');
 assert.ok(messages.every(m=>!('ownerScope' in m)&&m.content!=='别人的对话'&&m.role!=='system'));
});
