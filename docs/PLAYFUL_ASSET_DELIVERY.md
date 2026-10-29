# 反向持盆、敲盆和金属音效 · 素材交付 v1

2026-10-27，Codex制作。接续 [下一版方案](NEXT_PHASE_PLAYFUL_INTERACTION.md)，DeepSeek负责应用代码接入。本次没有修改服务器或原模型，没有把离线素材检查当作生产验收。

交付目录：[assets/playful-interaction-v1](../assets/playful-interaction-v1/README.md)。[预览和试听](../assets/playful-interaction-v1/previews/index.html)。

## 本次已制作

| 内容 | 交付 |
| --- | --- |
| 反向持盆 | 新外持hold，盆口朝角色左侧外方；内→外、外→内各一段 |
| 敲盆 | 双臂准备、单次击打循环、收回；可组合单次或2–4次连续敲击 |
| 金属音效 | 敲击、落地、侧边反弹3类，各4个音色变体，共12段 |
| 角色运行资产 | 83骨、45个运行片段（原39+新6）；多权重、原形态键保留 |
| Blender副本 | EDITABLE原约束rig、BAKED公共骨架、带声音的PREVIEW演示场景 |
| 配套 | 完整catalog/tracks/旧prop_motion、能力草案、音频参数、数值报告、SHA256 |

盆和直杆木柄金属勺的几何、大小、纹理均保持不变。反向持盆与敲击通过手臂和原挂点完成，没有拉长手臂、缩盆或临时变更物品比例。盆较大，放到身体前侧准备敲击时会遮住部分正面；预览提供侧面和斜侧视角供审美确认。

## 1. 运行文件与升级

`runtime/character_playful.glb` 是含全部旧片段的角色文件；`catalog.json`、`tracks.json`为对应完整表；`prop_motion.json`保持v3原有拾取/戴取/投掷曲线；盆与勺GLB原样复制，挂接矩阵不变。另新增 `audio/`、`audio_catalog.json` 和 `capability_proposal.json`。

升级时原子更新角色、catalog、tracks、资产版本；不把新片段同时加载两遍，也不混用旧播放器错误的左右臂hold规则。正在执行的任务先安全停止/对账，再切资产；旧握法存档迁移为inward。

新能力在草案中默认disabled，原因是**应用还需修复持物层、取消/租约、实例幂等，并完成运行时验收**，不是素材尚未提供。通过验收后由DeepSeek启用。

## 2. 动作参数

| clip ID | 秒数 | 轨道范围 | 事件 / 用途 |
| --- | --- | --- | --- |
| hold_basin_outward | 2.0循环 | 左臂8骨 | 外持稳定姿势，身体呼吸继续来自base |
| basin_grip_outward | 1.6 | 左臂8骨 | 1.45s grip_commit(outward)，余0.15s稳定保持 |
| basin_grip_inward | 1.6 | 左臂8骨 | 1.45s grip_commit(inward)，接回旧hold_basin |
| knock_basin_prepare | 0.7 | 双臂16骨 | 从外持盆+普通持勺姿势进入准备姿势 |
| knock_basin_hit | 0.6/次 | 双臂16骨 | 0.24s knock_contact；起止相同，可有限重复 |
| knock_basin_finish | 0.7 | 双臂16骨 | 收回右手，左盆仍outward，回到普通持勺 |

均原地、固定1×；不开放任意timeScale、力度或敲击部位。无额外root位移，无新骨骼，无材质/着色器依赖。

外持仍使用原 `bindings.leftHand`，饭勺仍使用 `bindings.rightHand`。`grip`决定使用哪个hold动作，不决定另一个神秘挂点；翻转途中物品始终随同一手骨，不能再次应用道具世界曲线造成双重变换。

### 分层接线（必须修复F02）

- 翻盆：动作接管左臂；右手持勺时保留hold_scoop，右手空闲则保留原base。
- 敲盆三段：动作接管双臂，关闭左右hold覆盖；下身、呼吸和尾巴仍由既有层管理。
- 动作结束：左手按grip恢复hold_basin或hold_basin_outward；右手如持勺恢复hold_scoop。
- `full_except_left_arm` 等旧动作含义保持“左臂由hold继续”；不能沿用当前写反的条件。
- 外持盆与walk/run/dig已经补做离线组合检查。wear/throw盆仍要求先显式切回inward；不扩展旧戴取投掷动画的适配范围。

## 3. 单次与连续敲击

工具示例：

```json
{"action":"set_basin_grip","object_id":"basin","grip":"outward"}
{"action":"knock_basin","object_id":"basin","tool_id":"rice_scoop","count":4,"tempo":"normal"}
```

这些是两条独立Step示例；以注册表定义和完整计划Schema包装，不把上面两行当成一个JSON对象。

执行顺序：prepare → hit重复N次 → finish。总时长 `1.4 + 0.6*N`；N=1为2.0s，N=4为3.8s。相对整个knock动作的敲击时刻为 `0.94 + 0.6*i`（i=0..N-1），即四次时0.94 / 1.54 / 2.14 / 2.74s。

宿主将hit的loop限制为N次，不能根据clip.loop=true无限播放。各段端点已匹配，不用在接触附近增加交叉淡化，也不能每敲一下重新从普通持勺姿势准备。

每个接触事件以 `(actionInstanceId,hitIndex)` 唯一标识。掉帧跨过事件也只能发一次；提交前复检当前实例、租约、双手物品和grip。使用catalog的 `effectPoints.knock.localPoint` 变换到实际勺模型世界位置，检查与盆表面接近；不按音效计时器伪造接触。

### 取消与收尾

- 翻盆提交前取消：停止新的任务步骤；沿当前翻转时轴反向退回原握法，或者按经验证的受控过渡收回，不能瞬切hold。提交后保留新grip，完成稳定端收尾。
- 连敲取消：立即禁止新的hit事件，保留已提交次数。击打前可沿已走路径退到ready；击打后可完成当前回程至ready，再播finish。不能跳到某个不连续的帧，也不能继续剩余敲击。
- 页面断开、租约失效、恢复等协议由代码实现，本包不声称这些已修好。
- 返回requestedCount/committedCount/实际最终grip；敲了2/4下不报全部完成。重复回包不补播声音。

## 4. 声音

全部为**原创程序化金属共振合成，非实物录音**：不谐振模态、衰减和短噪声瞬态构成敲击感；落地包含低频接触声，但没有预烘焙一串反弹。随机变体使用固定种子，可重建，无第三方音频采样。

| 文件前缀 | 变体数 | 每段时长 | 用途 |
| --- | --- | --- | --- |
| metal_knock_01…04.wav | 4 | 1.65s | 勺子主动敲盆 |
| basin_floor_01…04.wav | 4 | 2.25s | 盆落地 |
| basin_edge_01…04.wav | 4 | 1.75s | 碰墙、盆与已启用物品的碰撞 |

WAV PCM16、单声道48kHz、样本峰值约−5dBFS，12段均无削波采样。单声道供运行时空间声源定位；不能将原始波形额外硬放大后再限幅。声音来源说明见包README，原模型授权保持原约定。

推荐初始参数见audio_catalog，**这些仍需应用内试听校准**：相对法线入射速度低于0.10m/s不触发；1.8m/s为参考强碰撞；增益候选 `clamp((vn-0.10)/1.70,0,1)^0.65`；每碰撞对65ms去抖、最多6个并发声源。保留后续真正反弹，过滤持续接触/休眠抖动，禁止按碰撞后的速度决定响度。

主动敲击由knock_contact触发音效，不能再由同一次物理接触响第二次。同类别避免连续重复音色；音效只表现实际事件，不触发每一下的LLM规划。AudioContext用户点击解锁、总音量/静音、主呈现端和历史事件不补播由DeepSeek接入。

现有两个物品各有独立物理世界，跨物品碰撞未成立；要实现“盆撞到勺也发声”，仍需按方案共享局部物理世界。本包提供声音和动作，不冒充物理改造已完成。

## 5. Blender和预览

- `authoring/Whale_Playful_PREVIEW.blend`：7.8秒翻盆→四下敲击→翻回，音轨已内嵌；直接打开播放时间线，无需运行脚本。原地演示不含LLM调度。
- `Whale_Playful_EDITABLE.blend`：原约束rig的新副本，六段动作及对应盆/勺预览guide，便于继续精修。
- `Whale_Playful_BAKED.blend`：83骨烘焙版，六段新增完整骨架片段；网页完整45片段在runtime GLB中。
- `previews/index.html`：四个动作GIF、正/侧面姿态、12段独立试听和按接触时间混音的四次敲击。GIF与网页音频播放器独立；严格事件时刻以catalog及Blender预览为准。

作者脚本放在authoring/scripts，是可审查的离线制作记录，依赖上游工作区文件；不作为应用启动脚本，也不是让DeepSeek重新制作动作的任务。

## 6. 本轮检查证据

- 原39段动画JSON、网格/skin、节点及原二进制数据前缀逐项一致；仍为83骨，JOINTS/WEIGHTS_0..3保留。
- 原两个素材包74+35项SHA256均未改变。
- 原rig→烘焙→GLB回读：角色最大顶点差约 **0.018mm**，尾巴差约0.00014mm。
- 9组动作连接/循环接缝：骨位置差最大约 **0.00011mm**，报告中的骨旋转差为0°。
- 103个新动作采样 + 51个外持walk/run/dig组合采样：未发现握持容许区外身体表面相交；新动作盆勺互相相交面数为0；未穿地。
- 实际插值接触时刻0.24s：勺头与盆表面最近距离约 **1.09mm**，避免硬穿金属面。
- Three.js实际加载最终合并GLB、组合base/持勺/新动作，与完整新动作GLB比对：非尾巴骨位置差最大约 **0.00010mm**。尾巴是有意保留的独立运行层，不用其idle相位差判断手臂出错。
- 12段音频格式/长度/峰值/削波检查通过。音色试听和运行时碰撞音量仍需用户/应用验收。

以上为离散几何与离线运行数据验证，不是连续碰撞证明，也不是服务器已经启用。DeepSeek仍须验证真实播放的hold让位、有限循环、事件去重、取消、双客户端、刷新恢复，以及浏览器声音解锁和混音。

建议交接：先修最新review的F02/F05/F06/F07等执行基础，再按本文件接入本包；新增素材已由Codex完成，不再要求DeepSeek代做模型或动画。
