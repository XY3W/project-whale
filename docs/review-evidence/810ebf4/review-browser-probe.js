for(let i=0;i<180;i++){
 if(await cdp.evaluate('!!window.whale && window.whale.client.leaseEpoch>0'))break;
 await sleep(200);
}
await cdp.evaluate('window.whale.chat.openPanel()');
await sleep(1200);
const before=await cdp.evaluate(`(()=>{const w=window.whale;if(!w)throw new Error('model not ready');w.chat.openPanel();w.root.position.x=1.234;w.root.position.z=.567;w.root.rotation.y=Math.PI/4;w.basin.begin('pickup_basin');w.basin.handleEvent('grasp');w.basin.finish(true);w.basin.begin('wear_basin');w.basin.handleEvent('head_attach');w.basin.finish(true);w.basin.update(0,0);const b=w.basin.snapshot();w.client.sendStateSnapshot({x:1.234,z:.567,yawDeg:45,headObjectId:'basin',objects:[b]});return b})()`);
await sleep(2500);
await cdp.send('Page.reload');
await sleep(1500);
for(let i=0;i<180;i++){
 if(await cdp.evaluate('!!window.whale && window.whale.client.leaseEpoch>0'))break;
 await sleep(200);
}
const after=await cdp.evaluate(`(()=>{const w=window.whale;w.chat.openPanel();return{basin:w.basin.snapshot(),character:{x:w.root.position.x,z:w.root.position.z},connected:w.client.connected}})()`);
const newTab=await cdp.send('Target.createTarget',{url:await cdp.evaluate('location.href')});
const debugPort=new URL(cdp.ws.url).port;
const page=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
const target=page.find(x=>x.id===newTab.targetId);
const second=await cdp.constructor.connect(target.webSocketDebuggerUrl);await second.send('Runtime.enable');
await second.send('Page.bringToFront');
for(let i=0;i<180;i++){if(await second.evaluate('!!window.whale && window.whale.client.leaseEpoch>0'))break;await sleep(200);}
await sleep(500);
const readonlyBefore=await second.evaluate(`(()=>{const w=window.whale;const v={yaw:w.root.rotation.y,error:document.querySelector('.chat-status').textContent};w.root.rotation.y=1.5;w.enterChat();return v})()`);
await sleep(10000);
const readonlyAfter=await second.evaluate(`(()=>{const w=window.whale;return{yaw:w.root.rotation.y,chatOpen:w.chat.open,error:document.querySelector('.chat-status').textContent}})()`);
await cdp.send('Target.closeTarget',{targetId:newTab.targetId});
return{reload:{before,after},readonlyClick:{before:readonlyBefore,injectedStartYaw:1.5,after:readonlyAfter}};
