# Git 面板插件化：实施记录与评审交付（①–⑥）

> 状态：**已实施 · 待合并**（用户 2026-11-12 授权：「将git面板移除，然后在插件提供git面板查询」+ 口头裁定两项范围）
> 实施分支：主仓 `feat/git-panel-to-plugin`（worktree `D:\space\base\Polaris-wt\git-plugin-panel`）· 插件仓 `feat/polaris-git-panel`
> 上位文档：`plans/git-plugin-ui-implementation-spec.md`（UI/交互规范）、`plans/git-domain-plugin-extraction-requirement.md`（需求登记）、`plans/git-plugin-ui-prototype-analysis.md`（四条宿主关系分析）
> 效力说明：本轮为用户明确授权下的**范围缩减实施**（面板移除 + 插件查询/暂存/提交），非 spec 全量 R1/R2 迁移；偏差逐条列于 §5/§6。

## 0. 用户裁定记录（2026-11-12，AskUserQuestion 答复）

| # | 问题 | 裁定 |
|---|---|---|
| 1 | 本轮是否包含「移除主仓内置 GitPanel」（spec §0.1 称删除需另行授权） | **包含删码**：插件真宿主验证通过后，单独 commit 移除内置面板（保留共享资产），删除 commit 可独立 revert |
| 2 | 插件面板能力范围 | **查询+暂存提交**（Phase 1 纵切写路径）；不含 AI 提交信息会话（需 H2）、编辑器 gutter（需 H3）、中央 Tab（需 H4） |

## ① 边界与待裁定项清单

**已裁定**（本文 §0 两项 + 下表）：

| 项 | 裁定 | 依据 |
|---|---|---|
| cap.git / services/git（git2 引擎）归属 | **保留宿主**（方案 A），重定义为「宿主 SCM 插件运行时能力」 | 原型分析 §3：方案 B 需插件自带引擎，50+ action porcelain 对齐/冲突/lane graph 无等价保证 |
| DiffViewer | **保留宿主**（通用渲染能力，12 处消费：Chat PatchDiffRenderer/CenterStage diff tab/NarrowTabOverlay） | 原型分析 §2.4/H6 |
| gitStore / gitEditorService / 编辑器三扩展（gutter/blame/changeNavigator） | **保留宿主**：FileExplorer GitStatusIndicator 徽章、CenterStage diff tab、Editor collectExtensions 均为面板外消费者 | 勘察实测（消费者清单见 §3 附录） |
| git.panel 席位 / panelStates['git'] / toolSwitcher git 条目 | **保留**，内置面板实现换成 GitPanelPlaceholder 占位 | 原型分析 §2.3 建议；tab strip/宽度记忆/工具切换器零改动 |
| 面板外 AI 服务（commitMessageChat/atomicCommitChat/gitAtomicGrouping/gitNlQuery/gitContextService） | **随面板删除**（删后零生产消费者，逐个 grep 复核） | 死代码卫生；sessionStoreManager 的 kind 保护保留（会话核心不动） |
| i18n git.json（649 key） | **保留**：DiffViewer/FileNavigator/NarrowTabOverlay/CenterStage 仍消费 git.diff.* 等 | 删则断共享渲染面 |

**仍待裁定**（本轮不做，列出供后续批次）：

1. 插件承接 discard/分支写/fetch/pull/push/stash 写/冲突合并器/Rebase TODO 的批次与顺序（现由谁做？内置已删，这些能力**当前无处承载**——见 §6 缺口 G1）。
2. H2 host.ai 会话契约（AI 提交信息）落地排期。
3. H3 contributes.editorExtensions 契约落地排期（gutter/blame 现仍内置，未插件化）。
4. H4 tabRenderers/Overlay/Fullscreen 契约（中央 diff/合并器宽视图）。
5. Web-only 端插件面板的系统性回归（本轮 Web 通道为代码级验证：router_dispatch Remote 放行 + 插件面板同源，未做真机 Web 冒烟）。

## ② A/B 方案对比（数据通道）

| 维度 | A：保留 cap.git + services/git（**已采纳**） | B：连引擎一起删 |
|---|---|---|
| 插件数据通道 | `__POLARIS_HOST_INVOKE__('router_dispatch') → cap.git`（唯一通道） | 插件自带 Node git CLI 或独立 Rust 进程 |
| 权限/审计/WRITE_GATE | 宿主总线统一承担，写串行 FIFO 不中断 | 需在插件侧重建或放弃 |
| 功能等价风险 | 低：git2 引擎与内置同源，77 action 由 KNOWN_ACTIONS+契约测试单源锁定 | 高：porcelain 行为对齐、rebase/冲突/undo 全部重验 |
| Web-only | 天然可用（dispatch_router_dispatch Remote 放行） | 需解决 CLI/进程在 Web 端可用性 |
| 双端 AI 工具同源 | UI 与 AI 同走 cap.git，状态/错误语义单一 | 两套引擎两套语义（2026-08 失败根因之一） |

**本轮实证**：插件经 A 通道真宿主完成 stage→commit 落库（`a23e684` 独立 git 复核），审计链/WRITE_GATE 行为由宿主承担，零插件侧旁路。

## ③ action 等价矩阵（本轮面板实际消费）

wire 契约与 `models/git.rs` 逐字段对齐（**注意 serde 命名逐 struct 不同**）：camelCase = GitRepositoryStatus/GitBranch/GitTag/GitCommit(+Ref)/GitCommitDetails/GitIgnoreResult/GitDiscoveredRepo；snake_case = GitFileChange(old_path)/GitDiffEntry(file_path,change_type,old_content,new_content,is_binary,content_omitted,status_hint)/GitRemote(fetch_url,push_url)/GitStashEntry(commit_sha)。

| action | 参数 | 返回 | 面板消费点 |
|---|---|---|---|
| `is_repository` | workspacePath | bool | 工作区绑定（probeRepo） |
| `discover_repositories` | workspacePath, maxDepth=3 | GitDiscoveredRepo[] | 工作区非仓库时的嵌套仓库选择 |
| `get_status` | workspacePath | GitRepositoryStatus | 变更分组/头部 ahead-behind/reconcile |
| `get_worktree_file_diff` / `get_index_file_diff` | workspacePath, filePath | GitDiffEntry | 内联 diff（untracked 有 fallback） |
| `stage_file` / `unstage_file` | workspacePath, filePath | null | 行级主操作（写） |
| `batch_stage` / `batch_unstage` | workspacePath, filePaths[] | BatchStageResult/BatchOpResult | 多选批操作（写） |
| `commit_changes` | workspacePath, message, selectedFiles? | string(sha) | 提交（范围文案与参数一致：selectedFiles 或整 index）（写） |
| `get_log` | workspacePath, limit=50, skip | GitCommit[] | 历史分页 |
| `search_log` | workspacePath, filter{grep,fixedStrings}, limit, skip | GitCommit[] | 历史搜索 |
| `get_commit_details` | workspacePath, commitSha | GitCommitDetails | 提交详情（files 含 old/new content 直渲 diff） |
| `get_branches` / `get_remotes` / `get_tags` / `stash_list` / `get_gitignore` | workspacePath | GitBranch[]/GitRemote[]/GitTag[]/GitStashEntry[]/GitIgnoreResult | 只读 Tab |
| `stash_show` | workspacePath, index | string(patch) | Stash patch 查看（parseUnifiedPatch 解析） |

事件：`git-operation`（写后 reconcile，300ms 去抖）、`file-system-change`（1.5s 去抖，路径过滤在本仓库内才刷）。写类动作 Source=Bootstrap 放行、cap.git 内部 Plugin 拒写语义不受影响（面板不在插件进程）。

## ④ H1–H6 主仓落点与先后顺序（现状 + 后续）

| # | 增量 | 主仓落点 | 本轮状态 |
|---|---|---|---|
| H1 | 工作区结构化 props/订阅 | `__POLARIS_WORKSPACE_API__`（已存在，subscribe 挂载即回调=冷启动快照） | **零新增**（插件直接消费） |
| H2 | host.ai kind 会话 | 需新增 plugin-system/hostAiApi.ts + ChatInput 注册点 | 未做（本轮无 AI 面） |
| H3 | contributes.editorExtensions | 需新增 schema.ts + editorExtensionRegistry 外部注册通道 | 未做（gutter/blame 保留内置） |
| H4 | tabRenderers/Overlay/Fullscreen | 需新增 pluginTabRendererRegistry 外部通道 + LeftPanel fullscreen 接通 | 未做（插件窄容器自持 diff） |
| H5 | 事件订阅白名单 | `__POLARIS_HOST_LISTEN__` 非 chat-event 已透传（git-operation/file-system-change 实测可用） | **零新增** |
| H6 | DiffViewer 归属 | 已裁定保留宿主为通用渲染能力（原型分析 §2.4） | 裁定落定，代码未动 |
| 附加 | React shim 白名单 | `plugin-system/pluginModuleLoader.ts ensureReactShim`：只导出 useState/useEffect/useCallback/useMemo/useRef/memo/createElement/Fragment/Component/forwardRef/jsx | **缺口实录**：无 useSyncExternalStore/useLayoutEffect/useId 等；插件已按白名单适配（后续可在 shim 补导出，一行/个） |

后续批次顺序建议：H2 → H3 → H4（与 spec §12 Phase 2 一致）；每项落地前先补 schema 前后端镜像校验。

## ⑤ Phase 0/1 交付物与门禁（实测）

**插件仓 `plugins/polaris-git`（v0.1.0，自包含）**：
- 工程结构：bridge（唯一 window 层）/ model（repoStore：epoch+seq+reconcile；diffEngine：Myers+词级高亮+unified patch 解析；format）/ components（7 Tab + 头部 + 提交区）/ styles.css（pg- 前缀，全 token 色值）
- 测试：diff 引擎 31 断言 + store 假桥全链路 33 断言（含 epoch 丢弃/seq 优先/写后 reconcile/嵌套仓库选择/空信息拒绝）+ SSR render-verify（宿主桥缺失走降级文案）——`npm test` 全绿
- 门禁：`tsc --noEmit` ✅ · `scripts/validate.js` ✅（132 插件索引校验通过）· pack zip sha256 记录于 update 链
- manifest：`slot:'git.panel' + slotMode:'shadow'`、icon GitPullRequest（白名单内）、permissions 仅 workspaceRead、enabledByDefault=true（**偏差 spec §7.1 的 false**：内置席位删除后需默认启用才能保持功能连续，见 §6 G2）

**真宿主纵切（运行中 dev 宿主，数据根 D:\app\polaris-dev-s，浏览器实测）**：
- ✅ shadow 接管 git.panel 席位（tab strip/席位图标零改动）
- ✅ 冷启动工作区自动绑定（Polaris 仓库 main ↑28，真实 status/diff/历史/分支全渲染）
- ✅ 工作区切换 → epoch 重绑（切 polaris-git-smoke 后旧数据零残留）
- ✅ 内联 diff：文本 diff（行号/±/上下文/词级高亮）+ 二进制专用态
- ✅ 历史：log/搜索框/提交详情（作者/邮箱/±统计/文件 diff）
- ✅ 写路径 E2E：UI 点击暂存 → 状态 reconcile（未暂存→已暂存组迁移、范围文案「提交 1 个已暂存文件」）→ 填信息提交 → okbar「已提交 a23e684」→ **独立 git log 复核落库**
- 修复记录：shim 无 useSyncExternalStore → 改 useState 订阅；草稿受控值 bug（Map 不触发渲染）→ 组件 state；未跟踪徽章误标「冲突」→ 按区域语义；Panel 缺 init() → 补挂载

**主仓（worktree）删码**：
- 删 63 文件：`src/components/GitPanel/`（48）+ panel-exclusive 服务 9（commitMessageChat/atomicCommitChat/gitAtomicGrouping/gitNlQuery/gitContextService + 4 测试）+ `utils/gitFormat`(+test) + Chat GitSuggestion 孤儿
- 接线：App.tsx lazy GitPanel → `GitPanelPlaceholder`（新增 22 行占位）；应用层激活 `initGitStatusWatcher`（FileExplorer 徽章/CenterStage diff 的 status 活性来源）；viewStore 删 showGitPanel/gitPanelWidth/toggleGitPanel/setGitPanelWidth 四个死兼容成员（panelStates['git'] 机制保留）
- 门禁：`tsc --noEmit` ✅ · `pnpm lint` ✅（结果见提交信息）· `pnpm test:run` ✅ · `cargo check` ✅（后端零改动，例行复核）

## ⑥ spec 缺口 / 矛盾清单（只列不改）

- **G1 功能承载空窗（最重要）**：本轮删内置面板后，discard/分支写/远程 fetch-pull-push/stash 写/冲突三方合并/Rebase TODO/blame/Reflog/Undo 快照 UI **既不在内置也不在插件**（裁定范围只到查询+暂存提交）。R1「功能不变」在本轮口径下**明确不成立**——这是用户裁定的范围代价，需后续批次尽快补齐；其中冲突解决与远程操作建议排最前。
- **G2 enabledByDefault 矛盾**：spec §7.1 写 false，但席位删除后插件必须默认启用才能无缝接管；本轮取 true 并在此声明偏差。
- **G3 React shim 白名单**：spec §6.5 要求宿主 listen 契约处理，但未提 React shim 导出面；实测 useSyncExternalStore 不可用，插件被迫降级实现。建议 shim 补齐导出（主仓一行级改动）并写入 spec §6。
- **G4 插件发现时序**：插件文件直接落盘数据根 plugins/ 后，宿主在席位挂载时才重扫（无显式 rescan 命令）；商城安装链路（install_local/install_remote）无此问题，但 dev 联调文档应写明。
- **G5 i18n**：spec §10 要求 zh-CN+en-US 双语，本轮按 terminal-desk 现行范式硬编码中文（strings 集中于组件内），双语化留待批次；labelKey/labelDefault 已按规范声明。
- **G6 虚拟化**：spec GP-02 要求 >200 变更虚拟化，本轮未做（冒烟仓库规模小）；补齐时注意选择集以 path 为键已就绪。
- **G7 spec §12 Phase 1 要求「一条 AI 会话 + 一条 gutter 扩展」**：与用户裁定范围冲突（裁定明确不含），以裁定为准；spec 未修订前两者仍属 H2/H3 后续批次。
- **G8 窄宽度中央 diff 出口**：spec GP-06 narrow 模式应转中央 Tab，本轮插件窄容器内联 diff 自持（H4 未落地）；已在 DiffView 头注释声明偏差。
- **G9 并行会话混线**：插件仓 feat/polaris-git-panel 分支被并行 terminal-desk 会话直接落了 4 个提交（未切分支）；本次合并按 ff-only 处理，后续同仓会话建议先 `git branch --show-current` 确认分支再提交。
- **G10 需求文档 R1/R2/R3 口径**：本轮交付 ≈ R3 的「插件形态承接面板 + 删内置面板实现」，R1 功能等价按 G1 缺口打折、R2 增强仅兑现「插件独立发版」一项；需在需求文档 §5 验收口径下注明本轮为**分批交付第一批**。

## 文档同步

- `plans/core-slimdown-plugin-extraction-plan.md` §4.3 Git 行：冲突注记更新为「面板已插件化（本轮），cap.git/services/git/编辑器扩展保留宿主」。
- `plans/git-domain-plugin-extraction-requirement.md` §7：登记本轮实施与 G1/R1 打折声明。
- AGENTS.md §3.2 cap 清单：cap.git 条目不变（保留宿主），无需改动。
