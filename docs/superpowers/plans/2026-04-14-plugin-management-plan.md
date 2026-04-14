# Plugin 管理功能实现计划

> 基于设计文档：2026-04-14-plugin-management-design.md

---

## 实现步骤

### Step 1: 后端数据模型

**文件**: `src-tauri/src/models/plugin.rs`

创建 Rust 数据模型：
- `PluginListResult`
- `InstalledPlugin`
- `AvailablePlugin`
- `McpServerConfig`
- `Marketplace`
- `PluginOperationResult`

### Step 2: 后端 CLI 服务

**文件**: `src-tauri/src/services/plugin_service.rs`

实现 CLI 执行器：
- `list_plugins(available: bool)` - 调用 `claude plugin list --json [--available]`
- `install_plugin(id, scope)` - 调用 `claude plugin install`
- `enable_plugin(id, scope)` - 调用 `claude plugin enable`
- `disable_plugin(id, scope)` - 调用 `claude plugin disable`
- `update_plugin(id, scope)` - 调用 `claude plugin update`
- `uninstall_plugin(id, scope, keep_data)` - 调用 `claude plugin uninstall`
- `list_marketplaces()` - 调用 `claude plugin marketplace list --json`
- `add_marketplace(source)` - 调用 `claude plugin marketplace add`
- `remove_marketplace(name)` - 调用 `claude plugin marketplace remove`

### Step 3: 后端 Tauri Commands

**文件**: `src-tauri/src/commands/plugin.rs`

创建 Tauri 命令：
- `#[tauri::command] plugin_list`
- `#[tauri::command] plugin_install`
- `#[tauri::command] plugin_enable`
- `#[tauri::command] plugin_disable`
- `#[tauri::command] plugin_update`
- `#[tauri::command] plugin_uninstall`
- `#[tauri::command] marketplace_list`
- `#[tauri::command] marketplace_add`
- `#[tauri::command] marketplace_remove`

### Step 4: 注册命令

**文件**: `src-tauri/src/commands/mod.rs`

添加 `pub mod plugin;`

**文件**: `src-tauri/src/main.rs`

注册命令到 Tauri invoke_handler

### Step 5: 前端类型定义

**文件**: `src/types/plugin.ts`

创建 TypeScript 类型

### Step 6: 前端服务层

**文件**: `src/services/pluginService.ts`

创建 API 调用函数

### Step 7: 前端状态管理

**文件**: `src/stores/pluginStore.ts`

创建 Zustand Store

### Step 8: UI 组件

**文件**: `src/components/Settings/tabs/PluginTab.tsx`

创建主组件，包含：
- 搜索栏
- 插件列表（已安装 + 可用）
- 插件详情面板
- 市场选择栏

### Step 9: 集成到设置模态框

**文件**: `src/components/Settings/SettingsSidebar.tsx`

添加 `plugins` Tab

**文件**: `src/components/Settings/SettingsModal.tsx`

添加 PluginTab 渲染

### Step 10: 国际化

**文件**: `src/locales/zh/settings.json`

添加中文翻译

**文件**: `src/locales/en/settings.json`

添加英文翻译

---

## 依赖关系

```
Step 1 ──▶ Step 2 ──▶ Step 3 ──▶ Step 4
                                      │
                                      ▼
Step 5 ──▶ Step 6 ──▶ Step 7 ──▶ Step 8 ──▶ Step 9 ──▶ Step 10
```

---

## 验收标准

- [ ] 后端命令可正常调用 Claude CLI
- [ ] 前端可正常获取插件列表
- [ ] 安装/启用/禁用/更新/卸载功能正常
- [ ] 市场管理功能正常
- [ ] 国际化正常显示
- [ ] 错误处理正常
