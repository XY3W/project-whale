import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { XiangqiService } from '../server/xiangqi-service.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = read(); if (result) return result; await sleep(20); }
  assert.fail('Timed out waiting for the expected chess event');
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function fixture(t, { protocol = 'json', restored = false, reply = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-xq-wakeup-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data/brain-state.json'), JSON.stringify({ autoplay: { manualPaused: true, calls: [] } }));
  if (restored) {
    const chess = new XiangqiService(path.join(dir, 'data/xiangqi.json'));
    const board = chess.start({ userSide: 'red', requestId: 'restored' });
    assert(chess.userMove({ gameId: board.gameId, pieceId: 'red_soldier_1', toRow: 5, toCol: 0, expectedRevision: 0, moveId: 'old-user-move' }).ok);
  }
  const requests = [];
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const tools = !!body.tools;
    const custom = reply?.(body);
    const delta = custom ? (tools ? { tool_calls: [{ index: 0, id: `custom-${requests.length}`, type: 'function',
      function: { name: custom.name, arguments: JSON.stringify(custom.args) } }] } : { content: JSON.stringify(custom.json) }) : tools
      ? { tool_calls: [{ index: 0, id: `finish-${requests.length}`, type: 'function', function: { name: 'finish', arguments: JSON.stringify({ outcome: 'completed', speech: '' }) } }] }
      : { content: JSON.stringify({ type: 'finish_task', outcome: 'completed', speech: '' }) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const modelPort = await listen(model);
  const reservation = http.createServer(); const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const proc = spawn(process.execPath, [path.resolve('server/index.mjs')], {
    cwd: dir, env: { ...process.env, BRAIN_PORT: String(port), BRAIN_DEV: '1', DEEPSEEK_API_KEY: 'test-only-mock',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelPort}/chat/completions`, LLM_PROTOCOL: protocol,
      DEEPSEEK_THINKING: '0', AUTO_MINESWEEPER: '1', AUTO_TICK_MS: '50', AUTO_START_IDLE_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; proc.stdout.on('data', chunk => { logs += chunk; }); proc.stderr.on('data', chunk => { logs += chunk; });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    if (proc.exitCode === null) { proc.kill(); await new Promise(resolve => proc.once('exit', resolve)); }
    await new Promise(resolve => model.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(() => logs.includes('whale brain on'));
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws); const inbox = []; const readied = new Set();
    const send = (type, data = {}) => ws.send(JSON.stringify({ protocolVersion: 1, type, ...data }));
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw)); inbox.push(msg);
      if (msg.type === 'session_state' && !msg.readOnly && msg.phase === 'thinking' && msg.taskId && !readied.has(msg.taskId)) {
        readied.add(msg.taskId); send('executor_ready', { taskId: msg.taskId, leaseEpoch: msg.leaseEpoch, snapshot: { x: 0, z: 0, yawDeg: 0, objects: [] } });
      }
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    send('hello', { runtimeVersion: 'playful-v2-count33', stopReadyProtocol: 1 });
    const state = await until(() => inbox.find(m => m.type === 'session_state'));
    return { ws, inbox, send, epoch: state.leaseEpoch };
  }
  return { requests, connect, dir, get logs() { return logs; } };
}
function requestContext(req) {
  for (const message of req.messages) {
    const match = message.content?.match(/REQUEST_CONTEXT_JSON:\n([^\n]+)/);
    if (match) return JSON.parse(match[1]);
  }
  assert.fail('Request context missing');
}
for (const protocol of ['json', 'tools']) test(`${protocol}: every legal user chess move wakes the LLM despite a persisted manual pause; replay/illegal moves do not`, async t => {
  const f = await fixture(t, { protocol }); const c = await f.connect();
  c.send('xiangqi_start', { requestId: 'start', userSide: 'red', leaseEpoch: c.epoch });
  const start = await until(() => c.inbox.find(m => m.type === 'xiangqi_state' && m.board));
  await until(() => f.requests.length === 1 && c.inbox.at(-1)?.phase === 'idle');
  c.send('xiangqi_move', { gameId: start.board.gameId, pieceId: 'red_soldier_1', toRow: 4, toCol: 0, expectedRevision: 0, moveId: 'illegal', leaseEpoch: c.epoch });
  await until(() => c.inbox.find(m => m.type === 'xiangqi_state' && m.result?.ok === false));
  await sleep(450); assert.equal(f.requests.length, 1);
  const payload = { gameId: start.board.gameId, pieceId: 'red_soldier_1', toRow: 5, toCol: 0, expectedRevision: 0, moveId: 'user-move-1', leaseEpoch: c.epoch };
  c.send('xiangqi_move', payload);
  await until(() => f.requests.some(req => requestContext(req).xiangqi?.revision === 1));
  const turn = f.requests.find(req => requestContext(req).xiangqi?.revision === 1);
  assert.equal(requestContext(turn).xiangqi.yourTurn, true);
  assert.match(JSON.stringify(turn.messages), /当前权威棋盘已经轮到你/);
  c.send('xiangqi_move', payload); await sleep(600);
  assert.equal(f.requests.length, 2, 'Exactly one new thinking request for this legal move');
  // Complete the character's reply through the real authorization/commit path,
  // then verify the next user move wakes another turn too.
  c.send('debug_plan', { leaseEpoch: c.epoch, steps: [{ action: 'xiangqi_move', game_id: start.board.gameId,
    piece_id: 'black_soldier_1', to_row: 4, to_col: 0, expected_revision: 1 }] });
  const plan = await until(() => c.inbox.find(m => m.type === 'execute_plan' && m.xiangqiToken));
  c.send('xiangqi_commit', { token: plan.xiangqiToken, expectedRevision: 1, toRow: 4, toCol: 0, leaseEpoch: c.epoch });
  await until(() => c.inbox.find(m => m.type === 'xiangqi_result' && m.committed && m.revision === 2));
  c.send('plan_result', { taskId: plan.taskId, planId: plan.planId, generation: plan.generation, leaseEpoch: c.epoch,
    snapshot: { x: 0, z: 0, yawDeg: 0, objects: [] }, result: { status: 'completed', stopped: true,
      steps: [{ action: 'xiangqi_move', status: 'succeeded', actual: { committed: true, revision: 2 } }] } });
  await until(() => f.requests.some(req => requestContext(req).xiangqi?.revision === 2) && c.inbox.at(-1)?.phase === 'idle');
  c.send('xiangqi_move', { gameId: start.board.gameId, pieceId: 'red_soldier_2', toRow: 5, toCol: 2,
    expectedRevision: 2, moveId: 'user-move-2', leaseEpoch: c.epoch });
  await until(() => f.requests.some(req => requestContext(req).xiangqi?.revision === 3));
  assert.equal(f.requests.filter(req => requestContext(req).xiangqi?.revision === 3).length, 1, 'The next legal move must wake exactly one new turn');
  assert(!f.logs.includes('[autoplay] tick'), 'Chess must not be replaced by autonomous minesweeper');
  const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'data/brain-state.json')));
  assert.equal(stored.autoplay.manualPaused, false);
});
test('A restored game waiting for the character wakes once on executor hello; repeated/observer hellos do not duplicate it', async t => {
  const f = await fixture(t, { restored: true }); const c = await f.connect();
  await until(() => f.requests.length === 1);
  assert.equal(requestContext(f.requests[0]).xiangqi.revision, 1);
  assert.equal(requestContext(f.requests[0]).xiangqi.yourTurn, true);
  c.send('hello'); c.send('hello'); const observer = await f.connect(); observer.send('hello');
  await sleep(600); assert.equal(f.requests.length, 1);
});
test('A first user move coalesced with start uses the current turn, not the stale user-first start instruction', async t => {
  const f = await fixture(t); const c = await f.connect();
  c.send('xiangqi_start', { requestId: 'fast-start', userSide: 'red', leaseEpoch: c.epoch });
  const start = await until(() => c.inbox.find(m => m.type === 'xiangqi_state' && m.board));
  c.send('xiangqi_move', { gameId: start.board.gameId, pieceId: 'red_soldier_1', toRow: 5, toCol: 0, expectedRevision: 0, moveId: 'fast-move', leaseEpoch: c.epoch });
  await until(() => f.requests.length === 1);
  const req = f.requests[0]; assert.equal(requestContext(req).xiangqi.revision, 1);
  assert.match(JSON.stringify(req.messages), /当前权威棋盘已经轮到你/);
  assert.doesNotMatch(requestContext(req).request ?? '', /只简短确认/);
});

for (const protocol of ['json', 'tools']) test(`${protocol}: chat-agreed draw ends the game, autonomous draw attempts are rejected`, async t => {
  const f = await fixture(t, { protocol, reply(body) {
    const ctx = requestContext(body);
    if (!ctx.xiangqi || ctx.xiangqi.status !== 'playing') return null;
    if (body.messages.some(m => m.role === 'tool')) return null;
    const args = { operation: 'agree_draw', game_id: ctx.xiangqi.gameId, expected_revision: ctx.xiangqi.revision, user_agreed: true };
    return { name: 'xiangqi', args, json: { type: 'xiangqi_tool', ...args } };
  } });
  const c = await f.connect();
  c.send('xiangqi_start', { requestId: 'manual-draw', userSide: 'red', leaseEpoch: c.epoch });
  const started = await until(() => c.inbox.find(m => m.type === 'xiangqi_state' && m.board));
  await until(() => f.requests.length >= 1 && c.inbox.at(-1)?.phase === 'idle');
  // The mock attempted the tool in the autonomous start event; no authority.
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'data/xiangqi.json'))).status, 'playing');
  c.send('user_message', { text: '这盘和棋吧，我同意和棋。', leaseEpoch: c.epoch, snapshot: { x: 0, z: 0, yawDeg: 0, objects: [] } });
  const finished = await until(() => c.inbox.find(m => m.type === 'xiangqi_state' && m.board?.result?.reason === 'agreed_draw'));
  assert.equal(finished.board.status, 'drawn');
  assert.equal(finished.board.gameId, started.board.gameId);
  assert.equal(finished.board.result.winner, null);
  assert.equal(finished.board.revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'data/xiangqi.json'))).status, 'drawn');
});
