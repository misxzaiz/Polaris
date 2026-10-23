# spec: UI 模板运行时注册（AI 可注册 / 管理 / 填参渲染）

> 日期：2026-10-23 · 状态：实现中
> 关联：`plans/plugin-cap-inject-render-v1.md`（cap.ui.render 出处）、`plans/plugin-manage-hook-inject-v1.md` §5

## 1. 目标

让 AI 在**运行时**注册 parametrized UI 模板（声明式 DSL，非任意 HTML），此后在其住任意回合
用「模板 ID + params」在 AI 对话页渲染可交互卡片，用户操作结果经既有 oneshot 链路回传同回合。

现状缺口：插件聊天卡片（`chatCardRegistry`）只能在 manifest 安装时注册；`cap.ui.render`
已有运行时弹帧全链路（pending + oneshot + plugin_card 事件），但：

1. 无「模板注册 / 复用」能力——每次调用都要重发完整结构；
2. `custom` 帧必须命中已安装插件组件；
3. **question / form / confirm 帧前端没有任何专用渲染器**（`PluginCardFallback` JSON 兜底，
   且兜底无 respond 按钮 → 现在实际上会挂满 180s 超时）。

## 2. 设计决定（假设，未与用户二次确认）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 模板形态 | 声明式 DSL 白名单 | 与 `ui_render_capability.rs` 既有安全取向一致（「v1 不做任意 HTML」） |
| 生命周期 | 全局 + 持久化（可 persist=false 仅内存） | 契约 Storage（SqliteStorage domain=`ui.template`）现成可用 |
| 交互模式 | `request`（阻塞等 answer 180s，同现状）+ `display`（fire-and-forget） | 纯展示场景不该占 oneshot |

## 3. 后端：cap.ui.render 扩展（协议 v2，向后兼容）

### 3.1 新增动作

- `register`：`{ templateId, title?, description?, dsl: Node[], buttons?: [{id,label,danger?}], persist?: true }`
  → 校验（DSL 白名单/深度 ≤8 / 节点数 ≤64 / 序列化 ≤32KB）→ 存 Storage domain `ui.template`
  → `{ registered: true, templateId }`。同 id 重注册 = 覆盖更新（warn 日志 + owner 记录）。
- `unregister`：`{ templateId }` → 删持久化条目 → `{ unregistered: true }`
- `list`：`{}` → `{ templates: [{ templateId, title, description, owner, createdAtMs }] }`

### 3.2 frame.type 白名单扩展

`ALLOWED_FRAME_TYPES` + `"template"`：`{ type:'template', templateId, params?: object, mode?: 'display' }`

- `request` 请求级 `mode:"display"` 时：不登记 pending / oneshot，广播后立即返回
  `{ status:'displayed', interactionId }`（interactionId 仅作前端去重 id）。
- 模板帧 payload 组装：模板**定义内联**下发
  `{ title, frame: { type:'template', templateId, mode, template: <def>, params } }`
  → 前端无状态渲染，历史重放（对话磁盘恢复）不依赖注册表现存。「日志即真相」一致性。
- 交互模式校验 `frame.templateId` 必须已注册（stockpile 里查不到 → 报错给调用方）。

### 3.3 DSL 节点白名单

`vstack / hstack / text / metric / badge / table / progress / divider / input / select`
- `input/select` 带 `field` 名（≤32 字符）→ 应答收集 `values: { field: value }`
- `table`：columns ≤8、rows ≤50；`text` 内容 ≤2000 字符；`select` options ≤32
- 未知字段/类型：**fail fast**（注册时报错），渲染器对未知节点画错误占位（容错不崩）

### 3.4 应答协议（AI 解读端）

- template：`{ templateId, action: <buttonId>, values: {...} }`
- question：`{ answers: [{ selected: [...], customInput? }] }`（对齐 ask 事件形状）
- form：`{ values: { <name>: <value> } }`
- confirm：`{ confirmed: boolean }`

## 4. 前端：内置 UiFrameCard（cap 帧统一渲染器）

- `chatCardRegistry` 新增 `registerBuiltinExact(key, ...)`（不经 `mcp__{server}__{tool}` 组装，
  按 `toolName === 'ui.render'` 精确命中——`cap.ui.render` 发的帧 toolName 默认即 `ui.render`）。
- `UiFrameCard`（`src/components/Chat/chatBlocks/UiFrameCard.tsx`）：
  - payload 解析 `{ title, frame }` → 按 frame.type 分派：
    - `template` → DSL 渲染树（`uiTemplateNodes.tsx`）+ footer buttons + input/select 值收集
    - `question / form / confirm` → 最小组件渲染（顺手修复 §1-3 的 JSON 兜底缺口）
  - `{{param}}`/`{{param.path}}` 插值（value 需为 string/number；对象/数组不插值）
  - props.respond 缺失（display 模式 / 已应答 / 失败）→ buttons 禁用并显示状态条
  - 展示全部走主题 token（`border-border` / `bg-background-elevated` / `text-text-*` 等），
    **无硬编码颜色字号**（DESIGN.md 纪律）
- 注册处：`builtinPlugins.ts`（builtin 无 installPath 同款）。

## 5. 所有者与事件顺序（文字图）

```
AI（cap_dispatch）
  │ register ──────────────▶ [cap.ui.render] 校验 DSL
  │                                └▶ ctx.storage() store(ui.template, Item)
  │ request(template, params) ─▶ [cap.ui.render] load(ui.template)
  │        │ mode=interaction                      │ mode=display
  │        ▼                                       ▼
  │   登记 pending + oneshot                    仅广播
  │        │ 广播 plugin_card(filterable)          │
  ▼        ▼                                       ▼
前端 eventHandler 'plugin_card' → PluginCardBlock(mode:interaction, data=payload)
  ▼
PluginCardHost → chatCardRegistry.load('ui.render') → <UiFrameCard>
  ▼ 用户操作
respondPluginCard ──▶ cap.ai.chat respond_plugin_card ──▶ oneshot send（同回合回 AI）
                                        └▶ 广播 plugin_card_answered → 前端块 status 翻转
```

- 状态所有者：模板 = 契约 Storage（Sqlite）；pending = `AppState.pending_plugin_cards`；
  应答归属 = interactionId oneshot（幂等：`respond_plugin_card` 先 remove 再 send）。
- display 模式无 pending 表项：用户按钮禁用，不产生幂等边。

## 6. 验收

- [ ] AI 可通过 cap_dispatch 调 `cap.ui.render register` 注册模板，`list` 可见，重启后仍可用
- [ ] `request` template 帧 + params 在对话页渲染为填参卡片（`{{param}}` 替换生效）
- [ ] 用户点击按钮 / 输入值 → AI 同回合收到 `{action, values}`；卡片 status → answered
- [ ] `mode:'display'` 立即返回不阻塞，按钮禁用
- [ ] question / form / confirm 帧不再是 JSON 兜底，可交互（修复既有缺口）
- [ ] `cargo check` + `pnpm exec tsc --noEmit` + 相关 lint 通过

## 7. 边界与后续（明确不做）

- 不做任意 HTML / JS 注入面（sandbox frame 为后续可选项：`kind: 'html'` 另开规范）
- 协议无运行时 schema 校验是既知缺口：字段加得保守，Rust `serde` deny-unknown 等价校验由
  hand-written validate_frame 承担；前端对未知帧 type 走容错占位
- 模板 marketplace / 跨插件共享、模板级权限子策略：后续工作项
