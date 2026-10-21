# 总规划：Git 面板 vNext（Master Plan v1 · 对抗分析裁决稿）

> 文档效力顺序：**本文 > git-panel-prd.md > git-panel-impl-analysis.md > git-panel-idea-parity-plan.md**。冲突以本文裁定为准。
> 过程：四路对抗分析（性能并发 / 交互状态机 / AI 价值 / 工程治理），全部基于源码证据；本文只录裁决与合并后的执行计划。
> 对抗原报告要点已合并进本文 §二；裁决后未采纳项亦注明理由。

## 一、四路对抗裁决汇总

### 1.1 裁决采纳（改设计的硬伤 · 20 条 → 合并为 12 个裁决项）

| # | 对抗发现（证据） | 裁决 | 落点 |
|---|---|---|---|
| C1 | **Reply 错误通道只有 String**（router/mod.rs:466,500-504），PRD 承诺的错误分类传不出来 | ✅ 扩 Reply 错误载荷（`{code, kind, stderrSnip}` 结构化），列为 PR-2 前置 | PR-2 |
| C2 | **P0 承诺滑球**：原 PR-1 实为全地基（队列/事件/错误分类都塞了）；slice 测试 12 文件几十处断言重写被低估为「各 ~5 行」 | ✅ PR-1 重定型：**invoke 兼容 shim**（保 `invoke('git_*')` 签名，内部转 router_dispatch），slice 与测试**零改动**；队列/事件全距 PR-2。且 shim 写明 sunset 条款（P2 后只留事件订阅） | PR-1 |
| C3 | **casing 声明错误**：命令参数 camelCase、`models/git.rs` 全 `rename_all="camelCase"`，`types/git.ts` 字段却是 snake_case（GitDiffEntry）——「按 snake_case 对齐」会破坏前端 | ✅ 改为「**逐类型保持现状 casing**」 | PRD §FR-P0-1（已改） |
| C4 | **权限一票制**：PolicyPermission 只看 cap id；50 action 平铺 = status 只读与 force push 同 gate；Web Remote 默认全放行强推 | ✅ 单一 `cap.git` + **能力内按 source + 写类二级校验**（读域幂等放行；写操作敏感校验，范式对照 ConfigCapability）；**不引入动态 registry 背此锅** | PR-1/2 |
| C5 | **双路径过渡零治理**：50 命令薄转发后 commands/git.rs 永久双轨 | ✅ 对齐 todo_capability 范式：**PR-2 验收 = commands/git.rs git 域整体摘除**（capability 唯一入口），不做无限期双轨 | PR-2b |
| C6 | **lane 跨页不可 O(500)** + Sort::TIME 排序与 lane 拓扑序冲突（log.rs:73）；P50/N 页需重放 | ✅ ① 換 `Sort::TOPOLOGICAL`（显式写进协议）；② lane **不双实现**——参考现成开源实现（gitui 等带泳道状态机者）+ 契约用例单测；③ 新增预算：页 N 重放 p95<200ms | P2 |
| C7 | **缓存 key 自带 O(全史) 检查**（graph_ahead_behind 是全 walk）——为省时建的缓存最贵在命中判断 | ✅ key 改 `HEAD sha + refs 域 digest`（读取 refs 文件 mtime/内容摘要，廉价）；二开预算改 p50<50ms | P2 |
| C8 | **per-repo FIFO max=1 会自锁**：rebase 占队列分钟级，status 刷新风暴吃满 busy 槽 | ✅ 改「**读无限并发 + 写 max=1**」（贴 git 语义）；progress 事件 **≤4Hz 合流**；取消分级：git2 只读任务不承诺即时取消、写路径维持 kill | PR-2/P2 |
| C9 | **.git 副监听自造风暴 + 回环**：rebase 写 MERGE_HEAD/rebase-merge 数百次 fs 事件；git 自己写 index 也触发我们 | ✅ ① 自抑制：cap.git 任务活动窗口内 suppress（ledger 有任务归属信号）；② rebase 进行中刷新预算放宽 ≤3s；③ Web 端：60s 轮询兜底**如实标注为边界**（watch 是 tauri-app feature） | P2 |
| C10 | **非内容冲突全穿帮**：三类结果协议只有 `conflicts: string[]`（types/git.ts:326/337）；二进制/delete-modify/rename-delete 无 marker 可解析；status.rs 把冲突归并一个 bit | ✅ 协议升级 `GitConflictEntry { path, kind(text/binary/dm/rd), stages{...} }`，merge/rebase/cherry-pick/revert 四结果结构一次改齐；底层归一读 `.git/{MERGE_HEAD, REBASE_HEAD, rebase-merge}` | P3（前置协议 PR 在 P2.5） |
| C11 | **序列操作交叉守卫缺失**（branch.rs:250 只查 has_conflicts）+ rebase continue 链断裂（步数不存活、冲突判定靠 stderr 包含 "CONFLICT"） | ✅ **冲突状态机重画为「序列操作机」**（见 §3）；Continue 一律从状态回读不信任 stderr | P3 |
| C12 | **AI 矩阵重心倒置**：重 LLM 项排前面（AI-2 主打/AI-4 建 P2），与"确定性骨架优先"自相矛盾；AI-1 现范式对非 agentic 轻引擎是幻觉路径（提示词让模型自己跑 git 命令，纯文本引擎拿不到 diff 内容） | ✅ AI 矩阵重排（§1.3 裁决表）；AI-1 双档注入 + 回流锚点 + 驱逐豁免（sessionStoreManager 现无驱逐=预防性修复，需先写为规范不依赖事实） | P1 |

### 1.2 裁决砍掉 / 降级

- **砍**：折叠线性段选项（行高抖动破坏 virtuoso，自造复杂度）；AI-6 原形态（结构化数据喂 LLM 归纳"bug 哪来"，零杠杆）。
- **降级**：行级 staging 平权移出「超越 IDEA 五差异点」→ sinks P3（地基三缺：无 apply_range / 无 PartiallyStaged 位 / batchStage 只收整文件）；AI-4 冲突预测 → P3，**且 AI 部分砍掉**（交集清单确定性计算 + 一条规则建议：本地未提交>0 → 先 commit/stash）。
- **AI-2 从主打卖点位降格**：「本地启发式分组预检先行」（目录聚类 + change_type，纯代码），AI 只解释置信低项；连同跨文件多 hunk 改动的「不适合拆分」本地预检。

### 1.3 采纳的反直觉机会（写入设计）

1. **AI-5 换形态**：从「per-hunk 建议卡」升级为「agentic 冲突求解 agent」——利用 AI 引擎已有的 bash 能力在工作区读测试/邻近代码自证方案，面板呈现求解过程；per-hunk 卡仅作为 agent 不可用时的降级态。（P3+ 探索项，砍掉 token 裁剪焦虑）
2. **AI-3 改形态**：密钥/大文件/冲突标记用**纯本地扫描**（gitleaks 模式库，正则的完美领地）；LLM 只做提交后批量语义解释，形态从「弹卡」改为**常驻面板列表**（不主动打扰）。
3. **序列操作 Continue 做成不可错过**：continue 是最容易迷路的点，进度 UI 与 AI-3 Review 状态在中继上强绑定。
4. **AI-6 变身**：从"问答归纳"降为「自然语言 → 搜索参数」编译器（LLM 只产出 `--grep/--author/-S/--since` 参数），并入 P1 log 搜索顺手做，**零幻觉可验证**。

## 二、修订后总体规划（PR 序列 v2）

性能预算最终表（对抗修正后，取代 PRD §2.1）：

| 项 | 预算 | 关键手段 |
|---|---|---|
| log 首图 | ≤10k 仓 p50<300ms；50k 仓 p95<1.2s | topo 序 + Rust lane + 页 500 + skeleton |
| 热开 | p50<50ms（纯回放） | key = HEAD sha + refs 域 digest（廉价判据） |
| 翻页 | 页 N 重放 p95<200ms | topo 状态机重放，不重 sort |
| status 刷新 | 桌面 p95≤1s；rebase 中 ≤3s；Web=60s 轮询（边界） | 双 watcher + 自抑制 + 流式抑抖 |
| 长任务 | progress ≤4Hz 合流；读无限/写 max=1 | broadcast 复用（防 Lagged 丢 AI 流） |
| diff | >2MB 仅统计档（AI-2 同步走协议化裁剪标注） | 复用 MAX_EDIT_LENGTH 范式 |

> 实测归档（第七轮）：上表预算在当前实现上未达标，真机数字与根因交叉证据见 §十二「bench 实测」；修复主案 = C6/C7，独立 PR 排期。

| PR | 内容（修订） | 验收 |
|---|---|---|
| **PR-1** | 单 `cap.git`（action=去前缀命令名）+ **invoke 兼容 shim** + **纯转发**；能力内 source+写类校验；`web/api/ipc.rs` 路由臂改指 cap.git 后删 `git_dispatch.rs`；**不动 commands/git.rs、不动 slice 与测试** | 现 vitest 全绿零改动；web-only `cargo check` 过；shim sunset 条款写入代码注释 |
| **PR-2a** | Reply 错误通道结构化（C1）；队列（读无限/写1，C8）；长任务事件（taskId/progress 4Hz/cancel 分级语义）；协议 casing 逐类型定位 | 队列串行单测；pull 中途 cancel 演示；Lagged 计数基准 |
| **PR-2b** | **commands/git.rs git 域整域摘除**（对照 todo 范式）+ `write_file_absolute/read_file_absolute` 迁置（不随 git feature 消失） | `grep "invoke('git_"` 零命中；178 前端测试绿 |
| **P1**（3~4 PR）| amend（任意 commit）/fetch+auto-fetch（默认关）/stash apply·show/log 搜索（含 `branch1..branch2`、正则）+ **AI-6 编译器形态**/force-with-lease/**AI-1 加固**（双档 diff 注入 + 回流锚点 + 驱逐豁免规范）/reflog UI + 一键恢复 | 每项单测 + slice vitest |
| **P1.5**（小 PR，前置于 P2 UI） | **gitStore 状态按 wsPath 分片**（A5：现全局单例，sidebar/workbench 双面板互踩） | 双面板并发 vitest |
| **P2**（graph 主役）| Rust lane（参考实现 + 契约用例，**不双实现**）+ topo 序 + `GitLogPage` 协议/增量缓存（C7 修正 key）/.git 副监听（自抑制，C9）/undo 网络（恢复语义含反向快照 + .rej 诊断 + 保留策略 per-ws 上限）/操作流水面板 | §预算表逐项 bench 记录为本 PR 交付物 |
| **P2.5**（协议 PR） | `GitConflictEntry`/归一序列操作状态探测/Continue 步数回读（C10/C11 地基） | 协议双同步 + 字段级测试 |
| **P3** | **序列操作机 UI**（merge/rebase/cherry-pick/revert 四合一：批次累加、守卫、Continue 强制对话）+ 合并器（per-hunk + 计数 + 语义标签）+ interactive rebase（面板化 TODO + autosquash）+ AI-3 本地扫描常驻列表 + 本地启发式分组预检（AI-2 形态）| 四路冲突手测清单（含二进制/dm/rd 三类非内容冲突） |
| **P4** | cap.git 进 MCP/dispatch 白名单（`cargo build --bin polaris-mcp`）；插件示例（worktree/GitFlow/GitLab PR）；修 `SquareTerminal` 白名单漂移 | 插件三处同步 |

AI 矩阵最终排序（取代 PRD §排序）：**AI-1 加固 > AI-7 危护（AI 可缺席）> 本地分组预检 + AI-2 解释层 > AI-3 本地扫描 > AI-8（本地启发式）> AI-5（agentic 形态，P3+ 探索）> AI-4（无 AI）**；AI-6 = 搜索参数编译器，并入 P1。

## 三、风险登记册（裁决后存续项）

| 风险 | 等级 | 缓解 | 状态 |
|---|---|---|---|
| 双开进程（桌面 + polaris-web 同机）队列互斥不跨进程 | 低 | git 自身 lock 兜底；文档标注；不加跨进程锁 | 接受 |
| lane 参考实现许可/适配差异 | 中 | P2 首个 PR 做许可尽调（MIT/Apache）；契约用例覆盖 5 个典型拓扑 | P2 开工时核 |
| 性能预算无 CI 断点 | 中 | **仓库现状核查：`.github/` 不存在**（AGENTS §一 ci.yml 陈述与现状不符）——预算验收=每 PR 附本地 bench 记录（脚本化 `bench-git.mjs`），CI 引入后补自动化 | 接受+记录 |
| shim 永久化（C2 反面） | 中 | sunset 条款写进 PR-1 代码注释 + P2 验收 grep | 门控 |
| `.git` watcher 在 UNC/网络盘行为 | 低-中 | P2 实测三项（UNC 事件缺失 / 回环 / rebase 风暴），不达标即该仓退化为手动刷新并 UI 提示 | P2 实测项 |
| AI-1 幻觉路径（现网已在） | 中 | 双档注入（agentic 引擎=清单自查；文本引擎=前端注入裁剪 diff）；先 PR 于任何新 AI 项 | P1 首位 |

## 四、决策日志（关键裁定 10 条）

1. PR-1 = shim + 纯转发；队列/事件/错误分类全部延后（C2/C5 逻辑）。
2. 单 cap.git + 能力内二级校验；不拆多 capability，不背动态 registry（C4）。
3. commands/git.rs **整域摘除**在 PR-2b（不留双轨过渡条款）。
4. casing 逐类型保持现状（不做全仓统一，成本>收益）。
5. lane/冲突解析核心算法：参考实现 + 契约用例；**放弃 TS+Rust 双实现**。
6. 缓存判据用廉价 digest，禁止 ahead/behind 进 key。
7. 并发模型 = 读无限 + 写 max=1（非全部串行）。
8. AI 矩阵：确定性骨架优先于 LLM 项；LLM 三禁（不听使的输入窗口、无锚点回流、不可删除的常驻卡）。
9. 冲突域协议一次到位（GitConflictEntry），UI 状态机四操作合一。
10. 行级 staging/折叠线性段/AI-6 原形态：砍或降级，记录于本文以供翻案。

## 五、下一步

按 PR-1 修正形态写实施 spec（目标/契约/验收/不做 四段式）→ 开工。开工前把本文里程碑表与 PRD/impl-analysis 的三处已改点当作唯一基准（PRD FR-P0-1 casing 已同步修正）。

## 六、执行记录（2026-10-19）

**P0 已实施并通过本地门控**（spec：`plans/git-panel-p0-spec.md`，含实测记录与基线注记）：

| 项 | 状态 | 关键产物 |
|---|---|---|
| PR-1 shim + cap.git 上收 | ✅ | `services/router/git_capability.rs`（新）；`src/services/transport/index.ts` git 前缀拦截；state.rs 注册 |
| PR-2b 命令域摘除 | ✅ | `commands/git.rs` / `web/api/git_dispatch.rs` 删除；`commands/file_io.rs`（write/read_file_absolute、test_param_serialization 迁出）；能力直调 GitService |
| 裁决 7/8 增量 | ✅ | dispatch 三入口外包 `spawn_blocking`（不占 tokio worker）；cap.git 写路径 `WRITE_GATE` 互斥（写 max=1 最简落地） |
| 验证 | ✅ | gitStore 190 用例零改动全绿；tsc/cargo check/web-only gate 全过；单测编译过（运行受本机 DLL 限制，见 §登记册补注） |

**风险登记册补注**：`cargo test --lib` 本机不可运行（STATUS_ENTRYPOINT_NOT_FOUND，AGENTS §九）——
git_capability 的 5 个单测实际运行挂到 CI；已保证 `--no-run` 编译通过。

PR-2a 主体（Reply 结构化错误、写任务队列/取消、progress 合流、事件驱动刷新）与 P1（lane 图
算法、AI-1 加固）未开始 —— 下一个开工口。

## 七、执行记录（第二轮，2026-10-19 续）

| 项 | 状态 | 关键产物 |
|---|---|---|
| **P1.5 gitStore wsPath 分片** | ✅ | `types.ts` 新增 8 个 keyed 可选域（branchesByWs/remotesByWs/tagsByWs/commitsByWs/stashListByWs/diffsByWs/worktreeDiffsByWs/indexDiffsByWs）；6 个 slice 写点双写（keyed + 旧镜像，照 statusSlice 先例——statuses keyed + 镜像现存行为一致）；旧 UI/旧测试零改动；`shardedState.test.ts` 双面板乱序并发 3 用例（13 文件 193 用例全绿）+ tsc 过 |
| **P1·AI-1 加固（双档注入）** | ✅ | `gitContextService.formatGitDiffWithContent`（单文件 600 chars/总量 12k 预算裁剪 + binary/omitted 标注 + deleted 取 old_content）；`commitMessageChat.isAgenticEngine`（后端权威 `EngineCapabilities.tools` 判据，元数据缺失安全降级 false→注入正文）；`buildCommitMessageUserContent` 双档：agentic 保留 `git diff --cached` 自取，非 agentic 注入正文 + 「不得编造」约束（幻觉路径防线）。`gitContextAiGuard.test.ts` 7 用例全绿 |
| **P1·AI-1 驱逐豁免（规范先于事实）** | ✅ | `sessionStoreManager.isProtectedSession()`（PROTECTED_SESSION_KINDS=['commit-message']）——现管理器无 LRU 驱逐（事实核查代码确认），预防性守卫先行；未来任何回收策略必须消费本函数（注释铁律） |
| **P1·AI-1 回流锚点（二段确认核查）** | ✅（既有） | `CommitInput.handleAdoptSuggestion`：AI 建议经用户点击采纳才进提交框，无自动写入（红线满足，未新增改动） |
| **P2·C6① log 拓扑序** | ✅ | `services/git/log.rs::get_log` `Sort::TIME → Sort::TOPOLOGICAL`（协议级变化，注释注明 lane/页 N 重放依赖 + 前端不再自行重排）；`get_file_history` 保持 TIME（文件历史时间序直觉优先，非 lane 图主役）。cargo check + test-compile 双过 |

| **P1 后端动作批量（amend / fetch / stash apply·show / search_log / reflog / force-with-lease）** | ✅（服务+能力+类型+slice 层；UI 绑定留待面板改造） | ① `commit.rs::amend_commit`（git2 `Commit::amend`，message None = --no-edit；复用 `stage_selection` helper 提取自 commit()；任意历史 commit amend 注明依赖 P3 interactive rebase）；② `remote.rs::fetch`（CLI，stdout+stderr 合并 —— git 惯例诊断在 stderr）；③ `stash.rs::stash_apply/stash_show`（CLI，show 返回 raw patch）；④ `reflog.rs` 新模块（`get_reflog`，GS/US 记录分隔约定同 search_log）；⑤ `log.rs::search_log`（CLI —— grep/author/-S/--since/--until/`--`path/分支范围免费复用 git 实现，裁决 5「不双实现」；%B 完整信息按 GS 记录切分解析）；⑥ **force-with-lease**：`push_branch` 6 参（+lease）——force=true 从裸 `--force` **除名**，一律 `--force-with-lease`(=ref:sha)，lease 缺失按 remote-tracking 对照且失败透传不静默降级；⑦ models 新增 `GitReflogEntry`（camelCase）/`LogSearchFilter`（camelCase，grep_body 砍掉——CLI 无独立载体）；⑧ cap.git 6 新动作（fetch=写类入 DESTRUCTIVE、amend_commit、stash_apply、stash_show/search_log/get_reflog=只读）+ KNOWN_ACTIONS/巡逻测试同步；⑨ types/git.ts + 4 slice 方法（remoteSlice.push 增可选 leaseSha 尾参且**仅在提供时附加**——旧 5 键 payload 断言零改动；pushWithLease/fetchRemote/amendCommit/searchLog/stashApply/stashShow/getReflog）；⑩ 新测 `p1BackendParity.test.ts` 9 用例 —— 14 文件 203 用例全绿；cargo check / web-gate / test-compile 三门 0 |
| （真实语义差）P1 AI-6 参数编译器动作端已就绪 | △ | `search_log` 是编译器的**执行端**；自然语言 → filter 的编译（意图 → grep/author/-S 映射）属后续 AI-6 主体，本批未做 |

**仍开设口（下轮）**：P1 UI 绑定（stash apply/show 按钮、amend 按钮、搜索框、fetch/auto-fetch（默认关）设置项、reflog 面板）；AI-6 编译器主体；PR-2a 主体（Reply 结构化错误、写任务队列、progress 合流）；P2 lane 主役（泳道状态机 + 契约用例，log 已切拓扑序为前置）/ C7 缓存 key / .git 副监听；P2.5 冲突协议升级；P3 序列操作机（含任意 commit amend）；P4 生态出口。

## 八、执行记录（第三轮 · P3 冲突域接手修复，2026-10-20）

在 `feat/git-panel-vnext` worktree 实施本轮记录（详见 `git-panel-handoff.md` §2.1）：

| 项 | 状态 | 关键产物 |
|---|---|---|
| **C10/C11 冲突域 P0 假解决根修** | ✅ | `resolve_conflict_file` 三态重写（`WriteContent` 无条件写盘 + add / `CheckoutStage(side)` 按 stage2/3 blob 还原 / `Remove` 删盘 + 清冲突 stages）；根因 = 旧实现以 stage0 探测可写而冲突态无 stage0，暂存的是 marker 原文 |
| **删类 kind 映射反转修复** | ✅ | `(our 有,their 无)` → `DeletedByThem`（对齐 git 约定），幸存侧 stage 内容补记（删类 内容不再全 None）；sequence.rs +3 测试（编译门过，运行受 DLL 限制） |
| **三窗编辑器重写（真三窗）** | ✅ | regions 同源驱动三列对位、冲突块中列就地决策（VS Code 式）、Apply All 真实现（批量采纳未决策块为本方；parse 层背景：非重叠单侧改动早已被吸收）、跳下一未解决块、手编接管 |
| **Dialog 流转闭环** | ✅ | 新鲜 `getConflictState` 接力下一 Text 文件；归零按 kind 引导（rebase/cherry_pick/revert Continue/Abort，merge 去提交）；修复旧版 stale props |
| **入口 + 契约 + i18n** | ✅ | FileChangesList unmerged 右键 → openMerger；gitStore 三态 slice 方法；zh/en 键对齐 0 缺口 |
| **门禁** | ✅（存量除外） | tsc 0；cargo check/test-compile/web-gate 0；vitest：conflict 31/31、GitPanel+gitStore 305/305；全量 84 failed = 11 个基线存量文件（stash 复核，与本次无关）；lint 上余 6 error 同为基线遗留（非 git 域） |

**未做（增量留给下轮）**：AI-5 冲突块建议卡；中列 Append 双侧拼合；跨文件键盘流接力。**分支基线债（不属本域）**：11 个 vitest 存量失败文件（"fetch failed" 系 localhost mock 依赖）+ 6 个 lint error（PatchDiffRenderer/useRuntimeSummary/ansiToHtml）。

## 九、执行记录（第四轮 · P2 收尾核实 + FR-P3-2 Interactive Rebase，2026-10-20 续）

勘误：第三轮交接的「P2 泳道图 60%」为陈旧数据——实测 `get_log_with_lanes` + `compute_semantics_full`（语义色 local/unpushed/merged/dim）+ `lane_cache.rs` + WIP/stash 虚拟行 + `OperationsLog`（FR-P2-4）均已落地并挂载。

| 项 | 状态 | 关键产物 |
|---|---|---|
| **FR-P3-2 Interactive Rebase 核心闭环** | ✅ | 后端 `plan_interactive_rebase`（base..HEAD 应用序只读）+ `start_interactive_rebase`（面板 todo 渲染 inner todo → temp `apply_todo.cmd` 作 GIT_SEQUENCE_EDITOR 注入 `git rebase -i [--autosquash]`；C11 guard + 冲突回读 sequence state）；capability 双动作（写类 + 撤销快照）；前端 `RebaseTodoDialog`（动作下拉 + 上下移 + live 组校验 + autosquash）+ HistoryTab 右键入口 + slice 双方法 + 双语 i18n；组件测试 6/6、后端 4 单测（编译门过，运行受 DLL 限制） |
| （如实未做）reword / 拖拽 / edit 停点 | ⬜ | reword 需 GIT_EDITOR 二层编排；拖拽以按钮替代；下轮增量 |

## 十、执行记录（第五轮 · git 功能扫尾：AI-3 / AI-8 / FR-P2-3 UI / P4 / AI-6，2026-10-20 续）

按 master-plan 顺序在 `feat/git-panel-vnext` 完成（每项独立单主题提交 + 门禁）：

| 项 | 状态 | 关键产物 / 提交 |
|---|---|---|
| **P3-2 Interactive Rebase** | ✅ `41ccd8a6` | plan/start 后端（GIT_SEQUENCE_EDITOR 注入 cmd 脚本无声换 todo）+ RebaseTodoDialog + 右键入口；6 组件用例 + 4 后端单测 |
| **AI-3 提交前风险扫描（Review 门）** | ✅ `a11f5404` | `risk_scan.rs`：6 类密钥正则 + 冲突 marker + 大文件（blob>1MiB），120 条上限截断；`CommitRiskCard` 常驻（失败静默不阻断）；4 组件用例 + 正则单测；欠账：明细跳转 diff、LLM 提交后解释（v2） |
| **AI-8 fixup!/squash! 整理建议** | ✅ `84313dcc` | `suggest_rebase_todos`（前缀匹配 → 目标连段尾部插入；fixup-of-fixup/无目标 → unmatched 如实汇报；validate_todos 兜底降级）；Dialog AI-8 按钮 + toast 三级；纯函数 6 单测 + 组件 +2；欠账：未 push 分支检测、AI 解释层 |
| **FR-P2-3 Undo 收尾（UI 消费点）** | ✅ `859bb68f` | `UndoBar`：折叠最新 1 条 + 展开 3 条；恢复分级 toast（ok/conflict/error）；两步确认丢弃；undoSlice 三方法首个 UI 消费点；4 组件用例；欠账：危险操作 toast「撤销」按钮联动 |
| **P4 生态出口 v1** | ✅ `4a63f1e0` | bus_dispatch 白名单 + `cap.git`（写类经权限 gate + 审计；protocol.cap.git 只读动作协议）；`VALID_PLUGIN_ICONS` 补 `SquareTerminal`（前端 18 值对齐顺修漂移）；`cargo build --bin polaris-mcp` 重建；欠账：插件示例（插件仓侧） |
| **AI-6 v0（无 LLM）** | ✅ `37ce6316` | `gitNlQuery.compileGitQuery`（显式键/引号短语/中文作者/相对时间/路径词；落空 → 整句 grep 不劣化）；HistoryTab exactSearch 接线；10 用例；欠账：LLM 归纳层（⚡⚡）、blame/diff 域 |

**仍在册欠账（如实，未完成≠已完成）**：① P3-2 reword（GIT_EDITOR 二层编排）/ 拖拽 reorder / edit 停点 hover；② AI-5 冲突建议卡 / 中列 Append / 跨文件键盘流；③ graph.c 四数组 lane 收缩（性能优化，语义不变）；④ AI-6 LLM 归纳层 + blame/diff 域；⑤ P4 插件示例（GitFlow/worktree/GitLab PR，插件仓工作）；⑥ Undo toast「撤销」按钮联动；⑦ 风险卡明细跳转 diff。**分支基线债（不属本域，不越界修）**：11 个 vitest 存量失败文件（localhost mock，93f40dd3 基线复证等值）+ 6 lint error。

## 十一、执行记录（第六轮 · 合并收编 + 裁决砍除 + 欠账总审计，2026-10-20 续）

**合并**：`feat/git-panel-vnext` 全部 12 提交经 revert-of-reverts + cherry-pick 收编回 main（线性零冲突）；product 门禁全绿（tsc/vitest 331/cargo 三门）。

**裁决砍除（用户驱动）**：

| 项 | 状态 | 记录 |
|---|---|---|
| AI-2 建议卡从变更页移除 | ✅ `604e72f9` | 目录聚类对常见小变更多产出伪细分建议（如 locale 两目录拆两组），且常驻卡片挤压文件列表空间；引擎（gitAtomicGrouping）、store API（commit_group）、后端原子提交全部保留，重挂载点有注释标记；i18n `atomic.*` 键块已补齐（`5fc84156`） |
| 编辑器内 Git 工作台变体下线 | ✅ `981d4d76` | 「在编辑区打开 Git 工作台」路径全摘：`tabStore.openGitTab`/TabType 'git'/CenterStage 'git' 分支/面板三处 workbench 按钮/App openGitWorkbench（-161 行）；HistoryTab 的 `variant` 内部实现保留（自包含、无外部依赖）；git 面板回归侧栏形态 = ResizeHandle 无限拖宽 + 无编辑器时 fillRemaining 自适应，宽度即全屏 |

**欠账总审计（对照 PRD/master-plan 逐项核实，未实施清单）**：

| # | 项 | 出处 | 现实 |
|---|---|---|---|
| 1 | Interactive Rebase 增量：reword（GIT_EDITOR 二层编排）/ 拖拽 reorder / edit 停点 hover | FR-P3-2 | ~~未实施~~ → 第七轮：reword `fd7e0c06` + 拖拽 `1cb69957` 已落地；edit 停点 hover 仍未做 |
| 2 | AI-5 agentic 冲突求解 agent + per-hunk 降级卡；中列 Append 双侧拼合；跨文件键盘流接力 | FR-P3 合并器 | 未实施 |
| 3 | graph.c 四数组 lane 收缩算法 | FR-P2-1 | ~~简化版已覆盖单线+合并~~ → 第七轮：`144b20ce` 抽 polaris-git-lanes（父去重合并 + 即时释放，真实跑测 5/5）；协议零漂移 |
| 4 | AI-6 LLM 归纳层 + blame/diff 自然语言域 | AI-6 | v0 编译器（无 LLM）已上线；LLM 层 ⚡⚡ 未做 |
| 5 | AI-7 危险操作防呆（「会失去什么」AI 说明 + 安全网建议 stash/新分支） | PRD AI-7 | **全量未实施**（确认弹窗仅基础版） |
| 6 | P4 插件示例（GitFlow / worktree / GitLab PR） | P4 | 未实施（插件仓侧） |
| 7 | Undo toast「撤销」按钮联动 | FR-P2-3 | 未实施（UndoBar 已有第一个消费点） |
| 8 | 风险卡明细跳转 diff 定位 | AI-3 | 未实施 |
| 9 | PR-2a 主体：Reply 结构化错误（C1 `{code,kind,stderrSnip}`）、写队列完整版（现为 WRITE_GATE 互斥最简落地）、progress 事件 4Hz 合流、取消分级语义 | C8/C1 | ~~部分实施~~ → 第七轮：结构化错误 `6cb04cbd` 全链贯通；写队列 FIFO `8c19f1bc` + 合流器本体；progress 回调接线与前端 cancel 撤单入口残留 |
| 10 | 性能预算逐项 bench 记录（log 翻页 p95<200ms / 热开 p50<50ms 等） | §预算表 | ~~无 bench 产物~~ → 第七轮：`9925a02d` 脚本 + 真机归档（预算超标实锤，根因指向 C6/C7，见 §十二） |
| 11 | C9 .git 副监听 rebase 风暴自抑制 / Web 60s 轮询兜底 | C9 | ~~需复核~~ → 第七轮：后端 IGNORED_DIRS 已挡 .git 事件（复核结论：.git 直写无事件）；风暴源 = rebase 的工作区 checkout 链，自抑制窗口 `9ba1b174` 落地；Web 60s 轮询兜底仍未做（watch 属 tauri feature） |

**分支基线债复述**：11 个 vitest 存量失败文件（localhost mock）+ 6 lint error（PatchDiffRenderer/useRuntimeSummary/ansiToHtml），不属 git 域。

---

## 十二、执行记录（第七轮 · git 面板欠账总清偿，2026-10-21，worktree `feat/git-backlog-r6`）

**范围**：main `c0a0a594` 切出独立分支推进；每项单主题提交 + 真实门禁（tsc/eslint/vitest/cargo check/web-gate），未完成如实标注。分支不自行并入 main，等用户指令。

**提交清单与门禁**：

| 组 | 项 | 提交 | 实现 | 门禁 |
|---|---|---|---|---|
| A1 | AI-7 危护 v1（ConfirmDialog losses/safetyNet + 6 调用点 + i18n） | `9c0fa0a1` | `danger.*` 11 键 zh/en | ConfirmDialog.test 2 过 |
| A2 | AI-3 风险卡明细点击跳 diff | `2e1ccab6` | `onOpenFileDiff` + `handleRiskFileDiff` | CommitRiskCard.test 5/5 |
| A3 | FR-P2-3 Undo toast「撤销」联动 | `a394feed` | `undoToast.ts` toastWithUndo + 4 接线点 | undoToast.test 3 过；git 域 16 文件 103 过 |
| B1 | PR-2a C1 Reply 结构化错误 `{code,kind,stderrSnip}` | `6cb04cbd` | marker 承载 + router 拆包；TS `GitCapError` | cargo check 0 / web-gate 0 / replyError.test 3 过；Rust 单测已写未跑（DLL 基线） |
| B2 | PR-2a B2 写闸 FIFO 票号队列 + 进度合流器 | `8c19f1bc` | mini crate `polaris-gate-queue`（WriteGate FIFO + ProgressCoalescer 4Hz），接线 git_capability.rs（裸 Mutex → 票号队列） | crate 测试 4/4 真实过 |
| B3 | 欠账 ⑪ C9 rebase 风暴自抑制 | `9ba1b174` | `sequenceActivityUntilByWs` 活动窗口：序列写动作 events 延长窗口（3s），fileWatcher 防抖 800→3000 | 两 subscriber 测试 13/13 过；tsc/lint 0 |
| C1 | 欠账 ① reword | `fd7e0c06` | todo 行内改写标题（`newMessage`）；后端预写 `reword-N.txt` + 顺序表，GIT_EDITOR 脚本按 todo 序回放（无人工交互）；squash/fixup 前驱扩为 pick∥reword | RebaseTodoDialog.test 10 过；Rust test-compile 过/运行 DLL 基线限制；顺带补 `GitRebaseTodoItem` PartialEq（实锤既有盲区：cfg(test) 不进 `cargo check` 网格，旧 assert_eq 从未编译过） |
| C2 | 欠账 ① 拖拽 reorder | `1cb69957` | HTML5 原生 DnD（dragIndex state，测试友好）；首项锁定约束不变；与上下移按钮并存 | RebaseTodoDialog.test 12/12 过 |
| D2 | 欠账 ③ lane 算法 graph 化 | `144b20ce` | 算法抽 mini crate `polaris-git-lanes`：graph.c 父去重合并（重复父在等待列 → 复用不新增列）+ processed 即时释放；log.rs 薄适配，`GitLaneRow` 协议零漂移 | crate 5/5 真实过；cargo check/web-gate 0；log 契约用例（build_lane_fixture）编译过/运行受限（DLL 基线） |
| D1 | 欠账 ⑩ bench 记录 | `9925a02d` + 本节 | `scripts/bench-git.mjs`：真实链路 polaris-web→RouterBus→cap.git→git2 压测 | 见下「bench 实测」 |

**bench 实测（欠账 ⑩ 归档，主仓 HEAD 基线、3265 提交仓、n=30、2026-10-21）**：

形态：`cargo build --release --no-default-features --features git --bin polaris-web`（标准 web-gate 形态不含 git feature，测不了——bench 构建形态如实标注）；`POLARIS_DATA_ROOT` 隔离数据根；`/api/router_dispatch` 端到端；数据根为空仓（无历史缓存干扰）。

| 场景 | p50 | p95 | max | 预算 | 判定 |
|---|---|---|---|---|---|
| log 首页 limit=100 | 455ms | 549ms | 565ms | p95<200ms | 超标 |
| log 翻页 skip=100 | 449ms | 513ms | 549ms | p95<200ms | 超标 |
| log 深翻页 skip=500 | 447ms | 531ms | 534ms | p95<200ms | 超标 |
| 热开 status | 205ms | 258ms | — | p50<50ms | 超标 |
| 热开 log 首页（重复） | 489ms | 629ms | — | p50<50ms | 超标 |

**交叉证据**：轻 action（get_operations）p50≈3ms → HTTP/路由开销可忽略；翻页耗时与 skip 无关（首页≈深翻页）→ 成本不在页 N 重放，而在每次请求的**全史拓扑 walk + 语义着色全史 revwalk + refs 全收集**。C6（TOPOLOGICAL 版本协议漂移未落）/C7（热开廉价 key 未落）从"推测项"变为"量化的主成本项"：预算表数字在现有实现上不成立，修复路径 = C6/C7（页 N 重放 + 廉价热开 key），**本轮不动**（协议变更，须独立 PR 排期）。

**本轮明确不做（如实标注，非完成项）**：
- 欠账 ④ AI-6 LLM 归纳层（⚡⚡ 未做，维持 v0 编译器形态）；
- 欠账 ⑤ AI-5 agentic conflict agent（探索项未开始）；
- 欠账 ⑥ P4 插件示例（在插件仓 `D:\space\base\Polaris-plugin`，不在本 worktree）；
- B2 残留：git2 长动作 progress 回调接线未做（合流器本体就绪）；写动作取消的前端撤单入口未接（取消分级语义已写入代码注释）；
- interactive rebase 「edit 停点 hover」未做；
- 主仓 lib Rust 单测运行受 DLL 基线限制（0xC0000139）——本轮 test-compile 通过的 Rust 用例运行状态已逐项如实标注。
