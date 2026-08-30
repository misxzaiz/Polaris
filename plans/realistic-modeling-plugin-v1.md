# 真实三维建模插件（realistic-house）规划 v1

> 任务ID: be2c94b2 | 创建: 2026-08-31 | 状态: 起草中（调研回填后定稿）
> 验收标准: **成功建模一个老房子**——headless 生成 GLB，多材质 PBR，结构完整可辨（墙/坡屋顶/门窗/瓦/木构件），并带老化细节。

## 0. 环境事实（已实测验证）

| 项 | 结论 | 验证方式 |
|---|---|---|
| Blender | 4.5.12 LTS @ `D:/tools/blender/blender-4.5.12-windows-x64/blender.exe` | 本地 ls + 运行 |
| Principled BSDF 4.x 输入名 | `Base Color/Metallic/Roughness/Alpha/Normal/Specular IOR Level/Coat Weight/Sheen Weight/Emission Color`（无旧版 `Specular`） | bpy_probe.py 实测 |
| glTF 导出器 | `io_scene_gltf2` 可用 | 实测 import 成功 |
| PolyHaven files API | `https://api.polyhaven.com/files/<asset_id>` → `d[Map]['2k']['jpg']['url']`，贴图种类: `Diffuse/nor_gl/Rough/arm/Displacement` | curl 实测 |
| 下载速度 | 2k JPEG ≈ 25s / 4MB | 实测 brick_wall_02 |
| 插件基建 | `Polaris-plugin/plugins/blender-modeling/`，scripts/ 下 .py 自动被 `generateScriptIndex()` 扫描，schema 取自 `params_schema` 变量 | server.js:508 |

**关键推论**：
1. 纹理下载 25s/张 ⇒ **必须本地缓存**（`scripts/../cache/textures/<asset_id>/`），脚本内优先读缓存。
2. 真实感主要瓶颈不在几何，在**材质 PBR + 老化细节**。
3. 插件接入零成本：写一个 `realistic_house.py` 放进 scripts/ 即自动注册，`params_schema` 自动成为 MCP 工具参数。

## 1. 候选技术路线（对比后选定）

| 路线 | 描述 | 真实感上限 | 可控性 | 依赖 | 判定 |
|---|---|---|---|---|---|
| A. 纯 bpy 程序化几何 + PolyHaven PBR 贴图 | 代码建墙/顶/门窗，外购 CC0 纹理 | 高 | 高 | 仅网络首跑 | ✅ **主选** |
| B. 程序化 + CC0 预制件（窗棂/门/脊兽 glTF 导入合并） | 几何细节外包给现成模型 | 更高 | 中 | 模型源稳定性 | 🔄 细节阶段补充 |
| C. 建筑 CAD/参数族（IfcOpenShell/BIM） | 工程级 | 高但偏工程感 | 低 | 重依赖 | ❌ 与"老房子风化感"不符 |
| D. 图生 3D（TripoSR 等 AI 重建） | 单图出模 | 低（糊） | 极低 | GPU/在线 API | ❌ 不可复现 |

## 2. 老房子建模拆解（中国乡土老宅方向）

```
房体
├─ 基座/台基      砖石条基，出檐投影
├─ 墙体          砖墙（下部清水砖）/ 土坯抹灰（上部）混作 → PolyHaven brick + plaster
├─ 开洞          门洞/窗洞 → 非破坏 boolean（EXACT solver），洞口加木过梁
├─ 坡屋顶        双坡硬山顶：椽条阵列 + 望板 + 筒瓦/小青瓦逐片排列（错缝+随机旋转+少量缺失）
├─ 屋脊          正脊条 + 两端收头
├─ 木构件        门框/窗框/窗棂格栅（阵列 modifier）/ 檐檩 / 挑檐
└─ 附件          烟囱 / 台阶 / 门槛
老化（真实感核心）
├─ 风化斑驳      Noise+Voronoi 驱动 Mix Shader（墙体色差/漆皮剥落）
├─ 青苔霉斑      上部受潮面 AO 驱动 green 污渍
├─ 瓦面         碎瓦/缺瓦/瓦沟水渍（roughness 变化）
└─ 尘埃         檐下/墙脚粗糙度提升
```

## 3. 实施计划

- [x] 阶段0 调研（网络+本地验证）— 本文 §0/§1
- [ ] 阶段0.5 定稿选型 + 参数 schema 设计（回填调研结论）
- [ ] 阶段1 `realistic_house.py`：几何骨架（墙/顶/门窗）→ 先出无纹理白模验证结构
- [ ] 阶段1.5 材质系统：纹理缓存管线 + PBR 节点组 + 老化混合
- [ ] 阶段2 `mcp/server.js` 注册 `house_generate_3d`（或直接复用 `blender_generate_3d` 自动索引）
- [ ] 阶段3 headless 生成 → 预览 → 真实感迭代（多轮）→ 验收

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 纹理下载慢/断网 | 本地缓存 + 程序化纹理兜底（Noise/Ramp 合成砖缝） |
| boolean 开洞失败（共面/非流形） | EXACT solver + 洞口块略微超出墙面 + 失败回退手动删面 |
| 逐片瓦片面数爆炸 | 顶点数预算：瓦片用低模 plane 阵列，2k 面内；导出前 decimate 兜底 |
| GLB 纹理内嵌过大（web 预览慢） | 导出 2k jpg（非 png），纹理单张 ≤4MB |
| Blender headless 中文路径 | 输出固定 ASCII 路径 generated/ 下 |
