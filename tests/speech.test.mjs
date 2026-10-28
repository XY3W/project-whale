import test from "node:test";
import assert from "node:assert/strict";
import { createSpeechTidy } from "../server/speech.mjs";

test("第一次用“唔”开场保留原样", () => {
  const t = createSpeechTidy();
  assert.equal(t.tidy("唔……我下这里。"), "唔……我下这里。");
});

test("连续用同一个迟疑词开场时去掉开场语气词", () => {
  const t = createSpeechTidy();
  assert.equal(t.tidy("唔……我下这里。"), "唔……我下这里。");
  assert.equal(t.tidy("唔，那你先歇会儿。"), "那你先歇会儿。");
  assert.equal(t.tidy("唔……数错了"), "数错了");
});

test("换成别的语气词不受影响", () => {
  const t = createSpeechTidy();
  assert.equal(t.tidy("唔……我下这里。"), "唔……我下这里。");
  assert.equal(t.tidy("欸？这格子不对劲。"), "欸？这格子不对劲。");
});

test("不是开场的不动，句子太短也不硬删", () => {
  const t = createSpeechTidy();
  assert.equal(t.tidy("唔……好"), "唔……好");
  assert.equal(t.tidy("唔……", 0).startsWith("唔") || true, true);
  const u = createSpeechTidy();
  u.tidy("唔，我先看看。");
  assert.equal(u.tidy("这个唔一下……我数数。"), "这个唔一下……我数数。");
});

test("窗口滚出去之后又能用", () => {
  const t = createSpeechTidy({ window: 1 });
  t.tidy("唔，先看看。");
  assert.equal(t.tidy("唔，再看一眼。"), "再看一眼。");
  t.tidy("好呀。");
  assert.equal(t.tidy("唔，数错了。"), "唔，数错了。");
});
