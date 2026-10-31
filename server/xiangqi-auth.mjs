/**
 * 象棋搬运授权的签发与撤销。
 *
 * 独立出来是为了能直接测试：审查要求"没有授权、或授权属于另一盘棋时一步都不能动"，
 * 而这两条判断原来埋在 server/index.mjs 里，只能靠读源码验证。
 */

/** 撤销未完成的搬运授权（换局、收摊、取消任务时用） */
export function pendingXiangqiCleanup(session, reason, log = console.log) {
  let revoked = 0;
  for (const [id, auth] of session.xiangqiAuth) {
    if (auth.used) continue;
    session.xiangqiAuth.delete(id);
    revoked++;
  }
  if (session.pendingXiangqi) {
    session.pendingXiangqi = null;
    revoked++;
  }
  if (revoked) log(`[xiangqi] 撤销未完成的搬运授权 ${revoked} 个（${reason}）`);
  return revoked;
}

/**
 * 为计划里的 xiangqi_move 签发一次性搬运 token。
 * 计划里的 game_id 必须就是当前这盘棋——新旧棋局可能棋子 ID 和 revision 都一样，
 * 只比对棋规状态会把上一局的搬运落到新局上。
 */
export function issueXiangqiAuth({ xiangqi, session, task, plan, log = console.log }) {
  const step = (plan.steps ?? []).find((s) => s.action === "xiangqi_move");
  if (!step) return { token: null, error: null };
  const current = xiangqi.public();
  if (!current) return { token: null, error: { ok: false, reason: "NO_GAME" } };
  if (step.game_id !== current.gameId) {
    log(`[xiangqi] 拒绝授权：计划指向 ${step.game_id}，当前是 ${current.gameId}`);
    return { token: null, error: { ok: false, reason: "STALE_GAME", gameId: current.gameId } };
  }
  const began = xiangqi.beginMove({
    pieceId: step.piece_id,
    toRow: step.to_row,
    toCol: step.to_col,
    expectedRevision: step.expected_revision,
    taskId: task.id,
    generation: task.generation,
  });
  if (!began.ok) return { token: null, error: began };
  const token = `xq-${task.id}-${++session.xiangqiSeq}-g${task.generation}`;
  session.xiangqiAuth.set(token, {
    token,
    serviceToken: began.token,
    taskId: task.id,
    generation: task.generation,
    pieceId: step.piece_id,
    from: began.from,
    to: began.to,
    expectedRevision: began.revision,
    issuedAt: Date.now(),
    used: false,
    response: null,
  });
  session.pendingXiangqi = {
    token,
    pieceId: step.piece_id,
    from: began.from,
    to: began.to,
    expectedRevision: began.revision,
    stage: "reserved",
    taskId: task.id,
    generation: task.generation,
  };
  // 只留最新一张未使用授权
  const unused = [...session.xiangqiAuth].filter(([, a]) => !a.used);
  for (const [id] of unused.slice(0, -1)) session.xiangqiAuth.delete(id);
  log(`[xiangqi] 搬运授权 ${token} ${step.piece_id} (${began.from.row},${began.from.col})→(${began.to.row},${began.to.col}) rev=${began.revision}`);
  return { token, error: null };
}
