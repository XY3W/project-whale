import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';
import {SkillRegistry} from '../server/skills.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('原生工具：读取完整脚本、拒绝整段覆盖、按版本局部修改并保留旧内容',async(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-skill-tool-'));
 const registry=new SkillRegistry(path.join(dir,'data/skills.json'));
 const script='const data = "'+ 'x'.repeat(1800)+'";\nemit(data);';
 const sk=registry.create({title:'修补测试',trigger:'需要检查时',body:'第一条保留。第二条保留。',kind:'script',script}).skill;
 const calls=[];
 const model=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;calls.push(JSON.parse(raw));
  const i=calls.length;
  const params=i===1?{operation:'revise',skill_id:sk.id,expected_version:1,edits:[{field:'body',operation:'append',text:'未读'}]}:i===2?{operation:'read',skill_id:sk.id}:i===3?{operation:'revise',skill_id:sk.id,skill:{title:'修补测试',trigger:'需要检查时',body:'只剩新内容'}}:i===4?{operation:'revise',skill_id:sk.id,expected_version:1,edits:[{field:'body',operation:'append',text:'第三条新增。'}]}:{outcome:'completed',speech:'完成'};
  const name=i===5?'finish':'skill';
  res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'call'+i,type:'function',function:{name,arguments:JSON.stringify(params)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise(r=>model.listen(0,'127.0.0.1',r));
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,[path.resolve('server/index.mjs')],{cwd:dir,env:{...process.env,BRAIN_PORT:String(port),DEEPSEEK_API_KEY:'test-only',DEEPSEEK_BASE_URL:`http://127.0.0.1:${model.address().port}/`,LLM_PROTOCOL:'tools',DEEPSEEK_THINKING:'0',AUTO_MINESWEEPER:'0'},stdio:'ignore'});
 let ws;t.after(()=>{ws?.terminate();child.kill();model.close();fs.rmSync(dir,{recursive:true,force:true});});
 let response;for(let i=0;i<100;i++){try{response=await fetch(`http://127.0.0.1:${port}/`);break;}catch{await delay(30)}}assert.ok(response);
 const cookie=response.headers.get('set-cookie').split(';')[0];const inbox=[];
 ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers:{cookie}});ws.on('message',d=>inbox.push(JSON.parse(d)));await new Promise(r=>ws.on('open',r));
 async function next(type){for(let i=0;i<500;i++){const j=inbox.findIndex(m=>m.type===type);if(j>=0)return inbox.splice(j,1)[0];await delay(10);}throw Error('timeout '+type);}
 const state=await next('session_state');ws.send(JSON.stringify({type:'user_message',protocolVersion:1,leaseEpoch:state.leaseEpoch,text:'修补技能',snapshot:{x:0,z:0,yawDeg:0,objects:[]}}));
 assert.equal((await next('public_reply')).speech,'完成');assert.equal(calls.length,5);
 const results=calls[4].messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
 assert.equal(results[0].code,'SKILL_READ_REQUIRED');assert.equal(results[1].doc.script,script);assert.equal(results[2].code,'SKILL_EDIT_INVALID');assert.equal(results[3].skill.version,2);
 const saved=new SkillRegistry(path.join(dir,'data/skills.json')).get(sk.id);
 assert.equal(saved.body,'第一条保留。第二条保留。\n第三条新增。');assert.equal(saved.script,script);assert.equal(saved.history[0].body,'第一条保留。第二条保留。');
});
