# CodeMirror 高亮样式陷阱

## 问题

编辑器中双击选词后，相同词高亮显示为**绿色**，而非主题定义的蓝色。

## 原因

1. **类名错误**：主题中写了 `.cm-selectionMatch-selected`，但 CodeMirror 实际使用 `.cm-selectionMatch-main`

2. **内置默认样式**：`@codemirror/search` 模块有默认绿色样式 `#99ff7780`，覆盖了主题

3. **当前行高亮混淆**：`highlightActiveLine()` 会高亮光标所在整行，与选区高亮是两个独立功能

## 解决

```typescript
// 正确的类名
'.cm-selectionMatch': { backgroundColor: '...' },        // 匹配词
'.cm-selectionMatch-main': { backgroundColor: '...' },  // 当前词（不是 selected）
```

## 参考

- `src/components/Editor/Editor.tsx` - 扩展配置
- `src/components/Editor/modernTheme.ts` - 主题样式
