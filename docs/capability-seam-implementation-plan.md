# Capability Seam 升级实施计划

> 设计文档：[capability-seam-upgrade-design.md](./capability-seam-upgrade-design.md)
> 插件仓库：`D:\space\base\Polaris-plugin\`
> 规则：每实现一个 seam 功能，必须在 Polaris-plugin 仓库实现一个对应的测试 demo 插件验证

## 总览

| Phase | 主题 | 周期 | Demo 插件 |
|---|---|---|---|
| P1 | MCP 统一化 + toolProviders 扩展点 | 1-2 周 | `demo-shell-override` |
| P2 | Capability Seam 抽象（shell/fs/compaction/subagent） | 2-3 周 | `demo-sandbox-shell` / `demo-s3-fs` / `demo-smart-compaction` / `demo-dsh-subagent` |
| P3 | UI Slot + 运行时自省 | 2-3 周 | `demo-ui-shadow` / `demo-ui-chain` |

## 通用约定

### Demo 插件目录结构

每个 demo 插件放在 `Polaris-plugin/plugins/<name>/`，遵循现有插件规范：

```
Polaris-plugin/plugins/demo-xxx/
├── plugin.json           # 清单（含新增 toolProviders/providers 字段）
├── mcp/
│   └── server.js         # MCP server 实现（JSON-RPC 2.0 over stdio）
├── src/                  # 面板源码（如需）
│   └── Panel.tsx
├── dist/
│   └── panel.js          # 打包产物
├── update.json           # 更新清单
└── README.md             # demo 说明
```

### Demo 插件验收标准（通用）

1. 在 Polaris 设置 → 插件中安装成功，manifest 诊断无错误
2. 安装后默认行为符合预期（功能生效）
3. 卸载后系统自动回退到默认实现
4. 现有插件（marketplace/blender/zen 等）不受影响

---

## Phase 1：MCP 统一化 + toolProviders 扩展点

### P1-T1：InProcessMcpGateway 基础设施

**目标**：实现进程内 MCP 网关，让内置工具通过 MCP 协议路由，但不启动子进程。

**任务**：
- [ ] 新增 `src-tauri/src/ai/engine/simple_ai/in_process_mcp.rs`
- [ ] 实现 MCP JSON-RPC 2.0 协议的 in-process 路由
- [ ] 提供 `register_builtin_tool(name, handler)` API
- [ ] 路由 `initialize` / `tools/list` / `tools/call` 到对应 handler

**验证**：单元测试，in-process 网关能正确响应 MCP 协议消息。

### P1-T2：内置工具 MCP 化

**目标**：把 SimpleAI 的 11 个内置工具封装为 5 个 in-process MCP server。

**任务**：
- [ ] `polaris-bash` MCP server：注册 `bash` 工具（从 `BashTool` 迁移）
- [ ] `polaris-fs` MCP server：注册 `read_file` / `write_file` / `edit_file` / `list_directory` / `search_files` / `glob` / `apply_patch`（从 `fs.rs` 迁移）
- [ ] `polaris-plan` MCP server：注册 `update_plan`（从 `plan.rs` 迁移）
- [ ] `polaris-skill` MCP server：注册 `read_skill`（从 `skill.rs` 迁移）
- [ ] `polaris-subagent` MCP server：注册 `dispatch_agent`（从 `agent.rs` 迁移）
- [ ] 修改 `ToolRegistry::with_builtins()`：从硬编码 `Box::new(BashTool)` 改为从 `InProcessMcpGateway` 加载
- [ ] `McpClientPool` 统一路由：内置工具走 in-process，外部工具走子进程

**验证**：SimpleAI 所有内置工具行为不变（通过现有测试）。

### P1-T3：toolProviders 扩展点

**目标**：插件 manifest 新增 `contributes.toolProviders` 字段，声明覆盖内置工具。

**任务**：
- [ ] `src-tauri/src/models/plugin.rs`：`PluginManifestContributes` 新增 `tool_providers` 字段
- [ ] `src/plugin-system/types.ts`：新增 `PluginToolProviderContribution` 类型
- [ ] `src/plugin-system/registry.ts`：新增 `registerToolProviders` 方法
- [ ] `src-tauri/src/services/mcp_config_service.rs`：MCP 配置生成时，如果插件声明了 toolProvider 覆盖，则用插件的 MCP server 替换内置 server
- [ ] `src/plugin-system/mcp.ts`：`listEnabledPluginMcpServers` 考虑 toolProvider 覆盖优先级
- [ ] 前端 `PluginTab.tsx`：显示 toolProvider 覆盖状态（哪个插件覆盖了哪个能力）

**验证**：插件声明 `toolProviders: [{ capability: "shell", mcpServerId: "my-bash" }]` 后，bash 调用走插件 MCP server。

### P1-T4：Demo 插件 `demo-shell-override`

**位置**：`Polaris-plugin/plugins/demo-shell-override/`

**功能**：覆盖内置 shell，所有 bash 命令执行前记录审计日志，并限制危险命令（如 `rm -rf /`）。

**plugin.json**：
```jsonc
{
  "id": "demo.shell-override",
  "name": "Demo Shell Override",
  "version": "0.1.0",
  "description": "演示 toolProviders 扩展点：覆盖内置 shell，加审计日志 + 危险命令拦截",
  "enabledByDefault": false,
  "contributes": {
    "toolProviders": [
      {
        "capability": "shell",
        "mcpServerId": "demo-audit-shell",
        "description": "带审计日志 + 危险命令拦截的 shell 执行器"
      }
    ],
    "mcpServers": [
      {
        "id": "demo-audit-shell",
        "transport": "stdio",
        "command": "node",
        "argsTemplate": ["{{pluginDir}}/mcp/server.js"]
      }
    ]
  },
  "permissions": { "aiToolAccess": true, "workspaceRead": true }
}
```

**MCP server 行为**：
- `bash` 工具：接收 `{ command, workdir }` 参数
- 检查 command 是否在黑名单（`rm -rf /`、`del /f /s /q C:\*` 等）
- 黑名单命令返回错误，不执行
- 白名单命令：调用系统 shell 执行，记录命令+时间到 `{{pluginDir}}/audit.log`
- 返回 stdout/stderr/exit_code

**验收**：
- [ ] 安装后，AI 调用 bash → 走 demo MCP server
- [ ] `rm -rf /` 被拦截，返回错误
- [ ] `ls` 正常执行，audit.log 有记录
- [ ] 卸载后，bash 恢复默认实现

### P1 验收清单

- [ ] P1-T1 InProcessMcpGateway 实现 + 单元测试
- [ ] P1-T2 11 个内置工具 MCP 化 + 行为不变
- [ ] P1-T3 toolProviders 字段解析 + 覆盖逻辑
- [ ] P1-T4 demo-shell-override 插件可安装、可覆盖、可回退
- [ ] 现有插件零改动兼容
- [ ] DSH MCP 插件（如 mcp-memory）可直接安装使用

---

## Phase 2：Capability Seam 抽象

### P2-T1：Shell Seam

**目标**：定义 `ShellCapability` trait + 默认 Provider + 插件覆盖机制。

**任务**：
- [ ] 新增 `src-tauri/src/capabilities/mod.rs` + `shell.rs`
- [ ] 定义 `ShellCapability` trait + `ShellResult` / `ShellType` 类型
- [ ] 实现 `DefaultShellProvider`（从当前 `run_bash()` 迁移）
- [ ] 新增 `CapabilityRegistry`（`src-tauri/src/capabilities/registry.rs`）
- [ ] `BashTool::execute` 改为通过 `ShellCapability` seam 调用
- [ ] SimpleAI `ToolContext` 注入 `CapabilityRegistry`

**验证**：默认 Provider 行为与当前 `run_bash()` 完全一致。

### P2-T2：FileSystem Seam

**目标**：定义 `FileSystemCapability` trait + 默认 Provider。

**任务**：
- [ ] 新增 `src-tauri/src/capabilities/filesystem.rs`
- [ ] 定义 `FileSystemCapability` trait（read_text/write_text/edit_text/list_directory/search_files/glob/apply_patch）
- [ ] 实现 `DefaultFileSystemProvider`（从 `fs.rs` 迁移）
- [ ] SimpleAI 各 fs 工具改为通过 seam 调用

**验证**：文件读写行为不变。

### P2-T3：Compaction Seam

**目标**：定义 `CompactionCapability` trait + 默认 Provider。

**任务**：
- [ ] 新增 `src-tauri/src/capabilities/compaction.rs`
- [ ] 定义 `CompactionCapability` trait（should_compact/compact）
- [ ] 实现 `DefaultCompactionProvider`（从 `messageCompactor.ts` 逻辑迁移到 Rust，或保留 TS 调用桥接）
- [ ] 压缩触发点改为通过 seam 调用

**验证**：压缩行为不变。

### P2-T4：SubAgent Seam

**目标**：定义 `SubAgentCapability` trait + 默认 Provider。

**任务**：
- [ ] 新增 `src-tauri/src/capabilities/subagent.rs`
- [ ] 定义 `SubAgentCapability` trait（dispatch/check_status）
- [ ] 实现 `DefaultSubAgentProvider`（从 `DispatchAgentTool` 迁移）
- [ ] `DispatchAgentTool` 改为通过 seam 调用

**验证**：子代理派发行为不变。

### P2-T5：providers 扩展点

**目标**：插件 manifest 新增 `contributes.providers` 字段，声明覆盖 capability seam。

**任务**：
- [ ] `src-tauri/src/models/plugin.rs`：`PluginManifestContributes` 新增 `providers` 字段
- [ ] `src/plugin-system/types.ts`：新增 `PluginProviderContribution` 类型
- [ ] `CapabilityRegistry`：注册/查询/优先级选择/卸载回退
- [ ] Provider 通过 MCP server 通信（插件声明 mcpServerId，CapabilityRegistry 通过 McpClientPool 调用）
- [ ] 前端 `PluginTab.tsx`：显示 Provider 覆盖状态

**验证**：插件声明 `providers.shell` 覆盖后，shell 调用走插件。

### P2-T6：Demo 插件 `demo-sandbox-shell`

**位置**：`Polaris-plugin/plugins/demo-sandbox-shell/`

**功能**：通过 `providers.shell` 覆盖默认 shell，实现沙箱化执行（限制工作目录、限制网络）。

**plugin.json**：
```jsonc
{
  "id": "demo.sandbox-shell",
  "name": "Demo Sandbox Shell",
  "version": "0.1.0",
  "contributes": {
    "providers": {
      "shell": {
        "capability": "shell",
        "mcpServerId": "sandbox-shell",
        "description": "沙箱化的 shell 执行器（限制工作目录 + 禁止网络命令）"
      }
    },
    "mcpServers": [{ "id": "sandbox-shell", "transport": "stdio", "command": "node", "argsTemplate": ["{{pluginDir}}/mcp/server.js"] }]
  },
  "permissions": { "aiToolAccess": true, "workspaceRead": true, "workspaceWrite": true }
}
```

### P2-T7：Demo 插件 `demo-s3-fs`

**位置**：`Polaris-plugin/plugins/demo-s3-fs/`

**功能**：通过 `providers.filesystem` 覆盖默认文件系统，实现 S3 远程文件读写（用 mock S3 或 MinIO）。

### P2-T8：Demo 插件 `demo-smart-compaction`

**位置**：`Polaris-plugin/plugins/demo-smart-compaction/`

**功能**：通过 `providers.compaction` 覆盖默认压缩，实现基于 token 计费的智能压缩策略。

### P2-T9：Demo 插件 `demo-dsh-subagent`

**位置**：`Polaris-plugin/plugins/demo-dsh-subagent/`

**功能**：通过 `providers.subagent` 覆盖默认子代理，接入 DSH 的 subagent provider（spawn/fork 模式）。

### P2 验收清单

- [ ] P2-T1~T4 四个 seam trait 定义 + 默认 Provider
- [ ] P2-T5 providers 扩展点 + CapabilityRegistry
- [ ] P2-T6~T9 四个 demo 插件可安装、可覆盖、可回退
- [ ] 默认 Provider 行为完全不变（兼容性测试）

---

## Phase 3：UI Slot + 运行时自省

### P3-T1：UI Slot 系统

**目标**：`activityBar` 升级为 slot 注册模型，支持 append/shadow/chain。

**任务**：
- [ ] `src/plugin-system/types.ts`：`PluginViewContribution` 新增 `slot` + `mode` 字段
- [ ] `src/plugin-system/panelRegistry.ts`：支持 shadow（覆盖）和 chain（链式）语义
- [ ] `src/components/Layout/LeftPanel.tsx`：渲染时考虑 slot 模式
- [ ] 内置面板声明 slot id（如 `files.panel`、`git.panel`）

### P3-T2：Demo 插件 `demo-ui-shadow`

**位置**：`Polaris-plugin/plugins/demo-ui-shadow/`

**功能**：声明 `slot: "files.panel", mode: "shadow"`，替换默认文件面板为自定义版本（带文件预览缩略图）。

### P3-T3：Demo 插件 `demo-ui-chain`

**位置**：`Polaris-plugin/plugins/demo-ui-chain/`

**功能**：声明 `slot: "files.panel", mode: "chain"`，在文件列表项旁添加 Git blame 信息。

### P3-T4：运行时自省

**目标**：实现 `PluginInspector`，运行时查看插件树。

**任务**：
- [ ] 新增 `src/plugin-system/inspector.ts`
- [ ] 实现 `listPlugins` / `listMcpServers` / `listProviders` / `getProvider`
- [ ] 前端新增"插件诊断"面板（显示完整插件树 + Provider 覆盖状态）
- [ ] 插件热重载（重新发现 + 注册，不影响已建立会话）

### P3 验收清单

- [ ] P3-T1 slot 系统支持 append/shadow/chain
- [ ] P3-T2/T3 demo 插件 shadow/chain 生效
- [ ] P3-T4 插件诊断面板可用
- [ ] 热重载不影响现有会话

---

## 实施顺序与依赖

```
P1-T1 (InProcessMcpGateway)
  └─ P1-T2 (内置工具 MCP 化)
       └─ P1-T3 (toolProviders 扩展点)
            └─ P1-T4 (demo-shell-override)
                 │
                 ▼
P2-T1 (Shell Seam) ──┬── P2-T2 (FS Seam) ──┬── P2-T3 (Compaction Seam) ──┬── P2-T4 (SubAgent Seam)
                      │                     │                              │
                      └─────────────────────┴──────────────────────────────┘
                                            │
                                            ▼
                                     P2-T5 (providers 扩展点)
                                            │
                      ┌─────────────────────┼─────────────────────┐
                      ▼                     ▼                     ▼
               P2-T6 (sandbox-shell)  P2-T7 (s3-fs)  P2-T8 (smart-compaction)  P2-T9 (dsh-subagent)
                                            │
                                            ▼
                                     P3-T1~T4 (UI Slot + 自省)
```

## 风险缓解

| 风险 | 缓解 |
|---|---|
| MCP 化后性能下降 | in-process 网关不走子进程，零额外开销 |
| Seam 接口设计不合理 | 每个 seam 单独 ADR，参考 DSH 成熟设计 |
| 向后兼容破坏 | 每个 Phase 都有兼容性测试，默认 Provider 行为不变 |
| 插件 Provider 声明冲突 | 先安装先服务，后安装覆盖前安装 |

## 索引更新

每个 demo 插件完成后，更新 `Polaris-plugin/index.json`，把 demo 插件加入商城索引（标记为 `category: "demo"`），便于从 marketplace 安装测试。
