// 长时间真实动画验收：180° 转身、1.89m 最长走路、短步微调、一次跑动
// 低帧率（headless swiftshader 约 1.5fps）下这些步骤要跑几分钟，正好检验进度看门狗。
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
const IDLE =
  "window.whale.getMotionOwner() === 'none' && !window.whale.player.state.walking && window.whale.player.state.base === 'idle_stand'";

const out = {};
try {
  await once("!!window.whale && window.whale.client.connected === true", 60000);
  await once(IDLE, 120000);
  await sleepMs(4000); // 等首帧着色器编译过去，避免把冷启动当成卡死

  out.plan = await cdp.evaluate(`(async () => {
    window.whale.root.position.set(0, window.whale.root.position.y, 0);
    window.whale.root.rotation.y = 0;
    const t0 = performance.now();
    const res = await window.whale.run({ steps: [
      { action: 'turn', angle_deg: 180 },
      { action: 'walk', distance_m: 1.89 },
      { action: 'walk_adjust', distance_m: 0.08 },
      { action: 'run', distance_m: 0.464 },
      { action: 'turn', angle_deg: -180 },
    ] });
    return {
      status: res?.status ?? null,
      elapsedMs: Math.round(performance.now() - t0),
      steps: (res?.steps ?? []).map(s => ({ action: s.action, status: s.status, reason: s.reasonCode, actual: s.actual })),
      finalPosition: { x: +window.whale.root.position.x.toFixed(3), z: +window.whale.root.position.z.toFixed(3) },
      finalYawDeg: +((window.whale.root.rotation.y * 180) / Math.PI).toFixed(2),
    };
  })()`);
  out.consoleErrors = cdp.errors.slice(0, 5);
} catch (err) {
  out.error = String(err);
}
return out;
