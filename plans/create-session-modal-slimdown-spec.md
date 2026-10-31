# spec：CreateSessionModal 瘦身（新建会话弹窗太大）

日期：2026-11-01　所有者：quan + coding agent　状态：已批准（方案 B 先行，方案 A/C 后续候选）

## 背景与根因

右侧悬浮胶囊（QuickSwitchTrigger）→ 快速切换面板（QuickSwitchContent，w-56）→ 底部
「New Session」→ 打开 `src/components/Session/CreateSessionModal.tsx`。用户反馈：
从 224px 轻量面板点进来，突然是 512px 宽、纵向堆叠 ~700px 的全屏居中模态，太大了。

体量根因：引擎网格 + 供应商/模型选择器 + 主工作区 + 关联工作区全部无条件铺开，而其中
大部分多数时候不需要（引擎与供应商/模型有 cap.kv 按引擎记忆；关联工作区在
QuickSwitch 面板里本就可改）。

附带硬 bug：模态容器无 `max-height`/`overflow-y-auto`，矮窗口下内容上下溢出，
底部「创建」按钮可能被裁掉不可点。

## 改动点（仅 CreateSessionModal.tsx，4 个入口共用自动受益）

1. **裁切修复**：模态 `max-h-[85vh] flex flex-col`；标题/底部按钮 `shrink-0` 常驻，
   中间内容区 `min-h-0 overflow-y-auto`。宽度 `max-w-lg` → `max-w-md`。
2. **引擎 + 供应商/模型折叠**：默认一行摘要（引擎名 · 官方接口/Profile 名 · 模型），
   点击展开引擎网格 + SessionConfigSelector；展开态随模态关闭自然复位。
   摘要区置于主工作区区**之后**（底部）——原因：SessionConfigSelector 下拉向上弹
   （`bottom-full`），置于底部可保证展开后上方有 ≥240px 头部空间，不被滚动容器裁切。
   补齐与 NewSessionButton 对齐的「记忆引擎已下线 → 回退全局默认」effect（消除双实现漂移之一）。
3. **移除关联工作区区**：创建 project 会话时 `contextWorkspaceIds: []`；关联工作区
   管理仍在 QuickSwitch 面板与会话内进行（单一权威不新增写路径）。

## 边界（明确不做）

- 不动 NewSessionButton（状态栏 + 面板）——两套 UI 的彻底收敛是方案 C，另行立项。
- 不动 SessionConfigSelector 本体；不清理因此闲置的 i18n key
  （`createSessionModal.contextWorkspace*`，方案 C 可能复用）。
- 摘要行文案沿用本文件现状（中英混排硬编码），i18n 治理不在本 spec。

## 验收

- `pnpm exec tsc --noEmit` 通过；eslint 对改动文件无新增告警。
- 默认态（无操作）模态高度 ≈ 400px 量级（视工作区数量），创建路径不回归：
  自由会话 / 选主工作区 → 创建，引擎与供应商/模型取记忆值。
- 展开摘要可改引擎与供应商/模型；改动仅作用于新建会话（writeThroughToSession=false 语义不变）。
- 矮窗口（~600px 高）下模态可滚动、底部按钮始终可见可点。

## 决策记录

### 2026-11-01 用户改向：QuickSwitch 入口改为直接复用 + 号面板（方案 A 并入）

- 新增共享组件 `src/components/Chat/session/NewSessionPanel.tsx`（原 NewSessionButton
  内联面板整体迁出：引擎/供应商模型记忆、两步式工作区选择、fixed 视口钳制定位）。
- `NewSessionButton` 瘦身为纯触发器；`QuickSwitchPanel` 的「New Session」改挂
  NewSessionPanel（锚点=点击时按钮 rect，快速面板随即收起），不再渲染 CreateSessionModal。
- CreateSessionModal（已按本 spec 瘦身）保留给 Ctrl/Cmd+Shift+'+'、SessionTabs、
  OverlayGuard 三个入口；后续是否全面退役为方案 C 遗留项。
- 已知行为变化：面板按开/关卸载挂载，引擎选择不再跨开合保留（原 NewSessionButton
  内存态保留），以「创建时写回 cap.kv」的记忆为准——更可预测，如实记录。
- 布局约束：NewSessionPanel 不得渲染在带 transform 的祖先内（QuickSwitch 触发器容器
  有 -translate-y-1/2，transform 会使 fixed 退化为相对该祖先定位）。

### 2026-11-01 用户反馈：QuickSwitch 场景面板越出应用上缘 → 定位改视口居中

- 根因：共享面板的「锚点上方展开」定位为状态栏 + 号设计（按钮贴视口底，上方整屏）；
  QuickSwitch 的锚点在屏幕中部（快速面板顶 = 25%H，会话少时按钮 ~50%H），
  ~550px 面板向上展开顶部越界，且原定位对「面板高 vs 锚点上方空间」无感知。
- 改法：NewSessionPanel 增加 `placement: 'anchor' | 'center'`（默认 anchor）；
  QuickSwitch 传 center（fixed 50%/50% translate 视口居中），+ 号入口维持 anchor 不变。
  QuickSwitchContent 的 onCreateSession 回退为无参（rect 传参随锚点方案一并回退）。
- 双模式共用保险：根 `max-h-[calc(100vh-16px)]` + flex 收缩链——头部/自由会话行/搜索/
  底条 `shrink-0`，工作区列表 `min-h-0 shrink` 是唯一收缩项（内部滚动）。
  根不加 overflow：头部 SessionConfigSelector 下拉向上弹（bottom-full），根滚动容器会裁它。
