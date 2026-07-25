# Agent 体系下一步升级优化方案分析

> 基线:M0/M1 已完成、M2 核心链路(resultSchema/verdict 回流/波次状态机/dispatch_roster)已落地、Qoder 式交互优化(专家参数补全/专家团页签/自定义专家 CRUD)已上线。
> 上位文档:`docs/agency-agents-integration-plan.md`(§2-§4 设计)、`docs/agency-agents-implementation-plan.md`(M2/M3 任务拆解)。
> 状态:**B1(~4d) + B2(~4.5d) + B3 大部 + B4 大部 + B5(~5d) 已实施**;仅剩 U1-3(1.5d)、U1-4(1.5d)、U2-7 工程维护(1d)未实施。**本文件已按实际代码修正,已落地项标记为 ✅。**
> 更新日期:2026-07-26

---

## 0. 现状能力盘点(截至本轮)

| 层 | 已有 | 明显缺口 |
|---|---|---|
| 选人 | Gallery 浏览/搜索/筛选;`/agent` `/dispatch` `/nexus` 参数补全;自定义专家 CRUD;L0(options.agent)与 SimpleAI 下拉;`find_expert` MCP 工具(L1→L2);claude 引擎 `--agents <json>` 注入 | @ 提及引入专家(U1-3);专家详情抽屉(U1-4) |
| 配合 | resultSchema 注入 + verdict 提取校验 + 回流携带;✅ verdict 结构化卡片渲染;✅ Dev↔QA loop + escalation(MAX_FIX_ATTEMPTS=3);✅ 校验失败自动重试 | 无 |
| 组队 | ✅ roster 卡组队;✅ 拓扑波次并发补派;✅ 完成事件推进;✅ 进度 Panel(PipelineCard);✅ 波次上下文传递(member_summaries→REFERENCE);✅ activation 时序支持(later_groups 追派);✅ M3 orchestrator 角色;✅ 场景终局 Pipeline Status Report | 无 |
| 工程 | ✅ 双形态编译;✅ 纯逻辑单测;✅ corpus 幂等安装;✅ web IPC 桥覆盖全部 nexus/agent_corpus 命令;✅ find_expert MCP 工具 | corpus 上游漂移无更新提示;AgentDefinition.tools 白名单过滤未启用 |

---

## 1. 体验层升级方向(用户可感知)

### ✅ U1-1 专家团运行进度可视化

**已实施**(`AgentGalleryPanel.tsx:400-550` PipelineCard + `nexus-pipeline-update` 事件 + `nexus_list_pipelines` 查询 + web IPC 桥)。Gallery 第三页签「进行中」展示波次进度条、成员状态 chip、Dev↔QA loop、escalation 处置、追派按钮。

### ✅ U1-2 verdict 结构化卡片渲染

**已实施**(`DispatchTaskCard.tsx:300-384` VerdictBlock)。qa-pass 绿色徽标+验收计数;qa-fail 红色徽标+折叠 issue 列表(severity/expected/actual/fix_instruction/file_to_modify);phase-gate 完整支持。

### U1-3 @ 提及引入专家(输入任意位置)

**问题**:参数补全只在消息首 `/agent|/dispatch` 生效;Qoder 的心智是对话中随手 `@专家` 提及。
**方案**:复用 `@对话` 的建议管线(FileSuggestion 已有 conversation 模式先例),`@` 后弹专家分组;选中后两种语义可选:(a) 轻量——只把「请以专家 X 视角……」文本注入消息;(b) 重量——等价 `/agent <slug>` 切换会话 persona。建议做 (a),不打断当前 persona、心智接近"请教某人"。约 1.5d。注意与 @文件/@对话 建议的分组共存与优先级。

### U1-4 专家详情与来源可视

**问题**:Gallery 卡片信息密度低,无法预览 system prompt、「另存为自定义」需先展开弹层;会话内 agent slug 显示为裸 slug。
**方案**:
- Gallery 卡片点开抽屉:完整 system prompt 预览(corpus 文件 render markdown)、角色徽标(qa/gate-keeper/orchestrator,agent-roles.json 已有数据)、「另存为自定义」(forkCorpus 按钮已有,但入口在卡片上而非详情层)。
- 会话内当前专家可视:SessionConfigSelector 的 agent label 对 claude 引擎下 corpus slug 显示裸 slug,应回退 catalog 映射 emoji+中文名。
合计约 1.5d。

### ✅ U1-5 自定义专家团(用户自建 roster)

**已实施**(`AgentGalleryPanel.tsx:556-666` RosterBuilder + `saveUserRoster`/`deleteUserRoster` 命令 + `rosters-user.json` 合并)。用户可在 Gallery 专家团页勾选专家(自定义+corpus)自建 roster,波次按 role 自动编排。

## 2. 集成层升级方向(能力闭环)

### ✅ U2-1 Dev↔QA loop + Escalation

**已实施**(`nexus_pipeline.rs:717-865`)。QA fail verdict → continue developer 会话修复 → continue QA 复验;MAX_FIX_ATTEMPTS=3 耗尽 → escalation 待用户处置(accept/fail);verdict 校验失败自动 continue 一次要求重发 JSON。

### ✅ U2-2 波次上下文传递增强

**已实施**(`nexus_pipeline.rs:244-260` record_summary + `build_member_prompt` REFERENCE 注入)。成员摘要截断至 800 字,下波 prompt 带前波产出。

### ✅ U2-3 activation 时序完整支持

**已实施**(`RosterPipeline.later_groups` + `dispatch_group` + `append_waves` + `dispatched_groups` + PipelineCard 追派按钮)。always 波次完成→用户可追派 week3+/post-fix 组;as-needed 仅展示。

### ✅ U2-4 选路层打通(L1/L2 全引擎可用)

**已实施**:
- `find_expert` MCP 工具(`dispatch_mcp_server.rs:44`):L1 coordination.json 任务类型查表,miss 时返回 agent-index 片段供调用方语义匹配。**claude 引擎也能用选路能力**。
- 此处 `find_expert` 与 `polaris-dispatch` MCP 的 `find_expert` 工具**共享同一实现**(`ask_listener.rs:817-855`),非两个独立入口。

### ✅ U2-5 Web/移动端桥接补齐

**已实施**。`ipc.rs:85-191` 已桥接全部 `agent_corpus_*`/`custom_agent_*`/`user_roster_*`/`nexus_*` 命令,Web 模式下 Gallery/专家团完全可用。

### ✅ U2-6 M3:Orchestrator O3 混合

**已实施**:
- `build_member_prompt` 对 orchestrator 角色注入完整 pipeline 状态(成员逐波状态表 + mode + playbooks 目录引用)。
- `final_report` 在全部波次完成时自动生成,注入来源会话。
- 场景终局 Pipeline Status Report 汇总卡片(含每成员摘要、escalation 记录)。
- playbooks 目录(`<DataRoot>/agents/playbooks/`)已存在。

### U2-7 工程与数据维护

- **corpus 更新机制**:上游月增 ~50 agent;`gen-agent-catalog.mjs` 重跑 + corpusVersion 递增即可升级,但缺「检查上游 → 重新生成 → PR」的例行流程说明与 stale 提示(设置页显示基线 commit 与日期)。约 0.5d(文档+状态展示)。
- **tools 白名单过滤**:`AgentDefinition.tools` 解析未启用;SimpleAI spawn 子会话时按白名单过滤工具注册表,自定义专家表单顺带暴露 tools 字段。约 1d,安全/成本双收益。
- **claude 引擎 `--agents <json>` 注入**:已实现(`agent_corpus.rs:78` 供给 + `claude.rs` 消费),将当前选中专家(含 corpus 人格)注入 claude CLI 进程。**此通道已打通,但 CLI 版本兼容性需实测**(见 cli-integration 文档矩阵)。

---

## 3. 优先级与批次建议(剩余项)

| 批次 | 内容 | 主题 | 工作量 |
|---|---|---|---|
| **B3-remain** | U1-3 @提及 + U1-4 详情/另存为自定义 | 选人与自定义体验纵深 | ~3d |
| **B7-remain** | U2-7 工程维护(stale 提示 + tools 白名单) | 数据与安全治理 | ~1.5d |

**说明**:B1(进度可视化+verdict 卡片+波次上下文)、B2(Dev↔QA loop+escalation+activation 时序)、B4(选路打通+Web 桥)、B5(M3 orchestrator)已全部实施。剩余工作量约 4.5d。

## 4. 风险提示

1. **U1-3 @提及与现有 @文件/@对话 抢触发**:需明确优先级与前缀区分(如 `@专家:` 或分组共存),否则高频 @ 文件用户会被打扰。
2. **`--agents <json>` 依赖 claude CLI 行为**:不同版本参数支持不一,需按 cli-integration 文档矩阵实测后再放开,失败时静默回退现状。
3. **上游漂移**:corpus 更新会改变 slug 集合,用户自建 roster 引用的 slug 需在启动时校验并提示缺失成员,而非静默丢弃。
