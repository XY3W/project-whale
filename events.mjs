/** 关注事件去重：同一物品同一 revision 只触发一次，冷却期内不重复。 */
export function createEventDeduper(cooldownMs = 30_000) {
  const seen = new Map();
  return {
    shouldEmit(ev, now = Date.now()) {
      if (!ev || !ev.eventId || !ev.objectId) return false;
      const key = `${ev.objectId}:${ev.type}`;
      const last = seen.get(key);
      if (last && last.eventId === ev.eventId) return false;
      if (last && last.revision === ev.revision && now - last.at < cooldownMs) return false;
      seen.set(key, { eventId: ev.eventId, revision: ev.revision, at: now });
      return true;
    },
    size: () => seen.size,
  };
}
