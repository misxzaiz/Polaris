# Hello Panel — Polaris 插件示例

> 这是 Polaris **Plugin Runtime API v0.1** 的最小验证用例。

## 用途

演示一个真正的"前端 React 组件 + IPC 调用"插件应该长什么样：

1. **接收宿主能力**：`api: PolarisPluginApi` 作为 props 注入
2. **复用宿主单例**：`api.react`, `api.i18n`, `api.stores.workspace` —— **不要**自带 React/i18n
3. **使用宿主 UI 原语**：`api.ui.ConfirmDialog`, `api.ui.CodeMirrorEditor` ...
4. **受控 IPC**：`api.transport.invoke(cmd, args)`，命令名必须在 `plugin.json` 的 `permissions.ipc` 白名单内

## 文件清单

| 文件 | 作用 |
|---|---|
| `plugin.json` | manifest，声明 view 贡献 + IPC 权限 |
| `src/index.tsx` | 入口；default export 一个 React 组件 |

## 加载方式（Phase 2 完成后）

宿主侧通过 `loadPluginPanel({ pluginId, entryUrl })` 动态 import。

- `entryUrl` 在生产环境是 `convertFileSrc(${pluginDir}/dist/index.js)`
- 测试环境可用 inline `data:text/javascript,...`

完整的 panel 渲染接入（让 `<HelloPanel api={...}/>` 真的显示在 Activity Bar）是 **Phase 3** 的任务，需要让 `App.tsx` 支持"动态 panel 容器"。当前这个示例仅作**契约源代码**和类型校验用，未配置 Vite 构建。

## 关键约束

- 插件构建配置必须把 `react`, `react-dom`, `zustand`, `i18next`, `@codemirror/*` 列为 `external`
- 默认 `permissions.ipc: []` 等价于 **deny-all**，必须显式列出每个允许调用的命令
- API 版本 `^0.1.0` 表示插件依赖 `>=0.1.0 <0.2.0` 的宿主能力
