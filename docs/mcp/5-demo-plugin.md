# 5. 外部 Demo MCP 插件

## 目标

提供一个非内置插件样例，用来验证 Polaris 当前已经支持的本地插件安装、发现、展示、状态控制和卸载闭环。

样例目录：

```text
examples/plugins/demo-mcp-plugin/
  plugin.json
  README.md
  mcp/
    demo-mcp-server.js
```

## 安装验证

1. 打开设置页 Plugins 标签。
2. 选择 User 或 Project 安装范围。
3. 点击 Install from directory。
4. 选择 `examples/plugins/demo-mcp-plugin`。
5. 安装成功后刷新已安装插件。

预期结果：

- 插件列表出现 `example.demo-mcp`。
- 插件来源显示为用户安装或项目插件。
- 插件安装路径可见。
- 插件来源链接显示 demo 的 repository/homepage 元数据。
- ActivityBar 出现 `Demo MCP` 入口。
- 点击入口后左侧面板显示 demo 插件可视化面板。
- 面板内 Echo 功能可本地回显输入文本。
- 面板内 MCP Test 可把 `example-demo-mcp` 的测试提示发送到聊天。
- MCP surface 显示 1 个 server：`example-demo-mcp`。
- 权限显示 `workspaceRead` 和 `aiToolAccess`。
- 插件启用、MCP 启用状态可以切换并持久化。
- 点击卸载后，刷新列表不再残留该插件。

## 当前边界

该 demo 不是内置插件，不会写入 `src/plugin-system/builtinPlugins.ts`。

当前 Polaris 会发现外部插件 manifest 中的 MCP contribution，并在会话启动前把启用的外部 stdio MCP server 注入 Claude/Codex 运行时配置。`mcp/demo-mcp-server.js` 是一个最小 MCP server 样例，用于验证该运行时接入链路。

当前第一版运行时接入边界：

- 外部 demo 插件通过 manifest 贡献 ActivityBar 入口，但 React 面板由 Polaris 受控宿主 `demoPlugin` 提供，不执行插件目录里的前端代码。
- 仅支持 `stdio` transport。
- 支持 `{{pluginDir}}`、`{{workspacePath}}`、`{{appConfigDir}}` 占位符。
- 外部 server name 与内置 server 冲突时跳过外部 server。
- 插件状态关闭或 MCP surface 关闭时不会注入运行时配置。
- 已提供 `origin.updateUrl` 驱动的更新检查入口；demo 样例未声明可用更新源。
- 尚未实现远程来源安装、依赖安装、自动更新覆盖安装和权限确认 UX。
