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

/**
 * 场地事件队列：game_started / board_updated / game_finished。
 *
 * 同类型的同一局只保留最高 revision；一次模型调用消化一批事件，
 * 所以队列既做去重也做“并发事件合并”。
 */
export function createGameEventQueue(max = 8) {
  let items = [];
  return {
    push(event) {
      if (!event || !event.type || !event.gameId) return items;
      items = pushGameEvent(items, event, max);
      return items;
    },
    take() {
      const out = items;
      items = [];
      return out;
    },
    peek: () => items.slice(),
    size: () => items.length,
    /** 用户收摊时丢掉这局残留的事件，别让旧事件混进下一局 */
    clearGame(gameId) {
      items = gameId ? items.filter((e) => e.gameId !== gameId) : [];
      return items;
    },
  };
}

export function pushGameEvent(list, event, max = 8) {
  if (!event || !event.type || !event.gameId) return list;
  if (list.some((e) => e.eventId === event.eventId)) return list;
  // 同类事件只保留最高 revision：更旧的（迟到的）直接丢弃
  const same = list.find((e) => e.gameId === event.gameId && e.type === event.type);
  if (same && same.revision >= event.revision) return list;
  // 不同类事件（board_updated 与 game_finished）并存，交给同一次调用合并处理
  const kept = list.filter((e) => !(e.gameId === event.gameId && e.type === event.type && e.revision < event.revision));
  kept.push(event);
  return kept.slice(-max);
}
