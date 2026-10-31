# -*- coding: utf-8 -*-
"""Finalize only after validation succeeds; hashes never include the hash file itself."""
import json,hashlib,shutil
from pathlib import Path
from datetime import datetime,timezone
P=Path.cwd();A=P/'assets/xiangqi-v1';O=P/'public/models/xiangqi-v1'
read=lambda p:json.loads(p.read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
v=read(O/'validation.json');geo=read(O/'geometry-validation.json');integrity=read(O/'integrity.json');catalog=read(O/'catalog.json')
assert geo['checksPassed'];assert v['newActionCount']==16
assert sha(P/integrity['baseFile'])==integrity['baseSha256']
anchors=read(A/'reports/anchors_blender.json');src=P/'assets/playful-interaction-v2/authoring/Whale_Playful_EDITABLE.blend';assert sha(src)==anchors['sourceSha256']
shutil.copy2(A/'reports/bake_validation.json',O/'authoring-validation.json')
manifest={'assetVersion':'xiangqi-assets-v1','generatedAt':datetime.now(timezone.utc).isoformat(),'baseCharacterSha256':integrity['baseSha256'],'sourceRigSha256':anchors['sourceSha256'],'newActions':v['newActionCount'],'totalClips':v['totalClips'],'templates':14,'initialPieces':32,'modelBytes':(O/catalog['character']).stat().st_size,'motionOnlyBytes':(O/catalog['motionOnly']).stat().st_size,'authoringFilesLocalOnly':True,'runtimeIntegrationVerified':False,'userVisualAcceptance':'piece proportions and river lettering confirmed; integrated gameplay pending'}
(O/'manifest.json').write_text(json.dumps(manifest,indent=2))
maxSkin=max(x['maxVertexErrorM']for x in geo['skinErrors']);minimum=min(len(x['candidates'])for x in geo['initialBoardApproaches']);gripMax=max(x['gripRegionOverlapVertices']for x in geo['samples'])
summary=f'''# 素材验收记录\n\n2026-10-31。自动检查已通过；用户已确认最新比例与河界文字方向，正式宿主及集成流程仍待验收。\n\n- 16 段新动作，保留全部 45 段旧动作，共 61 段。\n- 14 种棋面模板、32 枚稳定棋子 ID。\n- 原网格、蒙皮、材质、节点、旧动画和原二进制前缀保持不变。\n- 双手接触点最大偏差：{v['maxPalmErrorM']*1000:.4f} mm。\n- 抱持时前臂倾斜最大偏差：{v["maxForearmTiltDeg"]:.6f}°；手腕方向最大偏差：{v["maxWristDirectionDeg"]:.6f}°。\n- 采样姿势的蒙皮顶点近似最大误差：{maxSkin*1000:.4f} mm。\n- 起停、循环、短步支撑与动作接续检查通过，数值详见 validation.json。\n- 初始盘面 32 枚均有接近站位；每枚至少 {minimum} 个采样角度可用。\n- 车边角、炮和中兵通过基于低位轮廓的几何路线搜索。它不是正式寻路器验收。\n- 选定姿势的非握持身体/衣物深度重叠为 0；手和前臂袖口另计，最大 {gripMax} 个采样顶点。宽袖握持仍有接触区域交叠，不宣称零穿插。\n- 普通放置/吃子等待点仅验证动作与几何，真实 ACK、任务代际、任意行走相位抢占、断线恢复由执行器接入后验收。\n\n棋子：半径0.46m（格宽40%），直径0.92m，高0.2553m。\n\n场地：象棋模式 11.5×11.5m、格距 1.15m。角色/物体均单位缩放，动作不包含世界平移。\n'''
(O/'QA_SUMMARY.md').write_text(summary)
(A/'README.md').write_text('# 象棋制作素材 v1\n\n正式交接：../../docs/XIANGQI_ASSET_HANDOFF.md\n\n- authoring/：本次新的四个 Blender 文件；原模型保留不改。\n- previews/：当前角色运行时预览 PNG / MP4。\n- reports/：制作与导出验证；正式报告以 public/models/xiangqi-v1/ 为准。\n- fonts/：字体原文件、来源与 OFL。\n\n运行包已在 public/models/xiangqi-v1/；本地启动 Vite，打开 /xiangqi-assets.html 可逐段检查。\n')
# Remove only backups generated in this new asset directory during this build.
for backup in (A/'authoring').glob('*.blend1'):backup.unlink()
for root in [O,A]:
 files={str(p.relative_to(root)):sha(p)for p in sorted(root.rglob('*'))if p.is_file()and p.name not in ['SHA256.json']and p.suffix not in ['.log']and '__pycache__'not in p.parts}
 (root/'SHA256.json').write_text(json.dumps(files,ensure_ascii=False,indent=2))
print(summary)
