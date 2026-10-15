# MCP Bridge 端口自愈（AI 自治）方案

> 状态：**已实施**（2026-10-16）
> 日期：2026-10-15
> 性质：设计 spec。解决 Bridge MCP 因 ask_listener 随机端口导致的下游工具（cap_dispatch / cap_list / dispatch_task 等）永久失联问题，以 AI 自治为核心目标。
> 前置根因分析已完成（基于源码）：见文末「根因证据」。

---

## 实施记录（2026-10-16）

### 已落地改动
| 文件 | 内容 | 验证 |
|---|---|---|
| `src-tauri/src/services/ask_listener.rs` | 固定端口池 `[56496,56497,56498,60097,60098]` + 绑定后原子落盘 meta | `cargo check` 通过 |
| `src-tauri/src/services/ask_listener_meta.rs`（新增） | meta 读写（原子 temp+rename）+ `pid_alive` + `resolve_active_meta_preferring`（多数据根探测 + 端口偏好）+ `mcp_config_paths`（定位各 mcp.json 落点）+ `candidate_roots`（公开访问器） | 逻辑模拟验证通过 |
| `src-tauri/src/services/dispatch_mcp_server.rs` | `request_via_tcp` 加 fallback（直连失败→读 meta→重建 token 重连） | **cap_list / cap_dispatch 实测通过** |
| `src-tauri/src/services/ask_mcp_server.rs` | `request_answer_via_tcp` / `request_form_ack_via_tcp` 走 `request_via_tcp_with_fallback` | `cargo check` + clippy 通过（与 browser 同模式） |
| `src-tauri/src/services/browser_mcp_server.rs` | `request_browser_via_tcp` 加 fallback | **browser_list 实测通过** |
| `src-tauri/src/services/bus_mcp_server.rs` | **[本次] 新增诊断工具** `bus_mcp_status` / `bus_mcp_regenerate`（独立进程，不依赖 ask 端口） | **实测通过**（见下） |

### 实测验证结果
1. **token 漂移自愈**：用新 exe + 错误 token + 正确端口 56496 调 cap_list → 返回完整能力列表 ✅
2. **端口漂移自愈**：用新 exe + 错误 token + 不存在的端口 60101 调 cap_list → 自愈连回 56496 ✅
3. **主进程重启自愈（实战）**：dev 主进程重启（pid 41780→11784，token 变 48e7cf0f，端口保持 56496），mcp.json 仍旧 token → cap_list 成功 ✅
4. **browser 自愈**：错误端口 + 错误 token 调 browser_list → 返回 `{"items":[]}` ✅
5. **cap_dispatch 全链路**：`cap_dispatch(cap.http, ping)` → `{"pong":true}` ✅
6. **fallback 决策逻辑**：真实数据模拟 `resolve_active_meta_preferring(56496)` → 命中 dev 56496 ✅
7. **【本次】`bus_mcp_status`**：`~/.claude/.polaris/claude/mcp.json` 固化 60097 vs 活跃 dev 56496 → `matches_active:false`，正确诊断出漂移 ✅
8. **【本次】`bus_mcp_regenerate`**：3 bridge server、6 参数（3 port+3 token）原子改写 60097→56496、token→meta 最新值，session 保持不动 ✅
9. **【本次】regenerate 后直连**：用改写后的 mcp.json 参数启动 dispatch → `cap_list` 返回 15 能力，**零 fallback**（配置=真实值，直连即通）✅

### 验证边界（如实报告）
- `cargo test --lib` 因**存量错误**（`turn_persist.rs:909` `is_some()` on unit）无法整体运行，非本次引入；改用 `cargo check` + 逻辑模拟验证。
- `ask_user_question` 天生弹 UI（无 read timeout 阻塞等回答），未做无打扰实测；其 fallback 与 browser 完全同模式（同 helper + 同决策），已由 browser 实测 + clippy + cargo check 三重确认。

### 运行态生效方式
- dev 实例主进程已跑新代码（端口 56496 稳定、meta 落盘）。
- bridge 新 exe 已构建于 `src-tauri/target/debug/polaris-mcp.exe`；杀掉旧 bridge 后 Claude 自动用新 exe 拉起，当前会话 cap_list 直接可用。

---

## 〇、结论先行

**现状：Bridge MCP server（ask / browser / dispatch）每次启动用 mcp.json 固化的旧 `--polaris-port` 连主进程，而 ask_listener 端口每次随机生成 → 主进程重启一次 = 永久失联一次。`cap_dispatch/cap_list` 全部故障。**

**方案：三层自愈，全部无需人工干预（AI 自治优先）：**

1. **主进程侧**：ask_listener 改「固定端口池启动」+ 每次绑定后**原子落盘元数据** `<dataRoot>/.meta/ask-listener.json`（含真实 port / token / pid / started_at）。
2. **Bridge 进程侧**：dispatch / ask / browser MCP server 在 `connect refused` 时**自动读元数据 -> 用真端口+新 token 重连**。会话内即自愈，无需重启 Claude、无需改 mcp.json。
3. **诊断通道**：独立 bus MCP（走自身进程，不依赖 ask 端口）新增 `cap.ask_listener.status` / `cap.mcp.regenerate`，AI 失联时随时查询或一键重生成配置。

---

## 一、背景与问题定义

### 1.1 现有两类 MCP，可靠性不对称

| 类别 | 代表 | 连接方式 | 可靠性 |
|---|---|---|---|
| **独立 MCP** | bus / requirements / agnes / ph / scheduler / prd-preview | 本地读数据根 / 存储，自给自足 | ✅ 永不漂移（`cap.http` ping 实证可通） |
| **Bridge MCP** | **ask / browser / dispatch** | stdin + TCP 连主进程 ask_listener | ❌ 端口随机 → 漂移即全灭 |

**`cap_dispatch` / `cap_list` / `dispatch_task` 属于 Bridge（dispatch）**，所以它们最先出问题。走 bus 的 `bus_dispatch`（独立进程）则一直可用——这正是本轮实测「cap.* 全灭、cap.http 却 pong 正常」的原因。

### 1.2 根因（源码已钉死）

```
ask_listener.rs:125   TcpListener::bind("127.0.0.1:0")   ← 端口 0 = 系统随机分配
        ↓ 随机 port + 随机 token（Uuid v4）
mcp_config_service.rs:826   {{polarisPort}} → 固化为具体端口，仅启动时写一次
        ↓
launcher.rs:80   prepare_workspace_config → 写 .polaris/claude/mcp.json（此后不再刷新）
        ↓
polaris-mcp dispatch/ask/browser  以硬编码旧端口连主进程 → Connection refused
```

**两个漂移源：`port`（随机端口）+ `token`（每次随机）。** 只修端口不修 token 也会再失联；只启动时刷 mcp.json 而不处理运行期重连，Claude 仍需重启才生效。

---

## 二、方案设计

### 2.1 【任教】主进程：固定端口池 + 元数据落盘

**文件**：`src-tauri/src/services/ask_listener.rs`

- 端口策略：不再 `bind("127.0.0.1:0")`，改为候选池顺序尝试——`[56496, 56497, 56498, 60097, 60098]`，首个可绑定即用；全占用才回落随机。
  - 理由：固定池让端口在绝大多数会话保持稳定，mcp.json 固化的值长期有效；仅并发多开时递增一跳，且该结果会落盘供自愈。
- 绑定成功后，**原子写入元数据**：
  ```
  <dataRoot>/.meta/ask-listener.json
  {
    "port": 56496,
    "token": "<uuid>",
    "pid": <主进程 pid>,
    "started_at": "<ISO8601>"
  }
  ```
  - 写入用既有 `write_json_atomically` 风格（temp + rename）。
  - 每次 spawn（主进程启动/重启）都重写，始终反映**当前真实**端口与 token。
- `AskListenerHandle` 扩展携带 `meta_path`，供配置层引用。

**文件（新增）**：`src-tauri/src/services/ask_listener_meta.rs`
- `read_ask_listener_meta(data_root) -> Option<AskListenerMeta>`
- `write_ask_listener_meta(data_root, port, token, pid) -> Result<()>`
- 单测覆盖：写入后读回、文件缺失返回 None、损坏 JSON 返回 None（不 panic）。

### 2.2 【监管】Bridge MCP：连接失败自动重连

**文件**：`src-tauri/src/services/dispatch_mcp_server.rs`（ask / browser 复用同一工具函数）

- 新增 `connect_with_fallback(configured_port, data_root) -> Result<TcpStream>`：
  1. 先按配置端口直连（快路径，正常情况一次成功）。
  2. `refused` 时读 `ask_listener_meta`：
     - 若 meta.pid 进程存活 → 用 **meta.port + meta.token** 重连。
     - 若重连仍失败或 meta 缺失/pid 已死 → 返回明确错误「主进程不可达，请先启动 Polaris，或等待其重启后重试」。
  3. **token 一并刷新**：连接帧使用 meta.token（新 token），避免「端口对了 token 旧」再被拒。
- 当前各 `handle_xxx_call` 内建连处统一替换为 `connect_with_fallback`（保持帧协议不变）。
- 注意：mcp.json 里的 CLI 参数端口保持现状即可——自愈在运行时完成，**不需要 Claude 重启，不需要改配置**。

### 2.3 【诊断】独立 bus 能力：状态查询 + 配置重生成

**文件**：`src-tauri/src/services/bus_mcp_server.rs`（独立进程，自给自足）

- 注册 `cap.ask_listener.status` → 读 `ask_listener_meta`，返回：
  ```json
  { "ok": true, "port": 56496, "token_present": true, "pid": 12345,
    "started_at": "...", "meta_path": "<dataRoot>/.meta/ask-listener.json" }
  ```
  → AI 在任何状态下都能确认「主进程实际端口与 token 是否就绪」。
- 注册 `cap.mcp.regenerate` → 读 meta + 复用 `mcp_config_service::resolve_workspace_mcp_runtime_service` 重新生成 `.polaris/claude/mcp.json`，返回 `{ ok, config_path, port }`。
  → AI 在 `status` 显示正常但仍连不上（配置过旧）时，可一键让后续新加载的 bridge 用上新端口。
- `cap_list` 天然列出这两个新能力（走 described_capabilities，无需额外接线）。

> **已实现（2026-10-16）**：以 `bus_mcp_status` / `bus_mcp_regenerate` 两个**直接工具**落地（非 cap.* 能力，因为 bus 进程自持轻量总线，直接实现更贴合「独立诊断通道」定位；`bus_help` 同步列出）。mcp.json 定位用 `ask_listener_meta::mcp_config_paths(config_dir)`：config_dir → 用户级 `~/.claude/.polaris/claude/mcp.json` → 各数据根 `.polaris/claude/mcp.json`。regenerate 做**最小精准改写**（只替换含 `--polaris-port`/`--polaris-token` 的 server，保留插件 server 与用户自定义），非全集重生成。

### 2.4 时序图（一次失联自愈）

```
Claude 会话内                                   主进程（ask_listener）
─────────────────────────────                   ────────────────────────
  启动(旧 mcp.json: 56496)                       绑 56496 ✓ → 落盘 meta(56496)
  cap_list / cap_dispatch
      │  connect 56496
      │<── refused ───────────────────────────────  (56496 已让位，现为 56497)
      │  connect_with_fallback
      │    读 meta → 56497 + 新token
      │  connect 56497 ─────────────────────────► OK
      │<── 正常响应 ─────────────────────────────
      ✅ 会话内自愈完成（无需重启 Claude）
```

---

## 三、验收标准

1. **单测**
   - `ask_listener_meta`：写→读回一致；缺失/损坏返回 None。
   - `connect_with_fallback`：配置端口拒连 + meta 有效 → 用 meta 端口重连成功（mock meta）；meta 缺失/pid 死 → 返回明确错误。
2. **集成（开发版 `pnpm tauri:dev:web`）**
   - 启动后 `cap_list` / `cap_dispatch` 正常。
   - **模拟漂移**：kill 主进程 → 重启 → 不重启 Claude → mcp.json 仍是旧端口的前提下，`cap_list` 成功（自愈生效）。
   - `cap.mcp.regenerate` 后，新生成的 mcp.json 的 `polarisPort` === meta.port。
3. **回归**
   - `cargo check` 0 error；`cargo clippy --lib` 无新增 warning。
   - 前端 `pnpm exec tsc --noEmit` 0 error（如动到相关类型）。
   - `bus_dispatch` 的 cap.todo/http/fs/bash 仍正常（独立通道不受影响）。
   - 若动 `polaris-mcp` 的 schema：`cargo build --bin polaris-mcp` 后重验（见记忆 `polaris-mcp-schema-exe-staleness`）。

---

## 四、改动清单

| 文件 | 改动 |
|---|---|
| `src-tauri/src/services/ask_listener.rs` | 固定端口池；落盘元数据；Handle 带 meta_path |
| `src-tauri/src/services/ask_listener_meta.rs`（新） | 元数据读写 + 单测 |
| `src-tauri/src/services/dispatch_mcp_server.rs` | 连接失败自动重连（connect_with_fallback） |
| `src-tauri/src/services/ask_mcp_server.rs` / `browser_mcp_server.rs` | 复用重连工具函数 |
| `src-tauri/src/services/bus_mcp_server.rs` | 注册 `cap.ask_listener.status` / `cap.mcp.regenerate` |
| （可选）`src-tauri/fixtures` 或测试 | meta 与 fallback 单测用例 |

**不改动**：`mcp_config_service.rs` 生成逻辑、前端协议、帧协议。风险面收敛。

---

## 五、风险与权衡

- **token 落盘安全**：元数据含明文 token（与 mcp.json 现状一致，数据根本地单用户）；文件 600 权限 & 不进入 git。
- **固定端口池仍可能漂移**：多开冲突时 +1。这正是元数据+重连存在的意义——自愈不依赖「端口永不变」，而依赖「漂移可知、可查、可重连」。
- **重连不重 mcp.json**：会话内自愈有效；新起的 Claude 进程读旧配置仍需 `cap.mcp.regenerate` 或固定端口策略保持稳定（两机制互补）。
- **不可用兜底**：主进程本身未启动时无解（bridge 依赖它）。当前已经能给出明确报错，后续可扩展「提示先启动 Polaris」。

---

## 六、根因证据（源码定位）

| 位置 | 证据 |
|---|---|
| `ask_listener.rs:125-132` | `TcpListener::bind("127.0.0.1:0")` + `Uuid::new_v4()` → 端口与 token 每次随机 |
| `mcp_config_service.rs:826-840` | `{{polarisPort}}` 用 `handle.port.to_string()` 固化，仅模板替换时不校验存活 |
| `launcher.rs:80` | `prepare_workspace_config` 仅引擎启动时调用一次，之后不刷新 |
| `dispatch_mcp_server.rs:90-127` | 每请求按 `config.port` 连接，无 fallback |
| 实测 | `cap_dispatch`(56496) refused，`bus_dispatch` cap.http ping 正常 → 独立通道可用、bridge 通道失效 |