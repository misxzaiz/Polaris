# 面板坐标域 + 层叠域（contain:paint 域墙）

> 2026-11-01 定案。背景：Git 面板「推送远程」弹窗全窗口居中被右侧 AI 对话盖住（回归自 aa27251e）。

## 背景与根因

- aa27251e 给左面板保活 wrapper 加 `isolation: isolate`，面板成为独立**层叠域**：面板内弹窗的 `z-modal` 不再与外部比较，对外整个面板是一颗原子绘制单元。
- 存量弹窗（GitPanel PushDialog 等约 20 处）仍按 `fixed inset-0` **视口坐标**写死 → 「几何全局 × 层叠面板」两轴错配：弹窗全窗口居中，而聊天区（DOM 序靠后 + relative 定位内容）绘制在面板原子单元之上，弹窗被盖。
- 定案：**面板开的弹窗应相对面板定位**——「面板 = 坐标域 + 层叠域」。不做 portal 到 body 的反向修法（那是「modal=全局」世界观，与面板域模型冲突）。

## 方案

在域墙（`LeftPanelContent` 的面板保活 wrapper）一次性声明，不逐个改弹窗文件（唯一权威，新增弹窗自动继承面板相对语义）：

1. wrapper 加 `contain: paint` → 依 CSS Containment 规范成为**全部 fixed/absolute 后代的 containing block**：`fixed inset-0` 弹窗自动退化为面板矩形内定位（遮罩与卡片只覆盖面板），层叠问题随几何收敛自然消失（无重叠即无之争）。顺带获得重绘隔离收益。
2. wrapper 加 `data-panel-coordinate-domain` 域墙标记 → 供面板内唯一合法的视口坐标消费者（终端脚本右键菜单 `TerminalScriptContextMenu`：`clientX/Y` + `fixed`，无 portal）在事件处把视口坐标换算为域相对坐标。
3. 弹窗文件的 `fixed inset-0 z-modal` className 一律不动——`fixed` 在域墙内的语义即「面板相对」。

## 所有者

- `src/components/Layout/LeftPanel.tsx`（域墙声明）
- `src/components/Terminal/TerminalScriptPanel.tsx`（右键坐标换算）

## 影响面（审计结论，2026-11-01 全量 grep）

- **受益（自动面板相对化）**：GitPanel 全部 Modal（PushDialog / BranchDialogs×6 / BranchSelector / BlameView / GitignoreTab / CreateBranchFromCommit / CreateTagFromCommit / QuickActions / RebaseTodo / TagsTab×2 / ConflictMerger×2）、TodoPanel×2、RequirementPanel×4、Terminal RunCommandModal、AgentGalleryPanel×3（插件面板）。
- **个案换算**：TerminalScriptContextMenu（唯一 clientX/Y + fixed + 无 portal 的面板内浮层）。
- **不受影响（已核实）**：SelectionContextMenu（App.tsx:487 根部挂载，处理全局划词）、FileExplorer/GitPanel 列表的 absolute 上下文菜单（无 fixed）、终端全屏（flex-1 形态非 fixed overlay）、ActivityBar/ToolSwitcher、App 级弹窗（均在域墙外）。

## 验收

- [ ] `pnpm exec tsc --noEmit` 通过；GitPanel / Terminal / Layout 相关 vitest 通过。
- [ ] 手测：Git 面板点「推送」→ 遮罩与卡片只覆盖左面板矩形、卡片面板内居中；聊天区不被遮罩影响、也不再盖住弹窗。
- [ ] 手测：终端面板脚本列表右键 → 菜单出现在鼠标位置（域相对换算正确）。

## 边界与后续（不在本次范围）

- 大对话框（ConflictMerger / RebaseTodo）在窄面板（200px）内偏挤：拖宽左栏（钳位上限 600px）可用；长期方向是升格 CenterStage tab（已有 `onOpenDiffInTab` 先例，VS Code 同款惯例）。
- 右侧聊天面板（RightPanel）**未**加域墙：聊天侧弹窗仍是视口坐标 + 根层叠，当前可用；是否对称收敛为后续独立决策（聊天侧有悬浮岛/QuickSwitchPanel 等自有浮层生态，需单独审计）。
- 面板内 fixed 菜单贴近面板底缘时可能被 contain 裁剪，如实际遇到再加 clamp。
