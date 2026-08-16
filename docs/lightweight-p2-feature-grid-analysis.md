# P2 可行性分析：Cargo 功能域 feature 网格

> 状态：可行性分析（不实施）
> 目标：评估把 git/lsp-index/scheduler/web-server/integrations 等能力域表达为 Cargo feature 的可行性、收益与成本，为是否实施提供决策依据。
> 前置：本分析基于 P0/P1 已完成的运行时开关 + 前端按需加载，聚焦"编译期轻量化"（不编进 clib/so）。

---

## 1. 结论摘要

| 维度 | 评估 |
|---|---|
| **可行性** | ✅ 部分能力域（git2 / tree-sitter）耦合干净，可直接 feature 化 |
| **收益** | ⚠️ 编译时间收益显著；**最终 exe 体积收益受 fat LTO 摊薄，需实测** |
| **主要障碍** | ① rusqlite 是横切依赖（核心 DOM 层，不可随功能关闭）② git 已定"主项目保留"决策 ③ `tauri-app` 门控已 471 处（若想关单个 command 需重构） |
| **推荐** | **先做 `lsp-index` 单个 feature 试点**，验证收益与门控成本后，再决定是否铺开 |

---

## 2. 现状基线（本次核查确认）

### 2.1 Cargo feature 现状
```toml
[features]
default = ["tauri-app"]
tauri-app = ["dep:tauri", "dep:tauri-build", "dep:tauri-plugin-*", ...]
```
- 仅区分 `tauri-app`（桌面）/ 无 feature（Web-only），**不区分能力域**。
- **471 处** `#[cfg_attr(feature="tauri-app", tauri::command)]` 门控已统一（`commands/*.rs` 41 文件），这是现成样板。

### 2.2 目标依赖耦合图谱（全量 grep 确认）

| 能力域 | 携带依赖 | 引用点 | 耦合度 | 可门控性 |
|---|---|---|---|---|
| **git** | `git2`(vendored-openssl) | 仅 `services/git/`(10) + `commands/git.rs` + `lib.rs` + `web/api/ipc.rs` | **极低** | ✅ 高 |
| **lsp-index** | `tree-sitter`+`tree-sitter-java`+`rayon`+`xxhash` | 仅 `services/lsp_index/` + `state.rs`(创建) + `models/config.rs`(配置字段) | 低 | ✅ 高 |
| **scheduler** | `cron` | `models/scheduler.rs`(inline) + `services/scheduler*` + `scheduler_daemon` + `commands/scheduler.rs` | 中（多处服务入口） | ⚠️ 中 |
| **web-server** | `axum`/`tower`/`tower-http`/`if-addrs` | `web/api/*` + `services/proxy/server.rs` + `commands（apply_web_server etc）` | **高**（与聊天/代理/桥接交织） | ❌ 低 |
| **integrations** | `tokio-tungstenite` | `integrations/dingtalk|feishu|qqbot` + `manager.rs` | 低 | ✅ 中 |
| **computer-control** | `enigo`/`xcap`/`uiautomation` | 已按 `cfg(windows)` 门控 | 已隔离 | ✅ 已就位 |
| **pty** | `portable-pty` | 已按 `cfg(not(android))` 门控 | 已隔离 | ⚠️ 平台级 |

### 2.3 rusqlite 横切依赖（**关键发现**）
`rusqlite`(bundled sqlite) 被三处使用：
- `services/dialog_index.rs` — **对话历史索引**（核心，不可关）
- `services/usage_db.rs` — **用量统计**（核心，不可关）
- `services/lsp_index/db.rs` — **代码索引**（可关）

**结论**：rusqlite 是**核心 DOM 层依赖**，不能随 lsp-index 关闭。feature 化 lsp-index 时，rusqlite 必须保留（共享依赖）。这意味着**无法通过关闭 lsp-index 卸载 sqlite 编译负担**——除非把 dialog_index/usage_db 也 feature 化（它们更核心，不值得）。

### 2.4 编译体积实测（debug 中间产物）
| 依赖 | rlib/rmeta 体积 |
|---|---|
| `tree-sitter` + `tree-sitter-java` | ~4.4MB |
| `rusqlite` + bundled sqlite | ~5.4MB |
| `git2` vendored-openssl | ~3.7MB(rmeta) |

> ⚠️ **这些是 debug 中间产物，不代表最终 exe 差异**。release 用 `opt-level=z` + `fat lto` + `strip=symbols` 后，未使用代码会被 LTO 树摇，**实际 exe 节约可能远小于 rlib 体积**——这是本分析最大的不确定性，必须实测。

---

## 3. 目标 feature 网格（草案）

```toml
[features]
default = ["tauri-app", "git", "lsp-index", "scheduler", "integrations"]
tauri-app = ["dep:tauri", ...]
# 能力域开关（默认全开，精简单设 # 去掉即可）
git = ["dep:git2"]
lsp-index = ["dep:tree-sitter", "dep:tree-sitter-java", "dep:rayon", "dep:xxhash-rust"]
scheduler = ["dep:cron"]
integrations = ["dep:tokio-tungstenite"]
```

### 3.1 设计原则
1. **默认全开**：`default = [全部]`，现有用户零变化（向后兼容硬约束，与 P0 同原则）。
2. **每个 feature 双向门控三处**（参考 `web-only-tauri-command-gate` 记忆）：
   - 模块声明 `#[cfg(feature="git")]`
   - `mod.rs` re-export `#[cfg(feature="git")]`
   - `lib.rs` invoke_handler 注册 `#[cfg(feature="git")]`
3. **Web-only 回归底线**：`cargo check --no-default-features` 必须仍通过。
4. **rusqlite 保持常驻**（共享核心依赖，不随任何功能关闭）。

---

## 4. 试点建议：lsp-index 优先

### 4.1 为什么选 lsp-index
- 耦合最干净（仅 `services/lsp_index/` + `state.rs` + `config.rs` 字段）。
- 携带依赖（tree-sitter/rayon/xxhash）是**纯可选增值**，无核心依赖。
- 关闭后有**明确降级路径**（`regex_fallback` 已存在，P0 开关语义已建立）。
- 收益可量化：debug 编译省 ~4.4MB + 大量解析时间。

### 4.2 试点改动清单（预估）
1. `Cargo.toml`：新增 `lsp-index` feature + `dep:tree-sitter` 等 optional。
2. `services/mod.rs`：`#[cfg(feature="lsp-index")] pub mod lsp_index;`
3. `state.rs`：`LspIndexService` 字段 + 创建逻辑包 `#[cfg]`。
4. `commands/lsp.rs` + `lib.rs` invoke_handler 注册：`#[cfg(feature="lsp-index")]`。
5. `web/api/ipc.rs`：lsp_* dispatch 路由包 `#[cfg]`。
6. 前端：`lspIndexStore`/`IndexStatusBadge`/`IndexEngineSection` 需在 feature 关闭时优雅隐藏（`invoke` 不存在 → UI 降级提示）。

### 4.3 试点风险
- 前端对 `lsp_*` invoke 的调用在 feature 关闭时会报"命令不存在"——**这是最大的坑**（invoke_handler 缺命令返回 error）。需定义统一的"能力缺失"提示路径。
- `config.rs` 的 LspConfig 字段在 feature 关闭时不能从 invoke 暴露（但 serde 仍需解析旧配置字段 → 用 `#[serde(default)]` 忽略而非删除）。

---

## 5. git feature：与插件化决策的张力

- **现状**：`git-plugin-extraction-plan` 已定"主项目内置 GitPanel 保留（后端 git2 不动）"，并已把编辑器 git 集成 + polaris-git 插件外迁。
- **feature 化 git 的吸引点**：关闭后不再编译 git2（vendored-openssl 是**编译耗时大户**，且难以交叉编译）。
- **张力**：主项目内置 GitPanel 保留 = 后端 git2 仍需在默认下可用 → 只能作为"精简配置"（`--no-default-features --features=tauri-app`）的关闭项，与插件化不冲突但价值边缘化。
- **建议**：git feature 化**推迟**到插件化完全走通后评估。当前 lsp-index 试点更干净。

---

## 6. 收益/成本权衡

| 项 | 收益 | 成本 | 判断 |
|---|---|---|---|
| lsp-index 试点 | 省 tree-sitter 编译；回归底线清晰 | 6 处门控 + 前端 invoke 降级 | **推荐先做** |
| git | 省 git2/openssl 编译（最大编译耗时） | 触碰"内置 GitPanel 保留"决策；invoke 降级面大 | 推迟 |
| scheduler | 省 cron（但很小）；语义清晰 | 多处服务入口门控 | ROI 中 |
| web-server | 省 axum/tower（大） | 与聊天/代理/桥接交织，**不可独立关** | ❌ 不可行 |
| integrations | 省 tokio-tungstenite | 三处机器人入口门控 | ROI 中 |

**核心结论**：P2 真正的收益在**编译时间**（尤其 git2/openssl 与 tree-sitter），而非 exe 体积（fat LTO 已摊薄）。若目标是加快构建，git2 卸载收益最大但决策受阻；lsp-index 是干净试点的最佳选择。

---

## 7. 推荐实施路径

```
Phase 0（试点）: lsp-index feature 化 + 前端 invoke 降级 + cargo check 矩阵
   门槛: --no-default-features 通过; 全开默认通过; 关闭后前端无白屏
   度量: cargo build 时间对比 + exe 体积对比

Phase 1（扩展）: scheduler / integrations feature 化（若试点评估 ROI 正）
   门槛: 同上 + 三档 CI 矩阵 {default, web-only, 精简桌面}

Phase 2（深水）: git feature 化（依赖插件化走通 + 重新评估"内置保留"决策）
Phase 3（不推荐）: web-server 拆分 —— 与核心交织过深,改为运行时 web.enabled 开关(已存在)
```

---

## 8. 本分析与其他轻量化抓手的关系

| 本分析 | 关系 |
|---|---|
| P0 运行时开关 | **正交**：P0 是运行时不启动服务，P2 是编译期不编进代码。两者叠加 = "能力不在场"完整闭环 |
| P1 前端按需 | **正交**：P1 管前端 bundle，P2 管后端二进制 |
| git-plugin-extraction | **依赖**：git feature 化需在插件化决策更新后才可评估 |
| web-only 门控记忆 | **复用**：471 处 `tauri-app` 门控是现成样板，P2 沿用同一模式 |

---

## 9. 需用户决策的点

1. **是否实施 P2**？若接受"主要是编译时间收益"这一结论，建议做 lsp-index 试点验证后滚动决策。
2. **git2 卸载是否值得**？取决于项目对"内置 GitPanel 保留"的坚定程度与构建速度的痛点程度。
3. **CI 矩阵成本**：三档 cargo check 增加 CI 时间，是否可接受？

> 本分析不改变任何代码。实施需在用户确认后启动。