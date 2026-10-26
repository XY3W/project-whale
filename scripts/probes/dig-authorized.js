// 授权挖掘的浏览器验收：走真实的 计划→授权→dig_contact→提交 链路。
// 需要服务端以 BRAIN_DEV=1 启动（仅用于本地/验收环境）。
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const once = async (expr, timeout = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await cdp.evaluate(expr); if (v) return v; await sleepMs(250); }
  return null;
};
const out = {};
try {
  await once("!!window.whale && window.whale.client.connected === true", 60000);
  await sleepMs(800);
  // 先把可能残留的盘面收掉（两步：结束 → 收起），再开一局
  for (let i = 0; i < 3; i++) {
    if (!(await cdp.evaluate("!!window.whale.getGame()"))) break;
    await cdp.evaluate("document.getElementById('start-minesweeper').click()");
    await sleepMs(700);
  }
  await cdp.evaluate("document.getElementById('start-minesweeper').click()");
  await once("window.whale.getGame()?.status === 'playing'", 8000);
  const game = await cdp.evaluate("window.whale.getGame() ? { id: window.whale.getGame().gameId, rev: window.whale.getGame().revision } : null");
  out.game = game;

  // 同时捕获服务端下发的计划与客户端发出的提交
  await cdp.evaluate(`(() => {
    window.__plans = [];
    window.whale.client.ws.addEventListener('message', (e) => {
      try { const m = JSON.parse(e.data); if (m.type === 'execute_plan') window.__plans.push(m); } catch {}
    });
  })()`);
  // 捕获客户端发出去的 plan_result / dig_commit，失败原因才看得见
  await cdp.evaluate(`(() => {
    window.__sent = [];
    const proto = WebSocket.prototype;
    const orig = proto.send;
    proto.send = function (data) {
      try { const m = JSON.parse(data); if (m.type === 'plan_result' || m.type === 'dig_commit') window.__sent.push(m); } catch {}
      return orig.call(this, data);
    };
  })()`);

  // 站到 (3,3) 格心，把勺子放到右手，并立刻同步一次权威快照
  const staged = await cdp.evaluate(`(() => {
    const w = window.whale;
    const g = w.getGame();
    const c = { x: -4 + 3.5 * g.cellSize, z: -4 + 3.5 * g.cellSize };
    w.root.position.set(c.x, w.root.position.y, c.z);
    w.scoop.state = 'held'; w.scoop.mode = 'hand';
    w.client.sendStateSnapshot(w.snapshot());
    return { x: c.x, z: c.z, rev: g.revision };
  })()`);
  out.staged = staged;
  await sleepMs(300);

  // 让服务端下发一份真实计划（含 digAuthId）
  await cdp.evaluate(`window.whale.client.ws.send(JSON.stringify({
    protocolVersion: 1, type: 'debug_plan', leaseEpoch: window.whale.client.leaseEpoch,
    speech: '', steps: [{ action: 'dig', game_id: window.whale.getGame().gameId, row: 3, col: 3, expected_revision: window.whale.getGame().revision }],
  }))`);
  await sleepMs(1200);

  // 等待这次挖掘提交的结果
  const t0 = Date.now();
  let done = null;
  while (Date.now() - t0 < 90000) {
    const snap = await cdp.evaluate(`(() => {
      const g = window.whale.getGame();
      const cell = g ? g.cells.find(c => c.row === 3 && c.col === 3) : null;
      return { rev: g?.revision ?? null, state: cell?.state ?? null, value: cell?.value ?? null, owner: window.whale.getMotionOwner() };
    })()`);
    if (snap.rev !== staged.rev) { done = snap; break; }
    await sleepMs(1000);
  }
  out.dig = done;
  out.final = await cdp.evaluate(`(() => { const g = window.whale.getGame(); return { rev: g?.revision, status: g?.status }; })()`);
  out.plans = await cdp.evaluate("(window.__plans ?? []).map(m => ({ taskId: m.taskId, planId: m.planId, digAuthId: m.digAuthId ?? 'MISSING', steps: m.plan?.steps?.map(s => s.action) }))");
  out.sent = await cdp.evaluate("(window.__sent ?? []).map(m => m.type === 'dig_commit' ? { type: m.type, digAuthId: m.digAuthId, taskId: m.taskId } : { type: m.type, steps: m.result?.steps?.map(s => ({ action: s.action, status: s.status, reason: s.reasonCode, actual: s.actual })) })");
  out.errors = cdp.errors.slice(0, 3);
} catch (err) {
  out.error = String(err);
}
return out;
