# 插件 UI 贡献规范（Plugin UI Contribution Spec）v1.0

> 状态：**v1.0 已确定**（用户 2026-11-07 拍板，同日确认全量范围：宿主提供插件开发支持后，
> form / ask / prd 已实现渲染内容**全部退役删除**，由交互组件插件提供对应模板与自定义支持）
> 地位：本规范是**所有插件 UI 贡献**（面板 / 聊天卡片 / 块委托 / 模板 / 组件）的准入门约。
> 交互组件插件（`interactive-component`）是第一个按本规范落地的实现；后续任何插件的
> 面板注册、模板注册、卡片渲染一律以本规范为准。
> 下游：`interactive-component-implementation-plan.md` 已按本规范条款号（[R-*]/[S-*]/[N-*]）
> 合规对齐 → 独立 worktree 实施（`git worktree add ../polaris-ic -b feat/interactive-component main`）。
> 用词约定：**必须**=强制（违反即验收拒绝）；**应当**=默认要求（偏离需在 spec 注明理由）；**可以**=可选。

---

## 1. 分层模型（总纲）

[R-1] 插件 UI 一律按四层归类，**渲染可外移，语义永不外移**：

| 层 | 归属 | 内容 |
|---|---|---|
| 触发层 | 各处 | MCP 工具结果 / AI DSL / 伴生进程事件 / 块事件 |
| 语义层 | **宿主** | 信任边界（form_core）、oneshot 消费、审计、hold 失效语义 |
| 渲染层 | **插件可贡献** | 模板 / 卡片组件 / 自由 HTML（iframe 沙箱） |
| 能力层 | 宿主门控 | form_submit / cap 调用桥（声明白名单） |

[R-2] 语义层数据结构与动作协议是**冻结面**：插件贡献只消费不修改。FormBlock/QuestionBlock/
PreviewArtifact 等块类型变更走宿主协议 spec，不允许插件侧扩展字段语义。

[R-3] 一个渲染贡献**必须**声明自己的触发来源归属（chatCards→mcpServerId；blockRenderers→blockType；
uiTemplates→templateId 命名空间），禁止跨归属渲染（如渲染他插件的私有 marker 结构）。

## 2. 贡献点契约

### 2.1 `contributes.views` + `contributes.panel`（既有，沿用）

[R-4] 面板入口 `views[].panelType` 全局唯一；`panel.entry` 相对插件目录；面板 JS 经
`loadModuleFromFile` 加载——**必须自包含**（除 react 经宿主 shim 外，禁止裸导入宿主模块）。

### 2.2 `contributes.chatCards`（既有，本规范修订两点）

[R-5] `card.mcpServerId` **必须**属于本插件 `contributes.mcpServers[].id`（registry 既有校验，维持）。
[R-6] 已安装插件（非内置壳）**必须**声明 `card.entry`（bundle 路径）；内置壳形态逐步退役，不再新增。
[R-7] `card.tools` 按工具名精确匹配；工具下线**必须**保留卡片匹配别名或迁移声明（见 §5 兼容规则）。

### 2.3 `contributes.blockRenderers`（**已撤销 2026-11-08**——块委托渲染）

> ⚠️ **本贡献点已整体撤销**：真机实锤插件 bundle 与宿主 react shim 导出面对齐过于
> 脆弱（ask-card 用 useReducer → blob 模块整体加载失败 → form/question/组件三通道
> 全灭），form/ask 块渲染回归宿主原生（FormCard/AskQuestionCard）。宿主与插件仓
> 相关实现均已拆除，以下 [R-8..R-11] 仅作历史记录，勿据此实施。详见
> interactive-component-implementation-plan.md §10。

```jsonc
"blockRenderers": [{ "blockType": "form" | "question", "entry": "./dist/blocks/form-card.js" }]
```

[R-8] `blockType` **必须**在宿主开放白名单内（首期：`form`、`question`）；白名单由宿主 spec 修订扩展，插件不得声明未开放类型。
[R-9] 委托组件收 `props: { block }`，`block` 为宿主块类型原样（协议冻结，[R-2]）；回传**必须**经 `polaris-host/form` 桥，禁止自联 dispatch。
[R-10] 委托未命中（插件禁用/加载失败）**必须**有宿主兜底渲染（工具名 + 折叠 JSON，复用 PluginCardFallback 形态）——委托是优化，不是单点。
[R-11] 同一 `blockType` 多插件声明时：先注册者生效 + warn 日志（对齐模板覆盖 owner 惯例），插件仓 index.json 展示实际生效方。

### 2.4 `contributes.uiTemplates`（新增——第三方模板注册）

```jsonc
"uiTemplates": [{ "id": "<pluginId>/<tplId>", "title": "...", "schema"?: {...}, "entry"?: "./dist/tpl.js", "html"?: "..." }]
```

[R-12] `id` **必须**以插件 id 为命名空间（`<pluginId>/<tplId>`）；内置模板 id（`ask-card`/`form-card`/`artifact-card`/`chart-card`）为保留名，第三方**不得**注册或覆盖（覆盖权限=L4 语义，对齐 cap 覆盖分级惯例）。
[R-13] `entry` 与 `html` 二选一：`entry` 走既有模块加载；`html` 为「卡片即数据」静态模板（占位符插值，禁脚本——脚本类需求走自由组件）。
[R-14] 模板与宿主 `ui.template` 域（ui_render_capability v2）**同域治理**：owner 记录、persist 落 Storage、覆盖更新带 warn——禁止另建第三套模板机制。
[R-15] AI 侧引用：工具结果 marker `{ template: "<pluginId>/<tplId>", data }` → 通用渲染；引用未注册模板**必须**回落兜底卡（不静默空白）。

### 2.5 `contributes.chatActions`（预留，roadmap W2 契约）

[R-16] Chat 状态栏/会话菜单动作注册：声明式 `when` 显隐条件 + `invoke`（panel 路由或 MCP 工具）；
禁止插件直接挂载宿主组件实例。首版随 W2 契约批落地。

## 3. 宿主桥规范（`polaris-host/*`）

[S-1] 桥是宿主向插件开放的**唯一**宿主能力通道。桥清单封闭管理：

| 桥 | 内容 | 状态 |
|---|---|---|
| `polaris-host/react` | React/JSX runtime shim | 既有 |
| `polaris-host/artifact` | ArtifactPreviewRenderer + 归一化 + 版本组 + 源码查看 + postMessage 桥 | 本规范新增 |
| `polaris-host/form` | registerComponent / submitForm / skipForm / answerQuestion 薄封装 | 本规范新增 |
| `polaris-host/cap` | 声明白名单内的 router_dispatch 转发 | 本规范新增（最严门控） |

[S-2] **桥准入规则**：桥内代码必须是立项前已服务多调用方的宿主通用核心；预期受益插件 < 2 个不立项；
总量有预算（≥ 5 座即信号：在往宿主回塞功能）。每桥立项单列行数入对账。
[S-3] 桥 API **只增不改**（additive-only）：参数收敛用新函数，不允许改既有函数签名；废弃走 §5 弃用规则。
[S-4] 插件**禁止**绕桥：不直调 `__POLARIS_HOST_INVOKE__` 敏感面、不 import 宿主内部模块路径、
不操作宿主 store。违反=验收拒绝（安全前提见 slimdown §6-1 hostInvoke 白名单）。

## 4. 安全规范

[S-5] 自由 HTML 组件**必须**运行于 iframe：`sandbox="allow-scripts allow-forms allow-popups allow-modals"`，
**禁止** `allow-same-origin`（保持 origin=null 隔离）。
[S-6] 组件→宿主消息**必须**满足全部三条，否则丢弃：`event.source === iframe.contentWindow`；
携带宿主下发的 `componentId`；payload 尺寸在限值内。
[S-7] 组件回传表单**必须**走 `polaris-host/form`（→ 现有 form_submit 管线）：read 三态、secret 掩码、
回执脱敏由宿主 form_core 服务端强制，AI 的 HTML 声明不构成信任。
[S-8] 组件 cap 调用三重门控**全部通过**才转发：① AI 声明 `caps` 白名单（render_component 参数，
component_register 登记）；② 宿主硬编码 deny 清单（写类/敏感：bash、fs 写、self.*、registry 等——
不可声明，非提示词约束）；③ Remote/Web 整体 deny。每次调用审计入链标 `source: component:<componentId>`。
[S-9] 核心通道插件（承载宿主核心交互渲染，如交互组件插件）**必须**标 `core: true`：不可卸载、
禁用入口对其核心模板不生效；`plugin_service` 卸载/禁用路径加守卫。

## 5. 命名与兼容

[N-1] 工具/marker/块类型更名**必须**保留旧名别名（兼容期默认永久，除非 spec 修订明确过渡窗）；
历史对话中的旧 marker **必须**可渲染。
[N-2] MCP server id（命名空间）**不应**随插件更名而变——它出现在历史 toolName 中（先例：
`polaris-prd-preview` 保留于交互组件插件）。
[N-3] 模板/卡片 bundle 遵循语义化版本；破坏性变更（删字段/改语义）**必须**升主版本并在商城描述声明。
[N-4] 弃用流程：宿主桥或贡献点字段弃用 → 保留 ≥ 2 个插件大版本 + warn 日志 + 商城公告 → 移除。

## 6. 校验与注册语义

[R-17] manifest 校验**必须**覆盖本规范全部新贡献点块（blockRenderers/uiTemplates 的字段类型、
entry 存在性、命名空间规则），校验单源在宿主、错误信息可定位（对齐 plugin-custom-icon 双端镜像惯例）。
[R-18] 注册失败语义 = **兜底降级**：校验失败/加载失败的贡献不注册、不影响其他贡献、不留死 manifest
（对齐 scan「单 manifest 无效不中断扫描」惯例）；开发期 warn、生产 debug。
[R-19] 块委托/模板注册的生效状态**必须**可观测：插件仓 index.json + 宿主 inspector 面板展示
（对齐 plugin.usage 双键观测经验）。

## 7. 测试与验收规范

[T-1] 行为等价金标：外移/新增渲染贡献**必须**先冻结行为基线（字段、语义、阈值、错误文案），逐条对齐。
[T-2] 每贡献**必须**过：宿主单测（校验/委托/兜底）+ 插件仓测试 + 真机冒烟（双端：桌面 + Web）+ 热更链路一次。
[T-3] 安全用例**必须**实测：伪造 postMessage（错 source/错 componentId）、未声明 cap 调用、deny 清单命中、
禁用插件后的兜底渲染。
[T-4] 行数对账：主仓删除 − 桥/契约新增单列，净删数如实报总账（防膨胀规则 §8，playbook）。

## 8. 反模式（明令禁止）

[A-1] 复制宿主核心组件进插件 bundle（分叉）；✅ 正解：桥准入（S-2）。
[A-2] 为单个插件往桥里加专属逻辑；✅ 正解：插件自包含或功能留宿主。
[A-3] 绕过加载器直调宿主内部（同 window 零隔离的侧门）。
[A-4] 语义层逻辑（信任边界/审计/oneshot）移入插件。
[A-5] 无兼容别名的工具/模板下线；无兜底的委托渲染。
[A-6] 投机性通用 API（为想象中的未来插件造灵活面）——每桥/每贡献点必须有现实受益者。

## 9. 与既有文档关系

- 本规范**上位**于：`interactive-component-implementation-plan.md`（实施合规对齐）、
  `interactive-component-plugin-plan.md` §7（v2 架构，本规范的来源叙述）、
  `prd-preview-extraction-playbook.md` §6（八步手册，流程层）、§8（防膨胀规则，并入 S-2/T-4）。
- 与宿主既有机制的关系：cap 覆盖分级（registry_capability L0/L2/L4）→ [R-12]；hostInvoke 白名单
  （slimdown §6-1）→ [S-4]；manifest 校验补齐（slimdown §6-2）→ [R-17]；plugin-custom-icon 双端镜像
  校验惯例 → [R-17]。
- 修订流程：本规范由用户确定后生效；修订走「条款提案 → 用户确认 → 版本号递增」，
  实施方案与贡献点校验代码同步更新。
