# 真实三维建模插件（realistic-house）规划 v1

> 任务ID: be2c94b2 | 创建: 2026-08-31 | 状态: **全部完成**（阶段1几何 → 1.5材质 → 2插件接入 → 3真实感迭代，验收达成）
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

## 1.5 网络调研回填（2026-08-31，两子代理已完成，关键项已 API 实测核实）

### A. 几何手法（可落地的 bpy 方案）

**门窗开洞首选「预切面」而非 boolean**（ranjian0/building_tools 的做法）：先在墙面按洞口网格细分出四边形 → `bmesh.ops.inset_region(thickness=洞宽, use_even_offset=True)` → `extrude_face_region` 内推形成框。零 boolean、零碎面；`btools/building/window/frame.py::add_frame_depth()`（face-hash 追踪挤出前后归属）可直接参考。boolean 仅作兜底，已知坑：cutter 必须穿出墙面≥0.001 且洞口四边比洞大 0.001（frame 遮缝）、transform_apply(scale=True) 防非均匀缩放坏法线、墙体须封闭实体、先 remove_doubles(1e-4)+normals_make_consistent；EXACT 失败换 FAST。

**屋顶分层构造**：椽条（cylinder r=0.025 + Array modifier, use_object_offset, 椽档 0.24m）→ 望板（坡向剖面 extrude + Solidify 0.015~0.02）→ 挂瓦条（方料 Array，间距=瓦露明 0.15m）→ 瓦。屋面坡度由剖面顶点 y=±tan(27°)·(进深/2+出檐) 统一定义，各层共用同一坡面基准防角度漂移。

**小青瓦铺设三法取舍**：Array modifier 最快但无随机抖动；**纯 bmesh 拷贝（推荐终稿）**——模板瓦一次 from_object，循环 `bmesh.ops.duplicate` + matrix=基准@Row_i@Col_j，顺手加 ±2° 转角/±5mm 高差随机（单瓦 24~64 tri，100m² ≈3300 片 ≈ 8~21 万 tri，预算内）；Geometry Nodes 仅编辑期 instance、导出前才 realize。面数超预算时降为 24 tri 低模 + normal map。

**木构架**：柱 cylinder r=0.12（柱高/10），梁/檩用穿插盒体不建真榫头，柱头 inset_region 收分；重复构件用 Collection Instance（不复制 mesh 数据）。

### B. 开源参考（全部 GitHub API 核实真实存在）

| 仓库 | 可借鉴点 | 许可证 |
|---|---|---|
| [ranjian0/building_tools](https://github.com/ranjian0/building_tools) 1504★ | `create_gable_roof`（extrude_and_outset+inset_region 做挑檐）、门窗框 face-hash 追踪 | MIT |
| [s-leger/archipack](https://github.com/s-leger/archipack) 381★ | 参数化属性↔自动重建 bmesh 的驱动骨架 | GPL-3.0 |
| [roberlarues/Roofeus](https://github.com/roberlarues/Roofeus) | 2D 模板瓦 UV 投影贴任意坡面——小青瓦直接可用 | MIT |
| [lsimic/ProceduralBuildingGenerator](https://github.com/lsimic/ProceduralBuildingGenerator) | random.seed 可复现的模块化门窗排布 | GPL-3.0 |
| [bijoor/wadi](https://github.com/bijoor/wadi) | 参数→bpy→Web 预览整链路参考 | MIT |
| blender-procedural-room-generator (KuzeyKayraEyioglu) | 预切面开洞思路印证 | MIT |

中文古建 bpy 专项搜索：**无成熟可抄仓库**（已搜索核实），需自建。

### C. 老房子默认参数表（写进代码的初值；多为行业通例，已标注未核实）

| 参数 | 默认值 |
|---|---|
| 开间（明间/次间） | 3.6 / 3.3 m（范围 3.0~3.9，未核实） |
| 进深 | 4.8 m（未核实） |
| 檐柱高 | 2.8 m（未核实） |
| 屋面坡度 | 27°（五举惯例，未核实） |
| 标准砖 | 240×115×53mm，灰缝 10mm（未核实标准号） |
| 小青瓦 | 长 200 / 宽 155~180 / 厚 10mm；纵向搭接后露明 150~160mm；垄步距 200mm（未核实） |
| 出檐 | 0.6m（飞椽 +0.2m）；椽档 0.24m；望板厚 0.015m；苫背 0.03~0.08m；柱径 0.24m |

### D. 材质/做旧节点手法（bpy 节点结构，headless bake 正好用 Cycles 的 Pointiness）

1. **污渍/edge wear**：`Geometry.Pointiness → ColorRamp(0.45~0.55 收窄)` → 驱动 Mix 污渍色与边缘磨损亮色
2. **色斑+粗糙度**：Noise(3-6, detail 8-16) → ColorRamp → Mix 双色斑；Voronoi(F1, 8-15) → ColorRamp ×0.4 → Roughness
3. **青苔只长朝上面**：`Geometry.Normal.Z → Map Range(0.55→1.0)` × Noise(20) → mask → Mix 深绿 + Bump + Roughness 0.9
4. **水渍流挂**：Object Z → ColorRamp(顶部强) × Noise(Mapping.Scale=(1,1,12)) → 暗色 + Roughness+0.2
5. **漆皮剥落**：Noise(2, 6) 二值化 mask → 两层 Mix（漆色/底层木色）+ Pointiness 边缘高光 + Bump 台阶

### E. CC0 材质清单（PolyHaven id 全部经 API 核实，均含官方 gltf 贴图包）

| 用途 | 已核实 asset_id |
|---|---|
| 清水砖墙 | brick_wall_006 / castle_brick_02_red / mossy_brick |
| 抹灰/土坯墙 | clay_plaster / worn_mossy_plasterwall / peeling_painted_wall |
| 屋面瓦 | clay_roof_tiles_02 / ceramic_roof_01 / roof_tiles_14 |
| 旧木 | weathered_planks / wood_peeling_paint_weathered / beam_wall_01 / moss_wood |
| 地面泥土 | dirt_floor / park_dirt / brown_mud_dry |
| 青苔/灰尘 | PolyHaven 无纯苔藓/dust（已核实）→ ambientCG Moss002 / SurfaceImperfections014 替代（id 已核实） |

### F. GLB 导出关键结论（决策依据）

- **程序化节点图无法进 GLB**（已核实 Blender 4.2 官方文档）：glTF 2.0 材质是固定参数块，导出器只识别 Principled BSDF 直连的 Image Texture；程序化做旧效果**必须 bake**。
- **headless Cycles bake 最小集**：engine=CYCLES, samples=1, CPU → `bake(DIFFUSE, pass_filter={COLOR})`（关直/间接光防 AO 混入）、`ROUGHNESS`、`NORMAL`、`AO`；numpy 从 pixels 合成 **ORM**（R=AO, G=Rough, B=0）→ 每材质 3 张：BaseColor/Normal/ORM。
- **AO 不烘进 Diffuse**（动态光下双重变暗），走独立 occlusion 通道。
- **预算**：主立面/屋面 2048，次要 1024；10~12 材质 × 3 ≈ 30~36 张，PNG 80~120MB → KTX2(ETC1S/UASTC) 可压至 15~25MB；UV 用 Smart UV Project，bake margin ≥8px。
- **不 bake 的省钱替代**：程序化 mask 在 CPU 端写入**顶点色**（mesh.color_attributes，RGBA 存苔藓/污渍/剥落三通道）→ GLB 原生导出 COLOR_0 → three.js 端混色，大平面效果最划算。
- **建议路线**：静态构件 bake 三张图；苔藓/流挂大尺度 mask 走顶点色。

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

- [x] 阶段0 调研（网络+本地验证）— 本文 §0/§1.5（两路子代理调研已回填定稿）
- [x] 阶段0.5 定稿选型 + 材质方案（路线A；GLB 走 bake 三张图 + 顶点色 mask，见 §1.5-F）
- [x] 阶段1 `realistic_house.py`：几何骨架（预切面开洞/分层屋顶/bmesh 瓦阵列）→ 先出无纹理白模验证结构
  - ✅ 4面墙 + 台基（预切面拼装开洞：1门 + 4窗，未走 Boolean solver——headless 下逐面墙按开洞拆条状网格更稳，洞口自带规整环边）
  - ✅ 坡屋顶分层：椽条阵列(44×2) + 望板 + 挂瓦条(16×2) + 小青瓦(~2003片，带随机抖动/少量缺失)
  - ✅ 屋脊 + 脊端收头
  - ✅ 木构架：8柱 + 3檩（前/后/中）
  - ✅ 附件：烟囱 + 台阶(3级) + 门槛
  - ✅ 顶点色通道预留（苔藓/污渍/剥落三通道）
  - 📦 输出：`docs/ai-3d-modeling/poc/output/house_white.glb`（510KB, 252 meshes, 13 materials）
- [x] 阶段1.5 材质系统：纹理缓存管线（cache/textures/<asset_id>/）+ PBR 节点组（§1.5-D）+ Cycles bake 三张图（§1.5-F）+ 顶点色做旧 mask
  - ✅ `bake_house.py`：导入白模 → 按材质合并 8 物体 → Smart UV → PolyHaven 下载缓存 → Cycles bake DIFFUSE/ROUGHNESS/NORMAL/AO(16spp) → numpy 合成 ORM（R=AO G=Rough）→ 顶点色做旧 → GLB 导出（JPEG q85）
  - ✅ 实测与计划差异：bake 分辨率提到 4096（主材质 brick/plaster/tile）+ 2048（其余 5 材质），单材质 3 张图改为 Diffuse/Normal/ORM 3 张内嵌（计划 §1.5-F 预估 30~36 张 PNG 80~120MB 未发生）；8 材质全部单 Principled + 3 图，GLB 体积 28.9MB（未走 KTX2，JPEG 内嵌已达标上限附近）
  - ⚠️ 遗留优化：瓦面 bake 图 93.5% 黑（UV 岛稀疏浪费）；KTX2 压缩可再省 ~60%
- [x] 阶段2 插件接入（scripts/ 自动索引即成 MCP 工具，必要时独立工具名）
  - ✅ bake_house.py 自动扫描注册为 `blender_generate_3d` 可选 script，9 参数 schema 暴露给 AI
  - ⚠️ 接入踩坑三则（已修）：params_schema 末属性尾逗号致解析静默失败；server.js 超时钳制 600s 不够完整 bake（已提到 1800s，实测 1135s）；stdout 须显式 print `Created N objects` 供 partsMatch 统计
- [x] 阶段3 headless 生成 → 预览 → 真实感多轮迭代 → 验收"成功建模一个老房子"
  - ✅ MCP 真实调用 `blender_generate_3d(script=bake_house, timeout=1200000)` 全链路 1135s 产出 27.8MB GLB（170460 v · 90832 tri · 8 材质）
  - ✅ 迭代1（色彩）：bake DIFFUSE 以 Non-Color 存盘被 three.js 按 sRGB 读 → 整体过暗 ~2.2 次方；修复为存盘前置 sRGB（save_bake_image）
  - ✅ 迭代2（做旧 mask 失效）：POINT/FLOAT_COLOR 域 + glTF 导出→导入循环污染 datablock 隐藏状态 → forced 白 COLOR_0 + aging 挤进 COLOR_1（three.js 只读 COLOR_0）→ 整栋土黄。修复：while 循环删净旧 color 属性 + CORNER/BYTE_COLOR + export_vertex_color='ACTIVE' + rebuild_mesh_datablock 全新 datablock 直通
  - ✅ 迭代3（苔藓分布）：屋顶 27° 坡整面 nz≈0.89 均过"朝上"判定 → 整坡全绿；叠加物体高度衰减（檐口浓/脊部淡）+ 噪声阈值 0.42→0.52，斑块占比降至 ~1/3
  - ✅ 浏览器 ON/OFF 对比验收：结构齐全（墙/坡屋顶/门窗/窗棂/瓦/木构件/烟囱/台基/台阶）、砖墙亮度恢复源图、苔斑/污渍/剥落自然分布
  - 📦 产物：`generated/realistic_house_textured.glb`（28.9MB）；预览 `generated/index_textured.html`（PolyHaven PBR + bake + 顶点色做旧开关）

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 纹理下载慢/断网 | 本地缓存 + 程序化纹理兜底（Noise/Ramp 合成砖缝） |
| boolean 开洞失败（共面/非流形） | EXACT solver + 洞口块略微超出墙面 + 失败回退手动删面 |
| 逐片瓦片面数爆炸 | 顶点数预算：瓦片用低模 plane 阵列，2k 面内；导出前 decimate 兜底 |
| GLB 纹理内嵌过大（web 预览慢） | 导出 2k jpg（非 png），纹理单张 ≤4MB |
| Blender headless 中文路径 | 输出固定 ASCII 路径 generated/ 下 |
