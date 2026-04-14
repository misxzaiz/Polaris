# Plugin 管理功能设计文档

> 版本：1.0.0
> 日期：2026-04-14
> 状态：设计中

---

## 一、功能概述

为 Polaris 添加插件管理可视化界面，让用户无需命令行即可浏览、安装、启用、禁用、更新和卸载 Claude Code 插件。

### 目标

1. 用户可以浏览已安装和可用插件
2. 用户可以安装新插件
3. 用户可以启用/禁用/更新/卸载插件
4. 用户可以管理插件市场

### 非目标

- 插件开发支持
- 插件配置界面（每个插件独立）
- 插件评分系统

---

## 二、架构设计

### 2.1 数据流

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   前端组件       │────▶│   Tauri 命令    │────▶│   Claude CLI    │
│  PluginTab.tsx  │     │  plugin.rs      │     │  plugin list    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                      │
         ▼                      ▼
┌─────────────────┐     ┌─────────────────┐
│   Zustand Store │     │   数据模型       │
│   pluginStore   │     │   models/       │
└─────────────────┘     └─────────────────┘
```

### 2.2 模块划分

**后端（Rust）**：
- `src-tauri/src/commands/plugin.rs` - Tauri 命令
- `src-tauri/src/models/plugin.rs` - 数据模型
- `src-tauri/src/services/plugin_service.rs` - CLI 执行器

**前端（TypeScript/React）**：
- `src/types/plugin.ts` - 类型定义
- `src/services/pluginService.ts` - API 调用
- `src/stores/pluginStore.ts` - 状态管理
- `src/components/Settings/tabs/PluginTab.tsx` - 设置 Tab
- `src/components/Plugin/` - 子组件目录

---

## 三、数据模型

### 3.1 Rust 数据模型

```rust
// src-tauri/src/models/plugin.rs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 插件列表结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResult {
    pub installed: Vec<InstalledPlugin>,
    pub available: Option<Vec<AvailablePlugin>>,
}

/// 已安装插件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub version: String,
    pub scope: String,
    pub enabled: bool,
    pub install_path: String,
    pub installed_at: Option<String>,
    pub last_updated: Option<String>,
    pub mcp_servers: Option<HashMap<String, McpServerConfig>>,
}

/// 可用插件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    pub plugin_id: String,
    pub name: String,
    pub description: Option<String>,
    pub marketplace_name: String,
    pub source: serde_json::Value,
    pub install_count: Option<i32>,
}

/// MCP 服务器配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(rename = "type")]
    pub server_type: Option<String>,
    pub url: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
}

/// 市场
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    pub name: String,
    pub source: String,
    pub repo: Option<String>,
    pub install_location: String,
}

/// 插件操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOperationResult {
    pub success: bool,
    pub message: Option<String>,
    pub error: Option<String>,
}
```

### 3.2 TypeScript 类型

```typescript
// src/types/plugin.ts

export interface PluginListResult {
  installed: InstalledPlugin[];
  available?: AvailablePlugin[];
}

export interface InstalledPlugin {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  installPath: string;
  installedAt?: string;
  lastUpdated?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface AvailablePlugin {
  pluginId: string;
  name: string;
  description?: string;
  marketplaceName: string;
  source: unknown;
  installCount?: number;
}

export interface McpServerConfig {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
}

export interface Marketplace {
  name: string;
  source: string;
  repo?: string;
  installLocation: string;
}

export interface PluginOperationResult {
  success: boolean;
  message?: string;
  error?: string;
}

export type PluginScope = 'user' | 'project' | 'local';
```

---

## 四、API 设计

### 4.1 Tauri Commands

| 命令 | 功能 | 参数 | 返回 |
|------|------|------|------|
| `plugin_list` | 列出插件 | `available: bool` | `PluginListResult` |
| `plugin_install` | 安装插件 | `pluginId, scope` | `PluginOperationResult` |
| `plugin_enable` | 启用插件 | `pluginId, scope` | `PluginOperationResult` |
| `plugin_disable` | 禁用插件 | `pluginId, scope` | `PluginOperationResult` |
| `plugin_update` | 更新插件 | `pluginId, scope` | `PluginOperationResult` |
| `plugin_uninstall` | 卸载插件 | `pluginId, scope, keepData` | `PluginOperationResult` |
| `marketplace_list` | 列出市场 | - | `Vec<Marketplace>` |
| `marketplace_add` | 添加市场 | `source: String` | `Marketplace` |
| `marketplace_remove` | 移除市场 | `name: String` | `()` |

### 4.2 CLI 命令映射

| Tauri 命令 | CLI 命令 |
|-----------|---------|
| `plugin_list` | `claude plugin list --json [--available]` |
| `plugin_install` | `claude plugin install <id> [-s <scope>]` |
| `plugin_enable` | `claude plugin enable <id> [-s <scope>]` |
| `plugin_disable` | `claude plugin disable <id> [-s <scope>]` |
| `plugin_update` | `claude plugin update <id> [-s <scope>]` |
| `plugin_uninstall` | `claude plugin uninstall <id> [-s <scope>] [--keep-data]` |
| `marketplace_list` | `claude plugin marketplace list --json` |
| `marketplace_add` | `claude plugin marketplace add <source>` |
| `marketplace_remove` | `claude plugin marketplace remove <name>` |

---

## 五、前端组件设计

### 5.1 组件结构

```
src/components/Settings/tabs/PluginTab.tsx
├── PluginSearchBar          # 搜索栏
├── PluginList               # 插件列表
│   ├── InstalledSection     # 已安装区域
│   │   └── PluginItem       # 插件项
│   └── AvailableSection     # 可用区域
│       └── PluginItem       # 插件项
├── PluginDetail             # 插件详情面板
└── MarketplaceBar           # 市场选择栏
```

### 5.2 交互流程

**安装插件**：
1. 用户在可用插件列表点击插件
2. 显示详情面板
3. 用户点击「安装」按钮
4. 弹出确认框，选择安装范围
5. 执行安装，显示加载状态
6. 安装完成，刷新列表

**启用/禁用插件**：
1. 用户在已安装列表点击插件
2. 详情面板显示当前状态
3. 用户点击「启用/禁用」按钮
4. 执行操作，更新状态

---

## 六、错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| CLI 执行失败 | 显示错误消息，提供重试选项 |
| 网络超时 | 显示超时提示，建议检查网络 |
| 权限问题 | 显示权限错误，引导用户检查 |
| 插件不存在 | 显示不存在提示，刷新列表 |

---

## 七、国际化

新增翻译 Key：

```json
{
  "nav.plugins": "插件管理",
  "plugins.installed": "已安装",
  "plugins.available": "可用插件",
  "plugins.install": "安装",
  "plugins.enable": "启用",
  "plugins.disable": "禁用",
  "plugins.update": "更新",
  "plugins.uninstall": "卸载",
  "plugins.search": "搜索插件...",
  "plugins.installSuccess": "插件安装成功",
  "plugins.installFailed": "插件安装失败",
  "plugins.scope.user": "用户级别",
  "plugins.scope.project": "项目级别",
  "plugins.scope.local": "本地级别"
}
```

---

## 八、实现计划

### Phase 1: 后端基础

1. 创建 `models/plugin.rs` 数据模型
2. 创建 `commands/plugin.rs` Tauri 命令
3. 创建 `services/plugin_service.rs` CLI 执行器
4. 注册命令到 `main.rs`

### Phase 2: 前端基础

1. 创建 `types/plugin.ts` 类型定义
2. 创建 `services/pluginService.ts` API 调用
3. 创建 `stores/pluginStore.ts` 状态管理

### Phase 3: UI 组件

1. 创建 `PluginTab.tsx` 主组件
2. 创建子组件（列表、详情、搜索等）
3. 集成到设置模态框
4. 添加国际化

### Phase 4: 测试优化

1. 功能测试
2. 错误处理完善
3. 性能优化

---

*文档版本：1.0.0*
*最后更新：2026-04-14*
