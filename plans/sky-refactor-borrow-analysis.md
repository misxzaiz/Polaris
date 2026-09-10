# sky 可借鉴点分析 —— Polaris 重构参考

> 状态：分析定稿（待实施）
> 日期：2026-09-10
> 性质：纯分析。从 sky（D:\space\base\do\sky）吸收架构思想用于 Polaris 渐进式重构。
> 对应：sky 自身定位 = Polaris 的架构级复刻升级（只复刻思想与契约，不复刻代码）

---

## 0. 结论先行

**sky 是把 Polaris 的经验浓缩成一套更干净骨架的实验。** 它的价值在设计纪律（一份契约定义清楚一件事，所有实现往契约上靠），不在实现完成度（Session/Scheduler/AuditSink 三个核心契约零实现、权限仍恒 Allow、FTS 零调用方）。

- **Polaris 现状**：功能过载后的机制增殖——同一能力暴露 3 次（IPC 284 个 command + HTTP 路由 + IPC 桥 195 分支 match）、3 套注册表并存（EngineRegistry/ExecutorRegistry/CapabilityRegistry）、AppState 41 字段、637 处 feature 门控、FTS5 膨胀。
- **sky 骨架**：一个入口（`Router.dispatch`）+ 一套契约（8 个核心 trait）+ 可替换实现。11 条路由全部构造 `Envelope` 走 dispatch → 权限检查 → 路由 → 事件广播。

**借鉴方式**：渐进式迁移思想，非复制代码。sky 无 CLI 子进程/无 MCP/无调度器，Polaris 的 5 引擎 + 12 MCP server + 28 插件是必须保留的资产。

---

## 1. 两项目量化对比

| 维度 | Polaris | sky |
|---|---|---|
| Rust 代码 | 241 文件 / 112,503 行 | ~4,500 行（src/ + contracts/） |
| tauri command | 284 个 | 无（无头 Core） |
| 前端 | 716 文件 / ~123K 行 TS | 1,263 行 React 壳 + 插件 iframe |
| 测试 | 无统一基线（历史 22+3 绿） | 232 测试，0 警告 |
| 依赖 | 728 crates | 16 crates，无零使用 |
| 引擎 | 5 个 + 插件引擎 | 1 个（SimpleAI HTTP 直连） |
| MCP | 12 个内嵌 server + 自研 client + bridge | 无（阶段 2 预留） |
| 插件 | 11 前端插件 + dsh 外部插件 | 8 内置能力 + 7 托管视图插件 |
| 传输 | 双传输（IPC/HTTP）+ IPC 桥 | 单传输（HTTP/WS）+ 单入口 dispatch |
| 权限 | 能力 seam（shell/fs/compaction/subagent） | Source 枚举（无 Local 变体）+ 双 gate + 工具级门 |
| 存储 | 四套独立持久化 + FTS5 trigram | 按域分库 + 审计内嵌 + FTS 可重建 |

---

## 2. 八项可借鉴设计（按价值排序）

### 2.1 单入口 dispatch —— 治"双传输"

**sky**：`Router` trait 只有 `dispatch` + `subscribe` + `register_handle`，**没有 `invoke`**。所有来源构造统一 `Envelope` 走同一条流水线。`resolve_handle` 从 trait 移除，防插件旁路直调。

**Polaris 现状**：业务能力暴露三次——`#[tauri::command]`（284）+ HTTP 路由（`web/api/*.rs`）+ IPC catch-all 桥（`web/api/ipc.rs` 195 分支 match）。`state.rs:clone_for_web()` 为 Web 服务器复制 40+ 字段 AppState（部分字段替换为空实例、scheduler_daemon 重建）。

**落地**：新增能力一律只写 `dispatch(Envelope)` 一次，Tauri/Web 两个壳都调它，渐进替换旧 command。

### 2.2 Source 来源标记 + 权限进 Envelope —— 治"本地沾光远程"

**sky**（`src/contracts/mod.rs`）：
```rust
pub enum Source {
    Bootstrap,                    // 只有 Core 内部调用才有，Shell 永不获得
    Remote { token: String },     // 经 HTTP/WS，必须带 token
    Plugin { caller: PluginId },  // 插件间调用
}
```
**Source 无 `local` 变体。** 本地 Shell 靠 `LocalSecret`（Core 启动生成、经环境变量非 HTTP 通道注入）证明身份，标 Bootstrap。源 IP 不作依据。cap.system 敏感操作（reveal/set/rotate）额外要求 `Source::Bootstrap`。token 默认开。

**Polaris 的坑**：new-app Phase 0 复审问题 #1 正是此漏洞（本地授权一次远程永久放行），已拆双 gate 但结构未从类型层面杜绝。

### 2.3 宿主拥有 AI 循环，引擎不重入 —— 治引擎架构混乱

**sky**（`plans/ai-architecture-v3` 最有价值的一版，代码级审计推导）：
- 引擎能力只做**单轮、无重入、不执行工具**。工具循环归 `chat_loop`（宿主）显式状态机驱动。
- 推理链：`StreamingCapability::invoke_stream(&self, params, ctx: &dyn Context)` 中 `ctx` 是借用，返回的 `Receiver<Event>` 活得比调用久，`tokio::spawn` 出去的任务无法移动借用 → 流式任务里调不到其他能力 → 这个约束是正确的设计，不是缺陷。
- 每轮检查取消、40 轮上限、`retryable && before_first_byte → 重试`（首字节流出后绝不重试，避免用户看到重复回答）。
- **空 tool_call_id 硬阻断**：宁可报错也不让脏数据污染 messages 历史。

**契约字段**：`Error { message, retryable, before_first_byte }`。

### 2.4 阻断式表单 + 三态 read 模式 —— Polaris 没有的原创设计

**sky**（`form_bridge.rs` + `ai_form_submit.rs` + `tools/form.rs`）：
- AI 调 `form` 工具 → 返回 hold JSON → chat_loop 挂起 → 广播 `tool.call.wait` → 用户提交后 `tool.call.resume` → 以提交回执作为 tool 消息继续。
- **信任边界**：字段原文只在服务端流转，AI 上下文只见回执。
  - `read="full"`（默认）：AI 可读全部值，secret 字段仍掩码
  - `read="none"`：AI 只见字段名列表，值全部 `<已隐藏>`
  - secret 字段无论模式一律掩码
- 超时清理（600s）+ 迟到提交拒绝；`expand_dot_paths` 支持 `a.b` 点路径展开。

**这是服务端强制的信任边界，不是提示词约束。**

### 2.5 工具 schema 内嵌 `panel` 元数据 —— 新增工具零前端改动

**sky**（`tools/form.rs:78`）：工具 OpenAI function schema 带 `panel: { tag: "sky-tool-form", interactive: true }`。前端 `<sky-tool-form>` 是 schema 驱动通用表单渲染器，未注册面板的工具回落 `<sky-tool-card>`。**新增带 UI 工具不改任何前端代码。**

### 2.6 按域分库 + 审计内嵌 + FTS 可重建 —— 治存储碎片化

**sky**（`storage_sqlite.rs`）：
- `stores/<domain>.db` 每域一库，非总库。
- `domain_audit` 表**内嵌各域 DB**——审计与业务表同库同域，天然同事务（消解"审计放哪"三角矛盾）。
- FTS5 用 `content='items'` 外部内容表模式（不存数据副本只存索引），`rebuild_fts` = DROP + 全量重建，**绝不做增量索引**。
- WAL 模式，连接池 `Mutex<HashMap<String, Mutex<Connection>>>`（处理嵌套锁生命周期）。
- 会话：JSONL 真相源 + SQLite 索引可丢弃可重建；重建前快照 title（用户改名只存索引，防丢失）；`get_next_seq` O(n) 是已标注待优化点。

### 2.7 四层服务端注入的共享组件层 —— 插件 UI 与主壳共用 token

**sky**（`server.rs::inject_shared_styles`，include_str 编译期内嵌）：插件 HTML `<head>` 后注入四层：theme.css（设计 token）→ ui.css（组件类）→ ui.js（基础 Web Components）→ panels.js（工具面板元素）。注入顺序/幂等/无 head 兜底均有测试锁定。

- **theme.css 三通道 token**：`--c-primary: 88 166 255` 存 R G B 三通道，用法 `rgb(var(--c-primary) / 0.5)` 派生任意透明度，**禁写 rgba 字面量**。CSS 变量穿透 Shadow DOM 是原生机制，token 天然共享。
- **契约纪律**："变量名是公共 API：只增不改，改名 = 全前端破坏性变更"。
- ui.js：5 个原生 Web Components（sky-button/card/tag/empty/indicator），attachShadow 样式隔离，注册幂等。

### 2.8 工具级安全门 —— 比 Polaris 更细的一层

**sky**（`ai_tools.rs`）：
```rust
const DANGEROUS_TOOLS: &[&str] = &["bash", "write_file", "edit_file"];
```
- 需 config `plugins["ai-tools"].dangerous_tools = true` 显式开启，**默认拒绝**。
- 被禁用时**从 specs 剔除**——模型根本看不到，避免浪费轮次。
- 拒绝时返回 `success:false, denied:true` + 人类可读启用说明，**不 throw**。
- 只读工具（read_file/list_directory/glob/search_files）默认放行。
- 另有一层 config section 白名单（`ALLOWED_SECTIONS` 单一真源，runtime 改端口、model_profiles 硬拒）。

---

## 3. 两个必须注意的坑

1. **sky 的"一切皆插件"部分实现但未验证**。`Session`/`Scheduler`/`AuditSink` 三个核心契约零实现；`Permission` 恒 `Allow`（bin/sky.rs 仍是 AllowAllPermission）；托管插件 `requires` 是装饰性的（能力仍靠 bin/sky.rs 手动注册）；`Transaction::commit/rollback` 是空操作（"审计同事务"靠表同库共置占位）。**强项是设计纪律，不是"插件化已完成"。**
2. **迁移要迁移思想，不复制代码**。sky 无 CLI 子进程/无 MCP/无调度器。sky 自己在 v4 也明确："供应商管理不做插件，做 core 能力"——说明它自己都没全走"一切皆插件"。Polaris 的成熟资产（5 引擎/12 MCP/28 插件/调度器/浏览器/派发）是重写必须保留的。

---

## 4. 渐进式重构路线（P1–P5）

| 阶段 | 内容 | 借鉴 sky | 从 Polaris 保留 |
|---|---|---|---|
| **P1** | 立 `dispatch(Envelope)` 单入口 + Source/权限进 Envelope | 2.1 + 2.2 | 现有 284 command 包成 adapter |
| **P2** | 存储收敛：按域分库 + 审计内嵌 + FTS 可重建 | 2.6 | dialog_index、unified repos |
| **P3** | AI 循环改造：宿主拥有循环 + 重试契约 | 2.3 | simple_ai/chat_loop 全部资产 |
| **P4** | 工具面板 schema 化 + 危险工具门 | 2.5 + 2.8 | MCP 全链路、12 server |
| **P5** | 共享组件层 + 主题 token 纪律 | 2.7 | themeEngine 7 层 88 维度 |

另：阻断式表单（2.4）为独立可选项，价值高但需产品决策（依赖 schema 化工具面板）。

---

## 5. sky 关键文件索引（供后续实施参考）

| 主题 | sky 文件 |
|---|---|
| 契约定义 | `do/sky/src/contracts/mod.rs`、`contracts/contracts.wit` |
| 单入口路由 | `do/sky/src/router.rs`（RouterBus + EventBroadcaster） |
| 权限/来源 | `do/sky/src/contracts/mod.rs`（Source）、`src/server.rs`（classify_source）、`src/lifecycle.rs`（LocalSecret） |
| AI 循环 | `do/sky/src/ai/chat_loop.rs`、`ai/mod.rs`、`ai/simple_ai.rs` |
| 阻断式表单 | `do/sky/src/ai/form_bridge.rs`、`plugins/ai_form_submit.rs`、`plugins/tools/form.rs` |
| 工具宿主 | `do/sky/src/plugins/ai_tools.rs`、`plugins/tools/{bash,config,form,fs}` |
| 存储 | `do/sky/src/plugins/storage_sqlite.rs`、`session.rs`、`config.rs` |
| 共享组件层 | `do/sky/src/server.rs`（inject_shared_styles）、`contracts/{theme.css,ui.css,ui.js,panels.js}` |
| 架构方案 | `do/sky/plans/ai-architecture-v1~v4.md`、`sky-skeleton-v1.md`、`phase0-review.md`、`pre-audit-report.md` |
| 可视化 | `do/sky/plans/visualization-architecture.md`、`web/src/ContentArea.tsx` |

---

## 6. 相关 memory 链接

- [[new-app-architecture]] 全新重写架构（同源思想，sky 是其落地实验）
- [[engine-externalization-complete]] 引擎外迁现状
- [[executor-registry-complete]] ExecutorRegistry（Polaris 的三套注册表之一）
- [[data-root-unification]] DataRoot 收敛（sky anchor.json 同源）
- [[session-history-redesign]] 会话历史（sky JSONL+可丢弃索引对齐）
