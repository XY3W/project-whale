import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationPage } from '../server/conversation.mjs';
import { recordMessage } from '../server/preferences.mjs';
import { mergeChatMessages } from '../src/ui/chatHistory.ts';

test('UI history pages all retained messages, keeps owners private and order stable during live appends', () => {
  const state = {};
  for (let i = 0; i < 251; i++) recordMessage(state, 'alice', 's', i % 2 ? 'assistant' : 'user', `message-${i}`);
  recordMessage(state, 'bob', 's', 'user', 'private-other-owner');
  let page = conversationPage(state, 'alice');
  assert.equal(page.messages.length, 100); assert.equal(page.hasMore, true);
  assert.equal(page.messages[0].content, 'message-151');
  const all = [...page.messages];
  recordMessage(state, 'alice', 's', 'assistant', 'live-during-fetch');
  while (page.hasMore) {
    page = conversationPage(state, 'alice', { before: page.before });
    all.unshift(...page.messages);
  }
  assert.equal(all.length, 251);
  assert.equal(all[0].content, 'message-0');
  assert.equal(new Set(all.map(m => m.messageId)).size, 251);
  assert.ok(all.every(m => !('ownerScope' in m) && !('deliveryKey' in m)));
  assert.deepEqual(conversationPage(state, 'nobody').messages, []);
  const bobId = state.messages.find(m => m.ownerScope === 'bob').messageId;
  assert.equal(conversationPage(state, 'alice', { before: bobId }).cursorExpired, true);
});

test('history preserves complete text and identity; legitimate equal replies remain separate', () => {
  const state = {};
  const text = '长消息'.repeat(4000);
  const a = recordMessage(state, 'alice', 's', 'user', text, { clientMessageId: 'client-id-12345678' });
  const replay = recordMessage(state, 'alice', 's', 'user', text, { clientMessageId: 'client-id-12345678' });
  assert.equal(replay.messageId, a.messageId);
  assert.equal(a.content, text);
  recordMessage(state, 'alice', 's', 'assistant', '嗯', { deliveryKey: 'reply:1' });
  recordMessage(state, 'alice', 's', 'assistant', '嗯', { deliveryKey: 'reply:1' });
  recordMessage(state, 'alice', 's', 'assistant', '嗯', { deliveryKey: 'reply:2' });
  assert.equal(conversationPage(state, 'alice').messages.length, 3);
});

test('restore merges early live replies and optimistic user bubbles without duplicates or inversion', () => {
  const optimistic = { role: 'user', content: '你好', clientMessageId: 'local1', createdAt: 99999 };
  const ack = { ...optimistic, messageId: 'server-user', createdAt: 100, sequence: 30 };
  const reply = { role: 'assistant', content: '你好呀', messageId: 'server-reply', createdAt: 101, sequence: 31 };
  const old = { role: 'assistant', content: '之前的对话', messageId: 'old', createdAt: 200, sequence: 29 };
  let list = mergeChatMessages([], [optimistic, reply]);
  list = mergeChatMessages(list, [old, ack, reply]);
  assert.deepEqual(list.map(m => m.messageId), ['old', 'server-user', 'server-reply']);
  list = mergeChatMessages(list, [ack, reply]);
  assert.equal(list.length, 3);
  const repeated = { ...reply, messageId: 'another-reply', sequence: 32 };
  assert.equal(mergeChatMessages(list, [repeated]).length, 4);
});

test('legacy IDs and explicit retention remain supported independently of the 24-message model window', () => {
  const now = Date.now();
  const state = { messages: [{ messageId: 'legacy', ownerScope: 'alice', role: 'assistant', content: 'old saved reply', createdAt: now },
    { messageId: 'expired', ownerScope: 'alice', role: 'user', content: 'expired', createdAt: now - 31 * 86400000 }] };
  assert.equal(conversationPage(state, 'alice').messages[0].messageId, 'legacy');
  recordMessage(state, 'alice', 's', 'user', 'new');
  assert.ok(state.messages.at(-1).sequence > state.messages[0].sequence);
});
