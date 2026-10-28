# 启幕 qimu —— AI PPT 工厂（可编辑 PPTX 文件交付）spec

> 状态：2026-10-29 **已实施并验证**（插件仓 commit `edf00cd`，未 push）。
> 验证：core 单测 7/7、MCP 协议 9/9（含有宿主/无宿主双环境自清理）、**产物级验收 5 主题全绿**
> （全版式渲染 → python zipfile 完整性 + python-pptx 结构断言：页数/16:9 画布/图表类别与数据/表格结构/关键文本）、
> 真桥冒烟全绿（临时导出目录+settings 恢复，桌面零残留）、forge manifest 体检通过、面板 tsc+esbuild 产包 646KB。
> 遗留：面板 UI 浏览器交互验证未完成（本会话 IAB webview 不可用；harness.tsx 工具链已留仓，一条命令可复验）。

## 1. 一句话定位

在 AI 对话里直接把主题、大纲或已有资料变成一套排版完整、**可继续编辑的 PPTX 文件**：
布局引擎本地直生 OOXML（非网页画布转换，杜绝 Gamma 式导出崩版），零额度零会员，
内容不出设备；面板无需 AI 也能用大纲语法独立构建并下载。

## 2. 需求证据（已证实）

- **赛道被极致验证**：Gamma 2025-11 完成 6800 万美元 B 轮、估值 21 亿美元，**7000 万用户、60 万付费订阅、$1 亿 ARR**（50 人团队、纯口碑增长）；AI PPT 赛道 Top3 产品流量月涨 30%+。
- **四个已证实的用户抱怨**（国内实测横评，什么值得买/知乎/SegmentFault）：
  ① 导出可编辑 PPTX 要会员（免费只给 PDF）；② Gamma 等导出 PPTX **排版崩坏、二次编辑成本高**（网页画布转 PPTX 的结构性缺陷）；③ 免费生成额度少、超出订阅；④ 返工比手做还慢、模板化严重。
- **本产品的差异化**正好逐条对应：本地直生原生 OOXML（排版引擎产出，非转换）→ 可编辑不崩版；插件形态 → 零额度（成本只是自己的 LLM token）；本地生成 → 内容不出设备；对话原生 → 不用另开网站上传资料。
- **开源侧活跃**（Presenton 自托管 Gamma 替代、PPTAgent、pptxgenjs/python-pptx 生态）证明技术路线成熟，但均为独立服务/Docker 部署——「插件内零安装、对话直出」仍是空位。

## 3. 候选筛选（15 候选中选出）

16 个初始候选覆盖文档/PPT/视频/图像/音频/3D/CAD/数据/网页等领域，全部按「是否交付真实文件级成果」重审：视频剪辑与音频处理（ffmpeg 依赖不确定+工程量不成比例）、CAD/机械（专业验证闭环无法在插件内完成，安全责任不可接受）、3D 建模（animation-3d 已桥接 Blender）、一句话建应用（zcode-bridge 已覆盖编程代理+前会话已规划 FlashForge）、海报设计（字体渲染环境风险+agnes 已覆盖 AI 图）、Excel 报表（第二名：exceljs 可行但 Excel Copilot 类在位者强、人群窄于 PPT）、DOCX 公文（中文排版验收成本高，WPS AI 已做）均被淘汰。

**AI PPT 工厂加权得分 88/100**：需求与痛点 20%（Gamma 体量+四抱怨实证）、收益与付费潜力 15%（在位者收费的产品，本地免费就是收益）、竞品缺口 15%（本地×对话×原生可编辑×零额度四交集无在位者）、成果实用价值 15%（真实可编辑文件）、频率与人群 10%（职场/学生/教师周频）、技术可行性 10%（已实证：pptxgenjs 产合法 OOXML，python-pptx 验收器可断言）、平台契合 10%（MCP 原生进程写文件+面板 blob 下载，零宿主改动）、维护成本 5%（vendored 单文件库，零原生依赖）。

## 4. 数据与文件契约

**Deck Spec（AI 面与面板共用的中间表示，camelCase）**：

```jsonc
{
  "title": "…", "subtitle": "…", "author": "…",
  "theme": "midnight|ink|sky|ember|paper",
  "slides": [
    { "type": "cover" },                                    // 自动取 title/subtitle/author
    { "type": "section", "title": "…", "note": "…" },       // 章节页
    { "type": "bullets", "title": "…",
      "bullets": [ "plain" | { "h": "小标题", "d": "说明" } ] },   // ≤6 条
    { "type": "two", "title": "…",
      "left": { "h": "…", "points": ["…"] },
      "right": { "h": "…", "points": ["…"] } },             // 每侧 ≤5 点
    { "type": "quote", "text": "…", "author": "…" },
    { "type": "chart", "title": "…", "note": "…",
      "chart": { "kind": "bar|line|pie", "labels": ["…"],
                 "series": [{ "name": "…", "values": [n] }] } },  // ≤8 labels ≤3 series
    { "type": "table", "title": "…", "head": ["…"], "rows": [["…"]] }, // ≤8 行 ≤6 列
    { "type": "end", "note": "…" }
  ]
}
```

**cap.kv `qimu.` 键空间**：`qimu.deck.<id>` → { id, file, title, theme, slideCount, path, ts }（作品登记，供 ppt_recent 与面板列表）；`qimu.settings` → { schemaVersion, exportDir?, theme? }。
**文件输出**：`{exportDir}/qimu-YYYYMMDD-HHmm-{标题净化}.pptx`；exportDir 缺省=用户桌面（探测失败退 Downloads/家目录），面板可改（经 cap.kv 与 MCP 共享）。

## 5. 核心机制（shared/core.js 单权威）

1. **Spec 归一化与容量护栏**：每类版式有硬性容量上限（bullets≤6、two 每侧≤5、chart≤8 标签/3 系列、table≤8×6、字符串长度上限），超限**报错让 AI 拆页**而不是缩字硬塞——这是「不崩版」的第一道保证。
2. **布局数学**：16:9（13.333×7.5in），每类版式一个确定性布局函数（位置/字号/留白全部算出）；标题与正文按字数 auto-shrink（CJK=1em、ASCII≈0.52em 估宽），仍超限的截断并标记。
3. **主题系统**：5 套完整主题（深 3 浅 2：midnight/ink/sky/ember/paper），每套 8 色 token + 字体对；所有版式只消费主题 token。
4. **渲染器**（vendor pptxgenjs UMD 单文件，零 npm 运行时依赖）：spec → OOXML buffer；node 侧写文件、panel 侧产 blob 下载。
5. **交付**：MCP 原生进程写文件 + `explorer /select` 定位（douyin-publish 同类先例）；面板侧同引擎 blob 下载（面板桥白名单不含 explorer，故 reveal 仅走 MCP/对话）。

## 6. MCP 工具（5 个）

| 工具 | 作用 |
|---|---|
| `ppt_build` | 核心：deck spec JSON → 真实 .pptx 落盘 + cap.kv 登记 → 返回路径/页数/主题摘要 |
| `ppt_guide` | 给 AI 的版式说明书（7 类版式的容量规则+一个最小完整示例），AI 先读再拼 spec |
| `ppt_reveal` | 在资源管理器中定位文件（win explorer /select，mac open -R，linux xdg-open 目录） |
| `ppt_recent` | 最近作品列表（标题/页数/路径/时间） |
| `ppt_forget` | 删除作品登记（confirm=true；不删文件本身） |

## 7. 面板（React，三 Tab：创作 / 作品 / 设置）

- **创作**：大纲 DSL 文本框（`# 章节页` / `## 内容页标题` + `- 要点` / `> 引言` / `%图表 kind|标签|系列值` / `|表格|表头|行`）→ core 解析为 spec → **HTML 网格实时预览**（按主题 token 与布局比例近似渲染，明示「预览≈最终版式」）→ 本地构建（同引擎 blob 下载 .pptx，无需 AI）+ 主题选择。
- **作品**：cap.kv 登记列表（标题/页数/时间/路径，复制路径按钮；打开目录引导用户找 MCP/对话）。
- **设置**：导出目录、默认主题、字体偏好。

## 8. 安全与隐私

- 零外网请求、零后台常驻服务（MCP 按需 stdio）；内容只经用户已配置的 LLM 通道。
- 文件只写到用户可见的导出目录（默认桌面），不碰系统目录；路径净化防目录穿越（`../`、非法字符剥除）。
- spawn 仅白名单三条 shell 命令（explorer/open/xdg-open），参数单文件路径不可拼接注入。
- 删除仅删登记不删文件（破坏面最小）。

## 9. 验收口径

- 单测（node --test）：spec 归一化/容量护栏/大纲 DSL 解析/溢出估算/主题完整性。
- **产物级验收（render-verify）**：渲染含全部 7 类版式的完整 deck → python zipfile 校验 zip 完整性 → **python-pptx 打开断言**（页数、每页形状构成、中文文本、图表类型与数据）——产物必须是 PowerPoint 兼容的可编辑文件。
- MCP 离线协议验证 + 真桥冒烟（构建落盘→登记→recent→forget，自清理；reveal 做成 opt-in 不自动弹窗）。
- 面板 tsc + esbuild 构建 + 打包上架（图标白名单 Film）。
