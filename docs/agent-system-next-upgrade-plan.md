# Agent 体系下一步升级优化方案分析

> 基线:M0/M1 已完成、M2 核心链路(resultSchema/verdict 回流/波次状态机/dispatch_roster)已落地、Qoder 式交互优化(专家参数补全/专家团页签/自定义专家 CRUD)已上线。
> 上位文档:`docs/agency-agents-integration-plan.md`(§2-§4 设计)、`docs/agency-agents-implementation-plan.md`(M2/M3 任务拆解)。
> 状态:仅分析与方案梳理,未实施。

---

## 0. 现状能力盘点(截至本轮)

| 层 | 已有 | 明显缺口 |
|---|---|---|
| 选人 | Gallery 浏览/搜索/筛选;`/agent` `/dispatch` `/nexus` 参数补全;自定义专家 CRUD;L0(options.agent)与 SimpleAI 下拉 | L1 查表(coordination.json)无消费方;L2 索引 skill 仅 SimpleAI 可用;claude 引擎会话内 persona 缺口 |
| 配合 | resultSchema 注入 + verdict 提取校验 + check 回流携带 | verdict 前端无卡片渲染;校验失败无自动重试;Dev↔QA loop / escalation 未做(P2-6) |
| 组队 | roster 卡组队、拓扑波次、并发补派、完成事件推进 | 波次进度不可见;只派 always 组;跨波只传 slug 列表不传产出摘要 |
| 工程 | 双形态编译、纯逻辑单测、corpus 幂等安装 | web IPC 桥未覆盖 nexus/agent_corpus 命令;corpus 上游漂移无更新机制 |

---

## 1. 体验层升级方向(用户可感知)

### U1-1 专家团运行进度可视化(优先级最高的体验缺口)

**问题**:点「启动专家团」后只有一条 toast,9 人 3 波的执行过程完全黑盒——哪波在跑、谁完成了、谁失败了、下一波何时出发,用户只能去后台会话列表里猜。
**方案**:Gallery 加第三页签「进行中」(或 RosterCard 就地展开):
- 数据源:`<DataRoot>/nexus/<id>.json`(RosterPipeline 已含 waves/current_wave/members 状态)+ 新命令 `nexus_list_pipelines` / `nexus_get_pipeline`;推进事件已在 Rust 侧发生,可复用 `emit_dispatch_event` 增发 `nexus-pipeline-update` 事件驱动前端刷新(比轮询好)。
- UI 复用早前 PRD 原型的波次卡(成员 chip + 状态色 + 进度条);成员点击跳转其后台会话(`openDispatchSession` 已有)。
- 场景终局产 Pipeline Status Report 汇总卡片(§4.4(c),对应 P2-7 未竟项)。
**改动**:`nexus_pipeline.rs`(emit 事件)、`commands/nexus.rs`(2 个查询命令)、Gallery 第三页签、dispatchStore 订阅。约 2d。

### U1-2 verdict 结构化卡片渲染

**问题**:`DispatchedTask.verdict` 已随 check/回流序列化到前端,但派发结果卡片仍只显示自由文本 summary——结构化的 qa-fail issue 列表(severity/expected/actual/fix)白白浪费。
**方案**:派发回流卡片按 `verdictStatus === 'structured'` 分支渲染:qa-pass 绿色徽标+验收计数;qa-fail 红色徽标+折叠 issue 列表(默认只显条数);unstructured 保持现状。复用简报卡片样式(compact-handoff 先例)。约 1d。

### U1-3 @ 提及引入专家(输入任意位置)

**问题**:参数补全只在消息首 `/agent|/dispatch` 生效;Qoder 的心智是对话中随手 `@专家` 提及。
**方案**:复用 `@对话` 的建议管线(FileSuggestion 已有 conversation 模式先例),`@` 后弹专家分组;选中后两种语义可选:(a) 轻量——只把「请以专家 X 视角……」文本注入消息;(b) 重量——等价 `/agent <slug>` 切换会话 persona。建议做 (a),不打断当前 persona、心智接近"请教某人"。约 1.5d。注意与 @文件/@对话 建议的分组共存与优先级。

### U1-4 专家详情与来源可视

- Gallery 卡片点开抽屉:完整 system prompt 预览(corpus 文件 render markdown)、角色徽标(qa/gate-keeper/orchestrator,agent-roles.json 已有数据)、「另存为自定义」(把 corpus 专家复制到项目级改编——自定义专家的最自然入口,比从零写 prompt 门槛低得多)。
- 会话内当前专家可视:SessionConfigSelector 的 agent label 对 claude 引擎下 corpus slug 显示裸 slug,应回退 catalog 映射 emoji+中文名。
合计约 1.5d。

### U1-5 自定义专家团(用户自建 roster)

**问题**:专家团只有 4 个内置场景;用户组不了自己的队。
**方案**:Gallery 专家团页「+ 自建专家团」:多选专家(自定义+corpus)→ 命名保存为用户 roster(落 `<DataRoot>/agents/rosters-user.json` 或项目级);启动路径复用 `start_roster`(rosters 读取处合并用户定义,slug 校验一致)。波次仍由 role 排序自动切。约 2d。

## 2. 集成层升级方向(能力闭环)

### U2-1 Dev↔QA loop + Escalation(P2-6,M2 闭环的核心缺口)

现状:QA FAIL verdict 只是被记录,没有任何后续动作——「配合」的闭环断在最后一环。
方案(按原设计):
- `nexus_pipeline` 成员终态处理时,若 verdict 为 qa-fail 且关联了 developer 成员(coordination handoff_pairs 或同 roster 内 role 匹配),对 developer 的 dispatchId 发 `continue_dispatched_task`(issue 列表作前置上下文,"只修列出的 issue");attempts 计数入 pipeline 状态。
- attempts=3 → 产 escalation schema → 经 polaris-ask 通道弹 AskUserQuestion(reassign/decompose/accept/defer),用户选择驱动状态机。
- 顺带补:verdict 校验失败时自动 continue 一次要求重发 JSON(当前直接降级 unstructured)。
约 3d,是 M2 出口标准的最后一块。

### U2-2 波次上下文传递增强

现状:下波 prompt 只提示「前波成员 X/Y 已完成」,不带产出内容——下游专家实际拿不到上游成果,「消费前波产出」是口头的。
方案:`on_dispatch_terminal` 时把成员 summary(截断至 ~800 字)写入 pipeline 状态 `member_summaries`;`build_member_prompt` 把前波各成员摘要填入 `[REFERENCE]` 段。纯 Rust 改动,不经主会话 LLM 转述(§4.4(c) 设计本意)。约 1d,**性价比最高的集成升级**。

### U2-3 activation 时序完整支持

现状:只派 always 组;week3+/as-needed/post-fix 组读入即丢。
方案:pipeline 保留全部组;always 波次完成(=场景主体完成)视作 gate PASS 事件,提示用户是否追派 week3+ 组(AskUserQuestion,而非自动——成本考虑);post-fix 组挂到 U2-1 的修复完成事件(continue 原 QA 会话复验)。as-needed 保持仅展示。约 1.5d。

### U2-4 选路层打通(L1/L2 全引擎可用)

- coordination.json 目前无消费方:在 polaris-dispatch 增加轻量工具 `find_expert(task_type|query)`——先查 L1 路由表,miss 时返回 agent-index 片段让调用方语义匹配。这使 **claude 引擎也能用选路能力**(nexus-agent-index skill 仅 SimpleAI 可读的通道缺口就此绕开)。约 1.5d。
- claude 引擎会话内 persona 缺口:用 claude CLI `--agents <json>`(免落盘,cli-integration 文档已调研)把当前选中的 corpus/自定义专家注入,补齐 `options.agent` 对 claude 的语义。约 1.5d,风险:CLI 版本兼容性需实测。

### U2-5 Web/移动端桥接补齐

`nexus_start_roster`、`agent_corpus_*`、`custom_agent_*` 均未过 `web/api/ipc.rs` 桥——Web 模式下 Gallery/专家团整体不可用(仅桌面)。按 ipc.rs 现有 dispatch 桥模式补注册。约 1d。低感知但决定功能覆盖面。

### U2-6 M3:Orchestrator O3 混合(原 P3-1..P3-3)

在 U2-1/2/3 之后启动:orchestrator agent 定义适配(决策者角色,pipeline 状态作 context 注入)、playbooks 三档 `/nexus sprint|micro`、两场景端到端演练与 token 成本校准(对照 context-cost-meter)。约 5d,维持原计划。

### U2-7 工程与数据维护

- **corpus 更新机制**:上游月增 ~50 agent;`gen-agent-catalog.mjs` 重跑 + corpusVersion 递增即可升级,但缺「检查上游 → 重新生成 → PR」的例行流程说明与 stale 提示(设置页显示基线 commit 与日期)。约 0.5d(文档+状态展示)。
- **tools 白名单过滤**:AgentDefinition.tools 解析未启用;SimpleAI spawn 子会话时按白名单过滤工具注册表,自定义专家表单顺带暴露 tools 字段。约 1d,安全/成本双收益。

---

## 3. 优先级与批次建议

| 批次 | 内容 | 主题 | 工作量 |
|---|---|---|---|
| **B1(建议先做)** | U2-2 波次上下文 + U1-1 进度可视化 + U1-2 verdict 卡片 | 让已落地的组队/回流链路「看得见、真联动」 | ~4d |
| **B2** | U2-1 Dev↔QA loop + Escalation(含校验失败自动重试)+ U2-3 时序支持 | M2 闭环收口(出口标准达成) | ~4.5d |
| **B3** | U1-3 @提及 + U1-4 详情/另存为自定义 + U1-5 自建专家团 | 选人与自定义体验纵深 | ~5d |
| **B4** | U2-4 选路打通 + U2-5 Web 桥 + U2-7 工程维护 | 全引擎/全端覆盖 | ~5.5d |
| **B5** | U2-6 M3 orchestrator | 完整 pipeline | ~5d |

**排序理由**:B1 全是对已建成链路的「最后一公里」——波次调度、verdict 都已在跑,但用户看不见、下游用不上,做完这 4d 现有投入的价值才真正兑现;B2 是设计上「配合」的闭环(没有 loop 的 QA 只是打分不是质量保证);B3/B4 可并行;B5 依赖 B2 的 loop 与 gate 数据。

## 4. 风险提示

1. **U2-1 的自动 continue 有成本放大风险**:QA fail→developer 重试→QA 复验是 3 次会话链;必须由 pipeline attempts 硬上限(3)与用户 escalation 兜底,且默认只在 roster 场景内启用,单发 dispatch_task 不自动 loop。
2. **U1-3 @提及与现有 @文件/@对话 抢触发**:需明确优先级与前缀区分(如 `@专家:` 或分组共存),否则高频 @ 文件用户会被打扰。
3. **U2-4 的 `--agents <json>` 依赖 claude CLI 行为**:不同版本参数支持不一,需按 cli-integration 文档矩阵实测后再放开,失败时静默回退现状。
4. **上游漂移**:corpus 更新会改变 slug 集合,用户自建 roster(U1-5)引用的 slug 需在启动时校验并提示缺失成员,而非静默丢弃。
5. **进度事件风暴**:U1-1 若逐成员逐状态 emit,9 人团队会打爆前端;按 pipeline 粒度节流(≥1s 合并)发事件。
