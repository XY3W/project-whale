// 扫雷 UI 验收：按钮 → 棋盘 → 悬停 → 无勺拒绝 → 捡勺 → 真实 dig 提交 → 揭示
// 逐段记录，任何一段失败也把已经拿到的结果带回来。
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const once = async (expr, timeout = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await cdp.evaluate(expr);
    if (v) return v;
    await sleepMs(300);
  }
  return null;
};

const out = { steps: [] };
const step = (name, value) => {
  out.steps.push({ name, value });
  return value;
};
const IDLE =
  "window.whale.getMotionOwner() === 'none' && !window.whale.player.state.walking && window.whale.player.state.base === 'idle_stand'";

/** 低帧率下执行器要先停稳才能接管：等空闲 + 重试 */
const runWhenIdle = async (expr, label) => {
  for (let i = 0; i < 4; i++) {
    await once(IDLE, 120000);
    await sleepMs(400);
    const r = await cdp.evaluate(expr);
    if (r) return r;
  }
  return { error: `no result for ${label}` };
};

try {
  await once("!!window.whale && !!window.whale.client && window.whale.client.connected === true", 60000);
  await sleepMs(800); // 等一次 session_state 回来，确认执行权

  // 1. 按钮开局
  out.buttonText = await cdp.evaluate("document.getElementById('start-minesweeper')?.textContent ?? null");
  let started = false;
  for (let i = 0; i < 3 && !started; i++) {
    await cdp.evaluate("document.getElementById('start-minesweeper').click()");
    started = !!(await once("window.whale.getGame()?.cells?.length === 100 && window.whale.board.state.visible", 8000));
  }
  out.startedFromButton = step("button→board", started);
  out.connection = await cdp.evaluate("({ connected: window.whale.client.connected, leaseEpoch: window.whale.client.leaseEpoch })");
  if (!started) return out;
  out.game = await cdp.evaluate(`(() => { const g = window.whale.getGame(); return { gameId: g.gameId, rev: g.revision, status: g.status, cells: g.cells.length, hidden: g.cells.filter(c=>c.state==='hidden').length }; })()`);

  // 2. 悬停高亮 + 坐标
  out.hover = await cdp.evaluate(`(() => {
    const r = window.whale.stage.renderer.domElement.getBoundingClientRect();
    window.whale.stage.renderer.domElement.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.7, bubbles: true }));
    return new Promise(res => setTimeout(() => res(window.whale.board.state.hover), 600));
  })()`);

  const target = { row: 4, col: 6 };
  const digExpr = `(async () => {
    const g = window.whale.getGame();
    if (!g || g.status !== 'playing') return { skipped: g?.status ?? 'no-game' };
    const c = { x: -4 + (${target.col} + 0.5) * 0.8, z: -4 + (${target.row} + 0.5) * 0.8 };
    window.whale.root.position.set(c.x, window.whale.root.position.y, c.z);
    window.whale.root.rotation.y = 0;
    const res = await window.whale.run({ steps: [{ action: 'dig', game_id: g.gameId, row: ${target.row}, col: ${target.col}, expected_revision: g.revision }] });
    return { status: res?.status ?? null, reason: res?.steps?.[0]?.reasonCode ?? null, actual: res?.steps?.[0]?.actual ?? null };
  })()`;

  // 3. 右手没勺：dig 必须被前置条件拒绝（不播动画、不提交）
  out.digWithoutScoop = step("dig without scoop", await runWhenIdle(digExpr, "dig without scoop"));
  out.revAfterRefusal = await cdp.evaluate("window.whale.getGame().revision");

  // 4. 走到饭勺旁并捡起来（真实对齐 + 脚尖挑勺动画）
  out.scoopAlign = await cdp.evaluate(`(async () => {
    if (window.whale.scoop.state === 'held') return { already: true };
    const r = await window.whale.basinBridge.align('rice_scoop');
    return { ok: r.ok, error: r.error ?? null, alignment: window.whale.basinBridge.alignment('rice_scoop') };
  })()`);
  out.scoopPickup = await runWhenIdle(
    `(async () => {
      if (window.whale.scoop.state === 'held') return { already: true, state: 'held' };
      const res = await window.whale.run({ steps: [{ action: 'pickup', object_id: 'rice_scoop' }] });
      return { status: res?.status ?? null, reason: res?.steps?.[0]?.reasonCode ?? null, state: window.whale.scoop.state, holder: window.whale.basinBridge.snapshot('rice_scoop')?.holder };
    })()`,
    "scoop pickup",
  );

  // 5. 真正挖掘
  out.dig = step("dig", await runWhenIdle(digExpr, "dig"));
  out.afterDig = await cdp.evaluate(`(() => {
    const g = window.whale.getGame();
    const cell = g.cells.find(c => c.row === ${target.row} && c.col === ${target.col});
    return { rev: g.revision, status: g.status, cell: { state: cell.state, value: cell.value }, revealed: g.cells.filter(c=>c.state==='revealed').length };
  })()`);

  // 6. 第二轮挖掘：revision 继续增长
  out.secondDig = await runWhenIdle(
    `(async () => {
      const g = window.whale.getGame();
      if (g.status !== 'playing') return { skipped: g.status };
      const c = { x: -4 + (6.5) * 0.8, z: -4 + (5.5) * 0.8 };
      window.whale.root.position.set(c.x, window.whale.root.position.y, c.z);
      const res = await window.whale.run({ steps: [{ action: 'dig', game_id: g.gameId, row: 5, col: 6, expected_revision: g.revision }] });
      return { status: res?.status ?? null, reason: res?.steps?.[0]?.reasonCode ?? null, rev: window.whale.getGame().revision };
    })()`,
    "second dig",
  );

  // 7. 重复挖已揭示格：应当被拒绝
  out.repeatDig = await runWhenIdle(
    `(async () => {
      const g = window.whale.getGame();
      const c = { x: -4 + (${target.col} + 0.5) * 0.8, z: -4 + (${target.row} + 0.5) * 0.8 };
      window.whale.root.position.set(c.x, window.whale.root.position.y, c.z);
      const res = await window.whale.run({ steps: [{ action: 'dig', game_id: g.gameId, row: ${target.row}, col: ${target.col}, expected_revision: g.revision }] });
      return { status: res?.status ?? null, reason: res?.steps?.[0]?.reasonCode ?? null, actual: res?.steps?.[0]?.actual ?? null };
    })()`,
    "repeat dig",
  );

  // 8. 站在格子外挖：应当被拒绝并给出距离
  out.outOfCell = await runWhenIdle(
    `(async () => {
      const g = window.whale.getGame();
      const hidden = g.cells.find(c => c.state === 'hidden');
      window.whale.root.position.set(0, window.whale.root.position.y, 0);
      const res = await window.whale.run({ steps: [{ action: 'dig', game_id: g.gameId, row: hidden.row, col: hidden.col, expected_revision: g.revision }] });
      return { status: res?.status ?? null, reason: res?.steps?.[0]?.reasonCode ?? null, actual: res?.steps?.[0]?.actual ?? null };
    })()`,
    "out of cell dig",
  );

  out.consoleErrors = cdp.errors.slice(0, 5);
} catch (err) {
  out.error = String(err);
}
return out;
