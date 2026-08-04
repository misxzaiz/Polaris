# 全局聚焦功能 10 轮研究日志

> 目标：设计"跟随鼠标聚焦部分内容、避免干扰"的全局聚焦功能，支持多种方式，
> 经 10 轮研究检查分析后确定实施方案并落地。
> 已提供三套 PRD 原型：方案A 几何聚光灯 / 方案B 语义聚焦 / 方案C 阅读聚焦模式（A+B 叠加）。

---

## 进度追踪

| 轮次 | 主题 | 状态 | 关键产出 |
|------|------|:----:|---------|
| R1 | 现有代码落点审计（气泡/文档 DOM） | ✅ 完成 | chat-{user,assistant,system}-message + chat-prose 类名体系；Virtuoso itemContent 直渲染气泡 |
| R2 | 覆盖层/快捷键/移动门控机制审计 | ✅ 完成 | overlayStore 计数器 + OverlayGuard；shortcutsStore global 分类；isTauri()/isWeb() |
| R3 | 多方案设计与原型对比 | ✅ 完成 | A 几何聚光灯 / B 语义聚焦 / C 混合（推荐） |
| R4 | 性能与渲染路径分析 | ✅ 完成 | B 全程 CSS transition 无高频计算；A 需 rAF 节流 |
| R5 | WebView2 层级与 OverlayGuard 协调 | ✅ 完成 | 聚焦层属全屏覆盖，必须走 overlayStore 计数器 |
| R6 | 移动端/多窗口/可访问性门控 | ✅ 完成 | 移动端禁用；多窗口每窗口独立；pointer-events:none 保 Tab |
| R7 | messageCompactor 占位交互 | ✅ 完成 | 压缩的是数据内容非 DOM 元素，占位不抢 :hover 焦点 |
| R8 | 主题变量接入与命名规范 | ✅ 完成 | 走 themeStore L4 沉浸层变量命名 |
| R9 | 风险与回退链验证 | ✅ 完成 | 8 风险 + 不变量 + 降档策略 |
| R10 | 最终方案定稿与实施清单 | ✅ 完成 | 方案 C，Phase 0-2 实施清单 |

---

## R1：现有代码落点审计（2026-08-04）

### 聊天气泡 DOM 结构

| 消息类型 | 外层容器类名 | 文件:行号 |
|----------|-------------|----------|
| user | `chat-user-message flex justify-end group` | `src/components/Chat/chatBubbles/UserBubble.tsx:79` |
| assistant | `chat-assistant-message flex gap-2 p-2 rounded-lg group` | `src/components/Chat/chatBubbles/AssistantBubble.tsx:91` |
| system | `flex justify-center my-2`（无专用类） | `src/components/Chat/chatBubbles/SystemBubble.tsx:9` |
| assistant 内容 | `chat-prose prose prose-invert max-w-none` | `src/components/Chat/chatBubbles/AssistantBubble.tsx:145` |

### 消息列表渲染链

- `EnhancedChatMessages.tsx:341` Virtuoso `itemContent` → `renderChatMessage(item, ...)`
- `renderChatMessage.tsx` 按 `message.type` 分派到 UserBubble/AssistantBubble/SystemBubble
- Virtuoso 是虚拟列表但渲染真实 DOM，`:hover` 级联可行
- 外层无额外包裹类，气泡即顶层元素 → `:has(:hover)` 级联直接作用于气泡本身

### CSS 类定义位置

- `src/index.css:427-489` 定义 `chat-assistant-message` / `chat-user-message` / `chat-prose` 基础样式
- 变量体系：`--chat-message-gap` / `--chat-bubble-radius` / `--chat-font-size` 等

### 结论

语义聚焦有天然类名锚点 `chat-user-message` / `chat-assistant-message` / `chat-prose`，
无需改动气泡组件内部结构，只在 index.css 加 `:hover` 级联即可。

---

## R2：覆盖层/快捷键/移动门控机制审计（2026-08-04）

### overlayStore（src/stores/overlayStore.ts）

- 计数器语义：`count > 0` = 有覆盖层遮挡
- `OverlayGuard`（src/components/Browser/OverlayGuard.tsx）订阅 `count > 0` 时隐藏原生 WebView
- 已接入：settingsOpen / createSessionOpen / fileSearchOpen
- **聚焦层挂载时必须 increment，卸载 decrement**，否则 WebView2 会冒到聚焦层之上

### 快捷键 shortcutsStore（src/stores/shortcutsStore.ts）

- `global` 分类已有：global.devtools / global.fileSearch / global.newSession / global.newSessionWithWorkspace
- 快捷键定义结构：`{ id, label, labelEn, keys, category, ... }`
- CM Compartment 响应式生效
- 分派：global.fileSearch → overlayStore.toggleFileSearch()

### 设置页结构（src/components/Settings/SettingsPage.tsx）

- `SettingsTabId` 枚举：general / theme / shortcuts / ...
- `topLevelKeysByTab` 分组保存：general → ['language','baiduTranslate','interaction']
- 聚焦设置挂 `general`（交互类）或独立小节

### 移动端门控（src/utils/platform.ts）

- `isTauri(): boolean` / `isWeb(): boolean`
- 移动端走 `src/mobile/`，触屏无悬停语义 → 聚焦功能自动禁用

---

## R3：多方案设计与原型对比（2026-08-04）

| 方案 | 机制 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| **A 几何聚光灯** | 全屏遮罩 + 鼠标处挖高亮圆 | 通用，任意区域生效 | 圆内可见不一定可读；高频 mousemove | 略读定位 |
| **B 语义聚焦** | 鼠标悬停的消息块/段落提亮，兄弟降亮度 | 性能最优；精准可读 | 只对结构化内容生效 | 精读 AI 回复 |
| **C 阅读聚焦模式** | L1 语义 + L2 聚光灯叠加 | 精读+略读兼得；互不冲突 | 实现量略大 | 全场景（推荐） |

**推荐方案 C**：默认 L1 语义高亮（覆盖 90% 精读场景），L2 聚光灯作为强模式可选层（略读定位兜底）。

---

## R4：性能与渲染路径分析

### 方案 B 语义聚焦（默认）

- 全程 CSS `transition` + `:hover` 级联，**零 JS 运行时开销**
- 无 `mousemove` 监听，无 `requestAnimationFrame`
- 低端机不掉帧
- GPU 加速属性：`opacity` / `filter: brightness()` 均为合成层友好

### 方案 A 聚光灯（强模式）

- `mousemove` 高频，必须 `requestAnimationFrame` 节流
- 圆心走 CSS 变量更新（`spot.style.setProperty('--mx', ...)`），不触发 React 重渲染
- `backdrop-filter: blur()` 在低端机掉帧 → 提供降档：仅降亮度不模糊
- 仅在 L2 强模式激活时才挂载 mousemove 监听，默认 L1 不挂载

### 性能预算

| 模式 | JS 开销 | CSS 开销 | GPU |
|------|--------|---------|-----|
| L1 语义 | 0 | transition | 合成层 |
| L2 聚光灯 | rAF 节流 mousemove | backdrop-filter | 中 |

---

## R5：WebView2 层级与 OverlayGuard 协调

### 问题

Tauri 下内置浏览器使用原生 WebView2，其层级始终位于 HTML 内容之上。
现有 `OverlayGuard` 策略：`overlayStore.count > 0` 时隐藏原生 WebView。

### 聚焦层协调

- L2（聚光灯）是全屏 `pointer-events:none` 遮罩，会遮挡内置浏览器 WebView
  - **挂载时 `overlayStore.increment()`，卸载 `decrement()`**
  - OverlayGuard 同步隐藏原生 WebView，避免 WebView 区域冒到聚焦层之上
- L1（语义聚焦）**不走 overlayStore**：只在 body 加类高亮聊天消息，不遮挡浏览器面板
  - L1 时内置浏览器 WebView 保持正常显示
- 与 settingsOpen/createSessionOpen/fileSearchOpen 走同一套计数器，嵌套安全

### 边界

- 聚焦层 z-index 必须低于 modal 类覆盖（settings/createSession），避免遮挡弹窗
- 建议聚焦层 z-index: 20，modal 类 z-index: 30+

---

## R6：移动端/多窗口/可访问性门控

### 移动端

- 触屏无悬停语义，`:hover` 在移动端无效
- `polaris-mobile` 下自动禁用聚焦功能（门控：`isTauri()` + 设备检测）
- 设置页在移动端隐藏聚焦开关

### 多窗口

- `useWindowManager` 多窗口场景下，聚焦层应每窗口独立
- 不用全局单例遮罩，而是跟随当前焦点窗口
- focusModeStore 按窗口隔离（或全局开关但渲染层每窗口独立）

### 可访问性

- `pointer-events: none` 必须保证，不阻断键盘 Tab 导航与读屏
- 强模糊提供"仅降亮度不模糊"降档
- 高亮提亮比不低于 0.5（避免对比度过低）
- 不依赖颜色单一通道（已有 border + box-shadow 双重高亮提示）

---

## R7：messageCompactor 占位交互

### 机制（src/utils/messageCompactor.ts）

- Virtuoso `rangeChanged` 驱动，可见区域外消息触发压缩
- 压缩的是**消息数据内容**（清重数据：工具输出、diff），保留元信息
- DOM 元素仍在（气泡容器 `chat-*-message` 类名不丢），只是内容变短
- `COMPACT_MARKER = '__compacted__'` 标记，`isCompacted()` 判断

### 对聚焦的影响

- ✅ 利好：占位不创建新 DOM 元素，`:hover` 级联仍作用于原气泡容器
- ✅ 无焦点抢夺：压缩/恢复是数据层操作，不触发 DOM 重建
- ⚠️ 注意：压缩态气泡内容变短，高亮视觉范围变小，属预期行为
- 无需为 compactor 做特殊处理

---

## R8：主题变量接入与命名规范

### themeStore L4 沉浸层命名规范

现有：`--spiderman-panel-blur` / `--spiderman-panel-opacity` / `--theme-panel-blur` 等。
聚焦功能新增变量应遵循：

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `--focus-dim-opacity` | 0.32 | 兄弟节点降亮度 |
| `--focus-dim-brightness` | 0.5 | 兄弟节点降亮 |
| `--focus-highlight-border` | var(--c-primary) | 高亮边框色 |
| `--focus-spot-clear` | 200px | 聚光灯清晰半径 |
| `--focus-spot-blur` | 3px | 聚光灯模糊度 |
| `--focus-spot-dim` | rgba(8,10,16,.82) | 聚光灯遮罩色 |

### 接入方式

- 走 themeStore 变量注入（与 L4 沉浸层一致）
- 用户可通过主题系统自定义
- 强度参数持久化到 config（interaction 字段下）

---

## R9：风险与回退链验证

### 风险清单

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| 1 | WebView2 层级冒顶 | 浏览器区域遮不住 | 走 overlayStore 计数器 |
| 2 | 移动端无悬停 | 功能失效 | isTauri 门控禁用 |
| 3 | 多窗口单例遮罩 | 跨窗口串扰 | 每窗口独立渲染 |
| 4 | messageCompactor 占位抢焦 | 切换闪烁 | 压缩不改 DOM 元素，已验证 |
| 5 | backdrop-filter 低端机掉帧 | 卡顿 | 降档：仅降亮度不模糊 |
| 6 | pointer-events 阻断交互 | Tab 失效 | 聚焦层 pointer-events:none |
| 7 | 嵌套滚动容器边界误判 | 高亮错位 | 用 :has(:hover) 级联非冒泡 |
| 8 | 主题变量缺失 | 样式回归 | 变量给默认值 fallback |

### 不变量

- 聚焦层 `pointer-events: none` 恒成立
- 聚焦层 z-index < modal z-index
- L1 默认开启时无 mousemove 监听
- 移动端下 focusMode 恒为 off

### 降档策略

- L2 强模式模糊掉帧 → 自动降为"仅降亮度不模糊"
- 仍掉帧 → 提示用户切回 L1

---

## R10：最终方案定稿与实施清单

### 选定方案：C 阅读聚焦模式（L1 语义 + L2 聚光灯叠加）

### 实施清单

#### Phase 0：基础设施

- 新建 `src/stores/focusModeStore.ts`：开关 + 模式(0/1/2) + 强度参数，持久化可选
- 新建 `src/components/FocusMode/FocusOverlay.tsx`：全屏 pointer-events:none 遮罩，Portal 到 body
  - 挂载时 `overlayStore.increment()`，卸载 `decrement()`
  - L2 模式挂载 mousemove 监听（rAF 节流）
  - z-index: 20-25
- App.tsx 挂载 FocusOverlay（lazy import）

#### Phase 1：语义聚焦级联（L1）

- `src/index.css` 新增聚焦级联：
  ```css
  body.focus-mode .chat-user-message,
  body.focus-mode .chat-assistant-message { transition: opacity .25s, filter .25s }
  /* 兄弟降亮度 */
  body.focus-mode ...:has(:hover) ... { opacity: var(--focus-dim-opacity); filter: brightness(var(--focus-dim-brightness)) }
  /* 当前高亮 */
  body.focus-mode ...:hover { opacity: 1; filter: none; box-shadow: ... }
  ```
- 同理 `.chat-prose p` 段落级
- themeStore 注入 `--focus-*` 变量

#### Phase 2：快捷键 + 设置 + 门控

- `shortcutsStore.ts` 新增 `global.focusMode`（默认 F）+ `global.focusModeStrong`（默认 Shift+F）
- 分派到 focusModeStore.setLevel()
- GeneralTab 新增"聚焦模式"小节（开关 + 强度选择 + 圆径滑块）
- 移动端门控：`isTauri()` 为 false 时强制 off
- 文档：本日志 + 更新 shortcuts 文档

### 验收标准

- [ ] F 切换 L1，鼠标悬停消息块高亮、兄弟降亮度
- [ ] Shift+F 切 L2，聚光灯跟随鼠标
- [ ] 聚焦层不阻断 Tab 键导航
- [ ] 设置打开时聚焦层不遮 modal
- [ ] 移动端聚焦功能不启用
- [ ] messageCompactor 压缩态不闪烁
- [ ] TypeScript 编译零错误
