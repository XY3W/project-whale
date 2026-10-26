// 开局视觉对比：没开局 vs 刚开局 vs 进行中
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

const out = {};
try {
  await once("!!window.whale && window.whale.client.connected === true", 60000);
  await sleepMs(1500);
  out.before = await cdp.evaluate(`({
    boardVisible: window.whale.board.state.visible,
    chip: getComputedStyle(document.querySelector('.game-chip')).opacity,
    chipText: document.querySelector('.game-chip').textContent,
  })`);

  await cdp.evaluate("document.getElementById('start-minesweeper').click()");
  await once("!!window.whale.getGame()", 8000);
  await sleepMs(250); // 扫光进行中
  out.pulseFrame = await cdp.evaluate(`({
    visible: window.whale.board.state.visible,
    chipOpacity: getComputedStyle(document.querySelector('.game-chip')).opacity,
    chipText: document.querySelector('.game-chip').textContent,
    boardY: window.whale.board.mesh.position.y,
  })`);
  await sleepMs(1400); // 扫光结束
  out.after = await cdp.evaluate(`({
    chipOpacity: getComputedStyle(document.querySelector('.game-chip')).opacity,
    chipText: document.querySelector('.game-chip').textContent,
    status: window.whale.getGame().status,
  })`);
  out.consoleErrors = cdp.errors.slice(0, 5);
} catch (err) {
  out.error = String(err);
}
return out;
