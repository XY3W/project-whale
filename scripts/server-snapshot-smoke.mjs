// 集成冒烟：服务端会不会用客户端快照更新角色状态（LLM 看到的位置是否最新）
// 用法: node scripts/server-snapshot-smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PORT = 8099;
const ENTRY = fileURLToPath(new URL("../server/index.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cwd = mkdtempSync(join(tmpdir(), "whale-smoke-"));
const proc = spawn(process.execPath, [ENTRY], {
  cwd,
  env: { ...process.env, BRAIN_PORT: String(PORT), DEEPSEEK_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += d; });
proc.stderr.on("data", (d) => { log += d; });

let code = 0;
try {
  let ws;
  for (let i = 0; i < 60; i++) {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!ws) throw new Error("服务端没有起来");

  const states = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "session_state") states.push(msg);
  });

  ws.send(JSON.stringify({ type: "hello" }));
  await sleep(300);
  const first = states.at(-1);
  if (!first) throw new Error("没收到 session_state");

  ws.send(JSON.stringify({ type: "chat_opened", leaseEpoch: first.leaseEpoch }));
  await sleep(200);
  ws.send(JSON.stringify({
    type: "user_message",
    text: "测试定位刷新",
    leaseEpoch: first.leaseEpoch,
    snapshot: {
      x: 1.5, z: -0.4, yawDeg: 45, base: "idle_stand", walking: false, chatOpen: true,
      objects: [{
        id: "basin", object_id: "basin", state: "worn", revision: 7, holder: "head",
        position: [0.02, 0.91, -0.07], quaternion: [0, 0.3827, 0, 0.9239], upright: false, available: false,
      }],
    },
  }));
  await sleep(500);
  ws.send(JSON.stringify({ type: "hello" }));
  await sleep(300);

  // 飞行中的盆不应该落盘：发一个 flying 快照，服务端应保持上一条已保存的状态
  ws.send(JSON.stringify({
    type: "user_message",
    text: "扔出去",
    leaseEpoch: first.leaseEpoch,
    snapshot: {
      x: 1.5, z: -0.4, yawDeg: 45,
      objects: [{ id: "basin", object_id: "basin", state: "flying", revision: 9, position: [1, 0.8, 2], upright: true }],
    },
  }));
  await sleep(500);
  ws.send(JSON.stringify({ type: "hello" }));
  await sleep(300);
  const afterFlying = states.at(-1).basin;

  const last = states.at(-1);
  const before = first.character ?? {};
  const after = last.character ?? {};
  const basin = afterFlying ?? null;
  const okCharacter = Math.abs(after.x - 1.5) < 1e-6 && Math.abs(after.z + 0.4) < 1e-6 && Math.abs(after.yawDeg - 45) < 1e-6;
  const okBasin = !!basin && basin.state === "worn" && basin.holder === "head" && Math.abs(basin.position[1] - 0.91) < 1e-6;
  console.log(JSON.stringify({ before, after, basin, okCharacter, okBasin }, null, 2));
  if (!okCharacter) throw new Error("服务端没有采用客户端快照");
  if (!okBasin) throw new Error("服务端没有持久化钢盆状态");
  if (basin.state === "flying") throw new Error("飞行中的状态不应该落盘");
  ws.close();
} catch (err) {
  console.error("SMOKE FAILED:", err.message);
  console.error(log.slice(-600));
  code = 1;
} finally {
  proc.kill("SIGKILL");
  await sleep(150);
  try { rmSync(cwd, { recursive: true, force: true }); } catch {}
}
process.exit(code);
