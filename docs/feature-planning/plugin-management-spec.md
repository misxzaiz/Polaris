# Plugin 管理功能规划文档

> 版本：1.0.0
> 日期：2026-04-14
> 状态：规划中

---

## 一、功能概述

为 Polaris 添加插件管理可视化界面，让用户无需命令行即可浏览、安装、启用、禁用、更新和卸载 Claude Code 插件。

### 目标用户

- 不熟悉命令行的用户
- 需要快速发现和安装新插件的用户
- 需要管理多个插件状态的用户

### 核心价值

1. **降低使用门槛**：无需记忆 CLI 命令
2. **提升发现效率**：可视化浏览插件市场
3. **简化操作流程**：一键安装/启用/禁用
4. **状态一目了然**：插件状态、版本、来源清晰展示

---

## 二、CLI 功能映射

### 2.1 支持的 CLI 命令

| CLI 命令 | 功能 | 参数 |
|---------|------|------|
| `claude plugin list --json --available` | 列出已安装和可用插件 | `--json`, `--available` |
| `claude plugin install <plugin>` | 安装插件 | `-s/--scope` |
| `claude plugin enable <plugin>` | 启用插件 | `-s/--scope` |
| `claude plugin disable <plugin>` | 禁用插件 | `-s/--scope`, `-a/--all` |
| `claude plugin update <plugin>` | 更新插件 | `-s/--scope` |
| `claude plugin uninstall <plugin>` | 卸载插件 | `-s/--scope`, `--keep-data` |
| `claude plugin marketplace list --json` | 列出市场 | `--json` |
| `claude plugin marketplace add <source>` | 添加市场 | - |
| `claude plugin marketplace remove <name>` | 移除市场 | - |
| `claude plugin marketplace update [name]` | 更新市场 | - |

### 2.2 CLI 输出数据结构

#### 已安装插件

```json
{
  "id": "figma@claude-plugins-official",
  "version": "2.0.7",
  "scope": "user",
  "enabled": true,
  "installPath": "C:\\Users\\...\\figma\\2.0.7",
  "installedAt": "2026-04-03T16:38:55.885Z",
  "lastUpdated": "2026-04-12T06:25:58.024Z",
  "mcpServers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp"
    }
  }
}
```

#### 可用插件

```json
{
  "pluginId": "asana@claude-plugins-official",
  "name": "asana",
  "description": "Asana project management integration...",
  "marketplaceName": "claude-plugins-official",
  "source": "./external_plugins/asana",
  "installCount": 7137
}
```

#### 市场列表

```json
{
  "name": "claude-plugins-official",
  "source": "github",
  "repo": "anthropics/claude-plugins-official",
  "installLocation": "C:\\Users\\...\\marketplaces\\claude-plugins-official"
}
```

---

## 三、UI 设计

### 3.1 入口位置

方案 A：**设置模态框新增 Tab**
- 位置：设置模态框 → "Plugins" Tab
- 优点：与其他设置项统一入口
- 缺点：需打开设置才能访问

方案 B：**左侧面板独立入口**
- 位置：左侧边栏新增插件图标
- 优点：快速访问，类似 VS Code
- 缺点：增加界面复杂度

**推荐方案 A**，保持界面简洁。

### 3.2 页面结构

```
┌─────────────────────────────────────────────────────────────┐
│ 设置 > 插件管理                                              │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────┐ ┌─────────────────────────────────────┐ │
│ │ 已安装 (8)      │ │ 插件详情                             │ │
│ │ ─────────────── │ │ ─────────────────────────────────── │ │
│ │ ✅ figma        │ │ 名称：Figma                          │ │
│ │ ✅ playwright   │ │ ID：figma@claude-plugins-official   │ │
│ │ ✅ superpowers  │ │ 版本：2.0.7                         │ │
│ │ ❌ typescript   │ │ 状态：✅ 已启用                      │ │
│ │ ...            │ │ 描述：Figma 设计工具集成...          │ │
│ │                │ │ 来源：claude-plugins-official       │ │
│ │ 可用插件       │ │ 安装时间：2026-04-03                │ │
│ │ ─────────────── │ │ 更新时间：2026-04-12                │ │
│ │ 🔍 搜索插件...  │ │                                     │ │
│ │ ─────────────── │ │ MCP 服务：                          │ │
│ │ 📦 asana       │ │ • figma (http)                      │ │
│ │ 📦 notion      │ │                                     │ │
│ │ 📦 slack       │ │ ┌─────────────────────────────────┐ │ │
│ │ ...            │ │ │ [禁用] [卸载] [更新]             │ │ │
│ │                │ │ └─────────────────────────────────┘ │ │
│ └─────────────────┘ └─────────────────────────────────────┘ │
│                                                             │
│ 市场：claude-plugins-official | pua-skills | [+ 添加市场]   │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 组件拆分

| 组件 | 功能 | Props |
|------|------|-------|
| `PluginSettingsTab` | 主容器 | - |
| `PluginList` | 插件列表 | `plugins`, `type`, `onSelect` |
| `PluginItem` | 插件项 | `plugin`, `installed`, `onAction` |
| `PluginDetail` | 插件详情 | `plugin`, `onEnable`, `onDisable`, `onUninstall`, `onUpdate`, `onInstall` |
| `PluginSearchBar` | 搜索栏 | `value`, `onChange` |
| `MarketplaceSelector` | 市场选择 | `markets`, `selected`, `onSelect`, `onAdd` |
| `MarketplaceAddModal` | 添加市场弹窗 | `onAdd`, `onCancel` |

### 3.4 交互流程

#### 安装插件

```
1. 用户浏览可用插件列表
2. 点击插件查看详情
3. 点击 [安装] 按钮
4. 选择安装范围 (user/project/local)
5. 执行安装，显示进度
6. 安装完成，刷新列表
```

#### 启用/禁用插件

```
1. 用户在已安装列表点击插件
2. 详情页显示当前状态
3. 点击 [启用]/[禁用] 按钮
4. 执行操作，更新状态
5. 提示可能需要重启
```

#### 更新插件

```
1. 检测到有更新版本
2. 显示更新标记
3. 用户点击 [更新]
4. 执行更新，显示进度
5. 提示重启生效
```

---

## 四、后端实现

### 4.1 Tauri Commands

```rust
// src-tauri/src/commands/plugin.rs

#[tauri::command]
pub async fn plugin_list(available: bool) -> Result<PluginListResult, String> {
    // 调用 claude plugin list --json [--available]
}

#[tauri::command]
pub async fn plugin_install(
    plugin_id: String,
    scope: String,
) -> Result<PluginInstallResult, String> {
    // 调用 claude plugin install <plugin> -s <scope>
}

#[tauri::command]
pub async fn plugin_enable(plugin_id: String, scope: String) -> Result<(), String> {
    // 调用 claude plugin enable <plugin> -s <scope>
}

#[tauri::command]
pub async fn plugin_disable(plugin_id: String, scope: String) -> Result<(), String> {
    // 调用 claude plugin disable <plugin> -s <scope>
}

#[tauri::command]
pub async fn plugin_update(plugin_id: String, scope: String) -> Result<(), String> {
    // 调用 claude plugin update <plugin> -s <scope>
}

#[tauri::command]
pub async fn plugin_uninstall(
    plugin_id: String,
    scope: String,
    keep_data: bool,
) -> Result<(), String> {
    // 调用 claude plugin uninstall <plugin> -s <scope> [--keep-data]
}

#[tauri::command]
pub async fn marketplace_list() -> Result<Vec<Marketplace>, String> {
    // 调用 claude plugin marketplace list --json
}

#[tauri::command]
pub async fn marketplace_add(source: String) -> Result<Marketplace, String> {
    // 调用 claude plugin marketplace add <source>
}

#[tauri::command]
pub async fn marketplace_remove(name: String) -> Result<(), String> {
    // 调用 claude plugin marketplace remove <name>
}

#[tauri::command]
pub async fn marketplace_update(name: Option<String>) -> Result<(), String> {
    // 调用 claude plugin marketplace update [name]
}
```

### 4.2 数据模型

```rust
// src-tauri/src/models/plugin.rs

#[derive(Serialize, Deserialize)]
pub struct PluginListResult {
    pub installed: Vec<InstalledPlugin>,
    pub available: Option<Vec<AvailablePlugin>>,
}

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize)]
pub struct AvailablePlugin {
    pub plugin_id: String,
    pub name: String,
    pub description: Option<String>,
    pub marketplace_name: String,
    pub source: serde_json::Value,
    pub install_count: Option<i32>,
}

#[derive(Serialize, Deserialize)]
pub struct Marketplace {
    pub name: String,
    pub source: String,
    pub repo: Option<String>,
    pub install_location: String,
}

#[derive(Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(rename = "type")]
    pub server_type: Option<String>,
    pub url: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
}
```

### 4.3 CLI 执行器

```rust
// src-tauri/src/services/plugin_service.rs

impl PluginService {
    pub async fn list_plugins(&self, available: bool) -> Result<PluginListResult, String> {
        let mut args = vec!["plugin", "list", "--json"];
        if available {
            args.push("--available");
        }

        let output = self.execute_claude(&args).await?;

        // 解析 JSON 输出
        let result: PluginListResult = serde_json::from_str(&output)
            .map_err(|e| format!("Failed to parse plugin list: {}", e))?;

        Ok(result)
    }

    pub async fn install_plugin(
        &self,
        plugin_id: &str,
        scope: &str,
    ) -> Result<PluginInstallResult, String> {
        let args = vec![
            "plugin", "install", plugin_id,
            "-s", scope
        ];

        let output = self.execute_claude(&args).await?;

        Ok(PluginInstallResult {
            success: true,
            message: output,
        })
    }

    // ... 其他方法
}
```

---

## 五、前端实现

### 5.1 Store 设计

```typescript
// src/stores/pluginStore.ts

import { create } from 'zustand';

interface PluginState {
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
  marketplaces: Marketplace[];
  selectedPlugin: Plugin | null;
  loading: boolean;
  error: string | null;

  // Actions
  fetchPlugins: (available?: boolean) => Promise<void>;
  installPlugin: (pluginId: string, scope: string) => Promise<void>;
  enablePlugin: (pluginId: string, scope: string) => Promise<void>;
  disablePlugin: (pluginId: string, scope: string) => Promise<void>;
  updatePlugin: (pluginId: string, scope: string) => Promise<void>;
  uninstallPlugin: (pluginId: string, scope: string, keepData: boolean) => Promise<void>;
  fetchMarketplaces: () => Promise<void>;
  addMarketplace: (source: string) => Promise<void>;
  removeMarketplace: (name: string) => Promise<void>;
  selectPlugin: (plugin: Plugin | null) => void;
}
```

### 5.2 服务层

```typescript
// src/services/pluginService.ts

import { invoke } from '@tauri-apps/api/core';

export const pluginService = {
  async listPlugins(available = false): Promise<PluginListResult> {
    return invoke('plugin_list', { available });
  },

  async installPlugin(pluginId: string, scope: string): Promise<PluginInstallResult> {
    return invoke('plugin_install', { pluginId, scope });
  },

  async enablePlugin(pluginId: string, scope: string): Promise<void> {
    return invoke('plugin_enable', { pluginId, scope });
  },

  async disablePlugin(pluginId: string, scope: string): Promise<void> {
    return invoke('plugin_disable', { pluginId, scope });
  },

  async updatePlugin(pluginId: string, scope: string): Promise<void> {
    return invoke('plugin_update', { pluginId, scope });
  },

  async uninstallPlugin(pluginId: string, scope: string, keepData: boolean): Promise<void> {
    return invoke('plugin_uninstall', { pluginId, scope, keepData });
  },

  async listMarketplaces(): Promise<Marketplace[]> {
    return invoke('marketplace_list');
  },

  async addMarketplace(source: string): Promise<Marketplace> {
    return invoke('marketplace_add', { source });
  },

  async removeMarketplace(name: string): Promise<void> {
    return invoke('marketplace_remove', { name });
  },
};
```

---

## 六、原型设计

### 6.1 主界面原型

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⚙️ 设置                                          ─ □ ✕              │
├────────────────────────────────────────────────────────────────────────┤
│ ┌────────────┬─────────────────────────────────────────────────────┐  │
│ │ General    │ ┌─────────────────────────────────────────────────┐ │  │
│ │ System     │ │ 🔍 搜索插件...                     🔄 刷新      │ │  │
│ │ Window     │ └─────────────────────────────────────────────────┘ │  │
│ │ AI Engine  │                                                     │  │
│ │ Translate  │ ┌────────────────┬────────────────────────────────┐ │  │
│ │ QQBot      │ │ 已安装 (8)     │ Figma                          │ │  │
│ │ Feishu     │ │ ────────────── │ ────────────────────────────── │ │  │
│ │ Speech     │ │ ✅ figma       │ ID: figma@claude-plugins-...   │ │  │
│ │ Assistant  │ │ ✅ playwright  │ 版本: 2.0.7  状态: ✅ 已启用   │ │  │
│ │ Advanced   │ │ ✅ superpowers │ 来源: claude-plugins-official  │ │  │
│ │ ┌────────┐ │ │ ✅ pua        │                                 │ │  │
│ │ │Plugins │ │ │ ✅ rust-ana.. │ 描述:                          │ │  │
│ │ └────────┘ │ │ ✅ typescript │ Figma 设计工具集成，支持设计   │ │  │
│ │            │ │ ✅ supabase   │ 系统变量生成、组件映射等...    │ │  │
│ │            │ │ ✅ frontend   │                                 │ │  │
│ │            │ │ ────────────── │ MCP 服务:                      │ │  │
│ │            │ │ 可用插件      │ • figma (http)                 │ │  │
│ │            │ │ ────────────── │   https://mcp.figma.com/mcp    │ │  │
│ │            │ │ 📦 asana      │                                 │ │  │
│ │            │ │ 📦 notion     │ 安装时间: 2026-04-03 16:38     │ │  │
│ │            │ │ 📦 slack      │ 更新时间: 2026-04-12 06:25     │ │  │
│ │            │ │ 📦 linear     │                                 │ │  │
│ │            │ │ 📦 github     │ ┌─────────────────────────────┐ │  │
│ │            │ │ 📦 jira       │ │ [🔴 禁用] [🗑️ 卸载]         │ │  │
│ │            │ │ ...           │ └─────────────────────────────┘ │  │
│ │            │ └────────────────┴────────────────────────────────┘ │  │
│ └────────────┴─────────────────────────────────────────────────────┘  │
│                                                                        │
│ 市场: claude-plugins-official ▾ | pua-skills | [+ 添加市场]           │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.2 安装确认弹窗

```
┌─────────────────────────────────────┐
│ 📦 安装插件                          │
├─────────────────────────────────────┤
│                                     │
│ 即将安装: asana                     │
│                                     │
│ 描述:                               │
│ Asana 项目管理集成，创建和管理      │
│ 任务、搜索项目、更新分配...         │
│                                     │
│ 安装范围:                           │
│ ◉ 用户级别 (推荐)                   │
│ ○ 项目级别                          │
│ ○ 本地级别                          │
│                                     │
│ 安装数量: 7,137                     │
│ 来源: claude-plugins-official       │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │        [取消]    [确认安装]     │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### 6.3 操作反馈

```
成功提示:
┌─────────────────────────────────────┐
│ ✅ 插件已启用                        │
│                                     │
│ figma 插件已成功启用。              │
│ 某些功能可能需要重启应用生效。      │
│                                     │
│              [确定]                 │
└─────────────────────────────────────┘

错误提示:
┌─────────────────────────────────────┐
│ ❌ 操作失败                          │
│                                     │
│ 无法安装插件 asana:                 │
│ 网络连接超时，请检查网络后重试。    │
│                                     │
│         [重试]    [关闭]            │
└─────────────────────────────────────┘
```

---

## 七、实现计划

### Phase 1: 基础框架（1-2天）

1. 创建 Tauri commands (`plugin.rs`)
2. 定义数据模型
3. 实现 CLI 执行器
4. 创建前端 Store 和 Service

### Phase 2: 列表展示（1天）

1. 实现 `PluginSettingsTab` 组件
2. 实现 `PluginList` 组件
3. 实现 `PluginDetail` 组件
4. 集成到设置模态框

### Phase 3: 操作功能（1-2天）

1. 实现安装功能
2. 实现启用/禁用功能
3. 实现更新功能
4. 实现卸载功能
5. 添加操作确认弹窗

### Phase 4: 市场管理（1天）

1. 实现市场选择器
2. 实现添加市场弹窗
3. 实现市场更新/移除

### Phase 5: 优化完善（1天）

1. 添加搜索过滤
2. 添加加载状态
3. 添加错误处理
4. 国际化支持
5. 单元测试

---

## 八、风险与注意事项

### 8.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| CLI 输出格式变化 | 解析失败 | 版本检测 + 降级处理 |
| 网络超时 | 操作失败 | 重试机制 + 错误提示 |
| 权限问题 | 安装失败 | 清晰的错误提示 |
| 重启需求 | 体验中断 | 明确提示用户 |

### 8.2 用户体验

1. **操作反馈**：所有操作需有明确的成功/失败反馈
2. **状态同步**：操作后需刷新列表保持数据最新
3. **重启提示**：需要重启的操作需明确提示
4. **错误处理**：友好的错误提示，避免技术术语

---

## 九、后续扩展

1. **插件评分系统**：展示用户评分
2. **插件推荐**：基于使用场景推荐
3. **批量操作**：批量启用/禁用
4. **自动更新**：自动检测并更新插件
5. **插件配置**：部分插件的可视化配置界面

---

*文档版本：1.0.0*
*最后更新：2026-04-14*
