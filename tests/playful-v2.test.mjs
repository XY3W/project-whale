import test from 'node:test';
import assert from 'node:assert/strict';
import {validateStep} from '../server/capabilities.mjs';
import {modeView,changeMode} from '../server/behavior-mode.mjs';
import {recordMessage,propose,memoryView,relevantMemory,editMemory,acceptSummary} from '../server/preferences.mjs';
import {planningMessages} from '../server/llm.mjs';
import {estimateRequest} from '../server/context.mjs';
import {ActionExecutor} from '../src/behavior/ActionExecutor.ts';

test('敲击count严格整数1..32，不接受0/33/小数/字符串',()=>{
 for(const count of [1,10,32])assert.equal(validateStep({action:'knock_basin',object_id:'basin',tool_id:'rice_scoop',count,tempo:'normal'}).count,count);
 for(const count of [0,33,1.5,'3',NaN])assert.throws(()=>validateStep({action:'knock_basin',object_id:'basin',tool_id:'rice_scoop',count,tempo:'normal'}));
});
test('服务端与执行器都拒绝run+walk_adjust资源冲突',async()=>{
 const step={action:'parallel',items:[{action:'run',distance_m:.464},{action:'walk_adjust',distance_m:.02}]};assert.throws(()=>validateStep(step));
 let invoked=0;const ex=new ActionExecutor({yaw:()=>0,position:()=>({x:0,z:0}),run:async()=>{invoked++},adjust:async()=>{invoked++}},{half:4});
 const r=await ex.run({steps:[step]});assert.equal(r.status,'failed');assert.equal(invoked,0);
});
test('活跃重复点击不续期，刷新重启绝对到期',()=>{const st={};changeMode(st,'active',1000);assert.equal(changeMode(st,'active',30000).expiresAt,601000);const copy=JSON.parse(JSON.stringify(st));assert.equal(modeView(copy,601001).mode,'quiet');});
test('记忆验证用户来源和原文：候选确认后注入，跨主人隔离，删除不复活',()=>{
 const st={};const m=recordMessage(st,'alice','session','user','我喜欢鲸鱼');
 const p={key:'ordinary_interest',value:'鲸鱼',sourceMessageId:m.messageId,sourceQuote:m.content};
 propose(st,'bob',[p],[m.messageId]);assert.equal(memoryView(st,'bob').length,0);
 propose(st,'alice',[{...p,sourceQuote:'我喜欢猫'}],[m.messageId]);assert.equal(memoryView(st,'alice').length,0);
 propose(st,'alice',[p],[m.messageId]);assert.equal(relevantMemory(st,'alice').length,0);
 const id=memoryView(st,'alice')[0].id;editMemory(st,'alice',{op:'confirm',id});assert.equal(relevantMemory(st,'alice')[0].value,'鲸鱼');
 acceptSummary(st,'alice',{text:'喜欢鲸鱼',sourceMessageIds:[m.messageId]},[m.messageId]);
 editMemory(st,'alice',{op:'delete',id});propose(st,'alice',[p],[m.messageId]);assert.equal(memoryView(st,'alice').length,0);assert.equal(st.summaries.alice,undefined);assert.ok(!JSON.stringify(st).includes('鲸鱼'));
});
test('显式记住称呼可验证确认，假设和第三人不能成为人设',()=>{
 const st={};const m=recordMessage(st,'a','s','user','以后叫我小乔');propose(st,'a',[{key:'preferred_name',value:'小乔',sourceMessageId:m.messageId,sourceQuote:m.content}],[m.messageId]);assert.equal(relevantMemory(st,'a')[0].value,'小乔');
 const h=recordMessage(st,'a','s','user','如果我说我喜欢猫呢');propose(st,'a',[{key:'ordinary_interest',value:'猫',sourceMessageId:h.messageId,sourceQuote:h.content}],[h.messageId]);assert.equal(memoryView(st,'a').length,1);
});
test('整请求预算包含模板和输出契约且能力只计一次',()=>{const messages=planningMessages({capabilities:[],goal:{originalText:'hello'}});const r=estimateRequest({messages,maxInputTokens:14000});assert.ok(r.total>0);assert.equal(r.total,Math.ceil(Math.ceil(JSON.stringify(messages).length*.6)*1.15)+64);assert.match(messages[0].content,/不.*数错|算术|计算/);});
