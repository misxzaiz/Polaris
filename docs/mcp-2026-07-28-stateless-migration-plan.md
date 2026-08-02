# MCP 2026-07-28 无状态化 · Polaris 长期升级规划

> 文档版本：v1.0  
> 创建日期：2026-08-02  
> 状态：规划中，待实施

---

## 目录

1. [背景](#1-背景)
2. [当前架构全景](#2-当前架构全景)
3. [MCP 2026-07-28 核心变更](#3-mcp-2026-07-28-核心变更)
4. [影响分析](#4-影响分析)
5. [三阶段演进路线图](#5-三阶段演进路线图)
6. [架构变更总览](#6-架构变更总览)
7. [风险与缓解](#7-风险与缓解)
8. [优先级与时间线](#8-优先级与时间线)
9. [附录：相关文件清单](#9-附录相关文件清单)

---

## 1. 背景

### 1.1 什么是 MCP 无状态化

MCP（Model Context Protocol）2026-07-28 版本是自协议推出以来最大规模的修订，核心变化是：

- **从"双向有状态连接"全面转向"无状态（Stateless）核心"**
- 移除协议层的 `initialize` 握手和 `Mcp-Session-Id` 会话管理
- 引入 Streamable HTTP 传输和 OAuth 2.1 认证
- 每个请求独立处理，不依赖服务端会话状态

### 1.2 为什么需要升级

| 若不升级 | 若升级 |
|---|---|
| 协议版本落后，无法与新版 MCP server 互操作 | 向前兼容，支持新版协议特性 |
| 无法利用 HTTP 传输的负载均衡/云原生优势 | 云原生部署，水平扩展 |
| 维护两套 MCP 体系（Simple AI + Pi）的技术债持续增长 | 统一 MCP 栈，减少维护成本 |
| 卡在 2025-06-18 版本，错过生态演进 | 跟上生态，兼容三方 MCP server |

---

## 2. 当前架构全景

### 2.1 MCP 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                       Polaris 主进程                            │
│                                                                │
│  ┌─────────────────────┐      ┌──────────────────────────┐    │
│  │   Simple AI 引擎    │      │      Pi 引擎             │    │
│  │                     │      │                          │    │
│  │  ToolRegistry       │      │  auth.json + extensions  │    │
│  │  ├─ 内置工具(11个)  │      │  (MCP 未接)              │    │
│  │  └─ McpClientPool   │      │                          │    │
│  │       └─ McpClient  │      │                          │    │
│  │            ├─ stdio  │      │                          │    │
│  │            ├─ initialize│   │                          │    │
│  │            └─ pending │      │                          │    │
│  └──────────┬──────────┘      └──────────────────────────┘    │
│             │                                                  │
│             ▼  11 个 stdio 子进程                              │
│  ┌──────────────────────────────────────────────────────┐     │
│  │  polaris-mcp (统一入口)                              │     │
│  │  ├─ todo / requirements / scheduler / prd-preview    │     │
│  │  ├─ agnes / ph / computer                            │     │
│  │  └─ ask / browser / dispatch (TCP bridge)            │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                                │
│  MCP 配置管理 ← mcp_config_service / mcp_manager_service     │
│  └─ .polaris/claude/mcp.json                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 当前使用的协议版本

| 组件 | 协议版本 | 文件 |
|---|---|---|
| computer_mcp_server | `2024-11-05` | `services/computer_mcp_server.rs` |
| MCP 客户端 (Simple AI) | `2025-06-18` | `ai/engine/simple_ai/mcp/types.rs` |
| 其他内置 server | 未显式声明，跟随 client 协商 | 各 `*_mcp_server.rs` |

### 2.3 两套 MCP 体系并存

| 体系 | 引擎 | MCP 集成方式 | 状态 |
|---|---|---|---|
| A | Simple AI | `McpClientPool` + stdio 子进程 | ✅ 已实现 |
| B | Pi | `auth.json` + extensions 体系 | ❌ 未接（`PreparedMcpConfig` 返回空） |

> 见 `src-tauri/src/ai/engine/pi.rs` 注释：`// MCP 未接：pi 用 auth.json + extensions 体系，不走 claude/codex MCP 配置；PreparedMcpConfig 返回空。`

### 2.4 涉及 MCP 的关键文件

| 分类 | 文件路径 | 说明 |
|---|---|---|
| MCP 客户端 | `src-tauri/src/ai/engine/simple_ai/mcp/types.rs` | JSON-RPC 类型定义，协议版本 2025-06-18 |
| MCP 客户端 | `src-tauri/src/ai/engine/simple_ai/mcp/client.rs` | `McpClient`：spawn 子进程、initialize 握手、请求路由 |
| MCP 客户端 | `src-tauri/src/ai/engine/simple_ai/mcp/mod.rs` | `McpClientPool`：会话级 MCP 客户端池 |
| MCP 入口 | `src-tauri/src/bin/polaris_mcp.rs` | 统一 MCP 二进制入口，11 个子命令 |
| 内置 server | `src-tauri/src/services/computer_mcp_server.rs` | Computer MCP server（协议 2024-11-05） |
| 内置 server | `src-tauri/src/services/todo_mcp_server.rs` | Todo MCP server |
| 内置 server | `src-tauri/src/services/requirements_mcp_server.rs` | Requirements MCP server |
| 内置 server | `src-tauri/src/services/scheduler_mcp_server.rs` | Scheduler MCP server |
| 内置 server | `src-tauri/src/services/prd_preview_mcp_server.rs` | PRD Preview MCP server |
| 内置 server | `src-tauri/src/services/agnes_mcp_server.rs` | Agnes MCP server |
| 内置 server | `src-tauri/src/services/personal_hub_mcp_server.rs` | Personal Hub MCP server |
| 内置 server | `src-tauri/src/services/ask_mcp_server.rs` | Ask MCP server（TCP bridge） |
| 内置 server | `src-tauri/src/services/browser_mcp_server.rs` | Browser MCP server（TCP bridge） |
| 内置 server | `src-tauri/src/services/dispatch_mcp_server.rs` | Dispatch MCP server（TCP bridge） |
| MCP 配置 | `src-tauri/src/services/mcp_config_service.rs` | MCP 服务器配置管理 |
| MCP 管理 | `src-tauri/src/services/mcp_manager_service.rs` | MCP 管理器（健康检查等） |
| MCP 诊断 | `src-tauri/src/services/mcp_diagnostics_service.rs` | MCP 诊断服务 |
| MCP 命令 | `src-tauri/src/commands/mcp_manager.rs` | MCP 管理器 Tauri 命令 |
| 工具注册表 | `src-tauri/src/ai/engine/simple_ai/tools/mod.rs` | Tool trait（预留无状态设计） |
| 对话循环 | `src-tauri/src/ai/engine/simple_ai/chat_loop.rs` | MCP 工具调用入口 |
| Pi 引擎 | `src-tauri/src/ai/engine/pi.rs` | Pi 引擎（MCP 未接） |
| 外部配置 | `.polaris/claude/mcp.json` | 运行时 MCP 服务器配置 |

---

## 3. MCP 2026-07-28 核心变更

### 3.1 协议层面的变化

| 变更项 | 旧版（2025-11-25 及之前） | 新版（2026-07-28） |
|---|---|---|
| **会话管理** | `initialize` 握手 + `Mcp-Session-Id` | 无状态，无会话 |
| **传输层** | Stdio 为主 | Streamable HTTP 为首选，Stdio 仍支持 |
| **请求路由** | 依赖 session 绑定实例 | `Mcp-Method` / `Mcp-Name` 头 |
| **认证** | 无标准 | OAuth 2.1 强制 |
| **初始化** | 必须 `initialize` → `notifications/initialized` | 无需初始化握手 |
| **工具调用** | 会话内多次调用共享上下文 | 每次调用独立，上下文由请求携带 |

### 3.2 对 Polaris 的具体影响

| 组件 | 影响等级 | 说明 |
|---|---|---|
| `McpClient` (Simple AI) | 🔴 **高** | 需移除 `initialize` 握手、`notifications/initialized`，改造请求路由 |
| `McpClientPool` | 🔴 **高** | 长连接池 → 按需创建或 HTTP 复用池 |
| 内置 MCP server（11个） | 🟡 **中** | 需更新协议版本号，移除 `initialize` handler 中的会话逻辑 |
| `computer_mcp_server.rs` | 🟡 **中** | `ComputerController` 可变状态需改为无状态 |
| Pi 引擎 MCP 集成 | 🟢 **低** | 当前未接 Polaris MCP，不受直接影响 |
| `mcp_config_service.rs` | 🟢 **低** | 配置格式不依赖协议版本 |
| 对外 MCP 配置 | 🟢 **低** | 外部 MCP 配置格式不变 |

---

## 4. 影响分析

### 4.1 代码影响范围

| 文件 | 改动量 | 风险 |
|---|---|---|
| `simple_ai/mcp/client.rs` | ~150 行 | 🔴 高 |
| `simple_ai/mcp/mod.rs` | ~100 行 | 🟡 中 |
| `simple_ai/mcp/types.rs` | ~30 行 | 🟢 低 |
| `computer_mcp_server.rs` | ~50 行 | 🟡 中 |
| 其他 10 个 `*_mcp_server.rs` | 各 ~20 行 | 🟢 低 |
| `polaris_mcp.rs` | 无变化 | 🟢 低 |
| `mcp_config_service.rs` | 无变化 | 🟢 低 |
| `tools/mod.rs` | 无变化 | 🟢 低 |
| `pi.rs` | 无变化 | 🟢 低 |

### 4.2 功能影响范围

| 功能 | 影响 |
|---|---|
| Simple AI 引擎的 MCP 工具调用 | 直接受影响，需重构客户端 |
| 前端 MCP 管理面板 | 不受影响（配置格式不变） |
| Pi 引擎 | 不受影响（MCP 未接） |
| 内置 MCP server（computer/todo 等） | 需更新协议版本 |
| 外部 MCP server 集成 | 需兼容旧版协议协商 |

---

## 5. 三阶段演进路线图

### 阶段一：基础设施层抽象（Q3 2026）

**目标**：建立协议无关的 MCP 抽象层，为无状态化铺路

#### 5.1.1 新增 `McpTransport` trait

**文件**：`src-tauri/src/ai/engine/simple_ai/mcp/transport.rs`（新建）

```rust
/// MCP 传输层抽象
#[async_trait]
pub(crate) trait McpTransport: Send + Sync {
    /// 发送请求并返回响应（无状态，每次独立）
    async fn send(&self, request: &JsonRpcRequest) -> Result<JsonRpcResponse>;
    /// 获取协议版本
    fn protocol_version(&self) -> &str;
}
```

#### 5.1.2 拆分现有 `McpClient`

将现有 `McpClient` 拆分为三个组件：

| 组件 | 职责 | 说明 |
|---|---|---|
| `StdioTransport` | 实现 `McpTransport` | 封装 stdio 子进程通信 |
| `HttpTransport` | 实现 `McpTransport` | 封装 HTTP 请求（为未来 Streamable HTTP 准备） |
| `McpSession` | 会话级封装 | 组合 `McpTransport` + 工具列表缓存 |

#### 5.1.3 引入协议版本协商层

```rust
pub(crate) enum ProtocolVersion {
    V2024_11_05,  // 旧版（有状态，仅 server 端兼容）
    V2025_06_18,  // 当前版本
    V2026_07_28,  // 新版（无状态核心）
}
```

#### 5.1.4 工作量估算

| 任务 | 文件 | 预估 |
|---|---|---|
| 新建 `McpTransport` trait | `simple_ai/mcp/transport.rs` ~200行 | 2天 |
| 重构 `McpClient` → `StdioTransport` | `simple_ai/mcp/client.rs` ~150行 | 1天 |
| 扩展类型定义 | `simple_ai/mcp/types.rs` | 0.5天 |
| 改造 `McpClientPool` → `McpSessionPool` | `simple_ai/mcp/mod.rs` | 1天 |
| 测试 | 新增 transport 单元+集成测试 | 1天 |
| **小计** | | **5.5天** |

---

### 阶段二：协议升级 + 无状态化（Q4 2026）

**目标**：MCP 2026-07-28 协议适配，核心架构从有状态转为无状态

#### 5.2.1 移除 `initialize` 握手

**当前流程**（有状态）：
```
spawn → write(initialize) → read(initialize.result) → write(notifications/initialized) → ready
```

**新流程**（无状态）：
```
spawn → ready（无握手）
```

**HTTP 模式**：
```
POST /mcp { jsonrpc, method: "tools/list" } → 响应
POST /mcp { jsonrpc, method: "tools/call", params: {...} } → 响应
```

**涉及代码**：`simple_ai/mcp/client.rs` 中的 `initialize()` 和 `send_notification()` 方法。

#### 5.2.2 改造 `McpClientPool` 为无状态池

**当前策略**：
- 会话启动时全部 spawn，会话结束 drop
- 每个进程持有 `pending` HashMap
- 进程常驻

**未来策略**：懒加载 + keepalive 池

```
┌─────────────────────────────────────┐
│         McpSessionPool              │
│                                     │
│  session_1: McpSession              │
│    ├── transport: StdioTransport    │
│    ├── tools: [...cached...]        │
│    └── last_used: Instant           │
│                                     │
│  session_2: McpSession              │
│    ├── transport: HttpTransport     │
│    ├── tools: [...cached...]        │
│    └── last_used: Instant           │
│                                     │
│  ── 惰性创建：首次 tools/call 时     │
│  ── 超时回收：idle 5 分钟自动销毁    │
│  ── 预热机制：会话启动时预创建       │
└─────────────────────────────────────┘
```

**进程生命周期策略对比**：

| 策略 | 延迟 | 资源占用 | 复杂度 | 推荐 |
|---|---|---|---|---|
| 按需 spawn（每次 call 创建） | 高 | 低 | 低 | ❌ |
| 懒加载 + keepalive 池 | 低 | 中 | 中 | ✅ **推荐** |
| HTTP 连接池 | 低 | 低 | 高 | ⏳ 长期 |

#### 5.2.3 更新所有 MCP server 的 `initialize` 响应

每个 server 的 `handle_initialize()` 需支持双版本协商：

```rust
// 当前
const PROTOCOL_VERSION: &str = "2024-11-05";

// 未来：支持双版本协商
fn handle_initialize(client_version: &str) -> Value {
    let negotiated = match client_version {
        "2026-07-28" | "2025-06-18" => client_version,
        _ => PROTOCOL_VERSION, // 降级兼容旧版
    };
    json!({
        "protocolVersion": negotiated,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
    })
}
```

涉及文件：所有 `*_mcp_server.rs`，共 11 个。

#### 5.2.4 工作量估算

| 任务 | 文件 | 预估 |
|---|---|---|
| 移除 `initialize` 握手 | `simple_ai/mcp/client.rs` | 2天 |
| `McpClientPool` 无状态化改造 | `simple_ai/mcp/mod.rs` | 1.5天 |
| 11 个 server 版本更新 + 协商 | 各 `*_mcp_server.rs` | 2天 |
| 协议协商逻辑 | `simple_ai/mcp/types.rs` | 1天 |
| 集成测试 + 回归 | 新增 | 2天 |
| **小计** | | **8.5天** |

---

### 阶段三：Pi 引擎 MCP 统一 + HTTP 传输（Q1 2027）

**目标**：合并两套 MCP 体系，支持 HTTP 传输

#### 5.3.1 Pi 引擎 MCP 集成

**现状**：Pi 引擎的 `PreparedMcpConfig` 返回空，MCP 功能完全缺失。
> 见 `src-tauri/src/ai/engine/pi.rs` 文档注释。

**方案**：研究 Pi 的 `extensions` 机制，将 Polaris MCP 服务注入 Pi 引擎。

```
Pi engine 启动时：
  ├── 读取 .polaris/claude/mcp.json
  ├── 转换为 pi extensions 格式
  └── 通过 --config 或 auth.json 注入

备选方案：
  ├── 方案 A：通过 pi auth.json 的 extensions 字段注入（优先探索）
  └── 方案 B：通过 pi 的 RPC 模式 + 自建 MCP 代理桥接
```

#### 5.3.2 HTTP 传输支持

MCP 2026-07-28 新引入的 Streamable HTTP 传输：

```
POST /mcp HTTP/1.1
Mcp-Method: tools/call
Mcp-Name: polaris-computer
Content-Type: application/json

{"jsonrpc": "2.0", "params": {...}}
```

**实施路径**：
1. 实现 `HttpTransport`（基于 `reqwest`/`hyper`）
2. 实现 `StreamableHttpTransport`（支持流式响应）
3. 为内置 MCP server 增加 HTTP 监听模式
4. 配置切换：`mcp.json` 新增 `transport: "http"` 选项

#### 5.3.3 统一 MCP 服务注册表

**远期目标**：所有引擎共用同一份 MCP 服务注册表

```
Polaris McpServiceRegistry
├── Simple AI → McpSessionPool
├── Pi → PiExtensionsBridge
├── Claude → ClaudeMcpConfig
└── Codex → McpSessionPool
```

#### 5.3.4 工作量估算

| 任务 | 预估 |
|---|---|
| Pi 引擎 MCP 集成研究 | 3天 |
| HTTP Transport 实现 | 3天 |
| Streamable HTTP 支持 | 2天 |
| 统一注册表设计 + 实现 | 2天 |
| 回归测试 | 3天 |
| **小计** | **13天** |

---

## 6. 架构变更总览

### 6.1 当前架构（2026-07）

```
┌──────────────┬──────────────┐
│  Simple AI   │     Pi       │
│  McpClient   │  (未接 MCP)  │
│  (有状态)    │              │
├──────┴───────┴──────────────┤
│      11 stdio 子进程         │
│     2024-11-05 协议          │
└─────────────────────────────┘
```

### 6.2 阶段一目标（Q3 2026）

```
┌──────────────┬──────────────┐
│  Simple AI   │     Pi       │
│  McpTransport│  (未接 MCP)  │
│  trait       │              │
├──────┴───────┴──────────────┤
│  StdioTransport | HttpTransport│
│  协议版本协商层              │
│  2025-06-18 / 2026-07-28    │
└─────────────────────────────┘
```

### 6.3 阶段二目标（Q4 2026）

```
┌──────────────┬──────────────┐
│  Simple AI   │     Pi       │
│  McpSession  │  (未接 MCP)  │
│  (无状态)    │              │
├──────┴───────┴──────────────┤
│  Lazy Pool + HTTP Transport │
│  2026-07-28 协议            │
│  向后兼容旧版               │
└─────────────────────────────┘
```

### 6.4 阶段三目标（Q1 2027）

```
┌──────────────┬──────────────┐
│  Simple AI   │     Pi       │
│  McpSession  │  PiExtension │
│  (无状态)    │  Bridge      │
├──────┴───────┴──────────────┤
│   统一 McpServiceRegistry    │
│  HTTP/2 + Streamable HTTP   │
│  2026-07-28+ 协议            │
│  多引擎共享 MCP 连接池       │
└─────────────────────────────┘
```

---

## 7. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| Pi extensions 机制不兼容 | 中 | 高 | 提前原型验证；备选方案 B 桥接 |
| 无状态化后性能下降（进程频繁 spawn） | 高 | 中 | 实现 keepalive 池 + 预热机制 |
| HTTP 传输增加攻击面 | 低 | 高 | 127.0.0.1 绑定 + OAuth 2.1 |
| 旧版 MCP server 兼容性 | 中 | 中 | 协议版本协商降级 |
| 三方 MCP server 未及时升级 | 高 | 中 | 在 `McpClient` 层做兼容适配 |
| `McpClientPool` 改造影响现有会话 | 中 | 高 | 接口兼容，逐步替换 |

---

## 8. 优先级与时间线

### 8.1 优先级矩阵

```
高影响 ┼────────────────────────────────────────
       │                                        │
       │  P0: Transport trait      P1: 无状态化 │
       │  协议版本更新             进程池       │
       │  server 版本更新          │
       │                                        │
       │  P2: Pi MCP 集成          P3: HTTP 传输 │
       │  统一注册表               Streamable    │
       │                           OAuth 2.1     │
低影响 ┼────────────────────────────────────────
       低复杂度                  高复杂度
```

### 8.2 时间线

```
Q3 2026          Q4 2026          Q1 2027          Q2 2027+
├─────────────┼──────────────┼──────────────┼─────────────┤
│ 阶段一       │ 阶段二       │ 阶段三        │ 持续优化     │
│             │              │              │             │
│ McpTransport│ 移除握手     │ Pi MCP 集成  │ 性能优化     │
│ trait 抽象   │ 无状态化     │ HTTP 传输    │ 生态跟进     │
│ 协议版本枚举 │ 进程池       │ 统一注册表   │ 文档完善     │
│ server 更新  │ 兼容层       │ OAuth 2.1    │             │
│ 测试        │ 测试         │ 测试         │             │
└─────────────┴──────────────┴──────────────┴─────────────┘
```

### 8.3 详细任务分解

#### P0（立即启动，Q3 2026）

| # | 任务 | 文件 | 预估 |
|---|---|---|---|
| 1 | 新建 `McpTransport` trait | `simple_ai/mcp/transport.rs` | 2天 |
| 2 | 定义 `ProtocolVersion` 枚举 | `simple_ai/mcp/types.rs` | 0.5天 |
| 3 | 重构 `McpClient` → `StdioTransport` | `simple_ai/mcp/client.rs` | 1天 |
| 4 | 更新 `computer_mcp_server` 协议版本 | `services/computer_mcp_server.rs` | 0.5天 |
| 5 | 更新其他 10 个 server 的协议版本 | 各 `*_mcp_server.rs` | 1.5天 |
| 6 | 单元测试 + 集成测试 | 新增 | 1天 |
| | **小计** | | **6.5天** |

#### P1（Q4 2026）

| # | 任务 | 文件 | 预估 |
|---|---|---|---|
| 7 | 移除 `McpClient::initialize` 握手 | `simple_ai/mcp/client.rs` | 1天 |
| 8 | 移除 `notifications/initialized` | `simple_ai/mcp/client.rs` | 0.5天 |
| 9 | 改造 `McpClientPool` 为懒加载 + keepalive 池 | `simple_ai/mcp/mod.rs` | 2天 |
| 10 | 实现 `McpSession` 无状态会话 | `simple_ai/mcp/session.rs`（新建） | 1.5天 |
| 11 | 协议版本协商逻辑 | `simple_ai/mcp/types.rs` | 1天 |
| 12 | 回归测试 | 新增 | 2天 |
| | **小计** | | **8天** |

#### P2（Q1 2027）

| # | 任务 | 文件 | 预估 |
|---|---|---|---|
| 13 | Pi extensions 机制研究 | `ai/engine/pi.rs` | 3天 |
| 14 | `HttpTransport` 实现 | `simple_ai/mcp/transport.rs` | 2天 |
| 15 | `HttpTransport` 的 server 端监听模式 | `polaris_mcp.rs` | 1天 |
| 16 | 统一 `McpServiceRegistry` 设计 | 新建 | 2天 |
| 17 | 跨引擎集成测试 | 新增 | 3天 |
| | **小计** | | **11天** |

#### P3（远期）

| # | 任务 | 预估 |
|---|---|---|
| 18 | Streamable HTTP 传输 | 3天 |
| 19 | OAuth 2.1 支持 | 3天 |
| 20 | MCP 服务网格（多节点部署） | 5天 |
| 21 | 协议插件化（自定义传输层） | 5天 |

---

## 9. 附录：相关文件清单

### 9.1 Rust 源文件

| 文件路径 | 说明 |
|---|---|
| `src-tauri/src/bin/polaris_mcp.rs` | 统一 MCP 二进制入口 |
| `src-tauri/src/ai/engine/simple_ai/mcp/types.rs` | MCP 类型定义，协议版本 2025-06-18 |
| `src-tauri/src/ai/engine/simple_ai/mcp/client.rs` | McpClient（有状态，需改造） |
| `src-tauri/src/ai/engine/simple_ai/mcp/mod.rs` | McpClientPool（有状态池，需改造） |
| `src-tauri/src/ai/engine/simple_ai/tools/mod.rs` | Tool trait（已预留无状态设计） |
| `src-tauri/src/ai/engine/simple_ai/chat_loop.rs` | 对话循环，MCP 工具调用入口 |
| `src-tauri/src/ai/engine/pi.rs` | Pi 引擎（MCP 未接，注释标记） |
| `src-tauri/src/services/computer_mcp_server.rs` | Computer MCP server（协议 2024-11-05） |
| `src-tauri/src/services/todo_mcp_server.rs` | Todo MCP server |
| `src-tauri/src/services/requirements_mcp_server.rs` | Requirements MCP server |
| `src-tauri/src/services/scheduler_mcp_server.rs` | Scheduler MCP server |
| `src-tauri/src/services/prd_preview_mcp_server.rs` | PRD Preview MCP server |
| `src-tauri/src/services/agnes_mcp_server.rs` | Agnes MCP server |
| `src-tauri/src/services/personal_hub_mcp_server.rs` | Personal Hub MCP server |
| `src-tauri/src/services/ask_mcp_server.rs` | Ask MCP server（TCP bridge） |
| `src-tauri/src/services/browser_mcp_server.rs` | Browser MCP server（TCP bridge） |
| `src-tauri/src/services/dispatch_mcp_server.rs` | Dispatch MCP server（TCP bridge） |
| `src-tauri/src/services/mcp_config_service.rs` | MCP 服务器配置管理 |
| `src-tauri/src/services/mcp_manager_service.rs` | MCP 管理器（健康检查等） |
| `src-tauri/src/services/mcp_diagnostics_service.rs` | MCP 诊断服务 |
| `src-tauri/src/commands/mcp_manager.rs` | MCP 管理器 Tauri 命令 |

### 9.2 配置文件

| 文件路径 | 说明 |
|---|---|
| `.polaris/claude/mcp.json` | 运行时 MCP 服务器配置 |

### 9.3 文档

| 文件路径 | 说明 |
|---|---|
| `docs/pi-agent-integration-plan.md` | Pi 引擎集成计划（含 MCP 未接注释） |
| `docs/simple-ai-codex-refactor-plan.md` | Simple AI 重构计划（含工具无状态设计） |
| `docs/pi-long-term-plan.md` | Pi 长期计划 |

---

## 附录 A：MCP 协议版本演进

| 版本 | 日期 | 核心变化 |
|---|---|---|
| 2024-11-05 | 2024-11-05 | 初始版本，有状态 stdio 协议 |
| 2025-03-26 | 2025-03-26 | 增量更新，完善工具定义 |
| 2025-06-18 | 2025-06-18 | 小幅修订 |
| 2025-11-25 | 2025-11-25 | 当前主流版本 |
| 2026-07-28 | 2026-07-28 | **无状态化核心 + HTTP 传输 + OAuth 2.1** |

---

## 附录 B：决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-08-02 | 三阶段演进 | 降低风险，渐进式迁移 |
| 2026-08-02 | 先抽象后升级 | 确保向后兼容，避免一次性大改动 |
| 2026-08-02 | 懒加载 + keepalive 池作为阶段二默认策略 | 平衡延迟和资源占用 |
| 2026-08-02 | Pi 引擎 MCP 集成放在阶段三 | 依赖前两阶段的基础设施，且需先研究 Pi extensions 机制 |