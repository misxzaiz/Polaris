# Polaris 视觉现代化 v3 — 选型决策指南

> 本文配套原型:`docs/design/prototypes/polaris-visual-modernization-v3.html`
>
> 用浏览器打开即可。原型在右上角提供 4 个风格切换按钮,可以实时对比同一布局在不同视觉语言下的呈现。

## 决策背景

经过两轮规划讨论(v1 / v2),结构方向已锁定为 **v2-A Agent Board First**:

- 顶部 Agent Control Bar(融合工作区、会话、引擎/模型/Effort/权限、运行状态、Board/Single 切换)
- 左侧 Context Sidebar(按 Context / Changes / Run / Integrations 分组)
- 中间 Agent Board(Multi-Session 网格 + Session Tabs + 单会话可展开)
- 右侧 Session Dock(可钉住,默认 pinned)
- 底部 Run Dock(Terminal / Problems / Scheduler Logs / Tool Output)

**v3 不再讨论"选哪种布局",而是回答"v2-A 用哪种视觉语言落地"。**

## 4 种视觉风格对比

| 维度 | Graphite Minimal | Glass Cockpit | Warm Studio | Compact Pro |
|---|---|---|---|---|
| 定位 | 推荐默认 | 差异化 / 演示 | Claude 风 / 长时间 | 高密度 / 多并发 |
| Canvas 基色 | `#14161a` 中性石墨 | 深空蓝紫渐变 | `#1a1715` 暖灰 | `#0c0d10` 极深冷 |
| Accent | `#7c9cff` 柔和蓝 | `#a78bfa` 紫 + `#22d3ee` 青 | `#d97757` Claude 橙 | `#7c8cf0` Linear 紫蓝 |
| 圆角 | 6 / 8 / 10 | 8 / 12 / 14 | 8 / 12 / 14 | 4 / 6 / 6 |
| 字号基础 | 13px | 13px | 13px | **12px** |
| 边框 | 极弱 α=0.055 | 半透明 + 内描边 | 柔和暖白 α=0.06 | 弱 α=0.05 |
| 阴影 | 平面化 | 玻璃光晕 + 紫光 | 深邃柔和 | 锐利低调 |
| 背景特效 | 无 | `backdrop-filter: blur(16px)` | 无 | 无 |
| 适合场景 | 工程师日常 8h+ | 产品演示 / 截图营销 | 写作创作 / 协作 | 多会话并发 / 大屏 |
| 性能影响 | 最低 | 较高(blur) | 低 | 最低 |

## 推荐路线

### 主推:Graphite Minimal(默认)

理由:
1. **视觉噪音最低**——直接回应 v2 报告中"暗黑过重、边角太显眼"的核心痛点
2. **工程化场景最友好**——适合开发者长时间使用
3. **实现成本最低**——纯 CSS 变量,无 backdrop-filter / 渐变开销
4. **可演化性强**——后续可以从它派生出亮色版

### 备选:Warm Studio(Claude 风)

理由:
1. **品牌契合**——Polaris 主要面向 Claude Code 用户,色调统一性强
2. **长时间舒适度高**——暖调对眼睛刺激更小
3. **与现有 Anthropic 生态视觉协调**

### 不推荐作为默认:Glass Cockpit / Compact Pro

- **Glass**:`backdrop-filter` 在低端机和某些 Tauri 配置下性能差;视觉过于"营销化",不像专业工作台
- **Compact**:12px 基础字对中文不友好,会让密集面板更难读;适合作为"密度模式"开关,而非默认

## 推荐落地策略

```
默认主题 = Graphite Minimal
+ 用户可选切换 = Warm Studio
+ 设置开关 = "紧凑模式"(借鉴 Compact Pro 的字号与圆角)
+ Glass 仅作为演示页 / 启动屏可选效果
```

## 可交互演示功能

打开 HTML 后可以测试:

| 操作 | 效果 |
|---|---|
| 右上角切换按钮 / `Cmd+1~4` | 实时切换 4 种视觉风格 |
| 顶部 `Single` / `Board` 按钮 | 切换 Agent Board 的网格 / 单会话模式 |
| Session Cell 右上角对角箭头 | 单会话展开为全屏沉浸态 |
| Session Dock 右上角图钉 | 切换钉住 / 悬浮态 |
| Run Dock 右上角向下箭头 | 折叠 / 展开底部区 |
| 左侧 Sidebar / 顶部 Session Tab / Dock 列表项 | 点击切换 active 态 |
| 待回答 Question Card 上的按钮 | 模拟回答交互 |

## 高保真细节

为保证原型对最终视觉效果有指导意义,以下细节均按生产级别设计:

- **状态色系统**:running(青/绿)、waiting(琥珀)、question(粉/红,带 blink 动画)、idle(灰)
- **运行状态可视化**:顶部"3 个会话运行中"带 pulse 动画;Session Cell 头部状态点带 glow
- **微交互**:消息进入动画(`msgIn`)、终端光标闪烁(`cursor-blink`)、待回答 blink
- **真实内容**:所有会话标题、文件名、commit message、工具调用都贴近 Polaris 实际场景(ChatStatusBar 拆分、Git 样式迁移、PanelHeader 测试等)
- **完整工具调用块**:Grep / Read / Edit 状态 + 代码 diff 展示
- **空状态友好**:每个 Cell 都有 footer input,即便单 Cell 也可独立操作

## 下一步

请基于原型选定方向后告诉我:

1. **主题选择**——Graphite / Warm / 双主题切换 / 其他?
2. **是否需要补充**:
   - 亮色主题对应版本(Daylight)
   - 紧凑模式开关原型
   - 启动页 / Workspace Home 原型
   - Settings 重构原型
3. **进入实施阶段后**:我可以输出 `tokens.css` + `tailwind.config.js` 改造 patch + 关键组件(`AppShell`、`AgentControlBar`、`ContextSidebar`、`SessionDock`、`RunDock`、`SessionCell`)的脚手架代码。

## 文件位置

- 原型 HTML:`D:\space\base\Polaris\docs\design\prototypes\polaris-visual-modernization-v3.html`
- 决策指南:`D:\space\base\Polaris\docs\design\polaris-visual-modernization-v3.md`(本文)
- 历史规划参考:
  - `polaris-layout-redesign-plan.md` (v1)
  - `polaris-agent-first-layout-v2.md` (v2)
  - `prototypes/polaris-layout-redesign.html` (v1 原型)
  - `prototypes/polaris-agent-first-prototypes-v2.html` (v2 原型)
