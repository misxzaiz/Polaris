# HTML 卡片渲染 · 手机浏览器端适配 — 需求开发文档（Spec）

> 四段式：目标 / 现状（已调查）/ 契约 / 验收与不做。
> 关联实现 spec：`plans/html-output-card-render-spec.md`（卡片检测/渲染/消息层契约）。
> 关联需求：`plans/radio-broadcast-infinite-listening-prd.html`。
> 本次范围：**手机浏览器端**（含 iOS Safari）对 HTML 卡片的适配，不改变桌面端行为，不改卡片检测/提取逻辑。

---

## 一、目标

HTML 卡片在**手机浏览器**（375px 宽视口，iOS Safari / Android Chrome）下：

1. 头部信息可读——标题/描述/元信息不因 5 个操作按钮挤压而严重截断；
2. iframe 高度不再写死 420px，按容器宽度自适应（窄屏用接近满宽的 16:9，桌面维持 420px）；
3. 「全屏预览」在 iOS Safari 可用——降级为应用内伪全屏弹层（`fixed inset-0` + 100dvh），而非依赖 `requestFullscreen()`（iOS 对非 video 元素不支持）；
4. 底部输入区不被 iOS home indicator 遮挡（safe-area padding）；
5. 手机浏览器访问链路已成立（二维码 `?token=` 进入），本次不做访问/鉴权改动。

**北极星验收一句话**：手机上「AI 输出完整 HTML → 卡片可读、可交互、可全屏，底部不被遮挡」。

---

## 二、现状（已双线调查确认）

### 2.1 访问链路（已成立，不做改动）
- vite `server.host: true`（`vite.config.ts:77-80`）→ 手机可访问 9827，`/api` 代理到本机 9829。
- 后端 Web server 默认 `0.0.0.0`（`src-tauri/src/models/config.rs:1178`），端口 `POLARIS_WEB_PORT` 覆盖（`server.rs:144-150`）。
- 鉴权：HTTP `Authorization: Bearer <md5>`、WS `?token=<md5>`、图片 `?token=`（`middleware.rs:100-137`）；dev token `98279829++`。
- cap.mcp 对**带有效 token 的 `Source::Remote` 放行**（`router/mcp_capability.rs:252-263`），跨设备 HTTP 可调。
- 手机浏览器与 APK 共享同一套 `src/`（`src/mobile/platform.ts:4-6`、`build-dist.mjs`），`MobileConnectionGate` 只挂 APK 分支。
- 入口：桌面 WebTab 二维码带 `?token=`（`WebTab.tsx:94-102`）。

### 2.2 卡片渲染现状缺口（本次修复对象）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| 1 | iOS 全屏失效 | `ArtifactPreviewRenderer.tsx:119` Web 分支 `document.documentElement.requestFullscreen()`；iOS Safari 对非 video 元素不支持 → reject 被 `catch` 静默吞（`:122-124`） | iPhone 上「全屏预览」完全不可用 |
| 2 | iframe 高度写死 420px | `:284` `h-[420px] min-h-[320px]` | 667px 高手机屏，一张卡占大半屏 |
| 3 | 头部窄屏截断 | `:189-280` 5 按钮 ~140px 固定 + 28px 图标；标题区 `min-w-0 flex-1` 但内层元信息多 span `shrink-0` | 375px 下标题/描述/大小/日期/路径严重截断或不可读 |

### 2.3 全局移动端现状
- viewport 已含 `viewport-fit=cover`（`index.html:6`），但**全项目无 `env(safe-area-inset-*)` padding 补偿**——iPhone 底部 home indicator 可能遮挡 ChatInput。
- 主容器已用 `100dvh` 兜底（`Layout.tsx:41`），消息流无 min-width、`.chat-prose` 已去 max-width（`index.css:518-519`）——基础自适应良好。
- 已有 `useContainerWidth` hook（`src/hooks/useContainerWidth.ts`，ResizeObserver）可复用做窄屏判定。

---

## 三、契约（落地到 ArtifactPreviewRenderer + ChatInput）

### 3.1 头部窄屏布局（`ArtifactPreviewRenderer.tsx`）
- 复用 `useContainerWidth` 测量卡片容器宽度，`narrow = width < 560`。
- **narrow 模式**：头部操作按钮收进标题旁（或保留 5 按钮但压缩为 `h-6 w-6` 小尺寸），元信息（大小/日期/路径/requirementId）在窄屏**换行到第二行**而非强行 truncate——保证标题一行完整可读、描述 truncate。
- 判定阈值 560 与 `ChatStatusBar` 的 `narrow:420` 对齐项目已有分级习惯。

### 3.2 iframe 高度自适应
- 用容器宽度算高：`height = clamp(240, width * 9 / 16, 420)`（16:9 上限 420、下限 240）。
- 桌面宽屏仍得 420，375px 屏约 210→240（保底），手机屏占比显著下降。
- 保持 `min-h-[320px]` 语义改为 `min-h-[240px]`，`max-h-[420px]`。

### 3.3 iOS 全屏降级（关键）
- Web 分支不再只依赖 `document.documentElement.requestFullscreen()`。
- 新增**应用内伪全屏**：`fixed inset-x-0 bottom-0 top-[40px] z-overlay`（保留顶部 TopMenuBar）+ iframe `flex-1`（复用现有全屏 Portal 结构 `:303-337`）。
- 进入策略：
  1. Tauri → `tauriSetFullscreen(true)`（不变）；
  2. Web 且 `requestFullscreen` 可用（非 iOS / Android Chrome 支持）→ 原生全屏（不变）；
  3. Web 且原生失败（iOS Safari）→ **自动降级伪全屏**，`setIsFullscreen(true)` 仍成立、Esc 兜底逻辑保留。
- 伪全屏状态与现有 `isFullscreen` 状态合并，退出按钮/ Esc 行为一致。

### 3.4 safe-area（`ChatInput.tsx` + 消息区底部）
- ChatInput 根容器加 `pb-[env(safe-area-inset-bottom)]`（浏览器无 safe-area 时为 0，天然无副作用）。
- 消息流底部预留一致的安全区（可视需要，最小改动：只在 ChatInput 加）。
- 桌面端 `env()` 无定义 → 计算为 0，**桌面行为零变化**。

### 3.5 不改动
- 卡片检测/提取逻辑（`htmlCardDetect`、`session_end` 挂点）**不动**。
- 桌面端 Artifact 头部 5 按钮布局、420px 高度**不动**（`narrow` 判定 ≥560 宽不触发）。
- 手机访问/鉴权/二维码链路不动。

---

## 四、验收标准

### 4.1 必过（窄屏 375px，可用 DevTools 设备模拟）
1. 头部标题完整可读（不横向溢出、不截断到不可读），描述 truncate、元信息不丢。
2. iframe 高度 ≈ 容器宽 × 9/16，明显小于 420px。
3. 点「全屏预览」：
   - iOS 模拟（无 requestFullscreen）→ 进入伪全屏，内容铺满、可退出；
   - 桌面 → 仍走原生全屏（无回归）。
4. 底部输入区在 `viewport-fit=cover` + safe-area 模拟下不被遮挡（padding 生效）。

### 4.2 回归（桌面 1280+）
5. 头部仍 5 按钮一行、标题完整、高度仍 420px——`narrow` 未触发，行为零变化。

### 4.3 卡片功能回归
6. 卡片内交互、复制/源码/下载、新标签页——不因本次改动受影响。

---

## 五、不做（边界）
- 不做独立移动版页面/路由（手机浏览器就是同一 SPA）。
- 不做 requestFullscreen 的通用 polyfill（iOS 无标准实现，伪全屏是唯一可靠路径）。
- 不改卡片检测/消息层协议。
- 不做手机端二维码访问链路的改造。
- 不引入 CSS Media Query 布局层（沿用现有 JS 宽度阈值体系）。
