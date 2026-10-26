// 近距离检查：棋盘平面是否切进盆底
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
  await sleepMs(1200);
  for (let i = 0; i < 3; i++) {
    await cdp.evaluate("document.getElementById('start-minesweeper').click()");
    if (await once("!!window.whale.getGame() && window.whale.board.state.visible", 6000)) break;
  }

  out.setup = await cdp.evaluate(`(() => {
    const w = window.whale;
    // 盆挪到旁边，别和角色重叠
    w.basin.object.position.set(2.6, 0.1337, 2.6);
    w.basin.object.quaternion.set(0, 0, 0, 1);
    w.root.position.set(0, w.root.position.y, 0);
    w.root.rotation.y = 0;
    const c = w.stage.controls;
    c.minDistance = 0.35;
    c.maxDistance = 30;
    c.target.set(0, 0.12, 0);
    w.stage.camera.position.set(0.55, 0.95, 1.35);
    w.stage.camera.fov = 18;
    w.stage.camera.updateProjectionMatrix();
    w.stage.camera.lookAt(0, 0.12, 0);
    c.update();
    return { camera: w.stage.camera.position.toArray().map((v) => +v.toFixed(2)), boardY: w.board.mesh.position.y };
  })()`);
  await sleepMs(900);
  out.after = await cdp.evaluate("window.whale.stage.camera.position.toArray().map(v => +v.toFixed(2))");
  out.consoleErrors = cdp.errors.slice(0, 5);
} catch (err) {
  out.error = String(err);
}
return out;
