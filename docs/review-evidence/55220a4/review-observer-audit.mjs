import ts from 'typescript';
import {registerHooks} from 'node:module';
registerHooks({load(url,c,next){if(url.endsWith('.ts'))return{format:'module',source:ts.transpileModule(fs.readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};return next(url,c)}});
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


await scenario('observer_ignores_cleared_board',async()=>{
 const {BrainClient}=await import('./src/brain/BrainClient.ts');
 globalThis.document={addEventListener(){},visibilityState:'visible'};globalThis.window={addEventListener(){}};
 const calls=[];let sock;
 globalThis.WebSocket=class {static OPEN=1;readyState=1;handlers={};constructor(){sock=this}addEventListener(t,fn){this.handlers[t]=fn}send(){} };
 const client=new BrainClient('ws://test-only');client.on({onGame:b=>calls.push(b)});client.connect();
 const emit=m=>sock.handlers.message({data:JSON.stringify(m)});
 emit({type:'session_state',game:{gameId:'old',status:'playing'},readOnly:false});emit({type:'session_state',game:null,readOnly:false});
 return{callbackCount:calls.length,lastBoard:calls.at(-1)};
});
fs.writeFileSync('../observer-audit.json',JSON.stringify(reports,null,2));
