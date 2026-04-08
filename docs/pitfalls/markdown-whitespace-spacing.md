# Markdown 代码块路径元素间距异常

**日期**：2026-04-08
**提交**：`0282e88`

## 现象

包含代码块的消息，`marked` 渲染后段落、列表等块级元素之间出现明显空行。

## 根因

`lightweightMarkdown.tsx` 有代码块路径用 `<span class="whitespace-pre-wrap">` 包裹所有子元素：

```
<span class="whitespace-pre-wrap break-words">   ← 设了 white-space: pre-wrap
  <div class="break-words">                       ← 继承了 pre-wrap（无覆盖）
    <p>text</p>\n<ol>\n<li>item</li>\n</ol>       ← marked 输出的 \n 变成空行
  </div>
</span>
```

`white-space` 是 CSS 继承属性，`CompletedTextBlock` 没有覆盖它。`marked` 输出在块级元素间有 `\n`（典型 8 处），`pre-wrap` 下每个 `\n` 渲染为一个 24px 空行。

## 修复

外层 `<span>` → `<div>`，移除 `whitespace-pre-wrap`：

```diff
- <span className="whitespace-pre-wrap break-words">
+ <div className="break-words">
```

安全依据：`StreamingCodeBlock` 内部有 `<pre><code class="whitespace-pre">`，`DeferredMermaidDiagram` 内部有自己的 `whitespace-pre-wrap`，均不依赖外层。

## 教训

1. **`white-space` 会继承** — 在容器上设 `pre-wrap` 前，确认所有子内容都需要它
2. **`dangerouslySetInnerHTML` + `pre-wrap` 是危险组合** — HTML 源码中的换行符会被保留渲染
3. **`<div>` 不要嵌套在 `<span>` 里** — 块元素在行内元素中违反 HTML 规范，浏览器修复 DOM 会产生不可预期的布局
