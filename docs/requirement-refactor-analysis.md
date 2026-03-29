# 需求库重构方案分析

> **状态**：已实现（方案一）

## 1. 当前实现

### 1.1 存储位置（已更新）

```
{config_dir}/requirements/
├── requirements.json    # 所有需求
├── workspaces.json      # 已注册工作区
└── prototypes/          # 原型 HTML 文件
    └── {id}.html
```

### 1.2 代码结构（已更新）

| 文件 | 说明 |
|------|------|
| `models/requirement.rs` | 数据模型（含 workspacePath/workspaceName） |
| `services/unified_requirement_repository.rs` | 单仓库实现 |
| `services/requirements_mcp_server.rs` | MCP 服务（支持 config_dir + workspace_path） |
| `commands/requirement.rs` | Tauri 命令层（新增） |
| `services/requirementService.ts` | 前端服务（使用 Tauri 命令） |
| `types/requirement.ts` | 前端类型定义 |

## 2. 实现内容

### 2.1 后端改动

| 文件 | 操作 |
|------|------|
| `models/requirement.rs` | 添加 `workspacePath`/`workspaceName` 字段、`QueryScope` 枚举 |
| `services/requirement_repository.rs` | 删除 |
| `services/unified_requirement_repository.rs` | 新建（单仓库） |
| `services/requirements_mcp_server.rs` | 更新，支持 scope 参数 |
| `commands/requirement.rs` | 新建（Tauri 命令层） |
| `bin/polaris_requirements_mcp.rs` | 更新，支持 config_dir 参数 |

### 2.2 前端改动

| 文件 | 操作 |
|------|------|
| `types/requirement.ts` | 添加 `workspacePath`/`workspaceName` 字段 |
| `services/requirementService.ts` | 改用 Tauri 命令 |

### 2.3 代码量变化

```
12 files changed, 1569 insertions(+), 795 deletions(-)
```

## 3. 新增 Tauri 命令

| 命令 | 说明 |
|------|------|
| `list_requirements` | 列出需求，支持 scope/status/priority/limit |
| `create_requirement` | 创建需求，自动关联工作区 |
| `update_requirement` | 更新需求 |
| `delete_requirement` | 删除需求 |
| `save_requirement_prototype` | 保存原型 HTML |
| `read_requirement_prototype` | 读取原型 HTML |
| `get_requirement_workspace_breakdown` | 获取工作区分布统计 |

## 4. 提交记录

```
ec36916 refactor(requirement): simplify to single global storage
914016b docs(requirement): add refactor analysis document
```

## 5. 注意事项

1. **原型路径变化**：原型文件现在存储在全局配置目录
2. **MCP 配置更新**：需要更新 MCP 配置以传递 config_dir 参数
3. **数据迁移**：旧工作区的需求数据需要手动迁移
