import { randomUUID } from 'node:crypto';
export function modeView(st,now=Date.now()) {
  const mode=st.behaviorMode??{mode:'quiet',modeEpoch:randomUUID(),activatedAt:null,expiresAt:null};
  if(mode.mode==='active'&&now>=mode.expiresAt)mode.mode='quiet';st.behaviorMode=mode;
  return {...mode,remainingMs:mode.mode==='active'?Math.max(0,mode.expiresAt-now):0,acceptingNewAutonomy:mode.mode==='active'&&now<mode.expiresAt};
}
export function changeMode(st,next,now=Date.now()) {
  const old=modeView(st,now);
  if(next==='active'&&old.mode==='active')return old;
  st.behaviorMode={mode:next==='active'?'active':'quiet',modeEpoch:randomUUID(),activatedAt:next==='active'?now:null,expiresAt:next==='active'?now+600000:null};
  return modeView(st,now);
}
