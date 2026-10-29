import {spawn} from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import WebSocket from 'ws';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-review-'));const sockets=[];let proc;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
async function start(){proc=spawn(process.execPath,[path.resolve('server/index.mjs')],{cwd:dir,env:{...process.env,BRAIN_PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});await new Promise((ok,bad)=>{let x='';const t=setTimeout(()=>bad(new Error('startup timeout')),4000);proc.stdout.on('data',b=>{x+=b;if(x.includes('whale brain on')){clearTimeout(t);ok()}});proc.on('error',bad)});}
async function connect(){const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`),inbox=[];sockets.push(ws);ws.on('message',x=>inbox.push(JSON.parse(x)));await new Promise(r=>ws.once('open',r));return{ws,inbox,send:x=>ws.send(JSON.stringify({protocolVersion:1,...x}))};}
async function wait(c,fn){for(let i=0;i<80;i++){const m=c.inbox.find(fn);if(m)return m;await delay(50)}throw Error('message timeout')}
async function stop(){for(const ws of sockets)ws.terminate();await new Promise(r=>{proc.once('exit',r);proc.kill()});}
try{await start();const a=await connect(),sa=await wait(a,m=>m.type==='session_state');const b=await connect(),sb=await wait(b,m=>m.type==='session_state');
console.log('initial_leases',JSON.stringify({firstReadonly:sa.readOnly,secondReadonly:sb.readOnly}));
b.send({type:'state_snapshot',snapshot:{x:1.234,z:0,yawDeg:0}});b.send({type:'hello'});const moved=await wait(b,m=>m.type==='session_state'&&m.character?.x===1.234);console.log('readonly_snapshot_accepted',moved.character.x===1.234);
b.send({type:'chat_opened'});a.send({type:'user_message',text:'挥手',leaseEpoch:sa.leaseEpoch});const plan=await wait(a,m=>m.type==='execute_plan');console.log('readonly_opened_owner_chat',!!plan);
b.send({type:'plan_result',taskId:plan.taskId,result:{status:'completed',steps:[{status:'succeeded'}],stopped:true}});const reply=await wait(b,m=>m.type==='public_reply');console.log('readonly_result_accepted_without_fencing',!!reply);
a.send({type:'user_message',text:'挥手',leaseEpoch:sa.leaseEpoch});await wait(a,m=>m.type==='execute_plan'&&m.taskId!==plan.taskId);await delay(450);const persisted=JSON.parse(fs.readFileSync(path.join(dir,'data/brain-state.json'),'utf8'));console.log('persisted_task_fields',JSON.stringify(persisted.session));
await stop();await start();const c=await connect();const sc=await wait(c,m=>m.type==='session_state');console.log('restart_state',JSON.stringify({phase:sc.phase,taskId:sc.taskId,needsReconcile:sc.needsReconcile}));
}finally{if(proc&&proc.exitCode===null)await stop();fs.rmSync(dir,{recursive:true,force:true})}
