// 生产页面验收：加载、棋盘恢复、允许时点一次开局并确认渲染
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
  out.loaded = !!(await once("!!window.whale && window.whale.client.connected === true", 90000));
  await sleepMs(1200);
  out.url = await cdp.evaluate("location.href");
  out.buttons = await cdp.evaluate(
    "[...document.querySelectorAll('.topbar button, #start-minesweeper, #reset-basin')].map(b => b.textContent)",
  );
  out.gameOnLoad = await cdp.evaluate(
    "window.whale.getGame() ? { rev: window.whale.getGame().revision, status: window.whale.getGame().status, cells: window.whale.getGame().cells.length, visible: window.whale.board.state.visible } : null",
  );
  out.readOnly = await cdp.evaluate("document.body.textContent.includes('只读')");

  // 生产页当前没有对局时点一次开局；只读页面会给出错误提示，不会抢执行权
  if (!out.gameOnLoad) {
    await cdp.evaluate("document.getElementById('start-minesweeper').click()");
    out.started = !!(await once("!!window.whale.getGame() && window.whale.board.state.visible", 15000));
    out.gameAfter = await cdp.evaluate(
      "window.whale.getGame() ? { gameId: window.whale.getGame().gameId, rev: window.whale.getGame().revision, hidden: window.whale.getGame().cells.filter(c=>c.state==='hidden').length } : null",
    );
  }
  out.chatError = await cdp.evaluate("document.querySelector('.chat-error')?.textContent ?? null");
  out.consoleErrors = cdp.errors.slice(0, 5);
} catch (err) {
  out.error = String(err);
}
return out;
