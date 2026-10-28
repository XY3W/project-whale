import test from "node:test";
import assert from "node:assert/strict";
import { runScript, checkScript } from "../server/sandbox.mjs";

test("纯计算：读 input、emit 返回值", async () => {
  const r = await runScript("const n = input.n; emit({ doubled: n * 2, arr: [1,2,3].map(x => x * n) });", { input: { n: 3 } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value, { doubled: 6, arr: [3, 6, 9] });
});

test("沙箱里没有宿主能力：process / require / fetch / Deno 都不存在", async () => {
  const r = await runScript(`
    emit({
      process: typeof process,
      require: typeof require,
      fetch: typeof fetch,
      Deno: typeof Deno,
      Buffer: typeof Buffer,
      setTimeout: typeof setTimeout,
    });
  `);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value, { process: "undefined", require: "undefined", fetch: "undefined", Deno: "undefined", Buffer: "undefined", setTimeout: "undefined" });
});

test("死循环会被 CPU 中断掐掉", async () => {
  const t0 = Date.now();
  const r = await runScript("while (true) {}", { timeoutMs: 120 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 3000, "不能真跑满");
});

test("内存上限：大分配会失败而不是拖垮进程", async () => {
  const r = await runScript("const a = []; for (let i = 0; i < 1e7; i++) a.push({ i }); emit(a.length);", { memoryMb: 8, timeoutMs: 800 });
  assert.equal(r.ok, false);
});

test("返回值过大直接拒绝", async () => {
  const r = await runScript("emit('x'.repeat(20000));", { maxOutput: 512 });
  assert.equal(r.ok, false);
  assert.match(r.error, /太大/);
});

test("日志条数有上限", async () => {
  const r = await runScript("for (let i = 0; i < 50; i++) log('line', i); emit(1);", { maxLogs: 5 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.logs.length, 5);
});

test("语法错误返回可读信息", async () => {
  const r = await runScript("const = ;");
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test("没调用 emit 时返回 null", async () => {
  const r = await runScript("const x = 1 + 1;");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, null);
});

test("checkScript：只检查语法", async () => {
  assert.equal((await checkScript("emit(1 + 1);")).ok, true);
  const bad = await checkScript("function (");
  assert.equal(bad.ok, false);
});

test("脚本读不到文件：没有 require/fs，尝试访问会报错而不是成功", async () => {
  const r = await runScript("try { const fs = require('fs'); emit(fs.readFileSync('/etc/passwd','utf8')); } catch (e) { emit({ blocked: true, msg: String(e.message).slice(0, 40) }); }");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.blocked, true);
});
