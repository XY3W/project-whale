/**
 * 脚本沙箱：QuickJS 编译到 WebAssembly，跑在进程内的一小块独立运行时里。
 *
 * 边界是结构性的：wasm 里没有 syscall，我们**只注入** `emit` / `log` 两个纯函数，
 * 不提供 require / process / fetch / 文件系统，所以脚本读不到 .env、发不出请求。
 *
 * 资源上限：CPU 中断（默认 300ms）、内存（默认 32MB）、日志条数、返回体积。
 */
import { getQuickJS } from "quickjs-emscripten";

export const LIMITS = { timeoutMs: 300, memoryMb: 32, maxOutput: 4096, maxLogs: 20 };

let runtimePromise = null;
const getRuntime = () => (runtimePromise ??= getQuickJS());

/**
 * 执行一段纯计算脚本。
 * 约定：脚本可以用 `input` 读入参，用 `emit(value)` 给出返回值，用 `log(...)` 记日志。
 *
 * @returns {{ok:boolean, value?:unknown, logs?:string[], ms:number, error?:string, timedOut?:boolean}}
 */
export async function runScript(source, { input = null, timeoutMs = LIMITS.timeoutMs, memoryMb = LIMITS.memoryMb, maxOutput = LIMITS.maxOutput, maxLogs = LIMITS.maxLogs } = {}) {
  const startedAt = Date.now();
  const code = String(source ?? "");
  if (!code.trim()) return { ok: false, error: "脚本是空的", ms: 0 };
  if (code.length > 4000) return { ok: false, error: "脚本太长（上限 4000 字符）", ms: 0 };

  const QuickJS = await getRuntime();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = startedAt + timeoutMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      interrupted = true;
      return true;
    }
    return false;
  });

  const context = runtime.newContext();
  const handles = [];
  try {
    const inputJson = JSON.stringify(input ?? null);
    const prelude = [
      `const input = ${inputJson};`,
      "let __out;",
      "const __logs = [];",
      "const emit = (v) => { __out = v; };",
      `const log = (...a) => { if (__logs.length < ${maxLogs}) __logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };`,
    ].join("\n");
    const wrapped = `(function(){\n${prelude}\n${code}\n;return { value: __out, logs: __logs };\n})()`;

    const result = context.evalCode(wrapped, "skill.js");
    if (result.error) {
      const dumped = context.dump(result.error);
      result.error.dispose();
      const message = typeof dumped === "object" && dumped && "message" in dumped ? String(dumped.message) : String(dumped);
      return { ok: false, error: interrupted ? "执行超时（可能死循环）" : message, timedOut: interrupted, ms: Date.now() - startedAt };
    }
    const value = context.dump(result.value);
    result.value.dispose();
    const payload = value && typeof value === "object" ? value : { value: null, logs: [] };
    let output = payload.value ?? null;
    const logs = Array.isArray(payload.logs) ? payload.logs.map((l) => String(l).slice(0, 200)) : [];
    let text;
    try {
      text = JSON.stringify(output);
    } catch {
      return { ok: false, error: "返回值无法序列化（可能有循环引用）", ms: Date.now() - startedAt };
    }
    if (typeof text === "string" && text.length > maxOutput) {
      return { ok: false, error: `返回值太大（${text.length} 字符，上限 ${maxOutput}）`, ms: Date.now() - startedAt };
    }
    return { ok: true, value: output, logs, ms: Date.now() - startedAt };
  } catch (err) {
    const message = err?.message ?? String(err);
    return {
      ok: false,
      error: interrupted || /interrupted/i.test(message) ? "执行超时（可能死循环）" : message,
      timedOut: interrupted || /interrupted/i.test(message),
      ms: Date.now() - startedAt,
    };
  } finally {
    for (const handle of handles) {
      try { handle.dispose?.(); } catch { /* already disposed */ }
    }
    try { context.dispose(); } catch { /* ignore */ }
    try { runtime.dispose(); } catch { /* ignore */ }
  }
}

/** 只做语法检查，用于创建/修改脚本技能时先行拦截 */
export async function checkScript(source) {
  const QuickJS = await getRuntime();
  const runtime = QuickJS.newRuntime();
  const context = runtime.newContext();
  try {
    const probe = `(function(){\n${String(source ?? "")}\n})`;
    const result = context.evalCode(probe, "check.js");
    if (result.error) {
      const dumped = context.dump(result.error);
      result.error.dispose();
      const message = typeof dumped === "object" && dumped && "message" in dumped ? String(dumped.message) : String(dumped);
      return { ok: false, error: message };
    }
    result.value.dispose();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    try { context.dispose(); } catch { /* ignore */ }
    try { runtime.dispose(); } catch { /* ignore */ }
  }
}
