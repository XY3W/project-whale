import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import WebSocket from 'ws';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function context(body){const text=body.messages[1].content;const at=text.indexOf('REQUEST_CONTEXT_JSON:')+'REQUEST_CONTEXT_JSON:'.length;return JSON.parse(text.slice(at).trim().split('\n')[0]);}
test('实际协议：最终第4次执行也review；消息先落盘；确认记忆同主人回喂；断言40雷未改',async(t)=>{
 let modelPort,serverPort;const calls=[];
 const stub=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const ctx=context(JSON.parse(raw));calls.push(ctx);
 const source=ctx.userMessageId;const out=calls.length<5?{type:'execute_plan',speech:'',steps:[{action:'wait',duration_s:0}]}:{type:'finish_task',outcome:'completed',speech:'记住了。',memory_proposals:[{key:'preferred_name',value:'测试员',sourceMessageId:source,sourceQuote:'以后叫我测试员'}]};
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
 send('chat_opened');send('user_message',{text:'以后叫我测试员',snapshot:{x:0,z:0,yawDeg:0,objects:[]}});
 for(let i=1;i<=4;i++){const plan=await next('execute_plan');send('plan_result',{taskId:plan.taskId,generation:plan.generation,planId:plan.planId,result:{status:'completed',stopped:true,steps:[{stepId:'s1',action:'wait',status:'succeeded',requested:{duration_s:0},actual:{},reasonCode:'OK'}]},snapshot:{x:0,z:0,yawDeg:0,objects:[]}});}
 assert.equal((await next('public_reply')).speech,'记住了。');assert.equal(calls.length,5);assert.equal(calls.at(-1).phase,'review');assert.equal(calls.at(-1).finishOnly,true);assert.equal(calls.at(-1).taskEvidence.length,4);
 const st=JSON.parse(fs.readFileSync(path.join(dir,'data/brain-state.json'),'utf8'));assert.ok(st.messages.find(m=>m.messageId===calls[0].userMessageId));
 const mem=await(await fetch(base+'/api/memory',{headers:{cookie}})).json();assert.equal(mem.memories[0].status,'confirmed');
 const other=await(await fetch(base+'/api/memory')).json();assert.equal(other.memories.length,0);
 const {MINE_COUNT}=await import('../server/minesweeper.mjs');assert.equal(MINE_COUNT,40);
});
