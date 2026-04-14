# MCP 可视化配置功能规划文档

> 版本：1.0.0
> 日期：2026-04-14
> 状态：规划中

---

## 一、功能概述

为 Polaris 添加 MCP (Model Context Protocol) 服务器可视化配置界面，让用户无需手动编辑 JSON 文件即可管理 MCP 服务器配置。

### 目标用户

- 需要添加自定义 MCP 服务器的开发者
- 需要管理多个 MCP 服务器的用户
- 不熟悉 JSON 配置的用户

### 核心价值

1. **降低配置门槛**：无需手写 JSON
2. **状态可视化**：MCP 服务器健康状态一目了然
3. **快速调试**：连接问题快速定位
4. **安全可控**：敏感信息（API Key）安全处理

---

## 二、MCP 架构分析

### 2.1 Claude CLI MCP 配置层级

```
~/.claude/settings.json          # 全局设置（含 enabledPlugins）
~/.mcp.json                       # 全局 MCP 配置
<project>/.mcp.json              # 项目级 MCP 配置
<project>/.polaris/claude/mcp.json # Polaris 内置 MCP
```

### 2.2 MCP 服务器类型

| 类型 | 传输方式 | 配置格式 |
|------|---------|---------|
| **stdio** | 标准输入/输出 | `{command, args, env}` |
| **http** | HTTP 请求 | `{type: "http", url}` |
| **sse** | Server-Sent Events | `{type: "sse", url}` |

### 2.3 CLI 命令映射

| CLI 命令 | 功能 | 输出 |
|---------|------|------|
| `claude mcp list` | 列出 MCP 服务器（含健康检查） | 文本列表 |
| `claude mcp add` | 添加 MCP 服务器 | 交互式 |
| `claude mcp add-json` | 添加 MCP 服务器（JSON） | - |
| `claude mcp get <name>` | 获取 MCP 详情 | JSON |
| `claude mcp remove <name>` | 移除 MCP 服务器 | - |
| `claude mcp serve` | 启动 Claude Code MCP Server | - |

### 2.4 现有 Polaris 实现

Polaris 已有 MCP 配置服务（`mcp_config_service.rs`）：

```rust
// 生成到 .polaris/claude/mcp.json
{
  "mcpServers": {
    "polaris-todo": {
      "command": "/path/to/polaris-todo-mcp",
      "args": ["<config_dir>", "<workspace_path>"]
    },
    "polaris-requirements": {...},
    "polaris-scheduler": {...}
  }
}
```

通过 `--mcp-config` 参数传递给 Claude CLI。

---

## 三、UI 设计

### 3.1 入口位置

**方案**：设置模态框新增 "MCP" Tab

### 3.2 页面结构

```
┌─────────────────────────────────────────────────────────────┐
│ 设置 > MCP 服务器                                            │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [➕ 添加服务器]                    🔄 刷新健康状态       │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 已配置的服务器                                           │ │
│ │ ─────────────────────────────────────────────────────── │ │
│ │ 🟢 plugin:playwright:playwright                         │ │
│ │    类型: stdio | 状态: 已连接                            │ │
│ │    命令: npx @playwright/mcp@latest                     │ │
│ │                                          [编辑] [删除]   │ │
│ │ ─────────────────────────────────────────────────────── │ │
│ │ 🟡 plugin:figma:figma                                   │ │
│ │    类型: http | 状态: 需要认证                          │ │
│ │    URL: https://mcp.figma.com/mcp                       │ │
│ │                                    [认证] [编辑] [删除]  │ │
│ │ ─────────────────────────────────────────────────────── │ │
│ │ 🟢 plugin:supabase:supabase                             │ │
│ │    类型: http | 状态: 需要认证                          │ │
│ │    URL: https://mcp.supabase.com/mcp                    │ │
│ │                                    [认证] [编辑] [删除]  │ │
│ │ ─────────────────────────────────────────────────────── │ │
│ │ 🟢 chrome-devtools                                      │ │
│ │    类型: stdio | 状态: 已连接                            │ │
│ │    命令: cmd /c npx chrome-devtools-mcp@latest          │ │
│ │                                          [编辑] [删除]   │ │
│ │ ─────────────────────────────────────────────────────── │ │
│ │ 🔵 polaris-todo (内置)                                  │ │
│ │    类型: stdio | 状态: 已配置                            │ │
│ │    命令: .../polaris-todo-mcp                           │ │
│ │                                              [查看]      │ │
│ │ ─────────────────────────────────────────────────────── │ │
│ │ 🔵 polaris-requirements (内置)                          │ │
│ │    类型: stdio | 状态: 已配置                            │ │
│ │                                              [查看]      │ │
│ │ ─────────────────────────────────────────────────────── │ │
│ │ 🔵 polaris-scheduler (内置)                             │ │
│ │    类型: stdio | 状态: 已配置                            │ │
│ │                                              [查看]      │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ 配置范围: ◉ 用户级别 ○ 项目级别                            │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 添加/编辑服务器弹窗

```
┌─────────────────────────────────────────────┐
│ ➕ 添加 MCP 服务器                           │
├─────────────────────────────────────────────┤
│                                             │
│ 服务器名称 *                                 │
│ ┌─────────────────────────────────────────┐ │
│ │ my-mcp-server                           │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 传输类型 *                                   │
│ ┌─────────────────────────────────────────┐ │
│ │ ◉ stdio  ○ HTTP  ○ SSE                  │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ ─────────── stdio 配置 ───────────          │
│                                             │
│ 命令 *                                      │
│ ┌─────────────────────────────────────────┐ │
│ │ npx                                     │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 参数 (空格分隔)                              │
│ ┌─────────────────────────────────────────┐ │
│ │ my-mcp-server@latest                    │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 环境变量                                    │
│ ┌─────────────────────────────────────────┐ │
│ │ API_KEY=xxx                             │ │
│ │ OTHER_VAR=value                         │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ ─────────── HTTP 配置 ───────────           │
│                                             │
│ URL *                                       │
│ ┌─────────────────────────────────────────┐ │
│ │ https://mcp.example.com/mcp             │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 请求头                                      │
│ ┌─────────────────────────────────────────┐ │
│ │ Authorization: Bearer xxx                │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ ─────────── OAuth 配置 ───────────          │
│                                             │
│ Client ID                                   │
│ ┌─────────────────────────────────────────┐ │
│ │                                         │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ Client Secret                               │
│ ┌─────────────────────────────────────────┐ │
│ │ ••••••••                     [获取]     │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 配置范围                                     │
│ ◉ 用户级别 (推荐) ○ 项目级别                │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │        [取消]         [保存]            │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 3.4 组件拆分

| 组件 | 功能 | Props |
|------|------|-------|
| `McpSettingsTab` | 主容器 | - |
| `McpServerList` | 服务器列表 | `servers`, `onRefresh`, `onEdit`, `onDelete` |
| `McpServerItem` | 服务器项 | `server`, `onEdit`, `onDelete`, `onAuth` |
| `McpServerForm` | 添加/编辑表单 | `server`, `onSave`, `onCancel` |
| `McpHealthStatus` | 健康状态指示器 | `status` |
| `McpTypeSelector` | 类型选择器 | `value`, `onChange` |
| `McpStdioConfig` | stdio 配置表单 | `config`, `onChange` |
| `McpHttpConfig` | HTTP 配置表单 | `config`, `onChange` |

---

## 四、数据模型

### 4.1 TypeScript 类型

```typescript
// src/types/mcp.ts

export type McpTransportType = 'stdio' | 'http' | 'sse';

export type McpServerStatus = 'connected' | 'needs-auth' | 'pending' | 'error' | 'configured';

export interface McpServer {
  name: string;
  status: McpServerStatus;
  config: McpServerConfig;
  isBuiltIn?: boolean;
}

export interface McpServerConfig {
  type: McpTransportType;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse
  url?: string;
  headers?: Record<string, string>;
  // oauth
  clientId?: string;
  clientSecret?: string;
}

export interface McpListResult {
  servers: McpServer[];
}

export interface McpServerDetail {
  name: string;
  config: McpServerConfig;
  status: McpServerStatus;
  capabilities?: string[];
  error?: string;
}
```

### 4.2 Rust 类型

```rust
// src-tauri/src/models/mcp.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub status: McpServerStatus,
    pub config: McpServerConfig,
    #[serde(default)]
    pub is_built_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum McpServerStatus {
    Connected,
    NeedsAuth,
    Pending,
    Error,
    Configured,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpServerConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
}
```

---

## 五、后端实现

### 5.1 Tauri Commands

```rust
// src-tauri/src/commands/mcp.rs

#[tauri::command]
pub async fn mcp_list() -> Result<Vec<McpServer>, String> {
    // 调用 claude mcp list 并解析输出
    // 同时包含内置 MCP 服务器信息
}

#[tauri::command]
pub async fn mcp_add(
    name: String,
    config: McpServerConfig,
    scope: String,
) -> Result<McpServer, String> {
    // 根据 config 类型构建 CLI 参数
    // 调用 claude mcp add 或 claude mcp add-json
}

#[tauri::command]
pub async fn mcp_get(name: String) -> Result<McpServerDetail, String> {
    // 调用 claude mcp get <name>
}

#[tauri::command]
pub async fn mcp_remove(name: String, scope: String) -> Result<(), String> {
    // 调用 claude mcp remove <name>
}

#[tauri::command]
pub async fn mcp_check_health(name: String) -> Result<McpServerStatus, String> {
    // 执行健康检查
    // 返回服务器连接状态
}

#[tauri::command]
pub async fn mcp_get_builtin() -> Result<Vec<McpServer>, String> {
    // 返回 Polaris 内置的 MCP 服务器
    // polaris-todo, polaris-requirements, polaris-scheduler
}
```

### 5.2 CLI 执行器

```rust
// src-tauri/src/services/mcp_cli_service.rs

impl McpCliService {
    pub async fn list_servers(&self) -> Result<Vec<McpServer>, String> {
        let output = self.execute_claude(&["mcp", "list"]).await?;

        // 解析文本输出
        // 格式示例：
        // plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
        // plugin:playwright:playwright: npx @playwright/mcp@latest - ✓ Connected

        let servers = parse_mcp_list_output(&output);
        Ok(servers)
    }

    pub async fn add_server(
        &self,
        name: &str,
        config: &McpServerConfig,
        scope: &str,
    ) -> Result<(), String> {
        let mut args = vec!["mcp", "add", "-s", scope];

        match config {
            McpServerConfig::Stdio { command, args: cmd_args, env } => {
                for (k, v) in env {
                    args.push("-e");
                    args.push(&format!("{}={}", k, v));
                }
                args.push(name);
                args.push("--");
                args.push(command);
                args.extend(cmd_args.iter().map(|s| s.as_str()));
            }
            McpServerConfig::Http { url, headers } => {
                args.push("--transport");
                args.push("http");
                for (k, v) in headers {
                    args.push("-H");
                    args.push(&format!("{}: {}", k, v));
                }
                args.push(name);
                args.push(url);
            }
            McpServerConfig::Sse { url, headers } => {
                args.push("--transport");
                args.push("sse");
                // ...
            }
        }

        self.execute_claude(&args).await?;
        Ok(())
    }

    pub async fn remove_server(&self, name: &str) -> Result<(), String> {
        self.execute_claude(&["mcp", "remove", name]).await?;
        Ok(())
    }
}

fn parse_mcp_list_output(output: &str) -> Vec<McpServer> {
    let mut servers = Vec::new();

    for line in output.lines() {
        // 解析格式: name: config - status
        // 例如: plugin:playwright:playwright: npx @playwright/mcp@latest - ✓ Connected
        if let Some(server) = parse_mcp_line(line) {
            servers.push(server);
        }
    }

    servers
}
```

---

## 六、前端实现

### 6.1 Store 设计

```typescript
// src/stores/mcpStore.ts

import { create } from 'zustand';

interface McpState {
  servers: McpServer[];
  builtinServers: McpServer[];
  loading: boolean;
  error: string | null;

  // Actions
  fetchServers: () => Promise<void>;
  addServer: (name: string, config: McpServerConfig, scope: string) => Promise<void>;
  removeServer: (name: string) => Promise<void>;
  checkHealth: (name: string) => Promise<McpServerStatus>;
}
```

### 6.2 服务层

```typescript
// src/services/mcpService.ts

import { invoke } from '@tauri-apps/api/core';

export const mcpService = {
  async listServers(): Promise<McpServer[]> {
    return invoke('mcp_list');
  },

  async getBuiltin(): Promise<McpServer[]> {
    return invoke('mcp_get_builtin');
  },

  async addServer(
    name: string,
    config: McpServerConfig,
    scope: string,
  ): Promise<McpServer> {
    return invoke('mcp_add', { name, config, scope });
  },

  async removeServer(name: string): Promise<void> {
    return invoke('mcp_remove', { name });
  },

  async checkHealth(name: string): Promise<McpServerStatus> {
    return invoke('mcp_check_health', { name });
  },
};
```

---

## 七、实现计划

### Phase 1: 后端基础（1-2天）

1. 创建 MCP 相关数据模型
2. 实现 `mcp_list` 命令（解析 CLI 输出）
3. 实现 `mcp_add` 命令（构建 CLI 参数）
4. 实现 `mcp_remove` 命令
5. 实现内置 MCP 获取

### Phase 2: 前端列表（1天）

1. 创建 `McpSettingsTab` 组件
2. 创建 `McpServerList` 组件
3. 创建 `McpServerItem` 组件
4. 集成到设置模态框

### Phase 3: 添加/编辑（1-2天）

1. 创建 `McpServerForm` 弹窗
2. 实现 stdio 类型配置表单
3. 实现 HTTP 类型配置表单
4. 实现 SSE 类型配置表单
5. 实现环境变量编辑

### Phase 4: 健康检查（1天）

1. 实现健康状态刷新
2. 实现状态指示器
3. 实现认证按钮（OAuth）

### Phase 5: 优化完善（1天）

1. 添加表单验证
2. 添加错误处理
3. 国际化支持
4. 单元测试

---

## 八、特殊场景处理

### 8.1 OAuth 认证流程

部分 MCP 服务器（如 Figma、Supabase）需要 OAuth 认证：

```
1. 用户点击 [认证] 按钮
2. 调用 mcp__plugin_xxx__authenticate
3. 获取授权 URL
4. 打开浏览器完成授权
5. 回调返回认证结果
6. 刷新服务器状态
```

### 8.2 敏感信息处理

- API Key、Client Secret 等敏感信息不直接显示
- 使用密码输入框或遮蔽显示
- 存储在安全的位置（如系统密钥链）

### 8.3 内置 MCP 服务器

Polaris 内置的 MCP 服务器（todo、requirements、scheduler）：

- 显示为特殊样式（蓝色图标 + "内置" 标签）
- 只能查看，不能编辑或删除
- 显示可执行文件路径

---

## 九、风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| CLI 输出格式变化 | 解析失败 | 版本检测 + 正则灵活性 |
| 健康检查耗时 | 体验差 | 异步加载 + 加载指示 |
| 敏感信息泄露 | 安全问题 | 遮蔽显示 + 安全存储 |
| 配置冲突 | 覆盖配置 | 合并策略 + 备份 |

---

## 十、后续扩展

1. **MCP 服务器模板库**：预设常用 MCP 配置
2. **MCP 调试工具**：测试 MCP 连接和功能
3. **MCP 日志查看**：查看 MCP 服务器日志
4. **MCP 权限控制**：控制 MCP 工具访问权限

---

*文档版本：1.0.0*
*最后更新：2026-04-14*
