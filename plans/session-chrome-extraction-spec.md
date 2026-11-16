# K-F2 会话 chrome 出仓 spec（Session/QuickSwitchPanel → chat-desk）

> 日期：2026-11-16 · 状态：实施中
> 上位：plans/host-kernel-roadmap.md K-F2 波次
> 归属决策：会话操作 UI（会话新建/切换/续接/跨端面板）与 chat-desk 同域，迁入 chat-desk 插件（不新建第三个插件），复用其 cap.session/cap.ai.chat 通道与已验证的 deps 代理模式。

## 迁移清单（~5.3k 行）
- src/components/Session/**（2662）：NewSessionPanel/CreateSessionModal/SessionConfigSelector/RemoteSessionsPanel/WorkspaceMenu/WorkspaceBadge/StatusDot 等
- src/components/QuickSwitchPanel/**（1336）
- src/services/remoteSessionFollower.ts（683）
- src/services/sessionBus.ts（144）
- src/services/chatExport.ts（186）
- src/services/sessionHandoff.ts（62）
- src/stores/sessionDirectoryStore.ts（221）

## 宿主保留与改造
- NotificationCenterPanel（通知中心）留宿主：sessionDirectory 依赖改为经 __POLARIS_APP_CORE__.stores.sessionDirectoryStore 读 chat-desk 回挂的同一 store（chat-desk 挂载时回挂）
- App.tsx：QuickSwitchPanel/Session 相关引用改为经插件（QuickSwitchPanel 由 chat-desk 面板内渲染；SessionConfigSelector/NewSessionPanel/CreateSessionModal 已在 chat-desk 有同源副本，宿主删源码）
- sessionDirectoryStore 回挂：chat-desk 挂载时 window.__POLARIS_APP_CORE__.stores.sessionDirectoryStore = 同一实例

## 门禁
tsc / vitest 全绿 / lint 不新增 error / cargo check + web-only / grep 断言主仓 0 命中 / 真机：快速切换面板、新建会话、跨端面板、通知中心会话状态、chat-desk 对话不回归。
