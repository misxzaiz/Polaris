# Polaris 功能扩展路线图

> 版本：1.0.0
> 日期：2026-04-14
> 基于：Claude CLI v2.1.104 功能分析

---

## 一、背景

本文档基于对 Claude CLI 完整功能集的分析，识别出适合 Polaris 可视化支持的功能缺口，并制定了分阶段的实现路线图。

### 分析方法

1. 执行 `claude --help` 及所有子命令帮助
2. 测试各命令的实际输出格式
3. 分析 Polaris 现有功能实现
4. 识别功能缺口和可视化机会
5. 评估优先级和实现复杂度

---

## 二、功能优先级矩阵

```
                    用户价值
              低                      高
        ┌─────────────────┬─────────────────┐
   低   │ Auto-mode 规则  │ Agent 选择器    │
   实    │ Hook 配置      │ 模型配置        │
   现    ├─────────────────┼─────────────────┤
   复    │ Worktree 管理   │ Plugin 管理     │
   杂    │ 认证管理 UI     │ MCP 可视化配置  │
   度    │                 │ 费用追踪        │
   高    │                 │                 │
        └─────────────────┴─────────────────┘
```

---

## 三、分阶段路线图

### Phase 1: 核心功能补全（预计 3-4 周）

**目标**：补全最重要的 CLI 功能可视化

| 功能 | 优先级 | 预计工时 | 文档 |
|------|--------|---------|------|
| Plugin 管理面板 | P0 | 5-7 天 | [plugin-management-spec.md](./plugin-management-spec.md) |
| MCP 可视化配置 | P0 | 5-7 天 | [mcp-configuration-spec.md](./mcp-configuration-spec.md) |
| Agent 选择器 | P1 | 3-4 天 | [agent-selector-spec.md](./agent-selector-spec.md) |

**里程碑**：
- 用户无需命令行即可管理插件
- 用户无需编辑 JSON 即可配置 MCP
- 用户可以为不同任务选择合适的 Agent

### Phase 2: 体验优化（预计 2 周）

**目标**：提升日常使用体验

| 功能 | 优先级 | 预计工时 | 文档 |
|------|--------|---------|------|
| 模型配置 | P1 | 2-3 天 | [model-configuration-spec.md](./model-configuration-spec.md) |
| 费用追踪 | P1 | 4-5 天 | [cost-tracking-spec.md](./cost-tracking-spec.md) |

**里程碑**：
- 用户可以灵活选择模型和努力级别
- 用户可以实时了解 API 成本

### Phase 3: 高级功能（预计 2 周）

**目标**：扩展高级用户功能

| 功能 | 优先级 | 预计工时 | 说明 |
|------|--------|---------|------|
| 认证管理 UI | P2 | 2-3 天 | 登录/登出/状态显示 |
| Worktree 集成 | P2 | 3-4 天 | 可视化 Worktree 管理 |
| 工具权限配置 | P2 | 2-3 天 | 工具白名单/黑名单 |

### Phase 4: 可选增强（按需实现）

| 功能 | 优先级 | 预计工时 | 说明 |
|------|--------|---------|------|
| Auto-mode 规则编辑 | P3 | 5-7 天 | 自定义安全规则 |
| Hook 配置 | P3 | 3-4 天 | 生命周期钩子 |
| 会话 Fork | P3 | 2 天 | 从历史创建分支 |
| 会话导出/导入 | P3 | 2-3 天 | 会话迁移 |

---

## 四、架构影响

### 4.1 后端新增模块

```
src-tauri/src/
├── commands/
│   ├── plugin.rs      # Plugin 管理命令
│   ├── mcp.rs         # MCP 配置命令
│   ├── agent.rs       # Agent 相关命令
│   ├── model.rs       # 模型配置命令
│   └── cost.rs        # 费用追踪命令
├── services/
│   ├── plugin_service.rs
│   ├── mcp_cli_service.rs
│   └── cost_service.rs
└── models/
    ├── plugin.rs
    ├── mcp.rs
    ├── agent.rs
    └── cost.rs
```

### 4.2 前端新增组件

```
src/
├── components/
│   ├── Settings/
│   │   ├── PluginSettingsTab.tsx
│   │   ├── McpSettingsTab.tsx
│   │   ├── ModelSettingsTab.tsx
│   │   └── BudgetSettingsTab.tsx
│   ├── Chat/
│   │   ├── AgentSelector.tsx
│   │   ├── ModelSelector.tsx
│   │   ├── EffortSelector.tsx
│   │   └── CostDisplay.tsx
│   └── Cost/
│       ├── CostStatsPanel.tsx
│       ├── CostChart.tsx
│       └── BudgetWarning.tsx
├── stores/
│   ├── pluginStore.ts
│   ├── mcpStore.ts
│   ├── agentStore.ts
│   ├── modelStore.ts
│   └── costStore.ts
└── services/
    ├── pluginService.ts
    ├── mcpService.ts
    ├── agentService.ts
    ├── modelService.ts
    └── costService.ts
```

### 4.3 配置文件变更

```typescript
// src/stores/configStore.ts

interface Config {
  // ... 现有字段

  // 新增
  customAgents?: CustomAgentConfig[];
  modelConfig?: ModelConfig;
  budgetConfig?: BudgetConfig;
}
```

---

## 五、依赖关系

```
                    Plugin 管理
                        │
                        ▼
MCP 可视化配置 ◄────────┼────────► Agent 选择器
                        │              │
                        ▼              ▼
                    模型配置 ◄────────┘
                        │
                        ▼
                    费用追踪
```

- Plugin 管理独立实现，无依赖
- MCP 配置可以引用 Plugin 提供的 MCP
- Agent 选择器可以参考已安装 Plugin 的 Agent
- 模型配置影响费用计算
- 费用追踪依赖模型配置和对话事件

---

## 六、技术风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| CLI 输出格式变化 | 高 | 中 | 版本检测 + 灵活解析 + 降级处理 |
| CLI 版本兼容性 | 中 | 高 | 最低版本要求 + 功能降级 |
| 新功能破坏现有架构 | 低 | 高 | 代码审查 + 集成测试 |
| 性能影响 | 中 | 中 | 异步处理 + 懒加载 |

---

## 七、验收标准

### Phase 1 验收

- [ ] Plugin 管理面板可正常列出/安装/启用/禁用/更新/卸载插件
- [ ] MCP 配置面板可正常添加/编辑/删除 MCP 服务器
- [ ] Agent 选择器可正常选择并生效

### Phase 2 验收

- [ ] 模型选择器可正常切换模型和努力级别
- [ ] 费用追踪可正确记录和显示费用
- [ ] 预算警告可正常触发

### Phase 3 验收

- [ ] 认证管理可正常登录/登出
- [ ] Worktree 管理可正常创建/删除/切换
- [ ] 工具权限配置可正常生效

---

## 八、文档索引

| 文档 | 内容 |
|------|------|
| [claude-cli-analysis-report.md](./claude-cli-analysis-report.md) | CLI 功能完整分析 |
| [plugin-management-spec.md](./plugin-management-spec.md) | Plugin 管理详细规划 |
| [mcp-configuration-spec.md](./mcp-configuration-spec.md) | MCP 可视化配置详细规划 |
| [agent-selector-spec.md](./agent-selector-spec.md) | Agent 选择器详细规划 |
| [model-configuration-spec.md](./model-configuration-spec.md) | 模型配置详细规划 |
| [cost-tracking-spec.md](./cost-tracking-spec.md) | 费用追踪详细规划 |

---

## 九、下一步行动

1. **评审本路线图**：确认优先级和工时估算
2. **Phase 1 启动**：从 Plugin 管理开始实现
3. **持续迭代**：每个功能完成后进行评审和调整

---

*文档版本：1.0.0*
*最后更新：2026-04-14*
