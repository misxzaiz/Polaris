# Git 与版本管理插件：UI/交互实施规范（GLM 执行版）

> 版本：v1.0 · 日期：2026-11-11
> 状态：**交互设计稿 · 待评审 · 未实施**
> 配套原型：`plans/git-plugin-ui-interaction-prototype.html`（自包含、可离线打开、模拟数据）
> 原型回归：`plans/git-plugin-ui-prototype-check.js`（运行 `node plans/git-plugin-ui-prototype-check.js`，44 项断言全部通过）
> 上位需求：`plans/git-domain-plugin-extraction-requirement.md`
> 前置分析：`plans/git-plugin-ui-prototype-analysis.md`
> 本文目的：让实施者无需猜测布局、状态、宿主接口与验收口径。**本文不是删除内置 Git 的授权。**

---

## 0. 给 GLM 的执行指令

### 0.1 任务目标

在 Polaris 插件仓实现完整的 Git 与版本管理插件，并按本规范补齐主仓宿主契约。最终目标是：

1. 插件承接内置 Git 的全部 UI 与交互能力，不以「轻量入口」代替完整功能。
2. 功能等价优先，其次才做体验增强；AI 不可用、宿主 API 不可用时必须显式降级，不能静默丢失。
3. 插件 zip 安装、升级、禁用回滚和桌面/Web 回归全部通过后，才允许单独提交主仓删码。
4. 任何与本规范冲突的现实约束都要停下并回报，不得自行发明第二套 Git 数据通道。

### 0.2 默认设计基线

为使 UI 和接口可以实施，本稿采用前置分析的推荐方案 A：

- `cap.git` + `services/git/` 保留为**宿主 SCM 插件运行时能力**，不属于待删除的前端 Git 面板实现。
- 插件只经 `host.cap.git`（底层 `router_dispatch`）访问 Git；禁止直调 `git_*`、`__TAURI_INTERNALS__`、新建 git CLI 旁路。
- DiffViewer 作为宿主通用渲染能力保留；Chat patch、中央 diff tab、窄窗口 diff 不得因 Git 插件化而断裂。
- `git.panel` 席位、`panelStates['git']` 与工具切换入口作为宿主通用视图契约保留，只删除内置面板实现。
- H2 AI 会话、H3 编辑器扩展、H4 Tab/Overlay、H5 事件、H6 通用 UI 是主仓增量，不得在插件里绕造。

> 若评审改为「连 cap.git 和 git2 一并删除」的方案 B，本规范的视觉与交互仍然有效，但数据适配层、Web 端方案、等价测试和实施顺序必须重新评审；GLM 不得直接把本稿当成方案 B 的实施依据。

### 0.3 实施硬停点

出现以下任一情况，停止对应阶段并报告，不得用假数据或内置残留掩盖：

- `host.cap.git` 的 action 参数/返回值无法从 `cap.git describe` 与现有类型中确认。
- AI 提交信息无法做到独立 kind 会话、工作区绑定和结果回流。
- 编辑器 gutter/blame/change navigation 无法通过受管扩展点挂载与卸载。
- 200px 侧栏出现横向溢出，或提交/危险操作被遮挡。
- 插件禁用后没有可用回滚路径，或插件未发布就准备删除主仓功能。
- Web-only 端出现尚未登记的能力缺失。

---

## 1. 设计定位与原则

### 1.1 一句话定位

**侧栏是改动流水线，中央区域是宽视图工作台，编辑器是上下文反馈，Chat 是可追问的 AI 会话。**

不把独立 Git 客户端的三栏布局压缩进 LeftPanel；也不把所有功能都弹成模态框。

### 1.2 设计原则

| 编号 | 原则 | 可验收表现 |
|---|---|---|
| D1 | 高频路径短 | `查看改动 → 暂存 → 写信息 → 提交` 不离开侧栏；需要宽 diff 时才进入中央 Tab |
| D2 | 容器决定形态 | 200/360/600px 均为完整功能，仅改变信息呈现方式，不删操作 |
| D3 | 服务端状态唯一 | 文件状态、分支、日志以 cap.git 返回值为准；选择、展开、草稿才是本地 UI 状态 |
| D4 | AI 只建议 | AI 生成提交信息、分组、Review、冲突建议均需人工确认；AI 故障不阻塞普通 Git |
| D5 | 危险操作可解释 | 执行前说明影响范围与快照；执行后提供结果和可用撤销，不用笼统「确定吗」 |
| D6 | 可恢复、可取消 | 长任务有进度和排队状态；取消只承诺后端支持的语义，不假装能撤回已写入操作 |
| D7 | 插件自包含 | 禁止 `import '@/'`；宿主能力只经版本化 API；样式只经插件作用域和主题 token |
| D8 | 键盘与读屏等价 | 所有悬停动作也可通过右键菜单、焦点和键盘到达 |

### 1.3 本轮 UI 不新增的旁支

Submodule、GitFlow、LFS、完整 PR 审查系统不随本规范扩张。已有功能必须保留，但不得以「做得更好」为名重做 diff 算法、会话内核或 Git 引擎。

---

## 2. 四层信息架构

### 2.1 L1：左侧板主面板（默认）

承载 7 个功能页：

| Tab ID | 中文名 | 默认内容 | 宽视图出口 |
|---|---|---|---|
| `changes` | 变更 | 冲突、已暂存、未暂存、未跟踪、提交区 | 单文件 diff、批量 diff |
| `history` | 历史 | 搜索、筛选、lane graph、提交列表、详情 | 提交对比、文件历史、Rebase TODO |
| `branch` | 分支 | 当前分支、本地/远程分支、创建/切换/合并 | 分支图、Rebase TODO |
| `remote` | 远程 | fetch/pull/push、远程列表、上游 | Push 任务详情 |
| `tags` | 标签 | 标签搜索、创建、删除、推送 | 标签指向提交详情 |
| `stash` | Stash | 保存、搜索、应用、弹出、删除 | Stash diff |
| `gitignore` | 忽略 | 规则编辑、模板、追加当前文件 | 大文件编辑器 |

默认页为 `changes`。Tab strip 使用图标、计数与 tooltip，横向可滚动；不得通过「更多」隐藏核心 Tab。

### 2.2 L2：中央 Tab / 全屏工作台

只在以下场景打开：

- 用户点击「在中央打开」；或容器宽度不足且内容无法可读展示。
- 多文件/提交对比、split diff、blame、lane graph 宽视图。
- 三方冲突合并器、Interactive Rebase TODO、长任务详情。

中央 Tab 标题格式：`Git · <文件名>`、`Git · 提交 <shortSha>`、`Git · 冲突解决`。重复打开同一对象应激活已有 Tab，而非无限新建。

### 2.3 L3：编辑器内嵌

- gutter：新增/修改/删除标记，点击打开对应 hunk diff。
- blame hover：提交摘要、作者、相对时间、short SHA；点击跳历史详情。
- Alt+Up / Alt+Down：当前文件的上一处/下一处改动；到边界时循环与否须与内置现状一致。
- 窄窗口 diff：使用宿主通用 DiffViewer，不由插件另写简化版。

### 2.4 L4：Chat 与文件树

- AI 提交信息在独立 kind 会话执行，右侧面板展示完整会话；侧栏仅显示最新建议摘要和「采用」。
- `@git`、`@git diff`、`@git commit`、`@git log`、`@git branch` 通过 Chat 输入贡献点注册。
- 文件树状态徽章复用宿主贡献点，颜色使用语义 token；点击徽章打开对应文件 diff。

---

## 3. 侧栏布局与响应式规范

### 3.1 纵向结构

```text
┌──────────────────────────────┐
│ 仓库选择 / 当前分支 / 刷新 / 更多 │  40px，固定
├──────────────────────────────┤
│ 7 个功能 Tab                  │  36px，固定，横向滚动
├──────────────────────────────┤
│ 同步状态 / 冲突 / 错误 / 选择条 │  按状态出现，不预留空白
├──────────────────────────────┤
│                              │
│ 当前功能页滚动区               │  flex:1; min-height:0
│                              │
├──────────────────────────────┤
│ AI 建议（有会话结果时出现）     │  可折叠，最多 2 行摘要
│ 提交信息 + 范围 + 提交按钮      │  仅 changes 且有变更时显示
└──────────────────────────────┘
```

提交区是正常 flex 子节点，不使用覆盖文件列表的绝对定位。长列表与提交区各自拥有正确滚动边界。

### 3.2 容器宽度断点

实现必须使用 `ResizeObserver` 或 CSS container query 观察**插件实际容器**，不能只用 `window.innerWidth`。

| 实际宽度 | 模式 | 规则 |
|---|---|---|
| 200–279px | `narrow` | 仅图标 Tab；文件目录让位文件名；次要动作收进行菜单；点击文件默认中央 diff；提交按钮仅图标+可访问名称 |
| 280–420px | `regular` | 单列；文件行显示短目录；内联 unified diff；提交按钮显示「提交」 |
| 421–600px | `wide` | 可展开内联详情；diff 可切 split；提交区可显示 amend 与范围详情 |
| 中央 Tab / fullscreen | `workbench` | 允许双栏/三栏；侧栏宽度规则不再套用 |

其他要求：

- 所有 row 使用 `min-width:0`，路径用 ellipsis，`title` 提供完整路径。
- 图标按钮视觉尺寸可为 28×28px，但指针热区至少 32×32px；触屏/compact 模式至少 40×40px。
- 200px 下禁止横向页面滚动；仅 Tab strip、代码/diff 内容允许自身横向滚动。
- 宽度改变不丢失提交草稿、选择集、滚动位置和正在执行的 AI 会话。

### 3.3 状态优先级

同一时刻多个状态出现时，按以下顺序展示，避免横幅堆叠：

1. 模态确认/冲突合并器。
2. 正在执行的写操作与长任务。
3. 冲突横幅。
4. 读取/权限错误。
5. AI 建议。
6. 同步状态和普通提示。

错误不能只用 toast；需要用户处理或重试的错误必须留在对应内容区。

---

## 4. 核心组件与交互合同

### GP-01 仓库与分支头

**内容**：仓库选择器、当前分支、ahead/behind、刷新、更多。

- 冷启动从 `host.workspace.current()` 自动绑定，禁止手填路径作为主流程。
- 工作区本身不是仓库但含嵌套仓库时，显示仓库卡片列表；选择只改变当前面板仓库，不切换宿主工作区。
- 工作区切换后：使旧请求失效、解除旧事件订阅、清理旧仓库选择/缓存，再加载新状态。
- 分支按钮打开分支选择浮层，支持搜索；有未提交改动时切换分支需显示现有风险确认。
- 刷新按钮在加载中显示进度，不得重复发起并发全量刷新。
- 「更多」包含操作流水、撤销快照、全屏工作台、插件信息与快捷键。

### GP-02 变更列表

分组顺序固定：`冲突 → 已暂存 → 未暂存 → 未跟踪`。无内容的组不占位。

**文件行从左到右**：选择框、状态字母、文件名与短目录、行级主操作、更多菜单。

- 单击文件名：预览 diff；单击选择框：只改变选择，不打开 diff。
- Shift+点击选择框：从锚点连续选择；Ctrl/Cmd+A：仅在列表焦点内全选可见变更。
- Enter：打开焦点行 diff；Space：切换选择；Escape：先清多选，再关闭当前浮层。
- 行级主操作：未暂存/未跟踪为「暂存」，已暂存为「取消暂存」。
- 右键菜单包含：打开文件、中央打开 diff、Blame、暂存/取消暂存、丢弃、加入 `.gitignore`、复制路径。
- 大于 200 个变更时启用虚拟化；选择状态以 path/area 为键，不能依赖列表索引。
- 操作成功后由最新 status reconcile，不在前端手工伪造最终服务端状态。

### GP-03 多选操作条

出现选择集时，在列表上方显示：`已选 N 项`、可用批操作数、暂存、更多、清除。

- 只展示当前选择集实际可执行的动作；禁用项必须说明原因。
- 批量丢弃需列出文件数和不可恢复项，执行前创建可用快照。
- 操作期间保持选择集只读，防止重复提交；失败后保留选择，成功后清空已不存在项。

### GP-04 提交区

**默认展示范围**：有显式选择集时为「提交已选 N 个文件」，否则为「提交 N 个已暂存文件」。范围文案必须与后端请求参数一致。

- 普通提交要求非空 message；amend 允许空 message 表示 `--no-edit`。
- 无可提交内容时按钮禁用，并在附近说明原因，不允许点击后才报错。
- Ctrl/Cmd+Enter 提交；输入框正在生成 AI 或写操作执行中时禁用提交。
- 提交成功后清空 message、amend 与选择；失败时保留全部草稿和选择。
- amend 已推送提交时给警告，不默认强制推送。
- 提交按钮主文案始终为「提交」或「修改提交」，加载时改为「提交中…」并防重。

### GP-05 AI 提交信息

入口是提交框右上角的火花按钮；点击后先展示引擎选择，再启动/复用会话。

**流程**：

```text
点击 AI
  → 固化 { workspaceId, repositoryPath, selectedPaths, diffRevision }
  → 创建/复用 plugin:polaris.git:commit-message 会话
  → Chat 显示上下文 chips 与流式生成
  → 侧栏出现建议卡（摘要 + 生成状态）
  → [采用] [在对话中继续] [重新生成]
  → 采用只写提交输入框，不自动提交
```

硬性规则：

- 生成期间的仓库和文件范围显示在会话顶部；后续变更不得偷偷混入已发起请求。
- 采用前若工作区或选择范围已变化，提示「建议基于旧改动生成」，由用户确认仍采用或重新生成。
- 会话可追问，例如「更简短」「使用中文」「改为 feat 类型」；追问保持在同一 kind 会话。
- 生成中禁止采用不完整文本；失败后保留输入框已有内容。
- AI 不可用/无权限时，按钮显示不可用原因，其余 Git 功能正常。

### GP-06 Diff 预览与中央 Diff

**侧栏内联预览**：文件路径、返回、unified/split（宽度允许时）、中央打开、打开文件、Blame。

- narrow 模式不渲染复杂内联 diff，直接提供中央 Tab。
- 大文件、二进制、内容省略、加载失败均有专用状态；不能展示空白。
- 保留字级高亮、Web Worker、窗口化与行级选区 stage 的既有能力。
- 中央 Tab 关闭不影响侧栏选择；侧栏仓库切换后，中央 Tab 必须保留其仓库上下文或明确标记过期，不得串仓库。

### GP-07 历史与详情

- 搜索框支持消息/SHA/作者；高级筛选放入可展开行，不长期挤压列表。
- 提交行展示 lane、摘要、refs、作者、相对时间；选中行打开详情。
- Ctrl/Cmd+点击多选，Shift+点击区间选择；选择两个提交后显示「对比」。
- 详情包含完整 message、SHA、作者/时间、父提交、文件列表；文件项可打开 diff。
- 右键提供创建分支/标签、cherry-pick、revert、checkout、rebase 等既有动作。
- 分页失败在列表底部内联重试；已有提交不能因加载下一页失败而消失。

### GP-08 分支、远程、标签、Stash、Gitignore

- **分支**：当前分支置顶，本地/远程分组；创建、重命名、删除、合并、rebase 入口保持现有语义。
- **远程**：fetch/pull/push 是长任务；显示 remote、branch、进度、排队/执行/完成/失败；force push 默认提供 `--force-with-lease`，不默认 hard force。
- **标签**：标注指向提交；删除远程标签是独立危险操作，不能和删除本地标签混为一个无差别确认。
- **Stash**：保存可输入说明；apply 与 pop 文案明确区分；查看内容走 diff；drop 需要确认。
- **Gitignore**：编辑、模板插入、保存；保存前显示磁盘状态是否已变化，避免覆盖外部编辑。

### GP-09 冲突与三方合并

冲突横幅固定显示未解决数量和「解决冲突」。

- 合并器必须放在中央/全屏，不塞入 200–600px 侧栏。
- 三窗为 current/base/incoming 与 result 的既有语义组合；标签随 merge/rebase/cherry-pick 变化。
- 每个冲突块提供接受 current/incoming/both/手动编辑；未解决计数实时更新。
- 「标记已解决」仅当前文件无未解决冲突时可用；成功后进入 staging，需由 status 验证。
- AI 建议默认折叠且只生成草稿，接受前必须人工确认。

### GP-10 危险操作确认与 Undo

统一四步：

```text
收集影响 → 创建快照 → 确认对话框 → 执行并给出结果/撤销
```

确认框必须包含：操作名称、仓库/分支、影响列表、不可恢复项、快照状态、主次按钮。

- 主危险按钮使用具体动词，如「丢弃 3 个文件」，不写「确定」。
- 快照创建失败时，破坏性操作默认不继续；若既有能力允许无快照继续，必须单独明示风险。
- 未跟踪文件删除等无法快照恢复的项目单独列出。
- Undo 只显示后端确认存在的快照；恢复也是写操作，需要冲突/覆盖检查。

### GP-11 长任务与通知

任务状态：`queued → running → succeeded | failed | cancelled`。

- 排队中可取消；执行中的取消按钮是否可用由后端能力决定。当前 cap.git 写操作已开始后不可承诺安全半途取消。
- 页面切 Tab 不取消任务；任务完成后面板即使隐藏，重进也能看到结果。
- toast 用于短暂成功反馈；失败详情、重试和日志入口留在任务卡片。
- 同一仓库写操作遵循 FIFO，不以前端并发绕过。

---

## 5. UI 状态模型

### 5.1 状态归属

| 状态 | 归属 | 持久化 |
|---|---|---|
| status/log/branches/diff/conflict | 服务端快照，经 repository store 缓存 | 按既有 cap/仓库缓存语义 |
| activeTab、展开组、diff mode | 面板 UI state | 可按插件配置保存 |
| selectedPaths、选择锚点、焦点 | 当前仓库 UI state | 不跨仓库恢复 |
| commit draft、amend | 当前仓库草稿 | 建议按 `workspaceId + repoPath` 保存 |
| AI sessionId、建议、streaming | host.ai 会话 + 面板映射 | 会话由宿主持久化 |
| dialog/menu/popover | 临时 UI state | 不持久化 |
| task/progress | cap 任务事件 | 宿主任务状态为准 |

### 5.2 请求一致性

每个仓库维护 `workspaceEpoch` 与 per-request sequence：

- 工作区/仓库切换时递增 epoch；旧 epoch 的响应不得写入新仓库状态。
- status、log、diff 分别维护请求序号，后发起的同键请求优先。
- 写操作完成后主动 reconcile 受影响状态；不能仅依赖 watcher。
- AI 流式写文件期间抑制自动 status 刷新，结束后立即刷新一次；不得轮询替代事件。
- `repo_touched` 只触发受影响范围 reconcile，禁止整仓所有 Tab 全量刷新。

### 5.3 标准页面状态

每个数据页至少实现：

| 状态 | 展示 | 操作 |
|---|---|---|
| initial loading | 结构骨架，不伪造数据 | 无 |
| refreshing | 保留旧内容，头部显示刷新 | 可继续查看，写操作按情况禁用 |
| empty repository | 分支与初始化说明 | 初始化仓库 |
| clean | 「没有未提交改动」+ 最近提交入口 | 查看历史/刷新 |
| no result | 搜索无结果 | 清除筛选 |
| error | 人类可读错误 + 错误详情 | 重试/打开日志 |
| no workspace | 说明尚未选择工作区 | 打开宿主工作区选择 |
| no permission | 说明缺失权限 | 打开插件权限设置，不反复请求 |
| offline/remote failure | 保留本地可用内容 | 重试远程操作 |

### 5.4 派生展示标志必须由真实数据驱动

所有"状态类"UI 只能由服务端快照或已 reconcile 的本地真相派生，禁止由演示开关、局部 UI flag 或一次性请求结果长期驱动：

- 冲突横幅、`U` 状态文件组、ahead/behind 徽章、脏工作区指示，必须由 `conflicted` / `status` 快照计算；写操作（标记已解决、提交、丢弃、撤销）完成后立即 reconcile，不得出现"提示仍显示冲突但列表已解决"。
- 禁止把演示场景标志（如原型里的 `scenario`）当作生产状态源；原型回归中已修复一次此类缺陷（冲突横幅由场景 flag 驱动，解决冲突后不消失）。
- `busy` / `streaming` 等瞬时标志必须在成功、失败、取消三条路径上都有复位；失败路径不得留下永久 loading。
- 任何计数文案（冲突数、选中数、变更数）从同一份数据实时计算，不允许硬编码。

---

## 6. 宿主 API 契约（主仓必须同步提供）

以下为**目标契约**。字段名为实施基线；若主仓已有等价契约，可适配但不得降低语义。所有 API 经 `pluginId` 鉴权，调用方不能伪造来源。

### 6.1 Panel props 与能力发现

```ts
interface GitPluginPanelProps {
  pluginId: string
  host: GitPluginHost
}

interface GitPluginHost {
  apiVersion: '1'
  capabilities: {
    has(name: 'scm.git' | 'ai.sessions' | 'editor.extensions' | 'ui.tabs' | 'events.repo'): boolean
  }
  workspace: HostWorkspaceGateway
  cap: HostCapabilityGateway
  ai?: HostAiGateway
  ui: HostUiGateway
  events: HostEventGateway
  config: HostPluginConfigGateway
}
```

- 缺少可选能力时显示明确降级，不调用不存在的方法。
- 缺少 `scm.git` 时整个面板显示「需要升级 Polaris 主应用」，而不是空白或手填路径兜底。

### 6.2 工作区 H1

```ts
interface HostWorkspaceSnapshot {
  id: string
  name: string
  path: string
}

interface HostWorkspaceGateway {
  current(): HostWorkspaceSnapshot | null
  list(): HostWorkspaceSnapshot[]
  subscribe(listener: (current: HostWorkspaceSnapshot | null) => void): () => void
}
```

`subscribe` 注册后立即推送当前快照。插件可以读取工作区，但仓库选择不等于切换宿主工作区。

### 6.3 Git 能力网关

```ts
interface HostCapabilityGateway {
  git<T>(action: string, params: { workspacePath: string } & Record<string, unknown>): Promise<T>
  describeGit(): Promise<Record<string, unknown>>
  cancel(taskId: string): Promise<void>
}
```

底层唯一实现：

```ts
__POLARIS_HOST_INVOKE__('router_dispatch', {
  req: { target: 'cap.git', payload: { action, ...params } }
})
```

- 必须检查 envelope 的 `ok/result/error`，非 2xx/业务失败统一转异常。
- action 与 casing 以 `cap.git describe`、`git_capability.rs`、`models/git.rs`、`types/git.ts` 为准，禁止猜参数。
- 插件 bundle 中不得出现 `git_get_status` 等旧 Tauri 命令直调。
- UI 面板来源与 AI/插件进程来源的权限不同，不得利用 Bootstrap 来源绕过插件权限治理；H1 网关需按 pluginId 施加允许动作矩阵。

### 6.4 AI 会话 H2

```ts
interface HostAiGateway {
  createSession(input: {
    kind: 'commit-message' | 'git-atomic' | 'git-review' | 'git-conflict'
    workspaceId: string
    workspacePath: string
    title?: string
  }): Promise<{ sessionId: string }>
  send(input: {
    sessionId: string
    content: string
    oneTimeSystemPrompt?: string
    engineId?: string
  }): Promise<void>
  subscribe(sessionId: string, listener: (state: HostAiSessionState) => void): () => void
  open(sessionId: string): void
  listSessions(filter: { kind: string; workspaceId: string }): Promise<Array<{ sessionId: string }>>
  getEngineCapabilities(engineId?: string): Promise<HostEngineCapabilities>
}

interface HostAiSessionState {
  latestAssistantText: string
  isStreaming: boolean
  error?: string
  revision: number
}
```

宿主实际 kind 必须命名空间化为 `plugin:<pluginId>:<kind>`；插件只能访问自己创建的会话。宿主不得把当前活跃主会话当作回流通道。

### 6.5 UI、编辑器与事件 H3–H6

```ts
interface HostUiGateway {
  openDiffTab(input: OpenDiffTabInput): Promise<{ tabId: string }>
  openFile(input: { workspacePath: string; filePath: string; line?: number }): Promise<void>
  openOverlay(input: { kind: 'merge' | 'rebase-todo' | 'task'; payload: unknown }): Promise<void>
  setFullscreen(enabled: boolean): void
}

interface HostEventGateway {
  subscribe(
    event: 'workspace-changed' | 'file-system-change' | 'repo_touched' | 'cap-task-progress',
    listener: (payload: unknown) => void
  ): () => void
}
```

`contributes.editorExtensions` 采用声明式能力 + 受管工厂：宿主拥有 CM6 实例、注册/卸载和热重载；插件只获得受限上下文，不能持有宿主任意内部对象。

`contributes.tabRenderers` 与 overlay 需要 schema 前后端镜像校验。`DiffViewer` 由 `host.ui` 提供或经宿主批准的通用渲染入口复用，不能 `import '@/components/Diff'`。

### 6.6 异步订阅纪律

宿主 listen 可能返回 `Promise<unlisten>`。所有封装必须像 `terminal-desk/src/bridge.ts` 一样处理未决期退订，保证 React StrictMode 双挂载下 cleanup 永远是同步函数，重复退订安全。

---

## 7. Manifest 与插件工程约束

### 7.1 Manifest 基线片段

```json
{
  "id": "polaris-git",
  "name": "Git 与版本管理",
  "version": "0.1.0",
  "enabledByDefault": false,
  "contributes": {
    "views": [{
      "id": "polaris-git.panel",
      "area": "activityBar",
      "panelType": "git",
      "icon": "GitPullRequest",
      "labelKey": "plugins.polaris-git",
      "labelDefault": "Git 与版本管理",
      "order": 20,
      "slot": "git.panel",
      "slotMode": "shadow"
    }],
    "panel": {
      "entry": "./dist/panel.js",
      "supportsFullscreen": true
    }
  },
  "permissions": {
    "workspaceRead": true,
    "appConfigRead": true,
    "appConfigWrite": true,
    "aiToolAccess": true
  }
}
```

新增 `editorExtensions/tabRenderers` 在 schema 实现后再加入，不得先写一个宿主忽略的声明。`author` 等商城元数据只放 `index.json`，不得放入 `plugin.json/update.json`。

### 7.2 推荐工程结构

```text
plugins/polaris-git/
  plugin.json
  update.json
  src/
    index.tsx                 # 仅注册与根组件
    Panel.tsx                 # 四层容器中的 L1 根
    host/
      index.ts                # 能力发现与版本门
      capGit.ts               # 唯一 Git 数据入口
      workspace.ts
      ai.ts
      events.ts
    model/
      types.ts                # 从真实契约生成/对齐
      repositoryStore.ts      # 服务端快照、epoch、reconcile
      uiStore.ts              # 纯 UI 状态
    components/
      RepositoryHeader.tsx
      PanelTabs.tsx
      changes/
      history/
      branches/
      remotes/
      tags/
      stash/
      gitignore/
      shared/
    workbench/
      DiffTab.tsx
      MergeEditor.tsx
      RebaseTodo.tsx
    editor/
      gutter.ts
      blame.ts
      navigator.ts
    styles.css
    locales/
  tests/
```

组件按功能组织，但 `host/` 是唯一能接触 window 全局的层。UI 组件禁止直接读取 `window.__POLARIS_*`。

---

## 8. 视觉与样式规范

### 8.1 Token 使用

生产样式只允许消费宿主语义变量：

| 用途 | Token |
|---|---|
| 主背景/表面/浮层 | `--c-bg-base` / `--c-bg-subtle` / `--c-bg-elevated`（按宿主实际变量校验） |
| hover/active | `--c-bg-hover` / `--c-bg-active` |
| 主/次/弱文本 | `--c-text-primary` / `--c-text-secondary` / `--c-text-tertiary` |
| 边框 | `--c-border`，必要时使用宿主 subtle 变体 |
| 主操作/选中 | `--c-primary` / `--c-primary-hover` |
| 成功/危险/警告/信息 | `--c-success` / `--c-danger` / `--c-warning` / `--c-info` |

写法：`color: rgb(var(--c-text-primary));`。禁止在插件组件中硬编码 `#1E1E24` 等主题色。

Git 状态语义：

- M = warning，A = success，D/U = danger，R = info。
- 颜色不是唯一信息，必须同时显示字母或文本。
- ahead/behind 使用 ↑/↓ + 数字及可访问名称，不仅靠红绿。

### 8.2 尺寸与排版

| 项 | 规范 |
|---|---|
| 根字号/行高 | 13px / 20px |
| 辅助文本 | 11–12px，行高至少 16px |
| 文件名/提交摘要 | 12–13px，单行 ellipsis |
| SHA/diff/路径详情 | 宿主等宽字体栈，11–12px |
| 面板水平内边距 | narrow 8px；regular/wide 12px |
| 文件行高 | 32px；compact 触屏 40px |
| 圆角 | 控件 6px；卡片/对话框 8–10px |
| 控件间距 | 4/8/12px 阶梯 |
| 焦点 | 2px 可见 focus ring，不能只改背景色 |

所有类名使用 `pg-` 前缀，根节点位于 `[data-plugin-scope]` 下；不得写全局 `button`、`input`、`.active` 等未限定选择器。

### 8.3 动效

- hover/selection 过渡 100–160ms；对话框 160–200ms。
- 加载 spinner 仅用于正在等待的区域，不整页闪烁。
- `prefers-reduced-motion: reduce` 下取消位移动画和非必要 spinner 动效。
- diff 与长列表不得用布局动画影响滚动性能。

---

## 9. 键盘、焦点与可访问性

| 快捷键 | 作用域 | 行为 |
|---|---|---|
| F5 | 面板可见且非输入/对话框 | 刷新当前仓库状态 |
| Escape | 当前最内层 | 菜单 → 对话框 → 清多选 → 退出内联预览，逐层处理 |
| Ctrl/Cmd+Enter | 提交输入区 | 满足条件时提交 |
| ↑/↓ | 文件/提交列表 | 移动焦点，不自动执行操作 |
| Enter | 列表行 | 打开 diff/详情 |
| Space | 列表行 | 切换选择；按钮上保留原生行为 |
| Shift+Space | 列表行 | 区间选择 |
| Ctrl/Cmd+A | 列表焦点内 | 全选当前可见列表；输入框内不劫持 |
| Alt+Up/Down | 编辑器 | 上一处/下一处 Git 改动 |

- Tab 顺序与视觉顺序一致；浮层打开时焦点进入，关闭后返回触发按钮。
- 模态框使用 `role="dialog" aria-modal="true"` 并锁定焦点；Escape 行为与取消一致。
- Tab strip 使用 `role="tablist"`/`tab`/`tabpanel` 与 `aria-selected`。
- 状态更新用克制的 `aria-live="polite"`；危险错误使用 `role="alert"`。
- 图标按钮必须有 `aria-label` 和 tooltip；禁用原因可被发现。
- 明暗主题文本与关键控件对比度至少 4.5:1，非文本边界/焦点至少 3:1。

---

## 10. 文案与 i18n

- 文案命名空间：`polaris-git`，按 `panel/changes/commit/diff/history/branch/remote/tags/stash/gitignore/conflict/errors` 分组。
- 至少提供 `zh-CN` 与 `en-US`；不得把中文硬编码为唯一文案。
- 所有动态文案使用插值，不拼接语序，例如 `commit.selectedFiles`。
- 错误展示宿主映射后的人类可读信息，技术详情可展开复制。
- 成功 toast 简短；涉及恢复时提供明确「撤销」动作而非仅文本。

---

## 11. 原型操作地图

打开 `git-plugin-ui-interaction-prototype.html` 后，可评审以下路径：

1. 顶部切换 240/360/560px，观察同一面板的信息重排。
2. 切换明暗主题与「正常/冲突/加载/错误/干净」场景。
3. 变更页选择文件、暂存/取消暂存、打开 diff、在中央查看。
4. 点击 AI 生成，等待建议回流；采用到提交框，或打开独立 Chat 会话。
5. 使用提交按钮或 Ctrl/Cmd+Enter 查看提交结果；原型不会执行真实提交。
6. 切到历史、分支、远程、标签、Stash、Gitignore 检查信息架构。
7. 从危险操作菜单打开确认框，检查影响、快照和按钮文案。
8. 冲突场景中打开三方合并器，检查中央/全屏承载方式。

**原型边界**：HTML 使用模拟数据，只证明交互和视觉，不证明 cap.git、AI、编辑器、桌面/Web 或热更新可行。这些必须由第 12 节的真宿主纵切验证。

---

## 12. GLM 实施顺序与提交边界

### Phase 0：契约与等价基线（主仓，单独提交）

1. 从 `cap.git describe`、现有 `types/git.ts`、组件与测试导出功能/action 矩阵。
2. 实现 H1–H6 的版本化宿主契约与 schema 镜像校验。
3. 为主仓契约增加单元/集成测试；记录现有桌面/Web 差异。
4. 产出：API 文档、权限矩阵、能力检测、回滚策略。

**门禁**：没有 H2/H3，不得宣称完整迁移开始。

### Phase 1：真宿主可运行纵切（插件仓 + 主仓联调）

1. 新建 `polaris-git` 自包含插件包，`enabledByDefault:false`。
2. 实现工作区自动绑定、shadow 接管、主题/i18n、错误边界。
3. 只实现 `status → diff → stage → commit`，全部真 cap.git 数据。
4. 接入一个 AI 提交信息会话与一条 gutter 扩展，验证 H2/H3。
5. 在 200/360/600px、compact、明暗主题、桌面/Web 下验收。

**门禁**：五条链路全部跑通后才进入全量 UI 搬迁。

### Phase 2：逐域承接（插件仓，小步提交）

顺序建议：changes/commit → diff/history → branch/remote/tags/stash/gitignore → conflict/rebase/undo → Chat 与编辑器全量。

每步保持：

- 功能等价清单逐项标注「保留/增强/降级」，降级项必须为 0。
- 测试跟随功能迁移，禁止只复制 UI 不复制行为测试。
- 不在主仓保留另一套可写 Git 路径。

### Phase 3：发布、切换与删码（分开提交）

1. 插件 zip 安装/升级/禁用回滚实测，发布链和 sha 校验通过。
2. 主仓切换到插件实现并完整回归。
3. 单独 commit 删除内置实现与死注册；通用 DiffViewer 等救援项明确保留。
4. 同步 `AGENTS.md`、core-slimdown §4.3、2026-08 旧方案和需求状态。

**禁止**：插件未可安装前删主仓；把内置保留作为隐藏兜底；一次提交混合宿主 API、插件全量实现和主仓删码。

---

## 13. 验收清单

### 13.1 交互验收

- [ ] 200/240/280/360/420/600px 与 compact 无横向页面溢出，提交区不被遮挡。
- [ ] 宽度/主题/Tab 切换不丢草稿、选择、滚动位置和 AI 会话。
- [ ] 工作区冷启动自动绑定；切换后旧响应和旧 watcher 不污染新仓库。
- [ ] status → diff → stage → commit 全真数据，提交范围文案与请求一致。
- [ ] AI 在独立 kind 会话，可追问、可回流；采用不自动提交；AI 故障不影响普通 Git。
- [ ] 7 个 Tab 与既有右键/对话框/高级功能全部有等价入口。
- [ ] gutter/blame/Alt+Up/Down、Chat `@git`、文件树徽章均可用。
- [ ] 冲突合并、Rebase TODO、宽 diff 在中央/全屏，不发生侧栏挤压。
- [ ] 危险操作有影响说明、快照、具体确认按钮与可用 Undo。
- [ ] 长任务排队/执行/失败/取消语义与后端一致，无虚假「已取消」。
- [ ] 冲突解决/提交/撤销后，冲突横幅、计数与徽章同步 reconcile（§5.4）。

### 13.2 工程验收

- [ ] 插件无 `@/` 依赖、无旧 `git_*` 直调、无绕过权限的第二数据通道。
- [ ] 主题色全部来自宿主 token；插件 CSS 不泄漏；中英文文案完整。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm test:run` 通过。
- [ ] `cargo check` 与 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过。
- [ ] 本机无法执行的 Rust 测试明确留 CI，不虚报通过。
- [ ] 桌面与 Web-only 均人工冒烟；缺项显式列出且不得进入「功能等价」结论。
- [ ] 插件安装、热更新、禁用回滚可用；主仓删除 commit 可独立 revert。
- [ ] 文档唯一权威同步，无「保留内置」与「已删除」两份冲突结论。
- [ ] `node plans/git-plugin-ui-prototype-check.js` 的 44 项原型断言全部通过；改动原型后须同步更新该脚本。

### 13.3 性能回归

沿用现有 PRD 预算作为回归起点：中型仓库首次 log p50 < 300ms、缓存命中 p50 < 80ms、AI 停止写入后 status ≤ 1s 更新、1k commits 滚动无可感跳跃。插件化不得引入固定轮询、全量 Tab 刷新或重复 diff 计算。

---

## 14. 评审仍需确认的事项

1. 正式确认方案 A 的删除边界；若选 B，重做数据与双端实施评审。
2. 确认 H2/H3/H4/H5/H6 由主仓提供，并纳入实施排期。
3. 确认本规范的四层交互和 HTML 原型，而不是恢复旧固定三栏。
4. R2「做得更好」本稿仅具体化为：容器自适应、AI 会话范围可见、危险操作影响透明、长任务状态可见、插件独立发版/热更新。新增增强不得挤占 R1。
5. 全量迁移前是否先冻结/收尾 git-panel 正在演进的 P0–P3 与 R6 E 组。

---

## 15. 可直接粘贴给 GLM 的启动语

> 请严格按 `plans/git-plugin-ui-implementation-spec.md` 实施，并用 `plans/git-plugin-ui-interaction-prototype.html` 核对交互。先执行 Phase 0 和 Phase 1，不要直接复制旧 GitPanel，也不要删除主仓内置实现。所有 Git 数据只经版本化宿主网关到 `cap.git`；禁止 `@/`、旧 `git_*` 直调和模拟数据冒充真实现。先提交宿主契约、action 等价矩阵与真宿主纵切验证结果；遇到第 0.3 节硬停点立即停止并报告。未经我另行批准，不进入 Phase 3 删码。
