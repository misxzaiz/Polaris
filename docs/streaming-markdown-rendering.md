# 实时 Markdown 渲染方案

> 实现日期: 2026-04-07
> 版本: 1.0.0

---

## 问题背景

AI 对话中的 Markdown 渲染原本是等 AI 响应结束后才渲染，导致用户在流式输出期间无法看到格式化效果，体验不够流畅。

**核心问题：**
1. 流式阶段显示纯文本，格式混乱难以阅读
2. 完整 Markdown 解析性能开销大，实时渲染会卡顿
3. 代码块语法高亮在流式阶段无法正确处理

---

## 方案设计

### 渐进式渲染三阶段

```
流式阶段 → 过渡阶段 → 完成阶段
```

#### 1. 流式阶段 (isStreaming=true)

使用轻量级 Markdown 渲染：
- 只处理行内格式（粗体、斜体、行内代码、链接、删除线）
- 不处理复杂块级元素（表格、Mermaid、标题）
- 代码块显示但不高亮（等待完整后处理）

**性能优化：**
- 200ms 节流（确保固定频率渲染）
- useDeferredValue 延迟渲染
- 最大处理长度 50KB
- 无限循环保护（最大 1000 次迭代）

#### 2. 过渡阶段 (isStreaming=false 后立即)

触发完整 Markdown 渲染：
- 使用 marked.js 完整解析
- 开始代码语法高亮
- Mermaid 图表渲染

#### 3. 完成阶段

所有元素完整渲染：
- 保持现有 TextPartRenderer 和 MermaidDiagram 组件
- 使用 markdownCache 缓存渲染结果

---

## 技术实现

### 新增文件

#### `src/utils/lightweightMarkdown.tsx`

轻量级 Markdown 解析器，专为流式渲染设计。

**核心组件：**

```tsx
// 主渲染组件
export const LightweightMarkdown = memo(function LightweightMarkdown({
  content
}: { content: string }) {
  const parts = useMemo(() => parseInlineMarkdown(content), [content]);
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, index) => renderPart(part, index))}
    </span>
  );
});

// 代码块分割函数
export function splitByCodeBlocks(content: string): Array<{
  type: 'text' | 'code-block';
  content: string;
  language?: string;
}>

// 未闭合代码块检测
export function hasOpenCodeBlock(content: string): boolean

// 流式阶段代码块渲染
export const StreamingCodeBlock = memo(function StreamingCodeBlock({
  content,
  language,
}: { ... })
```

**支持的行内格式：**
- `**bold**` / `__bold__` → 粗体
- `*italic*` / `_italic_` → 斜体
- `` `code` `` → 行内代码
- `[text](url)` → 链接
- `~~strikethrough~~` → 删除线

### 修改文件

#### `src/components/Chat/EnhancedChatMessages.tsx`

重构 `StreamingTextContent` 组件，支持实时 Markdown 渲染：

```tsx
const StreamingTextContent = memo(function StreamingTextContent({ content }: { content: string }) {
  const renderResult = useMemo(() => {
    // 性能限制：最大处理长度
    if (content.length > 50000) {
      return <span className="whitespace-pre-wrap break-words">{content}</span>;
    }

    // 检测代码块
    const codeBlockCount = (content.match(/```/g) || []).length;

    if (codeBlockCount === 0) {
      return <LightweightMarkdown content={content} />;
    }

    // 有代码块，分割处理
    const parts = splitByCodeBlocks(content);
    const hasOpenBlock = hasOpenCodeBlock(content);

    return (
      <span className="whitespace-pre-wrap break-words">
        {parts.map((part, index) => {
          if (part.type === 'code-block') {
            return <StreamingCodeBlock key={`code-${index}`} ... />;
          } else {
            return <LightweightMarkdown key={`text-${index}`} content={part.content} />;
          }
        })}
        {hasOpenBlock && <流式光标 />}
      </span>
    );
  }, [content]);

  return renderResult;
});
```

---

## 性能保障

| 机制 | 说明 |
|------|------|
| 200ms 节流 | 固定频率渲染，避免高频更新 |
| useDeferredValue | 降低渲染优先级，保持 UI 响应 |
| useMemo 缓存 | 避免重复解析相同内容 |
| 长度限制 | 最大 50KB，超长文本直接返回 |
| 循环保护 | 最大 1000 次迭代，防止死循环 |
| memo 组件 | 避免不必要的重渲染 |

---

## 安全措施

| 措施 | 说明 |
|------|------|
| 不使用 dangerouslySetInnerHTML | 避免 XSS 风险 |
| 链接安全属性 | target="_blank" + rel="noopener noreferrer" |
| 纯 React 渲染 | 使用 JSX 元素而非 HTML 字符串 |

---

## 渲染效果对比

### 流式阶段

**之前：**
```
这是**粗体**文本，带有`行内代码`和[链接](https://example.com)
```
显示为纯文本，格式混乱。

**现在：**
实时显示格式化效果：
- 粗体渲染为 `<strong>`
- 行内代码渲染为 `<code>`
- 链接渲染为可点击的 `<a>`

### 代码块处理

**之前：**
流式阶段代码块语法高亮无法正确处理，可能显示错误。

**现在：**
- 完整代码块：显示语言标签和代码内容，不高亮
- 未闭合代码块：显示原始文本 + 流式光标
- 流式结束后：触发完整语法高亮

---

## 后续优化方向

1. **进一步性能优化**：可考虑使用 requestAnimationFrame 替代节流
2. **更多格式支持**：可扩展支持标题、列表等简单块级元素
3. **智能渲染策略**：根据内容类型动态调整渲染频率

---

## 相关文件

- `src/utils/lightweightMarkdown.tsx` - 轻量级 Markdown 解析器
- `src/components/Chat/EnhancedChatMessages.tsx` - 流式渲染组件
- `src/utils/markdown.ts` - 完整 Markdown 渲染（完成阶段）