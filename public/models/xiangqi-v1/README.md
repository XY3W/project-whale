# 中国象棋素材 v1

用户验收修订：半径=格宽40%（0.46m），直径占格宽80%，厚度按最新意见加倍至0.2553m，取消深蹲拾取，双手水平夹托，棋子飞入/飞出。

16 段新动作、14 种棋面模板、32 枚棋子初始布局、棋盘与腰挂勺契约。

- 开发入口：`docs/XIANGQI_DEVELOPMENT_HANDOFF.md`。素材契约：`docs/XIANGQI_ASSET_HANDOFF.md`。
- 最终尺寸已经烘入网格；加载时不得再执行历史的“减半、加倍或×1.15”。汉界相对楚河旋转180°。
- 本地可视验收：运行项目 Vite 后打开 `/xiangqi-assets.html`。
- `character_xiangqi.glb` 保留当前材质眨眼模型全部网格/蒙皮/材质和原有45段动作，只追加16段新动作。`motions.glb` 是需按节点名重新绑定的轻量替代包。
- 参数与事件：`catalog.json`。曲线：`prop_motion.json`。布局：`initial_layout.json`。
- 棋盘格距1.15m，象棋模式临时切换至11.5×11.5m，棋盘铺满地板并隐藏16×16网格；不能把本素材整体缩回8m再沿用握点。
- `validation.json` / `geometry-validation.json` 记录素材检查范围；它们不证明正式棋规、宿主寻路、联网事务或任意相位中断已实现。

棋身、木纹与棋盘为本次自行制作。字面由思源黑体栅格化，见 `FONT_SOURCE.md` 和 `FONT_LICENSE.txt`。角色和既有盆/饭勺沿用原授权；本包没有重新授权角色。
