# 交互组件 v2 具体实施方案（宿主支持 / 插件实现 / 宿主代码移除）

> 状态：**已确定（用户 2026-11-07 拍板全量范围）**：宿主提供插件开发支持（A/B/D/E 契约批）→
> 删除宿主已实现的 form / ask / prd 渲染内容（D1+D2，D3 DSL 归一远期单列）→
> 交互组件插件提供对应模板（form-card/ask-card/artifact-card）与自定义支持（自由 HTML + 第三方注册）。
> 合规基线：`plugin-ui-contribution-spec.md` v1.0（已确定），条款号对照见 §0.1。

> 上游：`interactive-component-plugin-plan.md`（v2 定案：全通道渲染统一）、`prd-preview-extraction-playbook.md`（八步手册与防膨胀规则 §8）。
> 本文件落到**文件级**：宿主加什么（契约）、插件仓建什么（实现）、主仓删什么（移除），每批带验证门槛。
> 工作量单位=专注会话粗估；每批独立验收可叫停；顺序不可倒置（契约先行）。

### 0.1 合规条款对照（spec v1.0 → 本方案批次）

| spec 条款 | 落点批次 |
|---|---|
| [R-5..7] chatCards 校验/entry/别名 | C 批 plugin.json + server 兼容别名 |
| [R-8..11] blockRenderers 白名单/协议冻结/兜底/先到先得 | D 批块委托注册表 |
| [R-12..15] uiTemplates 命名空间/保留名/同域治理/兜底 | E 批 |
| [S-1..4] 桥清单封闭/准入/只增不改/禁绕桥 | A 批 hostBridge |
| [S-5..7] iframe 沙箱/postMessage 三条件/form 边界 | A+B 批 |
| [S-8] cap 三重门控 + 审计标注 | E 批 cap 桥 |
| [S-9] core: true 核心通道守卫 | D 批尾（form/ask 渲染依赖它，先于 D2 删除落地） |
| [N-1..4] 别名/命名空间/语义版本/弃用 | C 批（preview_html 别名、server id 保留） |
| [R-17..19] 校验覆盖/兜底降级/可观测 | D/E 批 manifest 校验 + inspector |
| [T-1..4] 金标/双端热更/安全用例/行数对账 | 各批验收矩阵 |
| [A-1..6] 反模式 | 全程（复审项） |

---

## 0. 阶段与依赖总览

```
A 宿主渲染桥(1) ──► B 登记+回传契约(0.5) ──► C 插件实现+PRD域移除(2)   【=原 PRD 泛化，先行闭环】
                                        └─► D 块委托注册表+form/ask 模板化(2)【渲染统一核心】
D ──► E uiTemplates 贡献点+cap 桥(1.5)                    【生态开放】
E ──► F DSL 归一(远期，未排期)
```

P1-P3 合计 **~6.5 会话**；F（UiFrameCard 588 + chartNodeView 243 的 DSL 归一）单列远期。

---

## 1. 宿主支持（新增契约，全部走 §8 防膨胀规则审查）

### 1.1 A 批：宿主渲染桥（~1 会话，+210 行）

| 件 | 位置 | 内容 |
|---|---|---|
| `polaris-host/artifact` shim | `plugin-system/hostBridge.ts`（新建） | `ArtifactPreviewRenderer` + `buildArtifactBlockFromData` + `useArtifactVersions` + 打开源码动作（fileEditorStore/getFileContent 封装）挂 window，loader 生成 blob shim |
| loader 重写扩展 | `pluginModuleLoader.ts` + `reactImportRewrite.ts` | 占位符 `polaris-host/artifact` → shim URL（与 react 重写同机制，上下文感知不变） |
| postMessage 桥 | hostBridge 内 | 协议 `{ type:'polaris-component-submit', componentId, formId, values }`；`event.source === iframe.contentWindow` 严格绑定 + componentId 校验 + values 上限 |
| 单测 | hostBridge.test | shim 存在性 / 重写正确性 / source 绑定拒绝伪造 |

验收：现有内置卡片改走 shim 渲染回归通过（先在受控形态验证桥）。

### 1.2 B 批：登记 + 回传契约（~0.5 会话，+80 行）

| 件 | 位置 | 内容 |
|---|---|---|
| `component_register` 动作 | `router/ai_chat_capability.rs`（SYNC_ACTIONS + describe） | 参数 `{ sessionId, componentId, formId, read, secretKeys?, title? }` → `form_core::build_hold` 泛化出组件型构造（无 fields schema）入 `form_holds`；归属校验 formId 属本会话活跃 marker |
| 回传零改动 | — | `form_submit` / `build_receipt` / `form-answered/skipped` 事件 / 审计闸 **一行不改**（整合的机制保证） |
| `polaris-host/form` shim | hostBridge | `registerComponent(decl)` / `submitForm(formId, values, opts)` / `skipForm(formId)` 薄封装（内部 aiChatDispatch，~50 行） |

验收：组件提交与 FormCard 提交走同一 `form_submit`，回执逐字段一致（统一检查矩阵 §3.4 过审）。

### 1.3 D 批：块委托渲染注册表（~0.5 会话，+90 行，渲染统一的关键契约）

现状（已核实）：`chatBlocks/index.tsx:102-111` 按 `block.type` 硬编码路由——`question → AskQuestionCard`、`form → FormCard`。

| 件 | 内容 |
|---|---|
| `contributes.blockRenderers?: [{ blockType, entry }]` | 新贡献点：manifest 类型 + registry 注册 + 校验（entry 必须属本插件；blockType 白名单首期 `form`/`question`） |
| 委托查找 | `chatBlocks/index.tsx` 的 `form`/`question` case 改为：委托注册表命中且插件启用 → 懒加载插件模板卡（props: `{ block, formBridge }`）；未命中/加载失败 → `BlockFallback`（工具名 + 折叠 JSON，复用 PluginCardFallback 形态） |
| 插件模板卡组件契约 | `export default Component({ block })`，block 结构与现 FormBlock/QuestionBlock 完全一致（**协议零变更**） |

### 1.4 E 批：uiTemplates 贡献点 + cap 桥（~1.5 会话，+220 行）

| 件 | 内容 |
|---|---|
| `contributes.uiTemplates?: [{ id, title, schema?, entry? , html? }]` | 第三方模板注册；与宿主 `ui.template` 域同域治理（ui_render_capability v2 惯例：owner 记录、persist、覆盖分级）|
| `polaris-host/cap` shim | `dispatch(target, payload)` —— 仅转发声明白名单内调用 |
| cap 门控 | ① component_register 时登记 AI 声明的 `caps` 白名单；② 宿主**硬编码 deny 清单**（cap.bash / cap.fs 写 / cap.self.* / cap.registry 等，写类敏感能力不可声明）；③ Remote/Web 整体 deny（对齐 cap.http 先例）；④ 每次调用审计入链标 `source: component:<componentId>` |
| 「卡片即数据」 | marker `{ template: '<plugin>/<tplId>', data }` → 通用渲染（其他插件零 bundle 成本） |

### 1.5 核心通道插件保护（方案 A，+30 行）

`interactive-component` 标记 `core: true`（manifest）：不可卸载；UI 禁用入口对 form/ask 模板不生效；版本随商城热更。`plugin_service` 卸载/禁用路径加守卫。

---

## 2. 插件实现（`D:\space\base\Polaris-plugin\plugins\interactive-component\`）

### 2.1 仓结构

```
interactive-component/
├── plugin.json              # §2.2
├── mcp/server.js            # Rust 557 行的 Node 零依赖等价（4 工具）
├── dist/card.js             # chatCard entry：自由组件卡（iframe + postMessage 桥 + form 契约登记）
├── dist/blocks/
│   ├── form-card.js         # 块委托：FormCard 等价模板
│   ├── ask-card.js          # 块委托：AskQuestionCard 等价模板
│   └── artifact-card.js     # 块委托：静态 artifact（薄，走 artifact 桥）
├── src/                     # 源码 + esbuild 打包脚本
├── test/                    # server 行为等价测试 + 模板渲染测试（迁移 Rust/前端用例）
└── update.json              # v1.0.0 → 商城 index.json
```

### 2.2 plugin.json 要点

- `id: "interactive-component"`，`name: "交互组件"`，`core: true`
- `mcpServers[].id: "polaris-prd-preview"` —— **服务端命名空间保留**：历史对话里
  `mcp__polaris-prd-preview__preview_html` 的卡片匹配不断链（chatCards 校验要求 server id 属本插件声明，保留即满足）
- `chatCards`: `{ id:'preview-card', tools:['render_component','preview_html','read_preview'], mode:'result', entry:'./dist/card.js' }`
- `blockRenderers`: form/question 两个条目（§1.3）
- `permissions`: workspaceRead/Write + aiToolAccess
- `uiTemplates`：内置模板以数据形式注册（ask/form/artifact/chart 走 blockRenderers，chart-card 留 E 批）

### 2.3 MCP server 行为等价（金标 = prd_preview_mcp_server.rs，逐条对齐）

| 工具 | 语义 | 备注 |
|---|---|---|
| `render_component` | html + title + form 契约（`{ formId, read, secretKeys?, submitLabel? }`）+ versionLabel | 新增；marker 的 PreviewArtifact 结构加可选 `form` 字段，`artifactType: "polaris.preview"` 不变 |
| `preview_html` | 兼容别名 = render_component 无 form | 永久保留，历史提示词/对话不断链 |
| `read_preview` / `list_previews` | 原样 | — |
| 落盘/版本/上限 | `.polaris/previews/<id>/index.html` + metadata；requirementId 版本递增；2MB | 实施前抓现 server 真实 argv 校准参数语义 |

### 2.4 模板实现要点

- **form-card**：FormCard 的字段类型白名单（string/number/boolean/textarea/select/secret/date…）+ style 白名单 + 模板保存（form_template_save/list 走既有动作）+ 私密提交开关；提交经 `polaris-host/form.submitForm`
- **ask-card**：选项单/多选 + 自定义输入 + skip；应答经 `answer_question` 封装（同 shim）；「已失效」态与 oneshot 消费语义一致
- **自由组件卡**：iframe sandbox `allow-scripts allow-forms allow-popups allow-modals`（**不加 allow-same-origin**）；挂载时 marker 含 form → `registerComponent`；收 submit postMessage → `submitForm`
- 迁移前逐条审计 AskQuestionCard(690)/FormCard(629) 内嵌的宿主耦合点（若有权限请求等宿主专属交互，保留宿主并在本表登记）

### 2.5 发布链

测试市场冒烟（plugin-creator 流程）→ zip 真机安装复验 → 商城 index.json + update.json → 热更一次验证。插件仓 CI：server 测试 + 模板渲染断言 + zip 完整性。

---

## 3. 宿主代码移除（分三批，与阶段一一对应，单主题 commit）

### 3.1 D1 批（C 阶段尾）：PRD 域，净删 ~977 行

> 复审修正（2026-11-07）：PRD MCP server 实际经 **`polaris_mcp` 聚合 bin 的 `prd-preview` 子命令**运行
> （`bin/polaris_mcp.rs:32` import + `:70-73` dispatch → `run_prd_preview_mcp_server`），不是独立 bin；
> 前端 builtin manifest 的 `command: 'polaris_prd_preview_mcp'` 只是声明壳，实际 spawn 以 Rust registry 为准。

| 位置 | 动作 |
|---|---|
| `src-tauri/src/services/prd_preview_mcp_server.rs`（557） | 删 |
| `services/mod.rs:36` | 删 `pub mod` |
| **`src-tauri/src/bin/polaris_mcp.rs`（:32 import、:70-73 `prd-preview` 子命令臂）** | **删（复审新增——漏删必编译失败）** |
| `mcp_config_service.rs`（:13/:23 常量、:152-155 `builtin_plugin_mcp_manifests` 条目、:211-217 `register_plugin_server` builtin 贡献、:891 capability 映射） | 摘除（复审修正：原引 ":578" 为注释行，实际四处如列） |
| `src/plugins/prd-preview/`（manifest 35 + card 209 + test 156） | 删 |
| `builtinPlugins.ts`（:11、:134、:169-178） | 摘除 |

门槛：`pnpm typecheck` + eslint(改动文件) + `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`；`grep -rn "prd_preview" src src-tauri/src` 残留为零。
**MCP schema 纪律（复审反转）：删除 `prd-preview` 子命令 = `polaris_mcp` 工具清单变更 → 必须 `cargo build --bin polaris-mcp` 并冒烟（AGENTS.md §五 staleness 纪律适用），否则 AI 侧看到已下线工具。**

### 3.2 D2 批（D 阶段尾）：form/ask 渲染退役，净删 ~1,290 行

| 位置 | 动作 |
|---|---|
| `chatBlocks/FormCard.tsx`（629） | 删（form-card 模板接管） |
| `tool-calls/AskQuestionCard.tsx`（690） | 删（ask-card 模板接管；宿主耦合点若存在则拆留，见 §2.4） |
| `Chat/index.ts:43` AskQuestionCard 公开导出 | 摘除（复审新增；`AssistantBubble.test.tsx` 引用同步迁移插件仓测试） |
| `chatBlocks/index.tsx` form/question case | 改为委托查找（~15 行胶水保留） |
| 协议侧 | **零变更**：FormBlock/QuestionBlock 类型、form/ask 工具、form_core/ask_listener、form_template 动作全部保留 |

门槛：块渲染委托 + 兜底单测；form/ask 全流程真机回归（含模板保存、skip、失效态）；交互组件插件被禁用守卫验证（form/ask 仍可用）。

### 3.3 D3 批（F 阶段，远期未排期）：DSL 归一

`chatBlocks/UiFrameCard.tsx`（588）+ `chartNodeView.tsx`（243）→ DSL 节点映射模板。单独立项评审（涉及 ui.render DSL 契约演化），本方案不排期。

**P1-P3 完成后主仓累计净删 ≈ -2,270 行（实现），新增契约 ≈ +630 行（三座桥 + 两个贡献点 + 守卫），对账单列。**

---

## 4. 验证矩阵（每批通用 + 专项）

通用（AGENTS.md §七）：typecheck / lint(改动文件) / cargo check / web-only 门 / 相关 vitest 实跑 / 行数对账（删除 − 契约新增，单列）。

| 批 | 专项验证 |
|---|---|
| A | shim 存在性 + 现内置卡走桥渲染回归 + 伪造 postMessage 被 source 绑定拒绝 |
| B | 组件型 hold 与 schema 型 hold 提交回执逐字段一致；迟到/重复提交「表单已失效」一致 |
| C/D1 | PRD 全功能等价（旧对话 preview_html 卡可渲染、版本递增、既有 previews 产物可读）+ 双端 + 热更一次 + 禁用插件工具消失（aiToolAccess 门控生效） |
| D/D2 | form/ask 委托渲染等价（含 secret 掩码、模板保存、skip、失效态）+ 委托未命中兜底 + 核心通道禁用守卫 |
| E | 第三方模板注册/覆盖 owner 校验 + cap 白名单通过/拒绝/deny 清单/Remote 四路实测 + 审计 `source: component:` 落链 |

---

## 5. 回滚与风险

- 每批独立 commit；插件仓保留前一版 zip；D1/D2 主仓删除可单独 revert。
- **最高风险 = D2**（form/ask 是核心交互 UI）：缓解 = §1.5 核心通道保护 + 委托兜底 + 真机回归矩阵；若 D2 评审不过，A-C/D1 独立成立（PRD 泛化闭环不受影响）——这就是分批的意义。
- 已知边界：协议无运行时 schema 校验 → block/marker 结构冻结并双边类型同步；`cargo test --lib` 不可用 → Rust 侧 `cargo check` + 行为等价测试放插件仓 Node 侧。

## 6. 拍板清单（实施前）

① D2 前审计 AskQuestionCard 宿主耦合点清单；② cap deny 清单初版范围评审；③ 模板覆盖权限分级（建议 L2：第三方不得覆盖内置模板 id）；④ `mcpServerId` 保留 `polaris-prd-preview` 命名空间的确认（历史 toolName 兼容）。
