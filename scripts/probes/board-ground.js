// 检查棋盘平面与地面物品的高度关系：网格线是否切进盆底
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
  // 开局并等棋盘出现
  for (let i = 0; i < 3; i++) {
    await cdp.evaluate("document.getElementById('start-minesweeper').click()");
    if (await once("!!window.whale.getGame() && window.whale.board.state.visible", 6000)) break;
  }
  // 盆放回场地中心（正压在棋盘中心）
  await cdp.evaluate("window.whale.basinBridge.reset()");
  await sleepMs(1200);

  out.geometry = await cdp.evaluate(`(() => {
    const THREE = window.whale.THREE;
    const board = window.whale.board.mesh;
    const box = new THREE.Box3().setFromObject(window.whale.basin.object);
    const charBox = new THREE.Box3().setFromObject(window.whale.root);
    return {
      boardY: board.position.y,
      boardRenderOrder: board.renderOrder,
      boardDepthWrite: board.material.depthWrite,
      boardPolygonOffset: board.material.polygonOffset,
      basinPosition: window.whale.basin.object.position.toArray().map((v) => +v.toFixed(4)),
      basinWorldMinY: +box.min.y.toFixed(4),
      basinWorldMaxY: +box.max.y.toFixed(4),
      characterMinY: +charBox.min.y.toFixed(4),
      basinState: window.whale.basin.state,
    };
  })()`);

  // 近距离看盆底与网格线的接触处
  await cdp.evaluate(`(() => {
    const c = window.whale.stage.controls;
    window.whale.stage.camera.position.set(0.9, 0.55, 1.15);
    c.target.set(0, 0.08, 0);
    c.update();
  })()`);
  await sleepMs(800);
  out.camera = await cdp.evaluate("window.whale.stage.camera.position.toArray().map(v => +v.toFixed(2))");
  out.consoleErrors = cdp.errors.slice(0, 5);
} catch (err) {
  out.error = String(err);
}
return out;
