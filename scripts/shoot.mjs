// 一次 Chrome 会话内执行多步截图，用于骨架/姿势的批量验证。
// 用法: node scripts/shoot.mjs <url> <plan.json>
// plan: { "width": 900, "height": 1000, "steps": [ { "out": "...", "expr": "...", "wait": 300 } ] }
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] ?? "http://127.0.0.1:5178/";
const planPath = process.argv[3];
const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
const width = plan.width ?? 900;
const height = plan.height ?? 1000;
const port = 9400 + Math.floor(Math.random() * 400);
const profile = `/tmp/whale-chrome-${port}`;

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
  "about:blank",
], { stdio: "ignore" });

async function http(path, init) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(150);
  }
  throw new Error(`CDP ${path} not ready`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.logs.push(`EXCEPTION ${msg.params.exceptionDetails?.exception?.description ?? ""}`);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        this.logs.push(`${msg.params.type.toUpperCase()} ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "eval failed");
    return res.result?.value;
  }
}

const target = await http("/json/new?about:blank", { method: "PUT" });
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const cdp = new CDP(ws);

await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: plan.deviceScaleFactor ?? 1, mobile: false });
await cdp.send("Page.navigate", { url });

const deadline = Date.now() + 60000;
let ready = false;
while (Date.now() < deadline) {
  await sleep(300);
  const waitExpr = plan.waitExpr ?? "window.whale !== undefined";
  if (await cdp.eval(`Boolean(${waitExpr})`).catch(() => false)) { ready = true; break; }
}
if (!ready) console.log("WARN: page not ready");
await sleep(800);

for (const step of plan.steps) {
  if (step.expr) await cdp.eval(step.expr).catch((e) => console.log(`step ${step.out} failed: ${e.message}`));
  await sleep(step.wait ?? 150);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(step.out, Buffer.from(shot.data, "base64"));
  console.log(`shot ${step.out}`);
}

if (cdp.logs.length) console.log(cdp.logs.slice(-10).join("\n"));
ws.close();
chrome.kill("SIGKILL");
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
