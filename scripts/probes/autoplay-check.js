// 自主开局验收：不点任何按钮，看她自己开局 / 继续，并观察第一轮模型回合
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const once = async (expr, timeout = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await cdp.evaluate(expr);
    if (v) return v;
    await sleepMs(400);
  }
  return null;
};

const out = {};
try {
  await once("!!window.whale && window.whale.client.connected === true", 60000);
  out.atConnect = await cdp.evaluate(`({
    game: window.whale.getGame()?.gameId ?? null,
    status: window.whale.getGame()?.status ?? null,
    rev: window.whale.getGame()?.revision ?? null,
    boardVisible: window.whale.board.state.visible,
    chip: document.querySelector('.game-chip')?.textContent ?? "",
  })`);

  // 什么都不点：等宿主自己开局（或继续她没下完的局）
  const t0 = Date.now();
  let sawTurn = false;
  let gameAt = null;
  while (Date.now() - t0 < 40000) {
    const snap = await cdp.evaluate(`({
      game: window.whale.getGame()?.gameId ?? null,
      status: window.whale.getGame()?.status ?? null,
      rev: window.whale.getGame()?.revision ?? null,
      visible: window.whale.board.state.visible,
      owner: window.whale.getMotionOwner(),
      performing: !!window.whale.player.performing,
      thinking: document.querySelector('.chat-thinking')?.classList.contains('show') ?? false,
      chip: document.querySelector('.game-chip')?.textContent ?? "",
      chipOpacity: getComputedStyle(document.querySelector('.game-chip')).opacity,
    })`);
    if (!gameAt && snap.game) gameAt = snap;
    if (snap.owner === "plan" || snap.performing || snap.rev > 0) sawTurn = true;
    if (gameAt && sawTurn && Date.now() - t0 > 12000) {
      out.observed = snap;
      break;
    }
    await sleepMs(1000);
  }
  out.gameAppearedWithoutClick = gameAt;
  out.autonomousActivity = sawTurn;
  out.waitMs = Date.now() - t0;
  out.final = await cdp.evaluate(`({
    status: window.whale.getGame()?.status ?? null,
    rev: window.whale.getGame()?.revision ?? null,
    revealed: window.whale.getGame()?.cells.filter(c => c.state === 'revealed').length ?? 0,
    chip: document.querySelector('.game-chip')?.textContent ?? "",
  })`);
  out.consoleErrors = cdp.errors.slice(0, 5);
} catch (err) {
  out.error = String(err);
}
return out;
