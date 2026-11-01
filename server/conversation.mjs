/** UI transcript pagination, independent of the model's recent context window. */
export function conversationPage(state, owner, { before = null, limit = 100, now = Date.now() } = {}) {
  const days = Number(process.env.MESSAGE_RETENTION_DAYS ?? 30);
  const cutoff = now - (Number.isFinite(days) && days > 0 ? days : 30) * 86400000;
  const items = (state.messages ?? []).map((m, index) => ({ ...m, sequence: m.sequence ?? index + 1 }))
    .filter(m => m.ownerScope === owner && m.createdAt >= cutoff && ['user', 'assistant'].includes(m.role));
  const end = before ? items.findIndex(m => m.messageId === before) : items.length;
  if (end < 0) return { messages: [], hasMore: false, before: null, cursorExpired: true };
  const size = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
  const start = Math.max(0, end - size);
  const messages = items.slice(start, end).map(({ messageId, clientMessageId, role, content, createdAt, sequence }) =>
    ({ messageId, ...(clientMessageId ? { clientMessageId } : {}), role, content, createdAt, sequence }));
  return { messages, hasMore: start > 0, before: messages[0]?.messageId ?? null };
}
