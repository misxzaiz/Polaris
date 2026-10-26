# 移除状态栏「后台任务中心」与「HTML 卡片」入口

- 日期：2026-10-25
- 状态：已实施
- 变更类型：UI 收敛（只删入口，不动底层能力）

## 目标

用户希望从 AI 对话输入框状态栏移除两个元素：

1. **后台任务中心**（火箭图标按钮 + 弹出面板）——入口
2. **HTML 卡片**（Layout 图标 toggle 按钮）——会话开关入口

## 移除范围与保留边界

| 项 | 处置 | 理由 |
|---|---|---|
| `DispatchCenterButton`（`src/components/Chat/dispatch/DispatchCenter.tsx`） | **整体删除** | 状态栏唯一入口，无其它挂载点 |
| `App.tsx` 中 `<DispatchCenterButton />` 挂载 | 删除 | |
| `components/Chat/index.ts` 的导出 | 删除 | 无外部使用 |
| `SessionConfigSelector.tsx` 中 HTML 卡片 toggle（Layout 图标按钮） | **只删按钮** | 仅 UI 入口 |
| `htmlCardRender` 配置字段 / `eventHandler.ts` 卡片检测逻辑 / `sessionConfigStore.setHtmlCardRender` | **保留** | 默认为关；删除字段需动协议与持久化清洗，超出本次 UI 诉求；保留可在未来需要时恢复入口 |
| 派发子系统（`dispatchStore` / `dispatchTaskService` / `DispatchTaskCard` / `AgentGalleryPanel` 派发按钮） | **保留** | 独立子系统，不依赖状态栏入口（/dispatch 命令仍在） |
| i18n key：`dispatch.centerTooltip/centerTitle/centerCount/centerEmpty`、`sessionConfig.htmlCard/htmlCardOn/htmlCardOff` | 删除 | zh-CN 与 en-US 同步 |

## 验收

- 状态栏不再出现火箭按钮与 HTML 卡片按钮；`/dispatch` 与消息内派发卡片不受影响
- `pnpm exec tsc --noEmit` 通过
- 相关 vitest（`sessionConfigStore.test.ts` 已覆盖 htmlCardRender 持久化，保留不改）

## 影响面

- 仅前端组件层；无后端 / cap 契约 / 协议改动