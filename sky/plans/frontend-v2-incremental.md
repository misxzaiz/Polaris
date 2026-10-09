# Sky 前端 v2 优化方案 — 分区增量渲染

> 诊断日期:2026-10-09
> 核心问题:全量 rerender 毁掉所有交互体验

## 根因

`rerender()` 每次清空 `rootEl.innerHTML` 重建整个 DOM。任何 `notify()` 调用
(工具调用/表单/浮窗/流式结束)都触发全量重建,导致:
- 表单输入焦点丢失
- 浮窗交互状态销毁(重建后 JS 沙箱重跑)
- 滚动位置丢失
- 输入框打字中断

## 方案:分区增量渲染

DOM 分为 4 个独立分区,各自独立更新,互不干扰:

```
#app
├─ #topbar        — 状态栏(仅连接/认证变化时更新)
├─ #stream        — 对话流(只追加新 block,已有 block 增量 patch)
├─ #composer      — 输入区(创建后不再重建,只读/禁用态切换)
└─ #overlay       — 浮窗群 + sheet + toast(独立层,不随 stream 重建)
```

### 核心改动

1. **对话流**:不再全量重建。新 block → `appendChild`;已有 block → `patchBubble`。
   `notify()` 只影响对话流分区。

2. **浮窗**:浮窗 DOM 创建后**持久存在**,不随 rerender 销毁。
   `ui.window close` 事件才移除。浮窗内交互(点击/输入)不会触发 DOM 重建。

3. **输入框**:`#composer` 只创建一次,后续永不重建。
   焦点保持、输入内容不丢。

4. **流式渲染**:chunk → 直接 `bubble.innerHTML = renderMarkdown(text)`。
   不走 `notify()`,不走全量 rerender。

## 浮窗交互修复

- 浮窗 DOM 持久化(不被 rerender 销毁)
- 浮窗内 HTML 由 AI 提供,DOMPurify 净化后注入
- JS 沙箱 `__sky.dispatch` 返回 Promise(而非裸 fetch)
- 浮窗可拖拽(桌面)/ 全屏(手机)
- 多个浮窗叠加(z-index 递增)

## 其他修复

- 去掉 `require()`(ESM 不可用)→ 全部 `import`
- session 续接:启动时读 `cap.history` 恢复对话
- 代码块语法高亮(轻量 CSS,不引 prism)
- 消息过渡动画(CSS animation,不卡)
- 滚动锚点(followBottom + 用户上翻暂停)
