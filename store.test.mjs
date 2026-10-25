import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore, reconcileOnLoad } from "../server/store.mjs";

test("存储：写入后可读回，原子替换", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-store-"));
  const file = path.join(dir, "brain-state.json");
  const s = createStore(file, 0);
  s.update((st) => {
    st.history.push({ role: "user", content: "你好" });
    st.ledger["p1"] = { state: "done", reply: "好" };
  });
  s.flush();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.history[0].content, "你好");
  assert.equal(raw.ledger.p1.reply, "好");
  assert.ok(raw.savedAt > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("对账：执行中的任务重启后标 unknown", () => {
  const out = reconcileOnLoad({ session: { id: "t1", phase: "executing" }, history: [], ledger: {} });
  assert.equal(out.session.phase, "unknown");
  const idle = reconcileOnLoad({ session: { id: "t1", phase: "idle" } });
  assert.equal(idle.session.phase, "idle");
});

test("对账：损坏文件回退为空状态", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-store-"));
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, "{not json");
  const s = createStore(file, 0);
  assert.deepEqual(s.state.history, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
