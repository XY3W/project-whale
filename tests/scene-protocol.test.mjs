import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

/**
 * 场地协议：playground / room 的切换、房间内禁止开局、任务中排队。
 * 起真服务 + 假模型，不改生产数据。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = read();
    if (result) return result;
    await sleep(20);
  }
  assert.fail('Timed out waiting for the expected scene event');
}
const listen = async (server) => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-scene-'));
  fs.mkdirSync(path.join(dir, 'data'));
  // 关掉自主开局与漫游，避免后台任务干扰断言
  fs.writeFileSync(path.join(dir, 'data/brain-state.json'), JSON.stringify({ autoplay: { manualPaused: true, calls: [] } }));
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const delta = body.tools
      ? { tool_calls: [{ index: 0, id: `finish-${requests.length}`, type: 'function', function: { name: 'finish', arguments: JSON.stringify({ outcome: 'completed', speech: '' }) } }] }
      : { content: JSON.stringify({ type: 'finish_task', outcome: 'completed', speech: '' }) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: body.tools ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const modelPort = await listen(model);
  const reservation = http.createServer(); const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const proc = spawn(process.execPath, [path.resolve('server/index.mjs')], {
    cwd: dir,
    env: { ...process.env, BRAIN_PORT: String(port), BRAIN_DEV: '1', DEEPSEEK_API_KEY: 'test-only-mock',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelPort}/chat/completions`, LLM_PROTOCOL: 'json',
      DEEPSEEK_THINKING: '0', AUTO_MINESWEEPER: '0', AUTO_START_IDLE_MS: '999999', AUTO_TICK_MS: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; proc.stdout.on('data', (c) => { logs += c; }); proc.stderr.on('data', (c) => { logs += c; });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    if (proc.exitCode === null) { proc.kill(); await new Promise((resolve) => proc.once('exit', resolve)); }
    await new Promise((resolve) => model.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(() => logs.includes('whale brain on'));

  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws);
    const inbox = []; const readied = new Set();
    const send = (type, data = {}) => ws.send(JSON.stringify({ protocolVersion: 1, type, ...data }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)); inbox.push(msg);
      if (msg.type === 'session_state' && !msg.readOnly && msg.phase === 'thinking' && msg.taskId && !readied.has(msg.taskId)) {
        readied.add(msg.taskId);
        send('executor_ready', { taskId: msg.taskId, leaseEpoch: msg.leaseEpoch, snapshot: { x: 0, z: 0, yawDeg: 0, objects: [] } });
      }
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    send('hello', { runtimeVersion: 'playful-v2-count33', stopReadyProtocol: 1 });
    const state = await until(() => inbox.find((m) => m.type === 'session_state'));
    return { ws, inbox, send, epoch: state.leaseEpoch };
  }
  return { requests, connect, get logs() { return logs; } };
}

test('默认在场地；切到房间后开局被 WRONG_SCENE 拒绝，切回后可以开局', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  assert.equal(c.inbox.at(-1).scene, 'playground');

  c.send('scene_switch', { to: 'room', leaseEpoch: c.epoch });
  const room = await until(() => c.inbox.find((m) => m.type === 'scene_changed' && m.scene === 'room'));
  assert.ok(room);
  assert.equal(c.inbox.at(-1).scene, 'room');

  c.send('game_start', { requestId: 'g1', leaseEpoch: c.epoch });
  const rejected = await until(() => c.inbox.find((m) => m.type === 'error' && m.code === 'WRONG_SCENE'));
  assert.ok(rejected, '房间里禁止开局');
  await sleep(150);
  assert.equal(c.inbox.some((m) => m.type === 'game_state' && m.board), false, '被拒绝时不能真的开出一局');

  c.send('scene_switch', { to: 'playground', leaseEpoch: c.epoch });
  await until(() => c.inbox.find((m) => m.type === 'scene_changed' && m.scene === 'playground'));
  c.send('game_start', { requestId: 'g2', leaseEpoch: c.epoch });
  const board = await until(() => c.inbox.find((m) => m.type === 'game_state' && m.board));
  assert.equal(board.board.status, 'playing');
});

test('非执行者不能切场地；棋局进行中切换被 IN_GAME 拒绝', async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const observer = await f.connect();

  observer.send('scene_switch', { to: 'room', leaseEpoch: owner.epoch });
  const denied = await until(() => observer.inbox.find((m) => m.type === 'error' && m.code === 'NOT_EXECUTOR'));
  assert.ok(denied);

  owner.send('game_start', { requestId: 'g1', leaseEpoch: owner.epoch });
  await until(() => owner.inbox.find((m) => m.type === 'game_state' && m.board));
  owner.send('scene_switch', { to: 'room', leaseEpoch: owner.epoch });
  const inGame = await until(() => owner.inbox.find((m) => m.type === 'error' && m.code === 'IN_GAME'));
  assert.ok(inGame);
  const lastState = [...owner.inbox].reverse().find((m) => m.type === 'session_state');
  assert.equal(lastState.scene, 'playground');

  // 扫雷要两次：第一次结束并揭开，第二次才把盘面收起来
  owner.send('game_end', { leaseEpoch: owner.epoch });
  await until(() => owner.inbox.find((m) => m.type === 'game_state' && m.ended));
  owner.send('game_end', { leaseEpoch: owner.epoch });
  await until(() => {
    const last = [...owner.inbox].reverse().find((m) => m.type === 'game_state');
    return last && (!last.board || last.board.status === 'ended') ? last : null;
  });
  owner.send('scene_switch', { to: 'room', leaseEpoch: owner.epoch });
  await until(() => owner.inbox.find((m) => m.type === 'scene_changed' && m.scene === 'room'));
});

test('任务进行中切场景改为排队，任务结束后自动落地', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  c.send('user_message', { text: '陪我待会儿', clientMessageId: 'msg-scene-1', leaseEpoch: c.epoch, snapshot: { x: 0, z: 0, yawDeg: 0, objects: [] } });
  await until(() => c.inbox.find((m) => m.type === 'session_state' && m.phase === 'thinking'));

  c.send('scene_switch', { to: 'room', leaseEpoch: c.epoch });
  const queued = await until(() => c.inbox.find((m) => m.type === 'session_state' && m.pendingScene === 'room'));
  assert.ok(queued);

  // 假模型只回 finish，任务很快结束，排队应当落地
  const done = await until(() => c.inbox.find((m) => m.type === 'session_state' && m.phase === 'idle' && m.scene === 'room'), 12000);
  assert.ok(done);
  assert.equal(done.pendingScene, null);
});

test('房间里的模型上下文与提示词说明当前场地', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  c.send('scene_switch', { to: 'room', leaseEpoch: c.epoch });
  await until(() => c.inbox.find((m) => m.type === 'scene_changed' && m.scene === 'room'));
  c.send('user_message', { text: '你在哪', clientMessageId: 'msg-scene-2', leaseEpoch: c.epoch, snapshot: { x: 0, z: 0, yawDeg: 0, objects: [] } });
  const promptText = (body) => (body.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n');
  const req = await until(() => f.requests.find((body) => promptText(body).includes('"scene":"room"')), 12000);
  assert.ok(req);
  const text = promptText(req);
  assert.ok(text.includes('【房间】'), 'system 里要有房间段落');
  assert.ok(text.includes('房间里不能开局'), '要说明房间里不能开局');
});
