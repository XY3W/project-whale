// 无依赖 CDP 探针：启动 headless Chrome，跑一段脚本，把结果打回终端。
// 用法: node scripts/probe.mjs <url> <script-file>
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9411 + Math.floor(Math.random() * 80);
const url = process.argv[2];
const scriptFile = process.argv[3];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDebugger() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) {
        const list = await r.json();
        const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error("chrome debugger 未就绪");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.errors = [];
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const cdp = new CDP(ws);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");
        cdp.logs.push(`[${msg.params.type}] ${text}`);
        if (msg.params.type === "error") cdp.errors.push(text);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        cdp.errors.push(d.exception?.description ?? d.text);
      }
      if (msg.method === "Log.entryAdded") {
        cdp.logs.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

const profile = mkdtempSync(join(tmpdir(), "whale-probe-"));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--disable-gpu-sandbox",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${process.env.PROBE_WINDOW ?? "1280,860"}`,
    url,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let chromeErr = "";
chrome.stderr.on("data", (d) => { chromeErr += d.toString(); });

let code = 0;
try {
  const target = await waitForDebugger();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  if (scriptFile) {
    const body = readFileSync(scriptFile, "utf8");
    const fn = new Function("cdp", "sleep", `return (async () => { ${body} })();`);
    const result = await fn(cdp, sleep);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify({ url: await cdp.evaluate("location.href") }, null, 2));
  }
  if (process.env.PROBE_SHOT) {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.PROBE_SHOT, Buffer.from(data, "base64"));
    console.log(`screenshot -> ${process.env.PROBE_SHOT}`);
  }
  if (cdp.errors.length) {
    console.log("=== PAGE ERRORS ===");
    for (const e of cdp.errors) console.log(e);
    code = 1;
  }
  const interesting = cdp.logs.filter((l) => /error|warn|basin|sandbox/i.test(l));
  if (interesting.length) {
    console.log("=== CONSOLE ===");
    for (const l of interesting.slice(-60)) console.log(l);
  }
} catch (err) {
  console.error("PROBE FAILED:", err.message);
  if (chromeErr) console.error(chromeErr.slice(-800));
  code = 1;
} finally {
  chrome.kill("SIGKILL");
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(code);
