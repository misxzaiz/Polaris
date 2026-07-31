# Pi 能力扩展与 Polaris 生态融合 — 长期方案规划

> 日期：2026-07-31
> 基于：Pi Engine v0.83.0 集成、Polaris MCP 插件系统（阶段 6 完成）、Pi Extension API 分析
> 目标：将 Pi 从"仅 4 内置工具的基础引擎"升级为"完整复用 Polaris 生态的能力体"

---

## 一、现状评估

### 1.1 已完成（Pi Engine 集成）

| 能力 | 状态 | 备注 |
|------|------|------|
| 后端 EngineId::Pi 注册 | ✅ | traits.rs 6 处 + pi.rs + pi_parser.rs |
| RPC 双向通信 | ✅ | stdin/stdout JSONL，pi_parser 归一化为 AIEvent |
| 文本/思考流式 | ✅ | text_delta + thinking_delta |
| 工具调用渲染 | ✅ | tool_execution_start/update/end |
| Session 持久化 resume | ✅ | --session-dir + --session-id |
| 自定义 provider（models.json） | ✅ | 支持自定义 provider 端点 |
| abort/steer 中断 | ✅ | build_abort_command |
| 前端引擎选择 + 配置页 | ✅ | 引擎下拉、i18n、CLI 路径配置 |
| 编译验证 | ✅ | cargo check --lib 全绿，tsc 零 pi 相关错误 |

### 1.2 当前 Pi 的能力缺口

Pi 原生仅 4 个内置工具：**read / bash / edit / write**，缺少：

| 缺失能力 | Polaris 已有实现 | 工具数 |
|----------|:----------------:|:------:|
| 浏览器自动化 | `polaris-browser-mcp` | 12 个工具 |
| 电脑操作（鼠标/键盘/截图/UI 控件） | `polaris-computer-mcp` | 14 个工具 |
| 个人空间（书签/TODO/笔记/导航） | `polaris-ph-mcp` | 5 个工具 |
| 待办/需求/排期管理 | `polaris-todo/requirements/scheduler-mcp` | ~15 个工具 |
| PRD 预览 | `polaris-prd-preview-mcp` | 1 个工具 |
| 智能问答/知识检索 | `polaris-agnes-mcp` + `polaris-ask-mcp` | ~10 个工具 |
| Dispatch 调度 | `polaris-dispatch-mcp` | ~8 个工具 |

**总计缺口：~65 个工具**，这些能力 Polaris 已实现，只需桥接即可。

---

## 二、核心矛盾与架构选择

### 2.1 矛盾

Pi 作为 Polaris 的后端 AI 引擎，其扩展能力依赖 **Pi Extension（TypeScript）+ Pi Package（npm/git 分发）**。而 Polaris 的 MCP Server 是 **Rust 独立进程 + JSON-RPC 2.0 stdio 协议**。

两条路径：

| 维度 | 路径 A：Pi Extension 桥接 | 路径 B：Polaris 插件贡献 MCP |
|------|:------------------------:|:---------------------------:|
| 运行方式 | Pi Extension 内嵌 TypeScript，子进程启动 MCP | Polaris 插件系统注册 MCP，Pi 引擎走 `--mcp-config` |
| 依赖 | 仅 pi-coding-agent（已全局安装） | Polaris 后端需暴露 MCP config |
| 认证 | Extension 自行管理 MCP 子进程认证 | 复用 Polaris 统一 config.json |
| 分发 | Pi Package → npm | Polaris 插件 → 内置 + 安装 |
| 适用引擎 | 仅 Pi | 所有引擎（claude/codex/simple-ai 等） |

**关键发现**：Pi 引擎启动命令当前 **不使用 `--mcp-config`**（注释明确"pi 用 auth.json + extensions 体系，不走 --mcp-config"）。因此路径 B 需要对 Pi 引擎做架构调整。

### 2.2 推荐：双轨并行策略

```
短期（0-2 月）:  路径 A — Pi Extension 桥接（零后端改动，最快见效）
中期（2-4 月）:  路径 A+B 融合 — Pi Package 化 + Polaris 插件贡献 MCP 统一
长期（4-6 月）:  路径 B — Pi 引擎启用 MCP config，所有引擎统一
```

---

## 三、短期方案：Pi Extension 桥接 Polaris MCP

### 3.1 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Pi CLI (--mode rpc --no-extensions --no-skills)                │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ~/.pi/agent/extensions/polaris-mcp-bridge/index.ts        │  │
│  │                                                           │  │
│  │  session_start:                                           │  │
│  │    ├─ 查找 Polaris 数据目录                                │  │
│  │    ├─ 启动 polaris-browser-mcp（stdio）                   │  │
│  │    ├─ 启动 polaris-computer-mcp（stdio）                  │  │
│  │    └─ ... 按需启动其它 MCP server                         │  │
│  │                                                           │  │
│  │  registerTool × N:                                        │  │
│  │    ├─ browser_navigate / browser_click / ...              │  │
│  │    ├─ screenshot / click / move_mouse / ...              │  │
│  │    └─ ph_list / ph_create / ...                           │  │
│  │                                                           │  │
│  │  execute:                                                 │  │
│  │    └─ stdio JSON-RPC → MCP 子进程 → 解析响应              │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                          │ stdio JSON-RPC 2.0
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Polaris MCP Server（Rust 独立进程，~65 个工具）                │
│  polaris-browser-mcp / polaris-computer-mcp / ...              │
│  config: <DataRoot>/config.json                                │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 目录结构

```
~/.pi/agent/extensions/polaris-mcp-bridge/
├── package.json                        # 依赖声明（typebox, @earendil-works/pi-coding-agent）
├── src/
│   ├── index.ts                        # 入口：生命周期管理 + 子进程启动/停止
│   ├── mcp-client.ts                   # stdio JSON-RPC 2.0 客户端（通用）
│   ├── tools/
│   │   ├── browser.ts                  # 12 个浏览器工具注册
│   │   ├── computer.ts                 # 14 个电脑操作工具注册
│   │   ├── personal-hub.ts             # 5 个 PH 工具注册
│   │   ├── todo.ts                     # 待办工具
│   │   ├── requirements.ts             # 需求工具
│   │   ├── scheduler.ts                # 排期工具
│   │   ├── agnes.ts                    # 知识/智能问答工具
│   │   ├── dispatch.ts                 # 调度工具
│   │   └── prd-preview.ts              # PRD 预览工具
│   └── types/
│       ├── tool-registry.ts            # 工具类型声明（与 Polaris 保持同步）
│       └── mcp-params.ts               # MCP 参数类型
├── config/
│   └── polaris-dir.ts                  # Polaris 数据目录解析（跨平台）
└── README.md
```

### 3.3 核心实现要点

#### MCP 子进程管理

```typescript
// session_start: 按需启动子进程
pi.on("session_start", async (_event, ctx) => {
  const config = await resolvePolarisConfig();
  const mcpServers: McpSubprocess[] = [];

  // browser: 需要 port + token
  const browserMcp = spawnMcp(
    "polaris-browser-mcp",
    ["--port", config.port, "--token", config.token],
    config
  );
  mcpServers.push(browserMcp);
  mcpRegistry.set("browser", browserMcp);

  // computer: 标准 config_dir + workspace_path
  const computerMcp = spawnMcp(
    "polaris-computer-mcp",
    [configDir, workspacePath],
    config
  );
  mcpServers.push(computerMcp);
  mcpRegistry.set("computer", computerMcp);

  // 注册所有工具
  await registerBrowserTools(pi);
  await registerComputerTools(pi);
  await registerPersonalHubTools(pi);
  // ... 其余按需注册

  // 存储到 session 上下文，session_shutdown 时清理
  (ctx as any).__polarisMcp = mcpServers;
});

pi.on("session_shutdown", async (_event, ctx) => {
  const servers = (ctx as any).__polarisMcp as McpSubprocess[];
  servers?.forEach(s => s.kill());
});
```

#### stdio JSON-RPC 2.0 客户端

```typescript
async function callMcpTool(
  mcpProcess: ChildProcess,
  toolName: string,
  params: Record<string, unknown>
): Promise<Value> {
  const requestId = `polaris-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const request = {
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: { name: toolName, arguments: params },
  };

  const promise = new Promise<Value>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`MCP tool ${toolName} timed out`));
    }, 30_000);

    const onResponse = (data: string) => {
      const line = data.trim();
      if (!line.startsWith("{")) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id === requestId) {
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error(`MCP error: ${msg.error.message}`));
          } else {
            resolve(msg.result?.content?.[0]?.text ?? msg.result);
          }
          mcpProcess.stdout?.off("data", onResponse);
        }
      } catch { /* 忽略非 JSON 行 */ }
    };
    mcpProcess.stdout?.on("data", onResponse);
  });

  mcpProcess.stdin?.write(JSON.stringify(request) + "\n");
  return promise;
}
```

#### 工具注册示例（Browser）

```typescript
export async function registerBrowserTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate the Polaris built-in browser to a URL",
    parameters: Type.Object({
      url: Type.String({ description: "Destination URL" }),
      label: Type.Optional(Type.String({ description: "Tab label" })),
    }),
    async execute(_toolCallId, params, signal) {
      const mcp = mcpRegistry.get("browser");
      if (!mcp) return { content: [{ type: "text", text: "Browser MCP not available" }] };
      const result = await callMcpTool(mcp, "browser_navigate", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  pi.registerTool({
    name: "browser_click",
    description: "Click an element in the browser by index or text",
    parameters: Type.Object({
      query: Type.Union([
        Type.String({ description: "Element index (e.g., [12])" }),
        Type.String({ description: "Element text to click" }),
      ]),
      index: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal) {
      const mcp = mcpRegistry.get("browser");
      const result = await callMcpTool(mcp, "browser_click", params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  // ... browser_fill, browser_inspect, browser_context, browser_back, browser_forward, ...
}
```

### 3.4 Pi 引擎侧改动

当前 `build_command` 使用 `--no-extensions --no-skills` 禁用所有扩展。启用 Extension 桥接后：

```rust
// src-tauri/src/ai/engine/pi.rs — build_command 中

// 移除 --no-extensions，允许 Pi Extension 桥接
// 保留 --no-skills（避免 Skills 干扰工具命名空间）
// cmd.arg("--no-extensions");  // 删除或注释
cmd.arg("--no-skills");
```

### 3.5 实施计划（4 阶段）

| 阶段 | 内容 | 预估工时 | 依赖 |
|------|------|:--------:|------|
| **P1** | Extension 骨架 + 1 个浏览器工具（browser_navigate）跑通 | 2 天 | — |
| **P2** | 完整浏览器工具集（12 个）+ 电脑操作工具集（14 个） | 3 天 | P1 |
| **P3** | Personal Hub + Todo/Requirements/Scheduler（~25 个） | 3 天 | P2 |
| **P4** | 按需加载（按需启动 MCP 子进程）+ 错误恢复 + 健康检查 | 2 天 | P3 |
| **合计** | **~10 天** | | |

### 3.6 风险与缓解

| 风险 | 缓解 |
|------|------|
| Pi 引擎启动命令不含 `--mcp-config`，MCP 子进程需 Extension 自行管理生命周期 | Extension 内嵌子进程管理，session_start/shutdown 生命周期绑定 |
| MCP 子进程崩溃 | 30s 超时兜底 + 重启机制 + 错误透传给 LLM |
| Polaris 数据目录路径跨平台差异 | 统一 `resolvePolarisConfig()` 解析（Windows/Mac/Linux） |
| 工具参数与 Polaris MCP 工具 schema 不一致 | 工具参数类型从 Polaris Rust 侧同步（或自动生成） |
| `--no-extensions` 移除后可能影响 Pi 默认行为 | 仅在 Polaris 选 Pi 引擎时移除（Polaris 控制 Pi 启动参数） |

---

## 四、中期方案：Pi Package 化 + Polaris 插件系统融合

### 4.1 目标

将 Extension 桥接层发布为 **Pi Package**，实现 npm 分发，并让 Polaris 插件系统能管理该 Package 的启用/禁用。

### 4.2 架构演变

```
短期                          中期
─────                         ─────
Extension 手动管理         →   Pi Package（npm 分发）
MCP 子进程硬编码           →   从 Polaris 插件系统读取 MCP 贡献列表
工具注册硬编码             →   从 MCP server 动态发现 tools/call schema
无状态管理                 →   前端 Settings 页控制启用/禁用
```

### 4.3 Pi Package 结构

```
npm:@polaris/pi-mcp-bridge@1.0.0
├── package.json
│   └── "pi": {
│         "extensions": ["dist/index.js"],
│         "skills": ["skills/browser.md"],
│         "dependencies": ["typebox"]
│       }
├── dist/
│   ├── index.js              # 编译后的 Extension 入口
│   └── tools/
│       ├── browser.d.ts      # 工具类型定义
│       └── computer.d.ts
├── skills/
│   └── browser.md            # Pi Skill 格式的使用说明
└── src/                      # 源码（开发时）
    └── index.ts
```

### 4.4 Polaris 侧改动

**后端 Rust**：`mcp_config_service.rs` 新增 Pi 引擎的 MCP 配置生成

```rust
// 当引擎为 Pi 时，生成 Pi 风格的 MCP config（非 claude 风格）
fn generate_pi_mcp_config(
    &self,
    plugin_registry: &McpServerContributionRegistry,
) -> Result<serde_json::Value> {
    // Pi 的 MCP 配置走 extensions/auth.json，不走 --mcp-config
    // 但 Polaris 可以在设置页为 Pi 生成 "MCP 工具列表" 配置
    // 并写入 ~/.pi/agent/settings.json
}
```

**前端**：Settings 页新增 "Pi Extension 管理" 标签

```
设置页
├── 引擎配置
├── MCP 插件 (已有)
├── Pi Extension 管理 (新增)
│   ├── @polaris/pi-mcp-bridge
│   │   ├── 启用/禁用
│   │   ├── MCP Server 子开关（browser/computer/ph/...）
│   │   └── 版本信息 + 更新按钮
│   └── ... 其它扩展
└── ...
```

---

## 五、长期方案：Pi 引擎启用统一 MCP 配置

### 5.1 目标

让 Pi 引擎像 Claude/Codex 一样，**直接走 Polaris MCP 配置生成机制**，不再依赖 Extension 桥接。所有 65+ 工具由 Polaris 统一声明、统一生命周期管理。

### 5.2 架构

```
当前:  Pi Engine 自带 4 工具 + Extension 桥接 ~65 工具
          ↓
目标:  Pi Engine 使用 Polaris 生成的 MCP config
          ├─ ~/.polaris/claude/mcp.json（已有，供 claude/codex 用）
          └─ ~/.pi/agent/mcp.json（新增，供 Pi 用）
              └─ 由 Polaris 后端从 McpServerContributionRegistry 生成
```

### 5.3 关键改动

| 改动 | 位置 | 说明 |
|------|------|------|
| Pi Engine 不再硬编码 4 工具 | `pi.rs` | 移除对 `--tools/--exclude-tools` 的硬编码，由 MCP config 控制 |
| 生成 Pi 风格 MCP config | `mcp_config_service.rs` | 新增 `generate_pi_mcp_config()` 方法，输出 `~/.pi/agent/mcp.json` |
| 引擎生命周期绑定 MCP | `mcp_manager_service.rs` | Pi Engine 的 start/continue 时，确保证 MCP config 已同步 |
| 移除 `--no-extensions` | `pi.rs` | 不再需要 Extension 桥接 |
| Pi Extension 转为可选 | — | 仅保留高级场景（如自定义权限门、渲染定制） |

### 5.4 时间线

| 里程碑 | 时间 | 前置条件 |
|--------|:----:|----------|
| 短期 Extension 桥接跑通 | M1 | — |
| Pi Package npm 发布 | M2 | 短期方案稳定 |
| Polaris 设置页支持 Pi Extension 管理 | M2-M3 | Package 化 |
| Pi 引擎统一 MCP config 架构 | M4-M5 | 短期方案验证 + Pi 支持 |
| 所有引擎统一能力（全部 65+ 工具） | M6 | 统一架构 |

---

## 六、与现有插件系统协同

### 6.1 关系图

```
Polaris 插件系统（阶段 6 完成）
    │
    ├─ Plugin Registry (前端) → 插件 manifest → UI contribution
    ├─ MCP Contribution Registry (后端 Rust) → MCP server 声明式定义
    ├─ 插件安装/发现/更新闭环
    │
    ├─ 路径 A: Pi Extension 桥接 ←→ MCP Contribution Registry
    │   └─ 通过设置页开关控制哪些 MCP server 被 Extension 加载
    │
    └─ 路径 B: Pi 统一 MCP config ←→ MCP Contribution Registry
        └─ Polaris 自动生成 ~/.pi/agent/mcp.json
```

### 6.2 需要新增的插件 manifest 字段

```json
// plugin.json 扩展
{
  "mcpServers": [
    {
      "name": "polaris-browser",
      "enabledForEngines": ["claude-code", "codex", "simple-ai", "mimo", "pi"],
      "piExtensionCompatible": true
    }
  ]
}
```

---

## 七、风险总览

| 风险 | 等级 | 影响 | 缓解 |
|------|:----:|------|------|
| Pi `--mode rpc` + `--extensions` 兼容性 | 高 | Extension 可能干扰引擎通信 | 实测验证；保留 `--no-extensions` 回退开关 |
| MCP 子进程生命周期管理 | 中 | 内存泄漏/僵尸进程 | session_start/shutdown 绑定 + 30s 超时 |
| 工具 schema 与 Polaris 漂移 | 中 | 工具参数错误 | 自动生成 schema，从 Rust 侧导出 |
| 跨平台路径差异 | 中 | 无法找到 MCP 二进制 | 统一路径解析函数 + 日志 |
| Polaris 与 Pi 认证体系不同 | 中 | 无法通过认证 | Extension 侧注入 Bearer token |
| Pi 版本升级破坏 Extension API | 低 | 编译错误 | Pi Package 锁版本 + 兼容性测试 |

---

## 八、推荐执行顺序

```
┌────────────────────────────────────────────────────────────┐
│  短期（现在）                                               │
│  1. 移除 pi.rs 中 --no-extensions                          │
│  2. 编写 polaris-mcp-bridge Extension（浏览器 1 个工具）   │
│  3. 在 Tauri 应用选 Pi 引擎跑通端到端                      │
│  4. 扩展至完整浏览器 + 电脑操作工具集（~26 个）             │
├────────────────────────────────────────────────────────────┤
│  中期（2 个月后）                                           │
│  5. 发布 Pi Package（npm:@polaris/pi-mcp-bridge）           │
│  6. Polaris 设置页支持 Pi Extension 管理                   │
│  7. 从 Polaris 插件系统动态读取 MCP server 列表            │
├────────────────────────────────────────────────────────────┤
│  长期（4-6 个月后）                                         │
│  8. Pi 引擎启用统一 MCP config                              │
│  9. 移除 Extension 桥接层，所有引擎能力对齐                 │
│  10. 统一工具渲染、统一认证、统一权限                       │
└────────────────────────────────────────────────────────────┘
```

---

## 九、成功标准

| 阶段 | 验收条件 |
|------|----------|
| 短期 | Pi 引擎用户在 Polaris 中可用 `browser_navigate` 打开网页、`screenshot` 截图、`click` 操作桌面 |
| 中期 | 通过 Pi Package 安装后自动可用，Polaris 设置页可管理启用/禁用 |
| 长期 | Pi 引擎与 Claude/Codex/SimpleAI 能力完全对齐，用户在设置页选择引擎后自动获得统一 MCP 工具集 |
