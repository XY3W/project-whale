// Run from repository root. Isolated probes; no server data, network or LLM calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import ts from 'typescript';
import { createGame, move, signature, adjudicateRepeat, publicGame } from '../../../server/xiangqi.mjs';
import { validatePlan } from '../../../server/capabilities.mjs';
import { XiangqiService } from '../../../server/xiangqi-service.mjs';
import { sanitizeProp, slotsOf } from '../../../server/public-state.mjs';
import { toolStartMessages } from '../../../server/llm.mjs';
import { XiangqiBoard, xqPoint, placementFor } from '../../../src/game/XiangqiBoard.ts';
const findings = {};
// A real legal perpetual-check cycle closed by the defending side.
const g = createGame(); g.board.fill(null); g.pieces.clear();
for (const p of [
 { id:'rk',side:'red',kind:'general',row:9,col:3 },
 { id:'bk',side:'black',kind:'general',row:0,col:5 },
 { id:'rr',side:'red',kind:'rook',row:2,col:4 },
]) { g.pieces.set(p.id,p); g.board[p.row*9+p.col]=p.id; }
const history=[signature(g)];
for(let cycle=0;cycle<2;cycle++)for(const [id,r,c]of [['rr',2,5],['bk',0,4],['rr',2,4],['bk',0,5]]){
 const result=move(g,id,r,c);assert(result.ok,JSON.stringify(result));history.push(signature(g));
}
const verdict=adjudicateRepeat(g,history);
assert.equal(verdict.reason,'repetition');
assert(g.moves.filter(m=>m.side==='red').every(m=>m.check));
findings.perpetualCheck={moves:g.moves.map(m=>({side:m.side,check:m.check,to:m.to})),actual:verdict,expected:'red loses for the repeated checks, rather than a draw'};
// Service restart preserves a draw as playing, and clears persisted idempotency/history.
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'whale-review-xq-'));
try{
 const file=path.join(temp,'game.json'),svc=new XiangqiService(file);
 const start=svc.start({requestId:'audit',userSide:'red'});
 let n=0;
 for(let cycle=0;cycle<2;cycle++)for(const [id,r,c]of [['red_horse_1',7,2],['black_horse_1',2,2],['red_horse_1',9,1],['black_horse_1',0,1]]){
  let result;
  if(id.startsWith('red'))result=svc.userMove({gameId:start.gameId,pieceId:id,toRow:r,toCol:c,moveId:'audit-'+n++,expectedRevision:svc.game.revision});
  else {const auth=svc.beginMove({pieceId:id,toRow:r,toCol:c,expectedRevision:svc.game.revision});assert(auth.ok);result=svc.commitMove({token:auth.token});}
  assert(result.ok,JSON.stringify(result));
 }
 const before={status:svc.status,decisions:Object.keys(svc.decisions).length,history:svc.history.length};
 const restored=new XiangqiService(file);
 const after={status:restored.status,decisions:Object.keys(restored.decisions).length,history:restored.history.length};
 assert.equal(before.status,'drawn');assert.equal(after.status,'playing');assert.equal(after.decisions,0);assert.equal(after.history,1);
 findings.restart={before,after};
}finally{fs.rmSync(temp,{recursive:true,force:true});}
// A stowed ladle is reported with holder=null by PropItem.snapshot; server remaps it to the hand.
const raw={object_id:'rice_scoop',state:'worn',holder:null,position:[0,.35,0],quaternion:[0,0,0,1]};
const cleaned=sanitizeProp(raw),slots=slotsOf(new Map([['rice_scoop',cleaned]]));
assert.equal(cleaned.state,'held');assert.equal(slots.right_hand,'rice_scoop');
findings.waistSnapshot={raw,cleaned:{state:cleaned.state,holder:cleaned.holder},slots};
// Finished game still injects the full game section; no game does omit it.
const promptHas=(x)=>toolStartMessages({xiangqi:x,skills:{index:[]}})[0].content.includes('【中国象棋】');
findings.promptGate={noGame:promptHas(null),playing:promptHas({status:'playing'}),finished:promptHas({status:'won'})};
assert.equal(findings.promptGate.noGame,false);assert.equal(findings.promptGate.finished,true);
// Exercise the actual board class with in-memory placeholder templates (no model fetch/browser).
const board=new XiangqiBoard(new THREE.Scene());
const layout=JSON.parse(fs.readFileSync('public/models/xiangqi-v1/initial_layout.json','utf8'));
for(const p of layout){board.layout.set(p.pieceId,p);board.templates.set(p.template,new THREE.Group());}
const view=publicGame(createGame()); board.update(view);
const moved=structuredClone(view);moved.revision=1;moved.pieces.find(p=>p.id==='red_soldier_1').row=5;
board.update(moved);
for(let i=0;i<240;i++)board.tick(performance.now()+1000+i*16.667);
const obj=board.instances.get('red_soldier_1');
assert(obj.position.y>.05);
findings.landing={after240Frames:obj.position.toArray(),expectedY:0};
board.select('red_rook_1');board.liftSelected('red_rook_1');board.select(null);
findings.cancelSelection={selected:board.selection,targetY:board.targets.get('red_rook_1').pos.y};
assert.equal(findings.cancelSelection.targetY,.045);
// Extract and transpile only the actual bridge, supplying deterministic local doubles.
const main=fs.readFileSync('src/main.ts','utf8');
const start=main.indexOf('  loco.xiangqiMove = async (step, ctx) => {');
const end=main.indexOf('\n  };',start)+6;
assert(start>0&&end>start);
const bridgeJs=ts.transpileModule(main.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
async function bridgeProbe({cancelled=false,capture=false}={}){
 const events=[];let time=0;
 const root=new THREE.Group();root.position.set(0,0,0);
 const piece={id:'black_rook_1',side:'black',row:0,col:0};
 const view={pieces:[piece,...(capture?[{id:'red_soldier_1',side:'red',row:1,col:0}]:[])]};
 const loco={
  async turn(deg){root.rotation.y+=deg*Math.PI/180;},
  async walk(d){root.position.x=THREE.MathUtils.clamp(root.position.x+Math.sin(root.rotation.y)*d,-3.7,3.7);root.position.z=THREE.MathUtils.clamp(root.position.z+Math.cos(root.rotation.y)*d,-3.7,3.7);},
  async adjust(d){await this.walk(d);},
 };
 const player={setCarrying(on){events.push({type:'carrying',on});return true;},async perform(clip,es,cb){
   events.push({type:'perform',clip,pickupDistance:clip==='chess_pickup'?Math.hypot(root.position.x+4.6,root.position.z+5.175):undefined});
   for(const e of es){time=e.time;events.push({type:e.type,time});cb(e.type);}time=clip==='chess_capture_place'||clip==='chess_place'?1.8:1.8;
   events.push({type:'animation_complete',clip,time});return true;
 }};
 const board={beginCarry(){events.push({type:'beginCarry',time});return true;},endCarry(id,target){events.push({type:'endCarry',time,target});}};
 const client={async xiangqiCommit(){events.push({type:'commit',time});return{ok:true,committed:true,revision:2};}};
 new Function('loco','root','degYaw','signedDeltaDeg','xiangqiBoard','player','xqPoint','placementFor','client','xiangqiView','xiangqiTokenRef',bridgeJs)(loco,root,()=>root.rotation.y*180/Math.PI,(a,b)=>((b-a+540)%360)-180,board,player,xqPoint,placementFor,client,view,'mock-token');
 const outcome=await loco.xiangqiMove({game_id:'audit',piece_id:piece.id,to_row:1,to_col:0,expected_revision:1},{token:'mock-token',isCancelled:()=>cancelled});
 return{outcome,events};
}
findings.bridge=await bridgeProbe({capture:true});
assert(findings.bridge.events.findIndex(e=>e.type==='commit')>findings.bridge.events.findIndex(e=>e.type==='animation_complete'&&e.clip==='chess_capture_place'));
assert(findings.bridge.events.find(e=>e.type==='perform'&&e.clip==='chess_pickup').pickupDistance>1.5);
findings.cancelledBridge=await bridgeProbe({cancelled:true});
assert(findings.cancelledBridge.events.some(e=>e.type==='perform'&&e.clip==='chess_pickup'));
// Exercise the actual authorization issuer, with a stale game_id as supplied by the plan.
const server=fs.readFileSync('server/index.mjs','utf8');
const as=server.indexOf('function issueXiangqiAuth(task, plan) {'),ae=server.indexOf('\n}',as)+2;
const tempAuth=fs.mkdtempSync(path.join(os.tmpdir(),'whale-review-xq-auth-'));
try{
 const svc=new XiangqiService(path.join(tempAuth,'game.json'));
 svc.start({requestId:'new-game',userSide:'black'});
 const session={xiangqiSeq:0,xiangqiAuth:new Map(),pendingXiangqi:null};
 const action={action:'xiangqi_move',game_id:'previous-unrelated-game',piece_id:'red_soldier_1',to_row:5,to_col:0,expected_revision:0};
 const issue=new Function('xiangqi','session','console',server.slice(as,ae)+';return issueXiangqiAuth;')(svc,session,{log(){}});
 const result=issue({id:'audit-task',generation:1},{steps:[action]});
 assert(result.token);findings.staleGameAuthorization={requestedGameId:action.game_id,currentGameIdDifferent:true,issued:!!result.token};
 let parallelAccepted=false;
 try{validatePlan({type:'execute_plan',steps:[{action:'parallel',items:[action,{action:'wait',duration_s:0}]}]});parallelAccepted=true;}catch{}
 assert(parallelAccepted);findings.parallelXiangqi={accepted:parallelAccepted};
}finally{fs.rmSync(tempAuth,{recursive:true,force:true});}
console.log(JSON.stringify({baseline:'26fd9ec',scope:'isolated deterministic probes, not full browser or production gameplay',findings},null,2));
