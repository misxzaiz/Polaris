# FileExplorer 冷启动/刷新空白修复

> 日期：2026-10-20
> 状态：已实施（前端改动，未改后端契约）

## 现象

用户反馈：文件浏览器打开时**有时内容为空**；即使点击刷新按钮也无反应，必须"重新选择工作区"才能显示。

## 根因

### P0 — 冷启动初始化 effect 依赖错误

`src/components/FileExplorer/FileExplorer.tsx` 的初始化 effect 将 `getCurrentWorkspace` / `getViewingWorkspace` 两个 store 方法引用放进依赖。Zustand v4 中这两个方法在 store 构造后引用稳定不变，effect **不会因 `workspaces` 或 `currentWorkspaceId` 变化而重跑**。

冷启动时序：

1. App mount → FileExplorer mount
2. effect 首次执行：`workspaceStore.workspaces=[]` → `targetWorkspace=null` → 不 `load_directory`
3. `useAppInit` 的 `syncFromServer` 完成 → `workspaces` 有值
4. effect 依赖未变，永不重跑 → `file_tree` 永远是 `[]`，UI 停在「此目录为空」

网络/后端同步时序抖动决定这一步是否被后续事件（`workspace-changed` / F5 / 用户操作）救回，于是表现为「有时空有时不空」。

### P1 — 刷新按钮静默 return

`src/stores/fileExplorerStore.ts` 的 `refresh_directory` 开头：

```ts
if (!current_path) return;
```

当 P0 未触发时，`current_path` 恒为 `''`，点刷新按钮毫无反应、无日志、无 error 状态——完全对齐用户描述的「刷新也没显示」。

### P2 — 刷新把"读取失败"当"目录被删"

`refresh_directory` 的并行加载用 `.catch(() => ({ children: null }))`，失败路径归入 `removedPaths` → 从 `expanded_folders` 中删除。**权限/占用/瞬时错误都会让已展开目录被强行折叠**。

## 修复

### 1. FileExplorer 初始化 effect 改为订阅派生 path 切片

```ts
const targetPath = useWorkspaceStore((s) => {
  const id = s.viewingWorkspaceId ?? s.currentWorkspaceId;
  if (!id) return null;
  return s.workspaces.find((w) => w.id === id)?.path ?? null;
});

useEffect(() => {
  if (targetPath && current_path !== targetPath) {
    load_directory(targetPath);
    loadCustomCommands(targetPath);
  }
}, [targetPath, current_path, load_directory, loadCustomCommands]);
```

Zustand selector 会对返回值做 Object.is 比较；path 字符串变化即触发 effect 重跑。path 为空时不进入加载分支，无副作用。

### 2. `refresh_directory` 加自举 fallback

`current_path` 为空时，主动从 `workspaceStore` 拉取 `viewingWorkspace || currentWorkspace` 的路径并 `load_directory`。任何一步 workspace 也不就绪时打 `log.warn` 早退（不再静默）。

### 3. `refresh_directory` 折叠错误处理

并行加载用 union 类型区分三种结果：

- `ok`：写入 `newCache`
- `missing`（后端返回"路径不存在/不是目录"）：清 `expanded_folders` 与 `folder_cache`
- `error`（其他错误）：保留展开态与旧 cache，打 `log.warn`

判定依据为错误消息正则匹配 `InvalidPath`（`/路径不存在|不是目录|No such file|not a directory/i`）。

## 未纳入本次修复的问题

以下在初分析中列出但**未实施**，留作后续工作项：

- P1（并发覆盖）：`load_directory` / `refresh_directory` 加 requestId 序列号，防止快速切换工作区时后写覆盖先写
- P2（懒加载失败静默）：`load_folder_content` 失败时无 UI 反馈；应给 FileTreeNode 加 loadError 标记 + 重试按钮
- P3（Windows 大小写敏感）：`normalizePath` 未做大小写归一；比较函数应收敛到单一 `comparePathEqual`
- P4（搜索折叠）：快搜对未加载目录返回空数组导致隐藏；应保留占位可展开或明确 UI 提示
- P5（布局压缩）：`flex-1` 容器未显式 `min-h-0`，error 面板长时可能压扁文件树
- P6（后端单点失败）：`read_directory_inner` 中单个 entry 元数据读取失败会整体失败；应 `continue` + 累计 warning

## 验证

- `pnpm exec tsc --noEmit` ✅
- `pnpm exec eslint src/stores/fileExplorerStore.ts src/components/FileExplorer/FileExplorer.tsx` ✅
- `pnpm vitest run src/stores/config-refactor.test.ts` ✅（11/11）

## 用户手工回归清单

1. 冷启动后立刻打开文件浏览器（左侧 Files 面板），观察是否自动显示当前工作区文件（**修复前**：可能停在「此目录为空」；**修复后**：应自动出现工作区根文件）
2. 若首屏空（极端场景），点刷新按钮：应立刻显示文件（**修复前**：无反应）
3. 展开若干目录后点刷新：若某个子目录当时被 IDE/编辑器占用导致瞬时读取失败，**保留原展开态**不再折叠；只有真的删除/重命名的目录才会折叠
4. 打开 F12 Console：修复过程中若跳过/回退路径触发，`log.warn` 会打印 `refresh_directory 跳过：无 current_path 且 workspaceStore 未就绪` 或 `refresh_directory：部分展开目录读取失败`，便于诊断
