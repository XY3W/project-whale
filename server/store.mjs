/** 持久化存储（C 批）：原子写入 + 防抖；重启后未完成任务标 unknown。 */
import fs from "node:fs";
import path from "node:path";

const EMPTY = () => ({ session: null, history: [], ledger: {}, character: null, savedAt: 0 });

export function createStore(file, debounceMs = 300) {
  let state = load();
  let timer = null;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return { ...EMPTY(), ...raw };
    } catch {
      return EMPTY();
    }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...state, savedAt: Date.now() }));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error("store flush failed:", err.message);
    }
  }

  return {
    get state() {
      return state;
    },
    update(mutate) {
      mutate(state);
      if (!timer) timer = setTimeout(flush, debounceMs);
    },
    flush,
    reset() {
      state = EMPTY();
      flush();
    },
  };
}

/** 启动对账：上次仍在执行的任务不可当作完成 */
export function reconcileOnLoad(stored) {
  const out = { ...EMPTY(), ...stored };
  if (out.session && ["thinking", "executing", "checking"].includes(out.session.phase)) {
    out.session = { ...out.session, phase: "unknown", reconciledAt: Date.now() };
  }
  return out;
}
