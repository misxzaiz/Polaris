# 最佳方案：config_dir 统一与配置写读分离根治

> 状态：设计稿（待评审）
> 日期：2026-09-07
> 范围：Polaris 主项目 + image-recognition 插件

---

## 一、问题全景（已彻底核实）

### 1.1 核心矛盾

桌面 Tauri 模式下，**同一进程内两套目录并存且脱节**：

```
                    ┌─────────────────────────────┐
                    │  data_root() = Roaming\Polaris │ ← 数据存储（用户可改）
                    │  ConfigStore::new() 读这里    │
                    │  plugin_set_config 写这里     │
                    │  Web 模式 MCP 注入读这里      │
                    └─────────────────────────────┘
                    ┌─────────────────────────────┐
                    │  Tauri app_config_dir        │
                    │  = Roaming\com.polaris.app    │
                    │  lib.rs:667 覆盖 state 到这   │
                    │  桌面模式 MCP 注入读这里       │
                    │  todo/requirement/scheduler 写这│
                    └─────────────────────────────┘
```

**写读分离**：插件配置面板存到 Polaris（ConfigStore），MCP server 从 com.polaris.app 读（{{appConfigDir}}）→ 读不到 → 报「未配置 API Key」。

### 1.2 已确认的关键事实

| 事实 | 证据 |
|---|---|
| `ConfigStore` 永远用 DataRoot（`Roaming\Polaris`） | `config_store.rs:24`，与 state 解耦 |
| Web 模式早已自洽（全走 DataRoot） | `lib.rs:1362` |
| 只有桌面模式分裂 | `lib.rs:667` 用 Tauri 目录覆盖 state |
| `{{appConfigDir}}` 无自主解析 = 传入的 config_dir | `mcp_config_service.rs:1009` |
| MCP 注入来源 = state.app_config_dir（桌面=com.polaris.app） | `chat.rs:1141`、`web/api/chat.rs:19`、`manager.rs:958` |
| 插件系统只认单一根，无法双读 | `plugin_service.rs:323` |
| com.polaris.app 与 Polaris **各有一份 config.json** | 本机实测 |
| DataStorage 已有完整迁移框架 | `data_root_cmd.rs` scan/migrate + map_legacy_subpath |
| DataRoot 统一是设计意图，桌面未贯彻 | `data_root.rs:31-32,192-195`；`lib.rs:1360` 注释 |
| **第二个隐藏分裂**：调度器桌面/Web 数据各自落盘 | `commands/scheduler.rs` vs `ipc.rs:1924` |
| **第三个隐藏分裂**：插件发现面板/MCP 各扫各的 | `plugin_config.rs:92` vs `mcp_config_service.rs:941` |

### 1.3 存量污染（当前已存在的脏状态）

| 数据 | 现状 |
|---|---|
| 插件 | com.polaris.app/plugins（9 个）与 Polaris/plugins（5 个）两套 |
| config.json | com.polaris.app 与 Polaris 各一份，`plugins["image-recognition"]` 可能不同 |
| todo / requirement / scheduler | 桌面在 com.polaris.app，Web 在 Polaris |
| image-recognition apiKey | 可能分散在两处（手动修过 com.polaris.app） |

---

## 二、方案目标与原则

**目标**：让「数据存储」（DataRoot）成为**唯一**的配置与数据承载，消灭双目录分裂；对用户**零破坏、可回滚、可感知**。

**原则**：
1. **不丢失数据**：迁移用复制 + 冲突副本（`.legacy-*`），不删源。
2. **可回滚**：每阶段独立可验证、可回退。
3. **用户可感知**：复用「数据存储」UI 展示检测/迁移，不搞静默。
4. **彻底**：不只修本插件，根治全部三类分裂。

---

## 三、最佳方案（分四阶段）

### 阶段 0：现状加固（插件侧，已完成 ✅）

`image-recognition/mcp/server.js` 改为**多候选目录合并读取**（DataRoot + Tauri 目录 + 兜底），且每次调用实时读。这让本插件在「统一完成前」的过渡期就能正常工作，无感。

> 已实施并验证。这是安全网，保证后续阶段任何时候出错，本插件都不受影响。

### 阶段 1：主项目根修复（两处核心，改动 <20 行）

**让桌面模式的 `state.app_config_dir` 与 `config_dir` 注入统一到 DataRoot。**

| 位置 | 改动 |
|---|---|
| `lib.rs:667` | `state.app_config_dir = data_root().config_dir()`（去掉 Tauri path resolver 分支） |
| `integrations/manager.rs:958` | `config_dir = data_root().config_dir()`（顺手修掉 non-tauri None 分支） |

**效果**：
- 一处改动自动收敛 **10 个** `state.app_config_dir` 消费点（插件发现、MCP 注入、executor、调度器健康监控等全部跟随 DataRoot）。
- MCP 注入与 ConfigStore 立即对齐 → image-recognition 根因消除（即使阶段 0 失效也不影响）。
- 顺带修复「插件发现面板/MCP 分裂」与「调度器桌面/Web 分裂」。

**验证**：编译通过 + 手动确认 `{{appConfigDir}}` 注入 = `Roaming\Polaris`。

### 阶段 2：直调点清扫（22 处，分两组）

把剩余直接 `app/window.path().app_config_dir()` 统一为 DataRoot。**分两批，每批独立验证。**

**批次 2a（无数据迁移风险）**：
- `prompt_snippet.rs`、`plugin_state.rs`、`agnes.rs`、`diagnostics.rs`、`chat.rs:2013/2045`、`scheduler.rs`（数据本就该在 DataRoot，且与 MCP 端对齐后一致性更强）

**批次 2b（需数据迁移）**：
- `todo.rs`（7 处）、`requirement.rs`（7 处）— 历史数据在 com.polaris.app，需迁到 DataRoot

### 阶段 3：存量数据迁移（复用 DataStorage 迁移框架）

**扩展 `scan_legacy_data`** 把 `com.polaris.app` 识别为「旧版数据源」（与 claude-code-pro 并列），复用整套 `migrate_legacy_data` 框架：

```rust
// scan_legacy_data() 中追加：
if let Some(base) = dirs::config_dir() {
    let path = base.join("com.polaris.app");
    if path.exists() && path != data_root().root() {
        results.push(LegacySource {
            path: path.clone(),
            label: "Tauri 遗留配置目录",
            ...
        });
    }
}
```

**关键设计**：
- `map_legacy_subpath` 已天然处理：`plugins/` 同名映射、`logs/` 跳过、冲突写 `.legacy-*` 副本、相同文件跳过——**安全**。
- **排除** `EBWebView`（WebView2 运行时）、`browser`（浏览器数据）等 Tauri 运行时目录，这些仍需留在 com.polaris.app，不迁。
- UI 上「数据存储 → 检测到旧版数据」会自动出现 com.polaris.app 条目，用户勾选迁移（默认 merge 模式）。

**零破坏**：源目录保留，迁移是复制；冲突文件不覆盖新数据（除非用户选 overwrite）。

### 阶段 4：收尾与文档

- 确认 `com.polaris.app` 仅剩 Tauri 运行时数据（EBWebView/browser 等）。
- 更新文档：`plugin-development-guide.md` 的 `{{appConfigDir}}` 明确 = 数据存储目录。
- 清理本机遗留：确认 `polaris`/`Polaris` 大小写、历史残留。

---

## 四、为什么不选其他方案

| 方案 | 否决理由 |
|---|---|
| 激进一次性全改（原策略 1） | 30+ 处 + 数据迁移一把梭，风险高、难回滚 |
| 只改插件（方案 A 单独） | 治标，其他插件仍踩坑；但作为阶段 0 安全网保留 |
| 兼容双根（原策略 3） | 插件系统只认单根，需大改发现/安装逻辑，复杂度最高且仍分裂 |
| 完全不动主项目 | 无法根治；三类分裂持续存在 |

---

## 五、风险与缓解

| 风险 | 缓解 |
|---|---|
| 阶段 1 后插件「消失」 | 阶段 3 迁移前，com.polaris.app/plugins 仍在，但阶段 1 后 MCP 去 Polaris/plugins 找 → **阶段 1 和 3 必须同版本发布**，或阶段 1 用「双根发现」过渡 |
| todo/requirement 历史数据不可见 | 阶段 2b 与阶段 3 捆绑，先迁后扫 |
| dev 与 release 版本读到不同目录 | 统一到 DataRoot 后天然一致 |
| WebView2 等运行时数据被误迁 | `map_legacy_subpath` 显式排除 EBWebView/browser |
| 迁移中断 | `migrate_legacy_data` 已有日志 + 冲突副本机制 |

> **⚠️ 关键约束**：阶段 1（改解析）与阶段 3（迁插件）**不能拆开发布**——否则改完解析、插件又没迁过去，用户插件会在 MCP 里消失。最优做法是：**阶段 1+2a+3 同版本发布**（解析统一 + 数据迁移引导同步上线），阶段 2b 紧随其后。

---

## 六、建议推进节奏

1. **阶段 0**：已完成（插件多目录读取）✅
2. **阶段 1+3 捆绑**：主项目根修复 + 迁移框架扩展，一次编译发布 → 根治
3. **阶段 2a**：清扫无迁移风险的直调点
4. **阶段 2b**：todo/requirement 迁移
5. **阶段 4**：文档 + 收尾

---

## 七、待确认

- [ ] 认可「阶段 1 与阶段 3 捆绑发布」的节奏？
- [ ] 迁移的默认冲突策略用 merge（现有默认，安全）？
- [ ] 是否要我在主项目先做**阶段 1 的代码改动草案**（不编译、只出 diff 给你审）？