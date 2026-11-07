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

---

## 9. 实施记录（feat/interactive-component，2026-11-07）

> 主仓 worktree `../polaris-ic`；插件仓 Polaris-plugin 分支 `feat/interactive-component`。

| 批 | 主仓 commit | 内容 |
|---|---|---|
| A+B | `8f4c6270` | 宿主桥（artifact/form/cap 封闭清单+报错 stub）、rewriter 规则制泛化、component_register + build_component_hold（collect reply 携带 receipt）、组件回执队列 + sendMessage 一次性注入 |
| D1 | `57ad887f` | PRD 域退役（Rust 557 + 壳 400 + 6 注册点，含 polaris_mcp 子命令臂与用法串 3 处——复审项全落地） |
| D+D2 | `fe52a954` | blockRenderers 注册表 + BlockDelegation（updateBlock 宿主回调）+ core:true 守卫（Rust manifest 字段 + uninstall 拒绝）；FormCard/AskQuestionCard 删除 |
| E | `0e37e024` | uiTemplateRegistry（命名空间/保留名/二选一/跨插件覆盖拒绝）+ Rust contributes 扩展 + cap 桥 deny 清单与声明白名单 + renderer/cap 透传 + server caps 参数 |
| test | `7a46023e` | 断言引号修正 |

插件仓 commit `3ee0d87`：interactive-component v1.0.0（server 移植 + 三 bundle + 测试 harness）。

### 验证证据

- `tsc --noEmit`：全绿（每批后实跑）
- `cargo check --lib`：0 error（B/E 批后）；`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`：绿（D1/E 后）
- `cargo build --bin polaris-mcp`：重建成功，冒烟——子命令清单无 prd-preview、requirements server 工具正常（stale usage 串经冒烟揪出并修正，验证了 AGENTS.md 重建纪律的价值）
- vitest：全量 112 文件/1470 用例绿（D2 后）；E 批受影响 5 文件 44 用例绿
- 插件服务端测试 4/4（金标三条错误路径 + 落盘/版本递增 + form/caps marker）；bundle：card 9.8KB / form-card 30KB / ask-card 32.5KB

### 与方案的偏差（如实登记）

1. `sessionId` 经 `PluginChatCardProps`（block.sessionId 已存在）而非 Context——避免投机性通用面（[A-6]）
2. 模板内 toast → 卡片旁瞬态横幅（宿主 store 不可 import，[S-4]）；i18n → t 兜底直出（文案即中文原文）
3. uiTemplates 本批交付契约+注册+校验（[R-12..R-14]）；「卡片即数据」渲染消费与 chatActions 留后续批次
4. 未做真机双端冒烟（worktree 无运行联调环境）——合并 main 后按 §4 验证矩阵补

### 9.1 真机冒烟记录（2026-11-07，dev 数据根 + junction 安装 + 浏览器自动化）

| 冒烟项 | 结果 | 证据 |
|---|---|---|
| 插件安装+发现 | ✅ | junction 进 Polaris-dev/plugins → cap.pluginDiscovery discover 23 含 interactive-component（core/blockRenderers/chatCards entry 齐）→ 前端注册表装载（插件页 21 个安装插件 0 诊断，侧栏出现全部插件面板入口） |
| render_component 卡片 | ✅ | AI 对话真实工具调用 → server 执行落盘（marker/previewId）→ 卡片 iframe 沙箱渲染 + 表单回传徽标 + 全屏 UI |
| form 契约登记 | ✅ | `[Component] 组件型 hold 已登记 formId=smoke-form-16 read=full`（组件 mount 自动登记） |
| 契约提交 | ✅ | 组件内提交 → `[Form] form_submit formId=smoke-form-16 holds 数=1` → 卡片「✅已提交（回执将随下一条消息带给 AI）」 |
| 回执回流 | ✅ | 下一条消息注入回执 → AI 准确答出提交值 42 |
| cap 白名单通过 | ✅ | 组件内 cap.kv（已声明）→ `[kv-set-ok] ok=true`（请求到达总线执行） |
| cap deny 拒绝 | ✅ | 组件内 cap.bash（已声明但敏感能力）→ `ok=false 属敏感能力，已拒绝（deny 清单）` |
| 伪造 formId 提交 | ✅ | WRONG-FORMID 提交 → 卡片桥忽略，**0 次到达后端**（log 仅正确契约一次 form_submit） |
| form/ask 块委托 live 渲染 | ⏳ | form 工具调用/hold 注册/form 事件广播均 ✅（log），委托 fallback 在注册修复前正确接住（lookup 链路 ✅）；**live 渲染被环境阻塞**：web 模式 WS 在浏览器标签后台化时节流 → 服务端 60s idle 关闭 → 活动事件丢失（前端有重连但活动窗口内丢了即丢）。非本分支引入（main 同行为）；真人可见标签页操作不受影响 |

冒烟驱动修复（已入库）：`d3416f18`（前端 manifest 镜像缺 core/blockRenderers/uiTemplates + shim 命名导出 + 解构遗漏 + block sessionId）、`576c372b`（replaceInstalled/registerInstalled 漏挂注册——安装插件路径从未注册新贡献点）。

**合并前剩余**：form/ask 委托的真人可见标签页回归（打开 localhost:9828 登录 98279829++，粘贴 form/ask 提示词各一轮，确认字段/选项卡渲染并提交）——自动化环境（IAB 后台节流+WS idle）无法代劳，真人操作不受影响。

### 9.2 阻塞语义定案（2026-11-07 用户拍板）

**阻塞与否由 AI 调用时选择，默认值按工具语义固定**：

| 工具 | 默认 | AI 可覆盖 | 回执到达 |
|---|---|---|---|
| ask_user_question | 阻塞 | 否（工具语义即等待） | oneshot 同回合 |
| form | 阻塞 | 否（collect/dispatch 都等提交） | oneshot 同回合 |
| render_component 无 form | 非阻塞 | 否（纯展示无回执面） | — |
| render_component + form 契约 | 非阻塞 | **✅ wait:true → 阻塞** | 默认：下一条消息注入 · wait:true：同回合 |

**wait:true 实现路径**（零新机制）：插件 server 本地开回调端口（ask_mcp_server「阻塞等主进程回包」同款模式）→ component_register 登记 hold + 挂起点 → form_submit 回执既喂挂起的工具调用也走卡片事件。超时纪律沿用 FORM_WAIT_TIMEOUT_SECS(600s) + 迟到「表单已失效」。

**效果**：自由组件补上「审批门/确认门」类场景（AI 等你操作完再继续），非阻塞保持「先渲染后补数据」场景——由 AI 按需在 marker 里选 wait。

### 9.3 P1/P2 实施后遗留问题（2026-11-07 真机复验发现）

**双工具共存问题**：内置 ask server 的 form/ask 工具与插件的 form/ask 工具**同时暴露给 AI**。
AI 调了内置版 → 旧 contextId 路由缺陷 → 面板不渲染。修复 = P3（移除内置 ask server 的
form/ask 工具注册），使 AI 只能调插件版本。

**新发现——内置 ask server spawn 不稳定**：log 反复出现"无法定位 polaris-mcp"导致
`polaris-ask` server 跳过（spawn 失败），但其工具曾在会话早期成功注册过 → 后续仍被调用。
此为**存量基础设施问题**（polaris_mcp 二进制定位机制），与本分支无关但加剧了调试复杂度。

**当前 git 状态**：
- 主仓 main：8fad28b5→c0abb73e(P1)→d950398a(P2)→54ef04f9(阻塞定案)→4fe59b14(合并)→8d451b67(cap shim 修复)→未 push
- 插件仓 main：337bc68(样式修复)→334b934(模板CSS)→21ceb70(form/ask 阻塞工具)→337bc68→未 push
- 插件 server 已实现 form/ask_user_question 阻塞工具 + render_component + preview/read/list
- 宿主已有 interaction_relay（begin/notify/sweep）+ mcp_call_raced _polarisSessionId 注入

**下一步（新会话）**：
1. P3：移除内置 ask server 的 form/ask 工具注册（保留 Claude 原生问答路径）
2. P4：真机验证（form/ask 委托渲染 + 原始样式 + 回执回流 + 多会话路由）
3. 通过后 push 两仓 main
