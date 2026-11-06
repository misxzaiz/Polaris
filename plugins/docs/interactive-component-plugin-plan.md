# 交互组件插件定案规划（原 PRD 预览外移的泛化升级版）

> **v2 修订 2026-11-07（用户定案追加）**：范围从「PRD 泛化 + 表单整合」升级为**全通道统一**——
> ask / form / plugin_card interaction / cap.ui.render DSL / PRD 全部以交互组件插件为**统一渲染层**：
> 固定形态走**内置模板**，自由形态走直出 HTML；其他插件可经贡献点**注册模板或提供 HTML**；
> 组件内可经宿主桥发起 **cap 调用**（声明白名单门控）。语义层（form_core / ask oneshot / 审计）**留宿主不外移**。
> 详见 §7 v2 统一架构章节；§1-§6 的单通道设计（marker/信任边界/安全协议）全部继续有效。
> 配套交互原型：对话内「交互组件统一架构」演示面板。

> 状态：**定案规划，未实施** · 日期：2026-11-07
> 用户三项定案：
> ① 插件落在 **Polaris-plugin 仓**（`plugins/interactive-component/`），不落主仓 `plugins/` 目录；
> ② 不叫 PRD——泛化为**交互组件**：AI 生成的任意交互界面（自由 HTML），支持表单等回传；
> ③ 表单整合：新组件的表单提交与现有 form 工具**走同一信任边界统一检查**。
> 上游：`prd-preview-extraction-playbook.md`（外移手册与本文件 §5 引用其阶段划分）、`host-slimming-incremental-roadmap.md` W3。

---

## 1. 现状盘点：五套「AI ↔ 用户交互」通道（整合检查对象）

| 通道 | 载体 | 格式固定点 | 回传 |
|---|---|---|---|
| PRD 预览卡 | chatCards result 模式 → PrdPreviewCard → iframe | **PreviewArtifact 字段结构固定** + toolName 精确匹配 | ❌ 纯展示 |
| form 工具 | ask_mcp_server → FormCard | **字段类型白名单**（string/number/boolean/textarea/select/secret/date/…）+ style 白名单 | ✅ form_submit（hold 一次性消费） |
| ask 问答 | ask_listener → 选项卡 | 固定选项卡形态 | ✅ answer_question（oneshot） |
| plugin_card interaction | 伴生进程 → PluginCardHost | 插件代码写死渲染 | ✅ respond()（伴生进程语义） |
| cap.ui.render DSL | AI 产 DSL → 宿主渲染 | DSL 节点白名单 | ❌ 展示 |

用户诉求 = 把 ① 的**自由 HTML**（不固定格式）与 ② 的**数据回传闭环**（表单）合体，且两者**共用一套信任边界与审计**。④（interaction 模式）是插件主动发起的通道，语义不同，不在本次整合范围。

---

## 2. 泛化设计：交互组件插件

### 2.1 定位

**「交互组件」**= AI 经 MCP 工具在对话流中渲染的任意自包含交互界面（HTML+CSS+JS，iframe 沙箱内运行），可选携带**回传契约**（表单/动作提交回喂 AI）。PRD 预览是它的「静态展示」特例。

- 插件 id：`interactive-component`，显示名「交互组件」（对齐直白命名纪律）
- 仓位置：`D:\space\base\Polaris-plugin\plugins\interactive-component\`（发布走商城 + 热更；本地真机复验走 zip 安装或 dev-link）
- 既有产物兼容：`.polaris/previews/` 目录与数据格式**原样沿用**，旧预览可读

### 2.2 MCP 工具契约

| 工具 | 语义 | 与现工具关系 |
|---|---|---|
| `render_component` | 渲染交互组件。参数：`html`、`title`、`description?`、`versionLabel?`、**`form?: { formId, read: "full"\|"none", secretKeys?: string[], submitLabel? }`**（回传契约声明） | `preview_html` 的泛化超集 |
| `preview_html` | **保留为兼容别名**（等价 render_component 无 form），schema 不变 | 既有对话/提示词不断链 |
| `read_preview` / `list_previews` | 原样迁移 | — |

marker 结构：PreviewArtifact 增加可选 `form` 字段；`artifactType: "polaris.preview"` **不变**（宿主通用 artifact 渲染核心零改动识别）。

### 2.3 不固定格式的边界（诚实声明）

「不固定」指**视觉与交互逻辑**（布局/控件/JS 行为全自由）；信任边界仍然固定且服务端强制：
`form.read` 三态、secret 掩码、回执脱敏由 form_core 管辖，AI 的 HTML 说了不算——这正是与 form 工具整合的意义。

---

## 3. 表单整合设计（本方案核心）

### 3.1 信任边界复用，不另起炉灶

现有 form 闭环（已核实源码）：form 工具建 `form_holds` → 前端 `form_submit(formId, values, read)` →
后端取 hold、原文只走服务端、`build_receipt` 生成回执喂回 → `form-answered/skipped` 事件回卡片。
**整合 = 交互组件的提交并入同一条管线**，只差「hold 从哪来」：

### 3.2 方案：`component_register` 登记动作（提交/回执/事件/审计全复用）

```
render_component 工具返回 marker（含 form 契约）
  → 前端组件卡片挂载时调 cap.ai.chat { action: "component_register",
       formId, read, secretKeys, sessionId, componentId }     ← 唯一新增动作（~40 行）
  → 后端按 form_core 泛化的 build_hold 构造「组件型 hold」（无 fields schema）入 form_holds
  → 用户在 iframe 内提交 → postMessage → 卡片桥校验 → 走【现有 form_submit】（零改动）
  → 回执生成/脱敏/事件状态机/审计 —— 与 FormCard 完全同管线（零改动）
```

- 后端新增仅两处：`component_register` 动作 + `form_core::build_hold` 泛化出组件型构造（fields 缺省语义）。
- `form_submit`、`build_receipt`、`form-answered/skipped` 事件、审计入链（should_audit 闸）**一行不改**——这就是「同步整合一起检查」的落点：一套边界服务两种表单形态。
- 迟到/重复提交的「表单已失效」语义天然继承（hold 一次性消费）。

### 3.3 iframe postMessage 安全协议（新增，卡片桥内 ~60 行）

| 威胁 | 缓解 |
|---|---|
| 伪造提交（iframe origin 为 null，不能靠 origin 校验） | `event.source === iframe.contentWindow` 严格比对 + 消息须携带宿主挂载时下发的 `componentId` |
| 组件 A 替组件 B 提交 | componentId 与卡片实例绑定，component_register 登记时后端校验 formId 归属本会话 |
| AI 画钓鱼表单骗输入 | 信任边界照搬 form_core：read=none 时值不进 AI 上下文；secretKeys 服务端掩码；提交按钮旁展示「回传模式」标识（沿用 FormCard 的私密提交开关语义） |
| 超大 payload | 沿用 2MB HTML 上限 + values 提交上限（对齐 form 现有约束） |

iframe 现有 `sandbox="allow-scripts allow-forms allow-popups allow-modals"`（`ArtifactPreviewRenderer.tsx:334`）已满足，**不加 allow-same-origin**（保持 origin=null 隔离）。

### 3.4 统一检查矩阵（FormCard ⇄ 交互组件，逐项同源）

| 检查项 | FormCard（schema 型） | 交互组件（自由型） | 共用 |
|---|---|---|---|
| read 三态服务端强制 | ✅ | ✅ | form_core |
| secret 掩码 | ✅ | ✅ | form_core |
| 回执 build_receipt | ✅ | ✅ | form_core |
| 提交管线 | form_submit | form_submit | 同一动作 |
| 事件状态机 | form-answered/skipped | 同 | 同 |
| 审计入链 | should_audit 闸 | 同 | 同 |
| 失效语义（一次性/超时） | ✅ | ✅ | form_holds |
| 渲染信任 | schema 白名单渲染 | **iframe 沙箱隔离**（更强） | 各自合理 |

---

## 4. 宿主侧改动总账（对照防膨胀规则）

| 改动 | 行数估算 | 性质 |
|---|---|---|
| artifact 渲染桥（playbook §3，卡片 bundle 复用宿主渲染核心） | +150~200 | 契约（多插件共用） |
| component_register 动作 + build_hold 组件型泛化 | +60~80 | 契约（form_core 既有信任边界的第三个入口） |
| 卡片 postMessage 桥（协议校验 + event.source 绑定） | +60（入 artifact 桥） | 契约 |
| 插件侧：Node server（3+1 工具）+ card bundle + 测试 | 插件仓 ~800 | 实现（出仓主体） |
| 主仓删除：Rust 557 + 前端壳 400 + 注册点 6 处 | **-957** | 实现 |

主仓净删 ≈ **-620~-660 行**，且新增的 ~270 行全部是「第三座桥以内的契约面」（react shim 215 + artifact 桥 ~210 + form 信任边界入口 ~80 ≈ 预算内，roadmap §4 追踪）。

---

## 5. 实施阶段（沿用外移手册四步，插入泛化项）

| 阶段 | 内容 | 参照 |
|---|---|---|
| A | 宿主 artifact 渲染桥 + postMessage 桥（含内置卡先改走桥验证） | playbook §3 |
| B | `component_register` + build_hold 泛化 + 统一检查矩阵过审（本文件 §3.4） | 本文件 §3 |
| C | 插件仓实现 `interactive-component`（Node server + card bundle + 测试），商城发布 + zip 真机复验 | playbook §4（路径改 Polaris-plugin 仓；本地冒烟走安装 zip，不再依赖主仓 plugins/ 目录） |
| D | 主仓删码 + 影子并行收口 + 行数对账 | playbook §5-§6（清单不变，`prd-preview` 字样按新 id 替换） |

工作量：A ~1 会话、B ~0.5、C ~1.5、D ~0.5，合计 ~3.5 会话。

---

## 6. 开放问题（实施前需拍板）

1. **旧 preview_html 工具名保留多久**：建议永久别名（成本≈0，避免历史对话工具引用断链）；若坚持下线，需在插件描述声明迁移。
2. **`interaction` 模式 plugin_card（④）是否长期与组件共存**：建议共存——它服务「伴生进程主动发起」，与「AI 经工具渲染」是两个方向；但 PluginCardHost 的 respond 通道未来可桥接 form_core，再评估。
3. **组件型表单是否需要 versionLabel 联动重渲染**：AI 迭代组件时旧卡片应保持已提交状态（block 事件状态机天然支持，实施时验证即可）。
4. **商城上架名**：「交互组件」（直白命名纪律）；描述里写清「含表单回传，隐私边界与系统表单一致」。

---

## 7. v2 统一架构（2026-11-07 定案：全通道渲染层统一）

### 7.1 分层模型（渲染统一，语义留宿主）

```
触发层（谁发起，入口各异）        语义层（信任边界，留宿主）           渲染层（统一到交互组件插件）
├ AI form / ask 工具      ──►  form_core / ask oneshot / 审计  ──►  模板渲染（内置 ask/form 模板）
├ AI render_component     ──►  component_register 登记         ──►  自由 HTML（iframe 沙箱）
├ AI cap.ui.render DSL    ──►  ui.template 域（既有）           ──►  DSL 节点 → 模板映射
└ 插件伴生进程 plugin_card ──►  respond 通道（既有）             ──►  第三方注册模板 / 数据卡
                                                          能力层：form_submit 回传 + cap 调用桥（白名单）
```

**铁律：只有「渲染」外移；「语义」永远留宿主。** form_core 信任边界、ask oneshot 一次性、
审计入链、hold 失效语义不进插件——它们是安全边界，不是 UI。

### 7.2 内置模板化（ask / form 的归宿）

固定形态改为「schema 数据 + 内置模板」：FormCard(629 行)/问答卡/PRD 卡的**渲染代码**退役为
交互组件插件的内置模板（ask-card / form-card / artifact-card / chart-card 四个起步），由插件分发可热更。
schema 与语义不变：form fields 白名单、ask 选项结构原样——变的只是「谁来画」。

### 7.3 第三方注册模板（贡献点）

`contributes.uiTemplates: [{ id, title, schema?, entry | html }]`：
- 有 entry → 插件自带模板 bundle（走既有 loadModuleFromFile，react shim）
- 只有 html/data → 「卡片即数据」：插件不需要打包 React 卡片，返回 marker 即可被通用渲染
- 注册表与宿主既有 `ui.template` 域（ui_render_capability v2 parametrized 模板运行时）**同域治理**：
  覆盖更新带 owner 记录、persist 落 Storage——避免第三套模板机制
- 其他插件的 chatCards 可声明 `renderer: "interactive-component"` 委托渲染，插件卡片开发门槛降为「数据 + 模板引用」

### 7.4 组件内 cap 调用桥（新增高危面，最严门控）

AI 生成的 HTML 组件获得调用宿主能力 = 任意代码触达总线，必须三重门控：
1. **声明式**：render_component 时 AI 声明 `caps: [{ target, actions }]`（如 `cap.config read`、`cap.kv get`）；
   component_register 登记白名单，组件桥只转发声明内调用
2. **分级拒绝**：写类/敏感 cap（bash/fs 写/self/registry）默认拒绝且不可声明（硬编码 deny 清单，非提示词约束）；
   Remote/Web 模式整体 deny（对齐 cap.http 先例）
3. **全量审计**：组件发起的每次调用入链并标注 `source: component:<componentId>`（观测面可见，对齐守望台经验）

### 7.5 可用性红线（与 slimdown「ask 是核心通道」判定的张力解法）

统一后若交互组件插件被禁用，form/ask 渲染随之失效——核心交互不能依赖可卸载插件。解法（二选一，实施前拍板）：
- **A（推荐）**：交互组件插件标「核心通道插件」（对齐 ask/dispatch 壳惯例）：不可卸载、enabledByDefault、
  禁用入口对 form/ask 模板不生效；版本随商城热更
- B：宿主保留极薄兜底渲染（违背删码初衷，仅作备案）

### 7.6 各通道归宿总表

| 通道 | 渲染层 | 语义层 | 宿主删除（渲染代码） |
|---|---|---|---|
| form | form-card 内置模板 | form_core + form_submit（零改动） | FormCard 629 行 |
| ask | ask-card 内置模板 | ask_listener oneshot（零改动） | 问答卡渲染部分 |
| PRD/静态 artifact | artifact-card 内置模板 | — | 前端壳 400 行 |
| DSL（cap.ui.render） | DSL→模板映射 | ui.template 域（既有） | 节点渲染器逐步（远期） |
| plugin_card interaction | 第三方注册模板 / 数据卡 | respond 通道（既有） | PluginCardFallback 之外的重复渲染（远期） |
| 自由 HTML | iframe 直出 | component_register + form_submit | — |

### 7.7 阶段扩展与开放问题

- P1 组件+表单整合（§3）→ P2 ask/form 模板化渲染 → P3 第三方注册 + cap 桥 → P4 DSL 归一（远期）
- 开放问题新增：⑤ 宿主兜底方案 A/B 拍板；⑥ cap 声明白名单的 deny 清单初版范围；⑦ 模板覆盖权限
  （第三方能否覆盖内置模板 id——建议 L2 级约束，对齐 cap 覆盖分级惯例）；⑧ PluginCardHost 的
  interaction 模式渲染是否也委托模板（建议 P3 后评估）。
