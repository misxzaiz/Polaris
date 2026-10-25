# 需求：cap.ui.render 支持任意 JS 与任意操作，实现最大能力

> 状态：**仅分析 + 需求记录**，未实施。本文档供后续 agent 直接落地（交接性质）。
> 来源：2026-10-25 会话实测（基金面板 DSL 卡片 / 猜数字交互游戏）暴露的能力边界问题。
> 一句话目标：**让 AI 渲染的卡片不再受 DSL 白名单限制，能跑任意 JS、并能经宿主执行任意（受管）操作。**

---

## 一、背景与问题（实测证据）

用 `cap.ui.render` 做了两个 demo，触到两个硬边界：

1. **猜数字游戏**：交互链路通（select + buttons → `plugin_card_answered` 回传），
   但游戏逻辑（判大小/续局/结算）**全部要 AI 侧记状态、重新渲染**，卡片自身不能跑判定逻辑。
   想做「卡片内即时反馈 / 动画 / 复杂 UI」完全不可能。

2. **基金面板**：DSL 只有 `vstack/hstack/text/metric/badge/table/progress/divider/input/select/chart` +
   按钮组（≤8）。想表达「Tab 切换 / 环形图 / 实时刷新」只能写死，无 JS 无状态。

结论：**DSL 白名单模式 = 声明式安全壳，能覆盖「表单/选项类展示」，覆盖不了「自包含可交互应用」。**
要最大能力，必须开放「任意 JS + 任意操作」，但要以**受管方式**开放，不能裸 `<script>` 注入主进程。

---

## 二、现状（已验证，附行号）

### 2.1 cap.ui.render 的 DSL 契约

- 后端：`src-tauri/src/services/router/ui_render_capability.rs`
  - 节点白名单 `TEMPLATE_NODE_TYPES`（`:101`），DSL 校验 `validate_template_node`（`280-506`）。
  - 明确注释：**"禁止任意 HTML/脚本注入 —— 这是「改造」与「注入攻击」的分界线"**。
  - 帧类型白名单：`question/form/confirm/custom/template`（`:84`）；`custom` 是自定义帧，但语义未扩展。
- 前端：`src/plugin-system/uiFrameTypes.ts`（与后端双边同步的 `UiTemplateNode` 联合类型，`:16-59`）。
- 渲染器：`src/components/Chat/chatBlocks/chartNodeView.tsx`（chart 节点 SVG 自绘）、`UiFrameCard.tsx`。
- 按钮应答 → `plugin_card_answered` 事件 → 前端更新卡片 status（`src/stores/conversationStore/eventHandler.ts:998`）。

### 2.2 已存在的「任意 HTML + 沙箱脚本」通道（关键资产，不要重造）

- **`ArtifactPreviewRenderer` 沙箱 iframe**：`src/components/Chat/chatBlocks/ArtifactPreviewRenderer.tsx:176`，
  `sandbox="allow-scripts allow-forms allow-popups allow-modals"`（**无 allow-same-origin**，跨源隔离）。
- **HTML 卡片链路**：`session_end` → `extractHtmlCardBlocks`（`eventHandler.ts:106`）→ `artifact_preview` 块 → 渲染。
- **Cap 桥（已规划，未实施）**：`plans/html-card-cap-bridge.md` —— 卡片内 JS 经 `postMessage` + 白名单
  调宿主 cap（`polarisCap.dispatch('cap.todo', {...})`），**明确不做通用 eval / 任意代码注入**（`:90`）。
- **真实的任意 HMTL 工具**：`mcp polaris-prd-preview preview_html`（`prd_preview_mcp_server.rs`）——
  当前 AI 输出任意 HTML 页面的正规通道，但它是**开发期工具**，不是会话卡片能力。

### 2.3 已有「最大能力」治理探索

- `plans/plugin-cap-full-freedom-v1.md` —— 插件侧最大自由度（推荐路径 D：PluginRpc ✓ / WASM 占位），
  核心思想：**护栏不降级**（仍过 RouterBus 统一 gate + 审计 + 超时）。
- `plans/html-card-cap-bridge.md` —— 卡片侧经白名单桥触达 cap，安全失败。
- 权限策略：`src-tauri/src/services/router/policy_permission.rs` 有完整 rule 体系
  （Remote deny / Plugin 高危 prompt / config allow 覆盖），开放操作面可按同一套扩展。

---

## 三、需求定义（分层���按能力从弱到强）

> 三层递进，都可独立验收；目标是「最大能力」= L2 + L3 都可用，且安全不裸奔。

### L1：DSL 增量（低成本，先做）
- 补 `chart` 支持 `area`（图表 spec `plans/cap-ui-render-chart-node-spec.md` 已提）；
- 补 `input` 的 number/range、`metric` 的 trend 箭头、`table` 的排序/筛选等；
- **不解决根本问题**，只是缓解。

### L2：卡片内任意 JS（核心诉求）
- 允许 `register` 的 DSL 携带 **`script` 字段 / `custom` 帧内嵌 HTML+JS**；
- 渲染到 **现有沙箱 iframe**（`ArtifactPreviewRenderer` 或同构的 `srcdoc` iframe），
  沙箱属性不变（`allow-scripts` + 无 `allow-same-origin`）→ **任意 JS 在隔离环境内跑，不触达宿主 DOM**；
- 卡片与宿主的数据交换走 **Cap 桥（postMessage 白名单，即 `html-card-cap-bridge.md`）**：
  卡片内能调 `cap.todo/kv/fs/http(审批后)/ui.*(受控)` 等白名单能力，结果回卡片继续渲染；
- **明确安全边界**：任意 JS 只在沙箱 iframe；主进程受理的仍是白名单 cap 调用（有审计、有权限 gate）。

### L3：任意操作（最大能力）
- 卡片内 JS 经 Cap 桥触达**所有** cap（不只白名单子集），权限判定复用 RouterBus 现有
  `policy_permission`（Plugin 源高危 prompt / Remote deny 等），**每个调用都有审计**；
- 卡片可进一步：发起 `cap.ai.chat`（开新会话/追问）、`cap.bash`（审批后）、`cap.git` 等；
- 可选进阶：动态注册能力（`cap.registry`）→ 卡片逻辑可转发到新的动态 cap，组合出任意工作流。

---

## 四、候选实现路径对比

| 路径 | 说明 | 安全 | 成本 | 契合度 |
|---|---|---|---|---|
| **A. 沙箱 iframe + Cap 桥（推荐）** | register 承载 HTML+JS，渲染进沙箱 iframe；跨源 postMessage 桥触达 cap（复用 `html-card-cap-bridge.md`） | 高：隔离 DOM + 白名单调用 + 审计 | 中 | ★ 高（两条既有 spec 的合流，改动克制） |
| **B. DSL 无限扩展** | 继续扩白名单节点 | 高 | 低（但天花板低，无法表达真交互） | 低（不解决核心诉求） |
| **C. 卡片脚本桥接宿主 eval** | 卡片直接调 `window.parent` 宿主执行任意命令 | 极低（逃逸隔离） | 低 | ★ 否决（违背一切既有安全治理） |
| **D. 插件进程 handler（PluginRpc）** | 卡片交互转发给插件进程执行，结果回卡片（`plugin-cap-full-freedom-v1.md` 路径 B） | 高（进程隔离） | 中高 | 中（适合重逻辑，但卡片轻交互杀鸡用牛刀） |

**推荐 A**：站在 `html-card-cap-bridge.md`（桥）+ `html-output-card-render-spec.md`（沙箱渲染）两个
已规划资产上，**不新造渲染器、不开放宿主 eval**，把「任意 JS」隔离在沙箱，「任意操作」收敛到
RouterBus 受管调用。若要更大灵活性，后续可在 L3 之上叠 PluginRpc（路径 D）。

---

## 五、契约草案（给实施 agent 的最小接口）

```jsonc
// register：dsl 增加 script 节点（或 custom 帧）
{
  "templateId": "demo/game",
  "dsl": [ { "type": "text", "content": "点击下方按钮试试" } ],
  "script": "window.__onReady = () => { /* 任意 JS，沙箱内 */ }",
  "buttons": [ { "id": "act", "label": "执行" } ]
}

// 卡片内调用宿主（postMessage，协议见 html-card-cap-bridge.md §3.1）
// window.parent.postMessage({ __polarisCap:1, id, target:'cap.todo', payload:{action:'list'} }, '*')

// request 增加 custom 帧（内嵌完整 HTML 或 HTML+JS，渲染进沙箱 iframe）
{
  "frame": { "type": "custom", "html": "<div id='app'></div><script>...</script>" }
}
```

---

## 六、验收标准（北极星）

1. **L2**：register 带 `script` 的卡片，脚本在沙箱 iframe 内真实执行（能改卡片 DOM、能发起 cap 桥调用）；
   卡片内 `polarisCap.dispatch('cap.todo', {action:'list'})` 拿回数据并渲染。
2. **L3**：卡片内可调 `cap.kv set/get` 且落库可查；`cap.http` 经审批后可调；调用均能查到审计记录。
3. **安全**：卡片脚本**无法** `parent.document` 访问宿主；未声明的 cap 目标一律安全失败（`ok:false` + 不落审计副作用）。
4. **不回归**：现有 DSL 卡片（基金面板/猜数字）照常渲染，`uiFrameTypes.ts` 与后端校验双侧同步。
5. 现有 `pnpm exec tsc --noEmit` / `cargo check` 通过。

---

## 七、明确不做（本期）

- ❌ 不做宿主侧任意 `eval` / 裸命令注入（路径 C 否决）。
- ❌ 不放行 `allow-same-origin`（保持沙箱隔离，防卡片逃逸到主进程 DOM）。
- ❌ 不做卡片→宿主的**无白名单**全量调用；每个操作都过 RouterBus 权限 gate + 审计。
- ❌ 不重造渲染器（复用 `ArtifactPreviewRenderer` 沙箱 iframe）。
- ❌ WASM 沙箱（P4 可选，见 `plugin-cap-full-freedom-v1.md`）。

---

## 八、参考文档

- `plans/html-card-cap-bridge.md`（Cap 桥协议，直接复用）
- `plans/html-output-card-render-spec.md`（沙箱 iframe 渲染契约）
- `plans/cap-ui-render-chart-node-spec.md`（chart 节点扩展先例）
- `plans/plugin-cap-full-freedom-v1.md`（插件侧最大自由度，护栏不降级）
- `plans/router-governance-hardening-spec.md`（权限策略收紧，L3 开放面的 gate 依据）
- 代码：`src-tauri/src/services/router/ui_render_capability.rs` / `src/plugin-system/uiFrameTypes.ts` /
  `src/components/Chat/chatBlocks/ArtifactPreviewRenderer.tsx` / `src/stores/conversationStore/eventHandler.ts` /
  `src-tauri/src/services/router/policy_permission.rs`