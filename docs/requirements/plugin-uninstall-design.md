# 设计文档：插件卸载进程清理方案

> 状态：已实施 (2026-08-22)

## 最终方案

### 核心设计

**方案 A 增强卸载流程** — 不改现有架构，只补全"卸载前杀进程"这一步。

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 进程发现方式 | 按 manifest 命令名 + 插件目录路径匹配 | 安全，避免误杀系统进程 |
| 通用运行时 | 按命令行含插件目录路径匹配（`wmic commandline like`） | `taskkill /IM node.exe` 会误杀所有 node 进程 |
| 专用二进制 | 直接按映像名 `taskkill /F /IM /T` | 专属二进制不会误杀，安全 |
| 目录删除 | 重试 5 次 + 500ms 间隔 | Windows 下进程退出后句柄延迟释放 |
| 引擎注册表 | 前端负责（`refreshInstalledPlugins` → `replaceInstalled`） | 后端无 pluginId→engineId 映射 |
| 服务进程 | 后端 `stop_services_for_plugin` | 已有 `PluginServiceManager` 实现 |
| 前端进度反馈 | 统一消息"Stopping processes and removing plugin..." | 避免多步 UI 复杂度 |

### 安全设计要点

1. **通用运行时（node/python/java/dotnet）** 不按映像名全局杀，改用 `wmic process where "commandline like '%pluginDir%'" get processid` 精确匹配
2. **WMIC LIKE 转义**：`%` → `[%]`, `_` → `[_]`，防止通配符误匹配
3. **专用二进制**（如 `my-plugin-server.exe`）才按映像名匹配，因为不会误杀
4. 目录删除重试 5 次，给 OS 释放句柄的时间

### 新增 Tauri 命令

`plugin_uninstall_with_cleanup` — 统一卸载命令：

1. 停止 PluginServiceManager 中的服务
2. 读取 manifest 获取插件命令名
3. 安全终止匹配进程（命令名 + 命令行双重匹配）
4. 等待 OS 释放句柄 (800ms)
5. 删除目录（重试 5 次，间隔 500ms）

### 改动范围

| 文件 | 改动 |
|------|------|
| `src-tauri/src/services/plugin_service.rs` | +351行：`CommandEntry`、`uninstall_plugin_with_cleanup`、`kill_plugin_processes_safe`、`collect_plugin_commands`、`kill_processes_by_image_name`、`kill_processes_by_command_line`、`remove_dir_all_with_retry` |
| `src-tauri/src/commands/plugin.rs` | +45行：`plugin_uninstall_with_cleanup` Tauri 命令 |
| `src-tauri/src/web/api/ipc.rs` | +33行：`dispatch_plugin_uninstall_with_cleanup` Web IPC |
| `src-tauri/src/lib.rs` | +1行：注册新命令 |
| `src/services/pluginDiscoveryService.ts` | +21行：`uninstallPluginWithCleanup` 前端 API |
| `src/components/Settings/tabs/PluginTab.tsx` | 卸载流程改用 `uninstallPluginWithCleanup`，移除旧的手动 `stopServicesForPlugin` |

### 验证结果

| 检查项 | 结果 |
|--------|------|
| `cargo check --lib` | ✅ 编译通过，无错误 |
| `npx tsc --noEmit` | ✅ 无新增错误 |
| `vitest pluginDiscoveryService` | ✅ 13 passed（含新增3个测试） |
| `vitest pluginServiceManager` | ✅ 6 passed |
| Rust lib test | ⚠️ 环境限制无法运行（已知问题，`rust-lib-test-env-limit`） |