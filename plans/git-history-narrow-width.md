# GIT-1..GIT-5 窄宽 GitPanel 提交展示增强 · spec

> 状态：已由交互原型确认逻辑（`git-history-narrow-width`）。实现按原型语义，不偏离。
> 牵涉：`src/components/GitPanel/HistoryTab.tsx`、`historyTabUtils.ts`、`LaneGraph.tsx`、i18n（`git.json` 中英）。

---

## 背景与根因

Git 面板在 **sidebar 形态**下宽度由左侧栏决定（桌面停靠可到 500+px，手机抽屉则 `min(85vw, 360px)` 约 318px）。窄宽时两类问题：

1. **提交信息看不到**：`renderCommitRow` 中 `LaneGraph`（泳道 14px/道）、`sha`、`refs`、`time`、多选钮都是 `shrink-0`，只有 `subject` 是 `flex-1 min-w-0 truncate`。容器越窄，subject 被挤到 0，信息读不到。
2. **展开也没有提交信息**：sidebar 展开 `renderInlineDetails`（`HistoryTab.tsx:1280`）只渲染 author + 统计 + 文件清单，**没有 message 区** —— 长提交的正文完全无处可读。

原型目标（5 条）经交互确认，不强行 "显示全部"，长信息保持"点开可读"。

---

## 需求

### GIT-1 行内 subject 单行截断（已有行为，加固）
- 保持 `truncate`（单行、`text-overflow: ellipsis`），subject 永远独占可伸缩宽度。
- 不改为多行/强制全宽显示。

### GIT-2 展开面板顶部完整展示 commit message
- 位置：sidebar 展开 `renderInlineDetails` 的详情区顶部，新增 message 区。
- 语义（对齐 workbench `CommitDetailsPane:256-266`）：
  - subject 单行（不折叠时）；有 body 时 body 呈现在 subject 下方。
  - 等宽字体、`whitespace-pre-wrap break-words`。
- 展开面板置顶展示 message，不把后续提交挤出视口。

### GIT-3 长 body：先折叠 N 行 → 点开 → 滚动
- body 默认折叠：`-webkit-line-clamp`（约 5 行）+ `overflow:hidden`。
- 有「展开全文」按钮；点开进入 `max-height: 200px; overflow-y: auto` 滚动区。
- 无 body 不显示展开按钮，不显示空 message 区高度。
- 折叠/展开状态按 commit 独立（每行一个），选中切换时重置。

### GIT-4 窄宽降级：subject 独占宽度
- 依据容器宽度（container query）降级：
  - `≤ 360px`：隐藏 `sha`、`time`、`refs`（分支徽章）；subject 独宽。
  - `≤ 400px`（次档）：按原型在 318px 抽屉直接落到最窄档即可，可在 378/399 附近设过渡。
- 阈值与 `LeftPanel` 抽屉宽度（`min(85vw,360px)`，375px 屏≈318px）对齐，至少覆盖 318px。
- 不因隐藏而丢失信息：sha/time 保留在展开面板 meta 行。

### GIT-5 小屏多选入口常显
- 默认多选钮（`Plus`）hover 才显示；窄容器下**常显**（无 hover 的触屏/窄抽屉）。
- 保持选中态 warning 高亮逻辑不变。

---

## 所有者与实现路径

| 项 | 文件 | 路径 |
|---|---|---|
| message 区（GIT-2/3） | `HistoryTab.tsx` | `renderInlineDetails`（~1303 详情容器顶部） |
| 折叠 state | `HistoryTab.tsx` | 复用 `isCommitMessageExpanded`（实现定案：sidebar 与 workbench 渲染路径互斥不会互踩；`loadCommitDetails`/`clearSelection` 已重置，天然获得"切换提交即折叠"语义） |
| 容器查询宿主 | `HistoryTab.tsx` | 列表滚动容器 `scrollContainerRef`（~1535）加 `container-type: inline-size`；或为其父级加 |
| 降级规则（GIT-4/5） | `index.css` | 已落地两档：`@container (max-width: 430px)` 隐藏 refs；`@container (max-width: 378px)` 隐藏 sha/time/refs + 多选钮常显。CSS 档位是唯一权威（TS 侧不留死常量） |
| 常量 | `historyTabUtils.ts` | 已落地 `INLINE_MESSAGE_CLAMP_LINES=5`、`INLINE_MESSAGE_MAX_HEIGHT=200`（经 CSS 变量传入，单一真源） |
| i18n | `locales/zh-CN/git.json` + `en-US/git.json` | 已落地 `history.showFullMessage`（含 `{{count}}` 行数插值）；展开/折叠按钮 title 复用既有 `expandMessage`/`collapseMessage` |
| 多选常显 | container query | `.sel` 钮 / 行 `+` 钮：窄容器 `opacity-100` |

---

## 边界与不回退

- **message 数据源（实现期发现的根因坑）**：`renderInlineDetails(commit)` 的 `commit` 参数是**列表行的 commit**（可能是 subject 截断视图）；完整 message 必须取 `selectedDetails.commit.message`（详情接口返回）。仅用 `commit` 参数做 sha 匹配与 author 展示。
- **长信息不强行显示全部**：行内永远单行 subject，展开面板滚动区高度封顶 200px（列表仍是主信息流）。
- **不破坏 workbench 形态**：container query 宿主是两种形态共用的列表滚动容器（`git-history-list`），workbench 提交列表被拖窄（下限 `COMMIT_LIST_MIN_WIDTH=280`）时同样获得降级——与方案 P3 一致，非回归。
- **Virtual list (`renderVirtualLaneRows`) 行**也走同一 `renderCommitRow`，降级天然生效。
- **pre-wrap / 等宽**：对齐 `CommitDetailsPane` 展示语义，不重新发明。

---

## 验收

- sidebar 展开 commit → message 区出现在文件清单上方；有 body 时默认折 5 行 + 「展开全文」。
- 超长 body → 「展开全文」后 200px 内滚动，不加分页不撑爆列表。
- 抽屉宽（318px）：
  - refs / sha / time 隐藏，subject 单行可读。
  - `+` 多选钮常显、可点、选中态 warning。
- workbench 形态无回归（`pnpm exec tsc --noEmit`、`pnpm lint`、相关 vitest）。
- 双端 i18n 有对应 key。

---

## 测试

- `HistoryTab.test.tsx` 新增：
  - sidebar 渲染 message 区（含 body）与「展开全文」。
  - 展开 → body 可见；再点折叠/切换行重置。
  - 容器窄宽（挂到 jsdom 的 `@container` 不可测，用 `class` 位或逻辑测试降级 class 是否存在）—— 若 container query 无法在 jsdom 断言，则测「CSS 规则已在文档」或降级常量生效。