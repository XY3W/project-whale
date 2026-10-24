// 用 Chrome DevTools Protocol 截图：等页面真正就绪、抓控制台报错。
// 用法: node scripts/shot.mjs <url> <out.png> [waitExpr] [width] [height]
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] ?? "http://127.0.0.1:5178/";
const out = process.argv[3] ?? "/tmp/shot.png";
const waitExpr = process.argv[4] ?? "window.whale !== undefined";
const width = Number(process.argv[5] ?? 1440);
const height = Number(process.argv[6] ?? 900);
const port = 9333 + Math.floor(Math.random() * 200);
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

async function json(path, init) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(150);
  }
  throw new Error(`CDP endpoint ${path} not ready`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
}

const target = await json("/json/new?about:blank", { method: "PUT" });
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const cdp = new CDP(ws);

await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await cdp.send("Page.navigate", { url });

const deadline = Date.now() + 60000;
let ready = false;
while (Date.now() < deadline) {
  await sleep(400);
  const res = await cdp.send("Runtime.evaluate", { expression: `Boolean(${waitExpr})`, returnByValue: true }).catch(() => null);
  if (res?.result?.value === true) { ready = true; break; }
}

// 让动画多跑几帧
await sleep(1200);

// 可选的"截图前执行"表达式（用来触发动作）
const preExpr = process.argv[7] ?? "";
const preWait = Number(process.argv[8] ?? 900);
if (preExpr) {
  await cdp.send("Runtime.evaluate", { expression: preExpr }).catch((e) => console.log("preExpr error", e.message));
  await sleep(preWait);
}

const logs = cdp.events
  .filter((e) => e.method === "Runtime.consoleAPICalled" || e.method === "Runtime.exceptionThrown" || e.method === "Log.entryAdded")
  .map((e) => {
    if (e.method === "Runtime.exceptionThrown") return `EXCEPTION ${e.params.exceptionDetails?.exception?.description ?? ""}`;
    if (e.method === "Log.entryAdded") return `LOG ${e.params.entry.level} ${e.params.entry.text}`;
    return `CONSOLE ${e.params.type} ${e.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`;
  });

const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
await fs.writeFile(out, Buffer.from(shot.data, "base64"));

const info = await cdp.send("Runtime.evaluate", {
  expression: `(() => { const w = window.whale; const base = { text: document.querySelector('.loading-note')?.textContent ?? '', hud: document.querySelector('[data-intent]')?.textContent ?? '' }; if (!w) return JSON.stringify(base); const inf = w.character.mesh.morphTargetInfluences; const names = Object.entries(w.character.morphs); return JSON.stringify({ ...base, clip: w.character.currentClipName, morphs: names.map(([n, i]) => [n, +inf[i].toFixed(3)]), gaze: [+w.idle.gaze.yaw.toFixed(3), +w.idle.gaze.pitch.toFixed(3)], forward: w.character.forward.toArray().map((v) => +v.toFixed(2)) }); })()`,
  returnByValue: true,
}).catch(() => null);

console.log(`ready=${ready} -> ${out}`);
if (info?.result?.value) console.log(info.result.value);
if (logs.length) console.log(logs.slice(-30).join("\n"));
else console.log("(no console output)");

ws.close();
chrome.kill("SIGKILL");
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
