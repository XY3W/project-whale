import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const reports=[];
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function until(fn,ms=5000){const t=Date.now();while(Date.now()-t<ms){const x=fn();if(x)return x;await sleep(20);}throw new Error('audit wait timed out');}
async function setup({model,seed,fastBudget=false,extraEnv={}}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-review-'));const sockets=[];const requests=[];
 if(seed){fs.mkdirSync(path.join(dir,'data'));fs.writeFileSync(path.join(dir,'data/brain-state.json'),JSON.stringify(seed));}
 let stub;
 if(model){stub=http.createServer(async(req,res)=>{let raw='';for await(const x of req)raw+=x;const body=JSON.parse(raw);requests.push(body);const output=await model(body,requests.length);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));});await new Promise(r=>stub.listen(0,'127.0.0.1',r));}
 const p=await port();const env={...process.env,BRAIN_PORT:String(p),AUTO_MINESWEEPER:'0',...extraEnv,DEEPSEEK_API_KEY:model?'audit-only-local-stub':'',DEEPSEEK_BASE_URL:stub?`http://127.0.0.1:${stub.address().port}/chat`:''};
 const args=[];if(fastBudget){const clock=path.join(dir,'clock.mjs');fs.writeFileSync(clock,'const original=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...a)=>original(fn,ms===180000?1400:ms,...a);');args.push('--import',clock);}
 args.push(path.resolve('server/index.mjs'));const proc=spawn(process.execPath,args,{cwd:dir,env,stdio:['ignore','pipe','pipe']});let logs='';proc.stdout.on('data',b=>logs+=b);proc.stderr.on('data',b=>logs+=b);await until(()=>logs.includes('whale brain on'));
 async function connect(){const ws=new WebSocket(`ws://127.0.0.1:${p}/ws`);const inbox=[];ws.on('message',b=>inbox.push(JSON.parse(b)));sockets.push(ws);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});await until(()=>inbox.some(m=>m.type==='session_state'));return{ws,inbox,send:(type,payload={})=>ws.send(JSON.stringify({protocolVersion:1,type,...payload})),state:()=>inbox.filter(m=>m.type==='session_state').at(-1)};}
 return{connect,requests,dir,get logs(){return logs},read:()=>JSON.parse(fs.readFileSync(path.join(dir,'data/brain-state.json'),'utf8')),async close(){for(const s of sockets)s.terminate();await sleep(20);proc.kill();await sleep(80);if(stub)await new Promise(r=>stub.close(r));fs.rmSync(dir,{recursive:true,force:true});}};
}
async function scenario(name,fn){try{const result=await fn();reports.push({name,...result});console.log(name,JSON.stringify(result));}catch(err){reports.push({name,auditError:err.message});console.log(name,'AUDIT ERROR',err.stack);}}
async function begin(s,text='挥挥手'){const c=await s.connect();c.send('chat_opened');c.send('user_message',{text,leaseEpoch:c.state().leaseEpoch});return c;}
async function plan(c){return until(()=>c.inbox.find(m=>m.type==='execute_plan'));}
function result(c,p){c.send('plan_result',{taskId:p.taskId,generation:p.generation,planId:p.planId,leaseEpoch:c.state().leaseEpoch,result:{status:'completed',stopped:true,steps:[{status:'succeeded',actual:{distance_m:.09}}]},snapshot:{x:0,z:.09,yawDeg:0}});}

await scenario('dig_without_task_scoop_or_revision',async()=>{
 const s=await setup();try{const c=await s.connect();c.send('game_start',{requestId:'new'});const b=await until(()=>c.inbox.find(m=>m.type==='game_state')?.board);
 const payload={gameId:b.gameId,x:.25,z:.25,row:8,col:8,actionInstanceId:'same-id'};
 c.send('dig_commit',payload);const first=await until(()=>c.inbox.find(m=>m.type==='dig_result'));
 c.send('dig_commit',payload);await until(()=>c.inbox.filter(m=>m.type==='dig_result').length===2);
 const second=c.inbox.filter(m=>m.type==='dig_result')[1];
 c.send('dig_commit',{...payload,actionInstanceId:'bad-position',x:9});await until(()=>c.inbox.filter(m=>m.type==='dig_result').length===3);
 const invalid=c.inbox.filter(m=>m.type==='dig_result')[2];
 return {noTask:true,noScoop:true,noExpectedRevision:true,first:{ok:first.ok,revision:first.revision},replay:{ok:second.ok,reason:second.reason},earlyError:{reason:invalid.reason,actionInstanceId:invalid.actionInstanceId??null}};
 }finally{await s.close();}
});
await scenario('manual_end_pause_overwritten',async()=>{
 const s=await setup({model:()=>({type:'finish_task',outcome:'completed',speech:''}),extraEnv:{AUTO_MINESWEEPER:'1',AUTO_START_IDLE_MS:'1000',AUTO_CONTINUE_IDLE_MS:'1000',AUTO_AFTER_MANUAL_END_MS:'1800000'}});
 let hb;try{const c=await s.connect();hb=setInterval(()=>c.send('heartbeat'),1000);c.send('game_start',{requestId:'manual'});const first=await until(()=>c.inbox.find(m=>m.type==='game_state')?.board);await until(()=>s.requests.length>=1);await sleep(150);c.send('game_end');const ended=await until(()=>c.inbox.find(m=>m.type==='game_state'&&m.board?.status==='ended'));const t=Date.now();await until(()=>s.requests.length>=2);const next=await until(()=>c.inbox.find(m=>m.type==='session_state'&&m.game?.gameId!==first.gameId&&m.game?.status==='playing'),10000);return{old:first.gameId,next:next.game.gameId,reopenedAfterMs:Date.now()-t,configuredPauseMs:1800000};}finally{clearInterval(hb);await s.close();}
});
await scenario('parallel_motion_and_wrong_heading',async()=>{
 const {ActionExecutor}=await import('./src/behavior/ActionExecutor.ts');const {validatePlan}=await import('./server/capabilities.mjs');let p={x:0,z:0};const calls=[];
 const loco={position:()=>({...p}),yaw:()=>0,turn:async()=>{calls.push('turn')},walk:async m=>{p.x+=m},run:async m=>{calls.push('run');p.z+=m},adjust:async m=>{p.z+=m},play:async()=>{},tail:async()=>{},sleep:async()=>{}};
 const plan=validatePlan({type:'execute_plan',steps:[{action:'parallel',items:[{action:'run',distance_m:.464},{action:'turn',angle_deg:0}]}]}).plan;
 await new ActionExecutor(loco,{half:4}).run(plan);p={x:0,z:0};const wrong=await new ActionExecutor(loco,{half:4}).run({steps:[{action:'walk',distance_m:.45}]});
 p={x:0,z:3.69};const edge=await new ActionExecutor(loco,{half:4}).run({steps:[{action:'walk_adjust',distance_m:.08}]});
 return{conflictingCalls:calls,wrongHeadingStatus:wrong.steps[0].status,adjustPastMargin:{status:edge.steps[0].status,position:p}};
});
fs.writeFileSync('../new-audit.json',JSON.stringify(reports,null,2));if(reports.some(x=>x.auditError))process.exitCode=1;
