import test from "node:test";
import assert from "node:assert/strict";
import { buildHistory, estimateTokens } from "../server/context.mjs";
import { addCandidates, confirmedMemories, validateProposals } from "../server/memory.mjs";

test("上下文：预算内保留最近消息，丢弃最旧", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `消息${i}` }));
  const { messages, dropped } = buildHistory(history, 10);
  assert.ok(messages.length > 0 && messages.length < 20);
  assert.equal(messages.at(-1).content, "消息19");
  assert.equal(dropped, 20 - messages.length);
});

test("上下文：单条超预算时不返回空上下文以外的内容", () => {
  const { messages } = buildHistory([{ role: "user", content: "x".repeat(1000) }], 10);
  assert.equal(messages.length, 0);
});

test("记忆：白名单外的 key 被拒绝，合法提案成为 candidate", () => {
  const r = validateProposals(
    [
      { key: "nickname", value: "小乔" },
      { key: "password", value: "x" },
      { key: "style", value: "回复简短一点" },
      { key: "interest", value: "第四项应被截断" },
    ],
    "msg-1",
  );
  assert.equal(r.accepted.length, 2);
  assert.equal(r.accepted[0].status, "candidate");
  assert.ok(r.rejected.some((x) => x.reason === "key_not_allowed"));
});

test("记忆：无来源拒绝，confirmed 过滤", () => {
  assert.equal(validateProposals([{ key: "nickname", value: "小乔" }], null).accepted.length, 0);
  const list = addCandidates([], [{ key: "nickname", value: "小乔", sourceMessageId: "m1", status: "candidate", createdAt: 1 }]);
  assert.equal(confirmedMemories(list).length, 0);
  list[0].status = "confirmed";
  assert.equal(confirmedMemories(list).length, 1);
});
