import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import WebSocket from 'ws';
import {estimateRequest} from '../server/context.mjs';
import {reviewMessages} from '../server/llm.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function context(body){const text=body.messages[1].content;const at=text.indexOf('REQUEST_CONTEXT_JSON:')+'REQUEST_CONTEXT_JSON:'.length;return JSON.parse(text.slice(at).trim().split('\n')[0]);}
test('实际协议：最终第4次执行也review；消息先落盘；确认记忆同主人回喂；断言40雷未改',async(t)=>{
 let modelPort,serverPort;const calls=[];
 const stub=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const ctx=context(JSON.parse(raw));calls.push(ctx);
 const source=ctx.userMessageId;const out=ctx.userMessage==='用户轻拍了你一下' ? {type:'finish_task',outcome:'completed',speech:'嗯？'} : ctx.userMessage==='我喜欢什么？' ? {type:'finish_task',outcome:'completed',speech:'你喜欢鲸鱼。'} : ctx.userMessage==='我喜欢鲸鱼' ? {type:'finish_task',outcome:'completed',speech:'知道了。',memory_proposals:[{key:'ordinary_interest',value:'鲸鱼',sourceMessageId:source,sourceQuote:'我喜欢鲸鱼'}]} : calls.length<5?{type:'execute_plan',speech:'',steps:[{action:'wait',duration_s:0}]}:{type:'finish_task',outcome:'completed',speech:'记住了。',memory_proposals:[{key:'preferred_name',value:'测试员',sourceMessageId:source,sourceQuote:'以后叫我测试员'}]};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(out)}}]}));});
 await new Promise(r=>stub.listen(0,'127.0.0.1',r));modelPort=stub.address().port;
 const portProbe=http.createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));serverPort=portProbe.address().port;await new Promise(r=>portProbe.close(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-v2-'));
 const child=spawn(process.execPath,[path.resolve('server/index.mjs')],{cwd:dir,env:{...process.env,BRAIN_PORT:String(serverPort),DEEPSEEK_API_KEY:'test-only',DEEPSEEK_BASE_URL:`http://127.0.0.1:${modelPort}/`,AUTO_MINESWEEPER:'0',DEEPSEEK_THINKING:'0'},stdio:'ignore'});
 let ws; t.after(()=>{ws?.terminate();child.kill();stub.close();fs.rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${serverPort}`;let first;
 for(let i=0;i<100;i++){try{first=await fetch(base);break;}catch{await delay(30);}}
 assert.ok(first);const cookie=first.headers.get('set-cookie').split(';')[0];
 const inbox=[];ws=new WebSocket(`ws://127.0.0.1:${serverPort}/ws`,{headers:{cookie}});ws.on('message',d=>inbox.push(JSON.parse(d)));await new Promise(r=>ws.on('open',r));
 async function next(type,predicate=()=>true){for(let i=0;i<250;i++){const n=inbox.findIndex(m=>m.type===type&&predicate(m));if(n>=0)return inbox.splice(n,1)[0];await delay(20);}throw Error('wait '+type);}
 const state=await next('session_state');const send=(type,p={})=>ws.send(JSON.stringify({type,protocolVersion:1,leaseEpoch:state.leaseEpoch,...p}));
 send('user_message',{text:'以后叫我测试员',snapshot:{x:0,z:0,yawDeg:0,objects:[]}});
 for(let i=1;i<=4;i++){const plan=await next('execute_plan');send('plan_result',{taskId:plan.taskId,generation:plan.generation,planId:plan.planId,result:{status:'completed',stopped:true,steps:[{stepId:'s1',action:'wait',status:'succeeded',requested:{duration_s:0},actual:{diagnostic:'x'.repeat(2800)},reasonCode:'OK'}]},snapshot:{x:0,z:0,yawDeg:0,objects:[]}});}
 assert.equal((await next('public_reply')).speech,'记住了。');assert.equal(calls.length,5);assert.equal(calls.at(-1).phase,'review');assert.equal(calls.at(-1).finishOnly,true);assert.equal(calls.at(-1).taskEvidence.length,4);
 assert.equal(calls.at(-1).taskEvidence.at(-1).resultRef,'executionReport');
 assert.equal(calls.at(-1).executionReport.steps[0].actual.diagnostic.length,2800);
 assert.equal(calls.at(-1).taskEvidence[0].result.steps[0].actual.diagnostic.length,2800);
 assert.ok(estimateRequest({messages:reviewMessages(calls.at(-1)),maxInputTokens:262144}).total>14000,'旧14k限制下会失败的多轮报告应能复核');
 const st=JSON.parse(fs.readFileSync(path.join(dir,'data/brain-state.json'),'utf8'));assert.ok(st.messages.find(m=>m.messageId===calls[0].userMessageId));
 const mem=await(await fetch(base+'/api/memory',{headers:{cookie}})).json();assert.equal(mem.memories[0].status,'confirmed');
 assert.equal(mem.recentConversation.length,2);assert.equal(mem.recentConversation[0].content,'以后叫我测试员');
 const other=await(await fetch(base+'/api/memory')).json();assert.equal(other.memories.length,0);assert.deepEqual(other.recentConversation,[]);
 send('user_message',{text:'我喜欢鲸鱼',snapshot:{x:0,z:0,yawDeg:0,objects:[]}});
 const update=await next('memory_updated',m=>m.pendingCount===1);assert.equal(update.pendingCount,1);
 assert.equal((await next('public_reply')).speech,'知道了。');
 const updated=await(await fetch(base+'/api/memory',{headers:{cookie}})).json();assert.equal(updated.memories.find(m=>m.key==='ordinary_interest').status,'candidate');assert.equal(updated.recentConversation.length,4);
 const interest=updated.memories.find(m=>m.key==='ordinary_interest');
 const confirmed=await(await fetch(base+'/api/memory',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({op:'confirm',id:interest.id})})).json();assert.equal(confirmed.memories.find(m=>m.id===interest.id).status,'confirmed');
 send('user_message',{text:'我喜欢什么？',snapshot:{x:0,z:0,yawDeg:0,objects:[]}});
 assert.equal((await next('public_reply')).speech,'你喜欢鲸鱼。');assert.ok(calls.at(-1).memory.some(m=>m.key==='ordinary_interest'&&m.value==='鲸鱼'));
 const beforeTap=calls.length;
 send('user_message',{text:'用户轻拍了你一下',snapshot:{x:0,z:0,yawDeg:0,objects:[]}});
 assert.equal((await next('public_reply')).speech,'嗯？');assert.equal(calls.length,beforeTap+1);assert.equal(calls.at(-1).userMessage,'用户轻拍了你一下');
 const cleared=await(await fetch(base+'/api/memory',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({op:'clear_history'})})).json();assert.deepEqual(cleared.recentConversation,[]);assert.equal(cleared.memories.length,2);
 const {MINE_COUNT}=await import('../server/minesweeper.mjs');assert.equal(MINE_COUNT,40);
});
