import { randomUUID } from 'node:crypto';

// In-memory by design: a closed page must not leave reminders running.
export function createTimerService({now=Date.now}={}) {
  const tasks = new Map();
  function create(owner, page, spec) {
    if (!owner || !page) throw Error('缺少页面身份');
    if (typeof spec.first_at !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(spec.first_at)) throw Error('首次时间必须带时区');
    const at = Date.parse(spec.first_at);
    const interval = spec.interval_seconds == null ? null : Number(spec.interval_seconds);
    const occurrences = spec.total_occurrences == null ? null : Number(spec.total_occurrences);
    if (!Number.isFinite(at) || at <= now()) throw Error('首次触发时间必须是未来时间');
    if (interval !== null && (!Number.isInteger(interval) || interval < 10 || interval > 31536000)) throw Error('重复间隔必须是 10 至 31536000 秒');
    if (occurrences !== null && (!Number.isInteger(occurrences) || occurrences < 1 || occurrences > 10000)) throw Error('总次数必须是 1 至 10000');
    if (interval === null && occurrences !== null && occurrences !== 1) throw Error('单次任务总次数只能为 1');
    for (const k of ['name','display_message','wake_note']) if (typeof spec[k] !== 'string' || !spec[k].trim() || spec[k].length > (k === 'wake_note' ? 500 : 100)) throw Error(`${k} 内容无效`);
    if ([...tasks.values()].filter(t=>t.owner===owner&&t.page===page).length >= 50) throw Error('定时任务已达 50 个上限');
    const t={id:randomUUID(),owner,page,name:spec.name.trim(),display_message:spec.display_message.trim(),wake_note:spec.wake_note.trim(),next_at:at,interval_seconds:interval,total_occurrences:interval===null?1:occurrences,occurrences:0,skip_at:null};tasks.set(t.id,t);return t;
  }
  function list(owner,page) {return [...tasks.values()].filter(t=>t.owner===owner&&t.page===page).sort((a,b)=>a.next_at-b.next_at).map(({owner,page,...t})=>t);}
  function cancel(owner,page,id) {const t=tasks.get(id);if(!t||t.owner!==owner||t.page!==page)return false;tasks.delete(id);return true;}
  function skip(owner,page,id,at) {const t=tasks.get(id);if(!t||t.owner!==owner||t.page!==page||t.next_at!==at||now()>=at)return false;t.skip_at=at;return true;}
  function cancelPage(owner,page){for(const t of tasks.values())if(t.owner===owner&&t.page===page)tasks.delete(t.id);}
  function tick(isDeliverable) {
    const timestamp=now(), due=[];
    for (const t of tasks.values()) {
      if(t.next_at>timestamp)continue;
      const scheduled=t.next_at, missed=timestamp-scheduled>2000;
      const deliver=!missed&&t.skip_at!==scheduled&&isDeliverable(t);
      t.occurrences++;
      if(deliver)due.push({...t,scheduled_at:scheduled});
      t.skip_at=null;
      if(!t.interval_seconds || (t.total_occurrences!==null&&t.occurrences>=t.total_occurrences))tasks.delete(t.id);
      else {
        t.next_at=scheduled+t.interval_seconds*1000;
        if(t.next_at<=timestamp){const n=Math.floor((timestamp-t.next_at)/(t.interval_seconds*1000))+1;t.occurrences+=n;t.next_at+=n*t.interval_seconds*1000;if(t.total_occurrences!==null&&t.occurrences>=t.total_occurrences)tasks.delete(t.id);}
      }
    }
    return due;
  }
  return {create,list,cancel,skip,cancelPage,tick};
}
