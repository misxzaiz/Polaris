# 移动端链接点击统一外投（防应用内跳转丢失状态）—— 设计 spec

> 关联根因分析见对话记录；本文档是方案 B 的可执行细化。
> **状态：Draft（2026-10-27）→ 待评审/实施**
> 目标：移动端 Android APK 点击「新窗口/外链」不再把整个 SPA 顶掉；链接交给**系统浏览器**打开，返回键始终回到应用当前页。桌面端行为**零变更**。

## 一、问题与根因链（实证）

- 移动端是 wry 0.57 单 Activity + 单 WebView（`src/mobile/platform.ts` 判定入口 + `MainActivity` 裸 `TauriActivity`）。
- wry Android 生成的 `RustWebChromeClient.kt` **未 override `onCreateWindow`**（源码实证，519 行无此方法）→ `window.open()` 返回 null；`<a target="_blank">` 点击被**降级为当前 WebView 同页导航**。
- 前端大量使用 `target="_blank"` / `window.open('_blank')`（全代码 18 处，两个 markdown 权威出口）——设计意图是「开新标签不打断当前页」，在移动端全部落空。
- 单 WebView 整体导航到外站 → React SPA JS 上下文卸载；按返回键回到的是**最后一次整页 HTTP 加载**（App 冷启动），表现为「刷新/丢状态」。

## 二、设计总纲

**核心**：移动端（`isMobileTauriRuntime()`）对一切「外部/新窗口」链接统一 `preventDefault` → `openExternalLink()`（opener 插件 → 系统浏览器，失败兜底 `window.open`）。桌面端/纯浏览器不注册、不拦截，行为原样。

**为什么走系统浏览器而非内置浏览器**：移动端 `currentMode==='http'`，`invoke('browser_*')` 经 HTTP transport 转发到**远程桌面后端**，内置浏览器本质是远程桌面 WebView 的投影，不落在手机屏幕；系统浏览器（opener）是本机可用的最自然路径。已确认 `tauri_plugin_opener` 在 `tauri-app` feature 内、`lib.rs:565` 已注册，移动端 APK 制造时可用。

## 三、改动范围

| 文件 | 改动 | 类型 |
|---|---|---|
| `src/services/linkExternal.ts` | 新增：`shouldOpenExternal` / `openExternalLink` / `registerExternalLinkGlobalHandler`（document capture click） | 新增 |
| `src/utils/cache.ts` | `linkRenderer.link`：移动端给 `<a>` 加 `data-open-external` 标记 | 改 |
| `src/utils/lightweightMarkdown.tsx` | 行内 link 分支并列加 `data-open-external` 标记 | 改 |
| `src/components/Common/ExternalLink.tsx` | 新增：统一外部链接组件（平台分派，桌面透传 `target="_blank"`） | 新增 |
| `src/main.tsx` | 移动端分支注册 `registerExternalLinkGlobalHandler`（一次，常驻） | 改 |
| §五清单中手写 `<a target="_blank">` | 移动端 branch 换用 `ExternalLink` / `openExternalLink` | 改（逐批） |
| `plans/mobile-external-link-handling.md` | 本文档 | 新增 |

**不触碰**：`src-tauri/gen/android`（生成物，方案 A 另立）、内置浏览器面板自身导航、后端命令、协议、store。

## 四、核心实现细节

### 4.1 `linkExternal.ts` 职责

```ts
export function shouldOpenExternal(href: string | undefined | null): boolean
// 返回 true 判定：
//  http: / https: / mailto: / tel:  —— 显式外链协议
// 返回 false（保持应用内）：
//  空值、相对路径、`#/...` 路由、`/api/` 静态资源、`/`、`file:` 等本地
//
// 应用路由则一律不拦截。白名单协议 + 非应用路由双条件，降低误伤。

export function openExternalLink(href: string): void
// 移动端：openInBrowser(href)（opener→系统浏览器；失败兜底 window.open）
// 桌面/web：不在此函数处理（外部侧直接 target="_blank"）

export function registerExternalLinkGlobalHandler(): () => void
// document.addEventListener('click', capture, true)
// 命中 closest('a[target="_blank"], a[data-open-external]') + shouldOpenExternal
// → preventDefault + stopPropagation + openExternalLink
// 返回取消函数。仅在移动端注册。
```

### 4.2 `cache.ts` linkRenderer

移动端时输出 `<a href="..." target="_blank" rel="noopener noreferrer" data-open-external="1">`；桌面端保持现状（不加属性）。`isTauriRuntime()` 已存在于该文件，扩展为按平台判定。

### 4.3 全局兜底（覆盖 `dangerouslySetInnerHTML` + 第三方顺手加入的链接）

只靠 renderer 加属性不够——`dangerouslySetInnerHTML` 注入的旧缓存 HTML、外部插件卡片的 HTML 不经过本项目 renderer。`registerExternalLinkGlobalHandler` 的 capture 监听兜住这些：凡是 `target="_blank"` 或带 `data-open-external` 的 `<a>` 且协议命中 → 拦截外投。

### 4.4 `ExternalLink` 组件（手写链接收敛载体）

桌面：渲染 `<a href target="_blank" rel="noopener noreferrer">{children}</a>`（原样）。
移动端：`onClick={(e)=>{ e.preventDefault(); e.stopPropagation(); openExternalLink(href); }}`。

## 五、手写 `<a target="_blank">` 清单（逐批改造）

| 组 | 位置 | 处理 |
|---|---|---|
| 聊天内容 | `ArtifactPreviewRenderer.tsx`（HTML 预览 blob：196 新窗、553 打开）、`UiFrameCard.tsx`（图表新窗 459）、`AgnesMediaCard.tsx`（69/123/183） | 换 `ExternalLink` / 移动端 `openInBrowser` |
| 个人中心 | `PersonalHub/LinkCard.tsx(85)`、`LinkDetailDialog.tsx(48,125)`、`SetupGuide.tsx(139)` | 换 `ExternalLink` |
| 设置 | `AppUpdateTab.tsx(237,247)`、`PluginTab.tsx(engine installUrl)`、`EngineExpandDetail(187)` | 换 `ExternalLink` |
| Git/文件 | `GitPanel/RemoteTab.tsx(166)`、`FileExplorer/SearchResultsList.tsx(200)`、`FileTreeNode.tsx(374)` | 语义是「浏览器打开/建仓远程页」→ `openInBrowser`（文件系统预览仍走 `openInDefaultApp`，不改） |
| 通用搜索/工具 | `SelectionContextMenu.tsx(184,187)` 翻译搜索、`BrowserPanel.tsx(965,1624)` 地址栏外部打开 | 换 `openInBrowser` |

> 注意 `ArtifactPreviewRenderer`/`UiFrameCard`/`Agnes` 的 `window.open(blobUrl)`——blob URL 协议不在 http/https 白名单，`shouldOpenExternal` 对其返回 false，需在**这些特定入口**显式调 `openInBrowser`（父链不匹配 hook 时由组件自己的 open 分支负责），不能依赖全局捕获拦 blob。

## 六、平台行为矩阵

| 环境 | 点击 `target="_blank"` / 外链 |
|---|---|
| 移动端 APK | `preventDefault` + 系统浏览器（opener）；失败兜底 window.open |
| 移动端纯浏览器（无 `__TAURI_INTERNALS__`） | 不拦截（opener 不可用），浏览器自带 tab |
| 桌面端 Tauri / 纯浏览器 | 不拦截，原 `target="_blank"` 新窗口 |

## 七、验收清单

1. 移动端真机/模拟器：聊天中 AI 产出 markdown 外链 → 点开系统浏览器，返回 App 停在**原消息位置**（滚动、输入不丢）。
2. HTML 图表「新窗口查看」→ 系统浏览器；blob 打开正常（不走全局捕获、由组件 open 分支调 opener）。
3. 应用内路由链接（`#/chat/...`、相对路径）→ 仍在应用内跳转，不被误拦截。
4. 桌面端回归：聊天内链/外链、`target="_blank"` 新标签行为与改动前一致。
5. 全局 handler 退出时 removeEventListener（移动端 HMR/重挂不泄漏）。

### 单测
- `linkExternal.test.ts`：`shouldOpenExternal` 对 http/https/mailto/tel/应用路由/相对路径/`/api/`的判定；`openExternalLink` 移动端走 `openInBrowser`。
- `ExternalLink.test.tsx`：移动端点击触发 `openExternalLink`；桌面透传 `<a target="_blank">`。
- 全局捕获逻辑抽纯函数供测试：命中/不命中分支。
- `cache.test.ts`：renderer 移动端输出 `data-open-external`，桌面不输出。

## 八、风险与回滚

- **误拦截**：白名单协议 + 非应用路由双条件；若个别应用内链被误伤，加 `data-keep-in-app` 属性显式跳过。
- **opener 失效兜底**：`openExternalLink` fallback `window.open`（仍可能同页降级，可接受）。
- **回滚**：单文件 revert，增量改动，桌面端零影响。
- **生成物零改动**：`tauri android build` 可任意重跑，不涉及 Kotlin。

## 九、后续可选（不在本版）

- 方案 A：Kotlin `onCreateWindow` → 系统浏览器，需将 `gen/android` 改动沉淀为构建 hook；可与本版叠加（兜住本版捕获不到的窗口 open）。
- 移动端将来启用本机 WebView 承载内置浏览器时，`openExternalLink` 可加分支出内置浏览器通道。

## 十、实施顺序建议

1. `linkExternal.ts` + 单测（纯逻辑先行，可独立验证）
2. `cache.ts` / `lightweightMarkdown.tsx` 出口标记 + `cache.test.ts` 断言
3. `main.tsx` 注册全局 handler + 单测
4. `ExternalLink` 组件 + 逐批替换 §五清单（按「聊天内容→设置→Git/文件→通用」顺序）
5. 真机验收（§七）