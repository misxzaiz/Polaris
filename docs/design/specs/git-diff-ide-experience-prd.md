# Git Diff IDEA 级体验改造 PRD

> 版本：1.0.0
> 日期：2026-06-26

---

## 一、背景与目标

### 1.1 背景

当前 Polaris 的 Git Diff 查看器（`DiffViewer.tsx`）仅提供基础的行级差异展示，缺少 IDE 级别的核心体验能力：词级差异高亮、语法着色、文件导航、键盘快捷操作。与 IntelliJ IDEA / VS Code 的 diff 体验存在明显差距。

### 1.2 目标

将 Git Diff 查看器提升至 IDEA 级别体验，核心指标：

- 词级差异：变更行内精确标红/标绿具体修改的词
- 语法着色：diff 视图保留代码语法高亮
- 文件导航：多文件 diff 时支持文件树切换
- 键盘驱动：全键盘操作，无需鼠标

### 1.3 非目标

- 不引入实时协作 diff
- 不实现三路合并冲突解决 UI（已有独立实现）
- 不改变后端 diff 计算逻辑

---

## 二、功能需求

### P0 - 词级差异高亮（Word-level Diff）

**用户故事：** 作为开发者，我希望在 diff 视图中一眼看出每行内具体修改了哪些词，而不是整行标红/标绿。

**实现方案：**

1. 后端无需改动，前端利用已有的 `old_content` / `new_content` 行内容
2. 使用 `diff` 库的 `diffChars` 函数对同一位置的 added/removed 行做字符级对比
3. 在渲染时，将行内容拆分为 `<span>` 片段，精确标注变更部分

**数据流：**

```
GitDiffEntry (old_content, new_content)
  → buildSplitRows (已有)
    → 对每个 removed/added 行对调用 diffChars
      → 生成 WordSegment[]: { text, type: 'same' | 'changed' }
        → 渲染为带高亮的 <span>
```

**验收标准：**
- [ ] 修改变量名时，仅变量名部分标红/标绿
- [ ] 大段代码仅修改一处时，未修改部分保持正常颜色
- [ ] 性能：1000 行 diff 渲染 < 200ms

---

### P1 - 语法高亮 Diff（Syntax Highlighting）

**用户故事：** 作为开发者，我希望 diff 视图中的代码保持语法着色，便于快速理解变更上下文。

**实现方案：**

1. 根据文件扩展名选择对应的 highlight.js 语言（项目已安装 highlight.js）
2. 对每行内容调用 `highlight(code, { language })` 获取 HTML
3. 在词级 diff 基础上叠加语法高亮：先做 word-level diff，再对相同部分应用语法着色

**文件扩展名映射（复用已有 CodeMirror 语言包）：**

| 扩展名 | highlight.js 语言 |
|---|---|
| `.ts`, `.tsx`, `.js`, `.jsx` | typescript / javascript |
| `.rs` | rust |
| `.py` | python |
| `.go` | go |
| `.json` | json |
| `.html`, `.vue` | xml / html |
| `.css`, `.scss` | css |
| `.md` | markdown |
| 默认 | plaintext（不着色） |

**验收标准：**
- [ ] TypeScript/React 文件 diff 保留关键字、字符串、注释着色
- [ ] 不支持的语言降级为纯文本，不报错
- [ ] 语法高亮不影响词级差异的准确性

---

### P1 - 文件导航面板（File Navigator）

**用户故事：** 作为开发者，查看多文件变更时，我希望在 diff 视图顶部看到文件列表，快速切换文件。

**实现方案：**

1. 在 DiffViewer 上方增加可折叠的文件导航条
2. 显示文件名、变更类型图标（M/A/D/R）、增删行数统计
3. 当前文件高亮，点击切换
4. 支持上下箭头键在文件间导航

**布局：**

```
┌─────────────────────────────────────────────┐
│ 文件导航（可折叠）                            │
│ ┌───────────────────────────────────────────┐│
│ │ ▼ src/components/GitPanel/FileChangesList ││
│ │   src/components/GitPanel/index.tsx       ││
│ │   src-tauri/src/services/git/commit.rs    ││
│ │   src/locales/en-US/git.json              ││
│ └───────────────────────────────────────────┘│
├─────────────────────────────────────────────┤
│ diff 内容区域                                 │
│ ...                                         │
└─────────────────────────────────────────────┘
```

**验收标准：**
- [ ] 多文件 diff 时自动显示文件导航
- [ ] 单文件 diff 时隐藏导航，最大化 diff 区域
- [ ] 文件列表显示增删统计（+12 -3）
- [ ] 点击文件名切换，当前文件有视觉指示

---

### P2 - 键盘快捷键

**用户故事：** 作为开发者，我希望用键盘完成所有 diff 导航操作。

**快捷键映射（IDEA 风格）：**

| 快捷键 | 功能 |
|---|---|
| `j` / `k` | 下一个 / 上一个变更 hunk |
| `]` / `[` | 下一个 / 上一个文件 |
| `Space` | 展开 / 折叠上下文 |
| `Enter` | 打开文件编辑器 |
| `Escape` | 关闭 diff 视图 |
| `/` | 搜索 diff 内容 |

**验收标准：**
- [ ] 所有快捷键可在 diff 视图聚焦时使用
- [ ] 不与全局快捷键冲突
- [ ] 快捷键提示显示在 diff 视图底部

---

### P2 - 行号 gutter 增强

**用户故事：** 作为开发者，我希望能看到变更前后的行号对应关系。

**增强内容：**

1. 旧版本行号（灰色，左侧）
2. 新版本行号（灰色，右侧）
3. 变更类型指示条（绿色 = 新增，红色 = 删除，灰色 = 上下文）
4. 行内折叠按钮（点击折叠/展开上下文行）

---

## 三、交互设计

### 3.1 主视图状态机

```
[文件列表模式] ←→ [单文件 diff 模式]
     ↑                    ↑
     │                    │
  [多文件 diff]      [文件导航条]
```

### 3.2 视图模式切换

- 默认：`split`（双栏对比）
- 可切换：`unified`（统一视图）
- 切换按钮在 diff 视图右上角

### 3.3 视觉规范

- 变更词高亮：`bg-red-500/15` (删除) / `bg-green-500/15` (新增)
- 行背景：`bg-red-500/8` (删除行) / `bg-green-500/8` (新增行)
- 语法高亮：复用 highlight.js 主题色
- 行号：`text-text-tertiary` 灰色
- 分割线：`border-border-subtle`

---

## 四、技术方案

### 4.1 新增依赖

无新依赖。使用已有：
- `diff` (jsdiff) - 词级 diff 计算
- `highlight.js` - 语法高亮

### 4.2 文件变更

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/components/Diff/DiffViewer.tsx` | 修改 | 核心改造：词级 diff + 语法高亮 |
| `src/components/Diff/WordDiffSegment.tsx` | 新增 | 词级差异渲染组件 |
| `src/components/Diff/SyntaxHighlighter.tsx` | 新增 | 语法高亮包装组件 |
| `src/components/Diff/FileNavigator.tsx` | 新增 | 文件导航面板 |
| `src/components/Diff/DiffKeyboardHandler.tsx` | 新增 | 键盘快捷键处理 |
| `src/services/diffService.ts` | 修改 | 新增词级 diff 计算函数 |
| `src/locales/zh-CN/git.json` | 修改 | 新增翻译 key |
| `src/locales/en-US/git.json` | 修改 | 新增翻译 key |

### 4.3 性能策略

1. **虚拟滚动**：使用已有的 `react-virtuoso` 处理大文件 diff
2. **懒计算**：词级 diff 仅在行可见时计算
3. **缓存**：语法高亮结果按文件路径 + 内容 hash 缓存
4. **Web Worker**（可选）：超大文件（>5000 行）的 diff 计算移至 Worker

---

## 五、实施计划

| 阶段 | 内容 | 工时 | 依赖 |
|---|---|---|---|
| Phase 1 | 词级差异高亮 | 1.5 天 | 无 |
| Phase 2 | 语法高亮 | 1.5 天 | Phase 1 |
| Phase 3 | 文件导航面板 | 1.5 天 | 无 |
| Phase 4 | 键盘快捷键 + 行号增强 | 1 天 | Phase 3 |
| Phase 5 | 测试 + 优化 | 0.5 天 | Phase 1-4 |
| **合计** | | **6 天** | |

---

## 六、验收标准总览

- [ ] 词级差异在所有语言文件中正确显示
- [ ] 语法高亮在支持的语言中正确渲染
- [ ] 多文件 diff 时文件导航面板正常工作
- [ ] 所有键盘快捷键正常响应
- [ ] 大文件（>1000 行）渲染性能达标
- [ ] 暗色/亮色主题下视觉表现正确
