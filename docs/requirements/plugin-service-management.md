# 需求分析：插件服务管理功能

> 日期：2026-08-22
> 状态：分析阶段

---

## 1. 问题描述

### 1.1 用户视角

用户在"设置 → 插件"页面安装插件后，试图卸载时出现类似"os error"的报错，卸载失败。

### 1.2 典型场景

1. 从商城或远程 URL 安装插件（如 `polaris.marketplace` 或其他 MCP 插件）  
2. 插件附带 MCP Server 或后台服务进程  
3. 用户尝试卸载 → 报错，目录残留  
4. 再次尝试可能仍失败，或部分清理后剩余文件无法删除  

### 1.3 报错根因

现象：卸载时前端提示类似 `os error`（如 `OS error 13` → Windows 实为 `Access is denied` / `OS error 32` → 文件被占用）。

根因（有排查证据支撑）：

1. **Windows 文件句柄占用**：插件附带的 MCP Server（stdio 子进程）或后台服务进程仍持有插件目录下文件的打开句柄，`std::fs::remove_dir_all` 删除失败。
2. **现有卸载流程只停了"一部分"进程**：前端 `handleUninstallLocalPlugin`（PluginTab.tsx L636-674）在卸载前调用 `stopServicesForPlugin`，但该命令只终止 **`contributes.services`** 类型的进程（由 `PluginServiceManager` 管理）。而插件实际可挂四类进程，见下表。
3. **MCP stdio 子进程由 `McpClient` 管理**：其生命周期依赖 `SimpleAI` 引擎的 `McpClientPool`，`Drop` 时才 kill 子进程（`client.rs` 的 `impl Drop` → `StdioTransport::kill_sync` → `child.start_kill`）。卸载时机未触发这些 Drop，进程残留。
4. **Web 模式的 IPC 卸载路径同样只删目录**：`src-tauri/src/web/api/ipc.rs` 的 `dispatch_plugin_uninstall_local`（L2115-2125）直接调 `uninstall_local_plugin`，仅 `remove_dir_all`，无任何进程清理。

### 1.4 四类进程归属

| 进程体系 | 注册/管理处 | 卸载时是否被终止 | 残留示例 |
|----------|------------|-----------------|---------|
| `contributes.services`（后台服务） | `PluginServiceManager`（Rust） | ✅ 已覆盖（stopServicesForPlugin） | — |
| `contributes.mcpServers`（stdio 子进程） | `McpClient` / `McpClientPool`（SimpleAI Rust） | ❌ 未覆盖 | 如 Blender、Git 等本地 MCP 进程 |
| `contributes.engines`（插件 AI 引擎进程） | `plugin_process_engine.rs` / `PluginProcessEngine` | ❌ 未覆盖 | 如 dsh 引擎的 Node 侧车 |
| http 远程 MCP（外部服务） | `HttpTransport` | ✅ 无本地进程无需终止 | — |

---

## 2. 现状勘察

### 2.1 插件生命周期现有能力

| 能力 | 状态 | 说明 |
|------|------|------|
| 安装（本地目录） | ✅ 完成 | `plugin_install_local` → 复制到 plugins 目录 |
| 安装（zip 包） | ✅ 完成 | `plugin_install_package` → 解压 → 复制 |
| 安装（远程 URL） | ✅ 完成 | `install_remote_plugin` → 下载 → 解压 → 复制 |
| 开关（启用/禁用） | ✅ 完成 | 前端 toggle，持久化到 pluginStore |
| 检查更新 | ✅ 完成 | 读取 `origin.updateUrl` 比对版本 |
| 应用更新 | ✅ 完成 | 下载 → 备份 → 替换 |
| **卸载** | ⚠️ 有缺陷 | 仅删除目录，不清理运行中进程 |

### 2.2 卸载流程（当前实现）

```
前端 PluginTab.tsx: handleUninstallLocalPlugin
  ├─ 1. stopServicesForPlugin(pluginId)  ← 仅停 PluginServiceManager 管理的服务
  ├─ 2. uninstallLocalPlugin(installPath) ← 后端 remove_dir_all
  └─ 3. resetPluginState(pluginId)        ← 重置前端 store
```

**缺陷**：`stopServicesForPlugin` 只停 `PluginServiceManager` 管理的"服务"（`contributes.services`），但插件可能有多个进程体系：

| 进程体系 | 管理方 | 卸载时是否被杀 |
|----------|--------|---------------|
| `contributes.services` | `PluginServiceManager`（Rust） | ✅ 是，被 stopServicesForPlugin 杀 |
| `contributes.mcpServers` | `McpClient` / `HttpTransport`（前端/引擎层） | ❌ **不杀** |
| `contributes.engines`（插件引擎进程） | 引擎管理器（`engineRegistry`） | ❌ **不杀** |
| 直接注册的 `McpTransport` | 前端 transport 层 | ❌ **不杀** |

### 2.3 进程管理架构

```
┌─────────────────────────────────────────────────┐
│                  插件系统                         │
├─────────────────────────────────────────────────┤
│  PluginServiceManager (Rust)                     │
│  ├─ services: HashMap<String, ManagedService>    │
│  ├─ stop_service() → kill child → release port   │
│  └─ stop_services_for_plugin()                   │
├─────────────────────────────────────────────────┤
│  McpClient / McpTransport (前端 + Rust)          │
│  ├─ 管理 MCP Server 的 stdio 子进程              │
│  ├─ 通过 process.stdin/stdout 通信               │
│  └─ 生命周期由 AI 引擎连接管理                    │
├─────────────────────────────────────────────────┤
│  EngineRegistry (前端)                            │
│  ├─ 管理插件注册的 AI 引擎进程                    │
│  └─ reRegisterPluginEngines()                    │
├─────────────────────────────────────────────────┤
│  pluginStore / pluginServiceStore (Zustand)      │
│  ├─ pluginStates 持久化                          │
│  └─ serviceStatuses 状态跟踪                     │
└─────────────────────────────────────────────────┘
```

### 2.4 关键代码位置

| 组件 | 路径 | 行数 |
|------|------|------|
| 插件设置页（卸载 UI） | `src/components/Settings/tabs/PluginTab.tsx` | L636-674 |
| 前端服务管理器 | `src/services/pluginServiceManager.ts` | 全文件 |
| 前端服务 Store | `src/stores/pluginServiceStore.ts` | 全文件 |
| Rust 服务管理器 | `src-tauri/src/services/plugin_service_manager.rs` | 全文件 |
| Rust 插件服务命令 | `src-tauri/src/commands/plugin_service.rs` | 全文件 |
| Rust 插件管理命令 | `src-tauri/src/commands/plugin.rs` | 全文件 |
| Rust 插件核心逻辑 | `src-tauri/src/services/plugin_service.rs` | 全文件 |
| Web IPC 插件卸载 | `src-tauri/src/web/api/ipc.rs` | L2115-2125 |

---

## 3. 需求分析

### 3.1 核心需求

> **P0：卸载前必须杀死插件关联的所有进程，确保文件可删除**

### 3.2 拆解需求

#### 3.2.1 进程发现与终止（P0）

| 需求 | 描述 |
|------|------|
| MCP Server 进程终止 | 卸载前中止该插件注册的所有 `contributes.mcpServers` 对应的子进程 |
| 引擎进程终止 | 卸载前中止该插件注册的 `contributes.engines` 对应的引擎进程 |
| 后台服务进程终止 | 现有 `stopServicesForPlugin` 已覆盖，需确认无遗漏 |
| 侧车进程兜底 | 对于无法通过常规方式终止的进程，尝试 `taskkill /F`（Windows）/ `kill -9`（Unix） |

#### 3.2.2 资源清理（P0）

| 需求 | 描述 |
|------|------|
| 目录清理 | 删除插件安装目录（现有） |
| 注册表清理 | 从 `pluginRegistry` 中移除插件注册信息 |
| Store 清理 | 清除 `pluginStore` 中的状态 |
| 服务状态清理 | 从 `pluginServiceStore` 中移除服务状态 |
| 持久化配置清理 | 清理 localStorage 中该插件的持久化配置 |

#### 3.2.3 错误处理与用户体验（P1）

| 需求 | 描述 |
|------|------|
| 准确报错信息 | 当进程终止失败时，给出具体原因而非模糊的"os error" |
| 强制卸载选项 | 允许用户选择"强制卸载"（跳过进程终止，仅标记移除） |
| 卸载进度反馈 | 展示卸载步骤（停止进程 → 清理文件 → 清理注册表） |
| 部分卸载恢复 | 如果卸载中途失败，提供回滚或重试指引 |

#### 3.2.4 Web 模式兼容（P1）

| 需求 | 描述 |
|------|------|
| Web 模式卸载支持 | 当前 `uninstallLocalPlugin` 通过 Tauri 命令执行，Web 模式需有 IPC 备选路径 |
| 跨平台一致性 | 确保 Tauri 和 Web 模式下的卸载行为一致 |

### 3.3 非功能需求

| 类型 | 需求 |
|------|------|
| 安全性 | 只能卸载已安装的插件，不能删除未授权路径 |
| 幂等性 | 重复卸载同一插件应安全（已删除 → 返回成功） |
| 并发安全 | 多个插件同时卸载不应相互干扰 |
| 资源释放 | 进程终止后应释放端口占用 |

---

## 4. 方案设计思路

### 4.1 方案 A：增强卸载流程（推荐）

**核心思路**：在现有 `handleUninstallLocalPlugin` 和 `uninstall_local_plugin` 之间增加完整的进程终止层。

```
1. 收集该插件的所有关联进程
   ├─ PluginServiceManager 中的服务
   ├─ MCP Server 进程（通过 McpTransport 注册表查找）
   ├─ 引擎进程（通过 EngineRegistry 查找）
   └─ 已知的侧车进程白名单

2. 按顺序终止（优雅 → 强制）
   ├─ 发送 SIGTERM / kill 信号
   ├─ 等待 3s 优雅退出
   └─ 超时则 SIGKILL / taskkill /F

3. 验证进程已终止（检查 PID 是否存活）

4. 执行文件清理

5. 执行注册表 / Store 清理
```

**关键变更文件**：

| 文件 | 变更 |
|------|------|
| `src-tauri/src/commands/plugin.rs` | 新增 `plugin_uninstall_enhanced` 命令，内含进程终止步骤 |
| `src-tauri/src/services/plugin_service.rs` | `uninstall_local_plugin` 增加进程终止前处理 |
| `src-tauri/src/services/plugin_service_manager.rs` | 新增 `kill_plugin_processes` 方法 |
| `src/services/pluginDiscoveryService.ts` | `uninstallLocalPlugin` 增强 |
| `src/components/Settings/tabs/PluginTab.tsx` | 卸载流程 + 进度反馈 + 错误提示 |

### 4.2 方案 B：独立进程管理器

**核心思路**：将全部插件进程管理统一到 `PluginServiceManager`，所有 MCP Server / 引擎进程都通过它注册和启停。

**优点**：单一责任、生命周期清晰  
**缺点**：改动量大，涉及 McpTransport 和引擎管理器的重构，且需要处理 MCP 协议层与进程管理层的解耦

### 4.3 方案 C：卸载时兜底 try-catch + 重试

**核心思路**：不追踪进程，卸载时先尝试 `remove_dir_all`，如果失败则：
1. 枚举并终止插件目录下所有打开的文件句柄（Windows 用 `handle` / `RestartManager`）
2. 重试删除
3. 如果仍失败，报具体错误并建议用户手动关闭进程

**优点**：改动最小，不需要追踪进程  
**缺点**：兜底方案不够优雅，Windows 下文件句柄枚举可能仍失败

---

## 5. 推荐方案

### 选择方案 A：增强卸载流程

理由：
1. 当前已经有 `PluginServiceManager` 作为进程管理入口，MCP Server 和引擎进程的管理方也有明确的注册入口
2. 改动集中在"卸载"这一条路径，不重构现有架构
3. 可以逐步迭代：先解决 MCP Server 进程终止（P0），再完善引擎进程终止（P1）

### 实施步骤

| 步骤 | 内容 | 优先级 |
|------|------|--------|
| 1 | 梳理 MCP Server 进程注册表，找到所有插件 MCP 子进程的句柄 | P0 |
| 2 | 在 `PluginServiceManager` 中增加进程终止辅助方法（kill by PID / 进程名） | P0 |
| 3 | 改造 `uninstall_local_plugin`：先终止进程，再删目录 | P0 |
| 4 | 前端增强：卸载前调用增强的进程终止 + 进度反馈 | P0 |
| 5 | 完善注册表/Store 清理逻辑 | P1 |
| 6 | Web 模式 IPC 适配 | P1 |
| 7 | 强卸载选项 + 错误恢复 | P2 |

---

## 6. 附录

### 6.1 相关文件清单

```
src-tauri/src/commands/plugin.rs
src-tauri/src/commands/plugin_service.rs
src-tauri/src/services/plugin_service.rs
src-tauri/src/services/plugin_service_manager.rs
src-tauri/src/web/api/ipc.rs
src/services/pluginDiscoveryService.ts
src/services/pluginServiceManager.ts
src/stores/pluginServiceStore.ts
src/stores/pluginStore.ts
src/components/Settings/tabs/PluginTab.tsx
src/plugin-system/registry.ts
```

### 6.2 已知相关记忆

- [[plugin-service-manager-wired]] — 插件服务管理接线
- [[mcp-stateless-complete]] — MCP 无状态化，McpTransport 架构
- [[dispatch-task-mcp]] — 任务派发 MCP 架构