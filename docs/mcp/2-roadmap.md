# 2. 后续阶段计划

## 阶段 4：后端插件 MCP contribution registry

状态：已完成。后端已有 `PluginMcpServerContribution`、`McpServerContributionRegistry` 和 `McpServerArgsMode`，当前内置 MCP server 已迁移为 registry 初始化内容。

目标：把 `mcp_config_service.rs` 中的内置 MCP server 定义表继续抽象为 registry，使后端能接收“插件贡献的 MCP server 定义”。

建议实现：

- 新增 Rust 侧插件 MCP contribution 类型：
  - server name
  - transport
  - command/bin name
  - bundled path / fallback path / dev path
  - env override
  - args template 或 args mode
  - required/optional

- 将当前内置定义表迁移到 registry 初始化。
- `WorkspaceMcpConfigService` 从 registry 读取定义并生成 Claude/Codex 配置。
- 保持 Todo、Requirements、Scheduler 当前行为不变。
- 增加测试覆盖：
  - Todo required，缺失时报错。
  - optional server 缺失时跳过。
  - disabled server 不进入 Claude/Codex 配置。
  - args mode 正确生成 `config_dir + workspace_path`。

## 阶段 5：前后端插件 manifest 对齐

状态：已完成第一步。当前已有 `docs/mcp/4-manifest-schema.md` 固化内置 manifest schema，前端测试校验 `polaris.todo` manifest 声明，后端 Rust mirror 校验 `polaris.todo` 的 `polaris-todo` server 已注册到 MCP contribution registry。

目标：避免前端 Todo manifest 和后端 MCP 定义各自维护，降低 server id/name 漂移风险。

建议方向：

- 定义共享的插件 manifest schema 文档。
- 前端继续使用 TS manifest，后端使用 Rust manifest mirror 或 JSON manifest。
- 增加一致性检查：
  - `polaris.todo` 前端声明的 `polaris-todo` 必须存在于后端 registry。
  - 后端 registry 的内置 plugin id 必须能在前端插件 registry 中找到。

后续可选增强：

- 引入 JSON schema 或生成式 manifest，减少 TypeScript/Rust mirror 的重复字段。
- 将更多内置插件拆分为独立 manifest 后，扩展内置对齐表与测试覆盖。

## 阶段 6：插件安装与发现流程

目标：从“内置插件”扩展到“可安装插件”。

建议方向：

- 插件目录约定：
  - `.codex-plugin/plugin.json` 或 Polaris 自有 `plugin.json`
  - `ui/`
  - `mcp/`
  - `permissions`
  - `assets`

- 后端扫描插件目录，返回已安装插件清单。
- 前端 registry 支持从后端加载动态插件 metadata。
- 设置页区分：
  - 内置插件
  - 用户安装插件
  - 项目插件

## 阶段 7：权限与安全边界

目标：插件声明的权限真正参与运行时限制。

建议方向：

- 将当前 manifest permissions 从展示信息升级为执行约束。
- MCP server 启动前校验权限：
  - workspace read/write
  - app config read/write
  - network
  - AI tool access

- 设置页支持用户确认高风险权限。
- 后端保存用户授权结果。

## 阶段 8：可视化模块动态化

目标：让插件能贡献可视化模块，不局限于当前内置 React panel。

建议方向：

- 先支持“内置组件注册”：manifest 的 `panelType` 映射到已有 React 组件。
- 再考虑动态 UI：
  - iframe sandbox
  - web component
  - remote bundle

- 短期不建议直接允许插件执行任意前端代码，先把 Todo 这类内置模块跑顺。

## 阶段 9：插件开发者体验

目标：提供可复制的插件开发模板。

建议方向：

- `docs/mcp` 增加插件开发指南。
- 提供 Todo 插件作为参考实现。
- 增加 manifest schema 示例。
- 增加 MCP server template。
- 增加验证命令：
  - manifest schema check
  - MCP binary resolution check
  - permissions check
