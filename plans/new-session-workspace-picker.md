# 新建会话工作区选择增强：显示路径 + 支持关联工作区

## 目标
统一三个新建/管理工作区入口的交互语言，参照已验证的 `WorkspaceMenu` 范式：
- 工作区列表项双行显示（name + path）
- 点工作区本体选主工作区，行尾 `+`/`✓` 切关联工作区
- 单面板内同时完成主+关联选择

## 现状
| 入口 | path | 关联工作区 |
|---|---|---|
| 顶栏 `+` 下拉 (`NewSessionButton`) | ❌ 仅 name | ❌ 点选即建 |
| `Ctrl+Shift+'+'` 弹窗 (`CreateSessionModal`) | ✅ 主区 | ⚠️ 关联区仅 name |
| 会话后菜单 (`WorkspaceMenu`) | ✅ | ✅ (范式源头) |

## 改动

### 1. `src/components/Chat/NewSessionButton.tsx`（核心）
- 列表项改双行：上行 name (font-medium truncate)，下行 path (text-xs text-text-tertiary truncate)
- 宽度 `min-w-[220px]` → `w-72`
- 新增本地状态 `pendingPrimaryId` / `pendingContextIds`
- 点工作区本体 = 选定主工作区（高亮，不立即创建）
- 行尾 `+`/`✓` 按钮 = 增删关联（参照 `WorkspaceMenu:218-238`，hover 显形，已关联常驻 ✓）；仅在 `sortedWorkspaces.length > 1 && pendingPrimaryId` 时显示
- 底部加固定操作条：`创建` 主按钮 + 关联数提示
- 点 `创建` 才 `createSession({ type:'project', workspaceId: pendingPrimaryId, contextWorkspaceIds: pendingContextIds, workspaceLocked: true, engineId: selectedEngineId })`
- "无工作区"项保留为快路径（直接 free 创建，不走两步）
- 复用 `useWorkspaceFilter`（已支持 name+path 搜索）
- 回车键绑定 `创建`

### 2. `src/components/Session/CreateSessionModal.tsx`（一致性）
- 关联工作区列表项 (line 274-291) 补 path 第二行，样式与主工作区一致
- 仅此一处，其余不动

### 3. i18n (zh-CN + en-US)
- `chat.json` `newSession` 补：`create`、`contextCount`、`selectPrimaryHint`、`addContext`、`removeContext`
- 复用现有 `noWorkspace`/`aiEngine`/`searchWorkspace`

## 不做
- 不抽共享 `WorkspacePicker` 组件（两处状态机不同：新建前 vs 会话后，强抽增耦合）
- 不动 `WorkspaceMenu`（范式源头）
- 不动 `ChatInput`（其工作区逻辑是 @workspace 文件引用补全，无关）
- 不默认展开关联区（行尾 + 已足够发现性）

## 风险
- 下拉从单击即建变两步：缓解=主工作区点选即高亮可改，创建按钮常驻，回车提交
- 下拉高度增加：缓解=`max-h-[320px]` 已有滚动，`w-72` 横向容纳 path

## 验证
- TypeScript 编译零错误
- 三个入口工作区列表均显示 name+path
- 顶栏下拉可选主+关联后创建
