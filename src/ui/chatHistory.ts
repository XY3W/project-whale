export interface ChatMessage {
  messageId?: string;
  clientMessageId?: string;
  role: 'user' | 'assistant' | 'note';
  content: string;
  createdAt: number;
  sequence?: number;
}

/** Merge by identity and server append order, independent of fetch arrival. */
export function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const out = current.map(m => ({ ...m }));
  for (const item of incoming) {
    if (!item || !['user', 'assistant', 'note'].includes(item.role) || typeof item.content !== 'string') continue;
    const index = out.findIndex(m => (item.messageId && m.messageId === item.messageId) ||
      (item.clientMessageId && m.clientMessageId === item.clientMessageId));
    if (index >= 0) out[index] = { ...out[index], ...item };
    else out.push({ ...item });
  }
  return out.sort((a, b) => {
    if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence;
    if (a.sequence !== undefined) return -1;
    if (b.sequence !== undefined) return 1;
    return a.createdAt - b.createdAt;
  });
}
