# Agency Agents 整合方案

> 将 `jnMetaCode/agency-agents-zh`(中文社区版,266 个)与 `msitarzewski/agency-agents`(英文上游,约 216 个)整合到 Polaris 的落地方案。
>
> **本文重点不是"导入 266 个 prompt 文件"——那毫无价值。重点是如何让 Polaris 具备「选对专家」与「多专家配合」的能力。** 两个上游项目真正的核心是 NEXUS——一套选择与编排协议,corpus 只是它的弹药库。
>
> 状态:仅分析与方案设计,未改动代码。
> 许可证:两上游均为 MIT,整合产物须保留 LICENSE 与来源声明。
> 关联记忆:[[simple-ai-codex-refactor]] / [[simple-ai-power-up-plan]] / [[dispatch-task-mcp]] / [[polaris-computer-mcp]]

---

## 0. 核心论点

agency-agents 的价值不在 266 个 `.md`,而在三套**协议**:

1. **选谁出场**(Activation)——`Coordination Matrix`(产出/消费依赖图)+ `runbooks.json`(场景→预设团队)+ `activation-prompts.md`(每 agent 的激活 prompt 模板,带 phase/task/acceptance criteria 占位符)。
2. **怎么配合**(Coordination)——`Handoff Templates`(7 种标准化交接:Standard/QA-PASS/QA-FAIL/Escalation/Phase-Gate/Sprint/Incident)+ `Quality Gates`(7 个 phase gate,每个指定 Gate Keeper + 通过标准)+ `Dev↔QA Loop`(任务级实现→验证→PASS 推进 / FAIL 带 fix instruction 回退,3 次重试升级)。
3. **谁来调度**(Orchestration)——`agents-orchestrator` agent 作为总指挥,持有 pipeline 状态、分配任务、执行 gate、3 次重试后升级。

Polaris 已有的承载能力:
- agent 定义 + `dispatch_agent`(子会话,同进程,深度≤3)——对齐 Claude Code Task 工具,适合单次 subtask
- [[dispatch-task-mcp]](独立后台会话,并发≤3,深度≤2,带 role/model 选择 + 结果回流)——适合多 agent 并行团队
- SimpleAI skill 索引 + `read_skill`(progressive disclosure)——适合把 NEXUS doctrine 作为可加载指令

**整合 = 把 NEXUS 的三套协议嫁接到 Polaris 的两个 dispatch 通道上**。corpus 导入是准备工作(§6 Phase 0),不是目标。

本文主体是三个问题,各占一章:
- **§2 怎么选择专家**——分层决策链:用户手动(L0)> 结构路由查表(L1)> 语义路由兜底(L2)> 主会话直做(L3)
- **§3 怎么配合**——Handoff schema 结构化回流 + Quality Gate + Dev↔QA Loop + O3 混合 orchestrator
- **§4 怎么组合专家团**——roster 表达 + activation 时序触发器 + 并发≤3 下的拓扑波次调度 + 三层结果汇聚

---

## 1. 项目调研(简版,详见附录 A)

### 1.1 两者本质

两者都是「Claude Code subagent 定义词典(`.md` + YAML frontmatter + body)+ 多工具格式转换器(`convert.sh` 18 种格式)+ 安装脚本(`install.sh` 复制到各工具目录)」。

**frontmatter 格式**(与 Polaris `parse_agent` 几乎完全同构):
```markdown
---
name: 前端开发者          # 显示名(中文版是中文)
description: 精通现代 Web ...
emoji: 💻
color: cyan
tools: read_file, edit_file, ...   # 工具白名单
---
# 前端开发者 Agent 人格      # body = system prompt
你是 **前端开发者**...
```

### 1.2 英文上游 `msitarzewski/agency-agents`(约 216 agent)

工程化程度高,有机器可读元数据:
- `divisions.json`——17 部门 → label/icon/color(CI `check-divisions.sh` 保证与目录一致)
- `tools.json`——18 种工具的 install contract(`format`/`installKind`(per-agent/roster/plugin)/`dest`/`detect`/`version`)
- `runbooks.json`——4 个场景的预设团队 roster(slug 引用 + 分组 + activation 时序)
- `strategy/`——NEXUS doctrine:`nexus-strategy.md`(总纲)+ `QUICKSTART.md`(Full/Sprint/Micro 三档)+ 7 个 `playbooks/phase-0..6-*.md`(每 phase 有 Gate Keeper)+ `coordination/`(activation-prompts + handoff-templates)+ 4 个 `runbooks/scenario-*.md`

### 1.3 中文社区版 `jnMetaCode/agency-agents-zh`(266 agent)

上游翻译 + 51 个中国原创(小红书/抖音/微信/B站/快手/微博/飞书/钉钉运营、政务 ToG、医疗合规、高考志愿、Qt 上位机、机械设计、养殖档案等)+ 3 个本地部门(`hr/` `legal/` `supply-chain/`)。追平上游 commit `3f78a30`(2026-06-18)。**缺少** `divisions.json`/`tools.json`/`runbooks.json` 三个机器可读文件(用 `AGENT-LIST.md`/`CATALOG.md` 人工表格替代),但 `strategy/` doctrine 与上游同步。

### 1.4 两者关系

同源(中文版 = 上游 fork + 翻译 + 扩展)、互补(中文版有中国本地化 corpus,英文版有工程化元数据)。对 Polaris(中文、面向开发者)最优:**以中文版 corpus 为主体 + 从英文版回补三个机器可读 json + strategy/ doctrine**(中文版 strategy 已同步,可直接用)。

---

## 2. 怎么选择专家(Selection Layer)

「选专家」要回答:**这个任务该用谁?依据什么决定?用户手动选与自动选怎么共存?**

### 2.1 结论:四层决策链(L0–L3,严格优先级)

| 层 | 决策者 | 机制 | Polaris 接入点 | 适用 |
|---|---|---|---|---|
| **L0 用户显式指定** | 用户 | `/agent <slug>` 或 UI 选择 → `options.agent` | `SessionOptions.agent`(traits.rs:110)→ claude CLI `--agent` 透传(claude.rs:416)/ SimpleAI `load_agent`(agent.rs) | 用户明确知道要谁;**终局,orchestrator 不得覆盖** |
| **L1 结构路由(确定性查表)** | Rust 代码 | 任务类型/phase → slug 查表,来源为固化的 Coordination Matrix + roster | `resources/nexus/coordination.json`,由 `nexus_pipeline.rs` 查,**不进 LLM context** | pipeline 内标准任务(frontend task → frontend-developer);零 token、可测试、可缓存 |
| **L2 语义路由(兜底)** | orchestrator LLM | 基于 266 条 `slug — name — description` 索引语义匹配,给 1–3 候选 + 理由 | 索引生成为 `agent-index.md`(~40KB),走 skill 通道 `read_skill` 按需加载,不常驻 context | 查表 miss 的长尾任务;交互场景经 AskUserQuestion 确认,pipeline 自动场景取 top-1 并把路由理由记入 pipeline 状态 |
| **L3 缺省** | — | 不派专家 | 主会话直接做 | 琐碎任务,派发开销 > 收益 |

**理由**:确定性优先(L1 可测试、零成本、不受 LLM 波动影响),语义兜底(L2 覆盖 266 个 agent 的长尾,硬编码矩阵不可能穷举),用户随时可覆盖(L0 尊重显式意图)。这也回答了「手动选与自动选如何分层共存」:`options.agent` 是会话级 persona 覆盖(用户意图),L1/L2 是任务级派发选人(orchestrator 意图),作用域不同、互不抢占——orchestrator 派发子任务时即使父会话有 `options.agent`,子任务仍按 L1/L2 选人。

**关键实现决策:路由不单独 dispatch 一个 agent-router**。为一次选人多开一个子会话(往返延迟 + token 成本)不划算;L2 在 orchestrator 自身 context 内完成(read_skill 加载索引后直接判)。仅当用户在非 pipeline 场景问「这事该找谁」时,才值得可选的轻量 router 交互(Phase 1 进阶项)。

### 2.2 任务级依据:Coordination Matrix + Activation Prompt

**上游机制**:`nexus-strategy.md §10` 的 `Agent Coordination Matrix`(9×9 部门产出/消费依赖图)+ `coordination/agent-activation-prompts.md`(每个 agent 一段激活模板,带 `[PHASE]`/`[TASK ID]`/`[ACCEPTANCE CRITERIA]`/`[REFERENCE DOCUMENTS]` 占位符)。`agents-orchestrator` 根据任务类型从矩阵查「该 spawn 哪个 developer」,再用 activation prompt 模板填占位符后委派。

例(activation prompt 节选):
```
You are Frontend Developer working within the NEXUS pipeline for [PROJECT].
Phase: [PHASE] | Task: [TASK ID] — [DESC] | Acceptance criteria: [CRITERIA]
Reference documents: Architecture / Design system / API spec / Brand guidelines
When complete, your work will be reviewed by Evidence Collector.
Do NOT add features beyond the acceptance criteria.
```

**Polaris 接入**:
- **Coordination Matrix 双形态**:机器可读形态固化为 `resources/nexus/coordination.json`(任务类型→producer/consumer slug 对),供 L1 查表(Rust,`nexus_pipeline.rs`);语义形态(关键 handoff pair 表:Senior PM→All Developers / UX Architect→Frontend / Backend→Frontend API spec / Developer→Evidence Collector / Evidence Collector→Orchestrator verdict)作为 `nexus-coordination` skill 供 orchestrator `read_skill`,用于 L2 判断与 task 分解。
- **Activation Prompt 模板库**:把 `agent-activation-prompts.md` 拆成 per-agent 模板,落到 `<DataRoot>/agents/activation/<slug>.md`。**分工:模板检索由 Rust 提供**(`nexus_pipeline::load_activation(slug)`,查不到时回退到通用模板),**占位符填充由 orchestrator LLM 完成**(`[TASK]`/`[ACCEPTANCE CRITERIA]` 需要语义理解,代码填不了;`[PHASE]`/`[REFERENCE DOCUMENTS]` 由 Rust 从 pipeline 状态预填)。填充后的完整文本作为 `dispatch_agent` 的 task 描述或 `dispatch_task` 的 prompt 传入——比裸传 task 多了「上下文 + 验收标准 + 下游 reviewer」三个约束。
- **与 L0(`options.agent`)的关系**:`options.agent` 是用户手动选一个 agent 覆盖会话 persona(单专家);activation prompt 是 orchestrator 自动选 + 自动填上下文(编排)。两者分层不冲突(见 §2.1)。

### 2.3 场景级选队:Runbook Roster(移至 §4)

场景级「选一队人」与任务级「选一个人」机制不同——它是预编排的团队 + 时序,涉及分批派发与结果汇聚,独立成章,见 **§4 怎么组合专家团**。

### 2.4 用户级选专家:Agent Gallery + 自动推荐

**用户主动选**:Phase 1 的 Agent Gallery 面板(复用 `skillStore` 骨架 + `divisions.json` 分组/图标/颜色),卡片展示 emoji+中文名+description,支持搜索/部门筛选,「启用为当前 agent」(写 `options.agent`)或「dispatch 一次性任务」(调 `dispatch_agent`)。`/` 命令补全 `/agent <slug>` 与 `/dispatch <slug> <task>`。

**自动推荐(进阶)**:即 §2.1 的 L2 语义路由的交互化包装——用户描述任务后,orchestrator 在自身 context 内(read_skill 加载 agent-index)匹配 1-3 个候选 agent + 理由,经 AskUserQuestion 让用户确认后派发。不硬编码矩阵,靠 description 语义路由;不单独 dispatch router agent(见 §2.1 实现决策)。

---

## 3. 怎么配合(Orchestration Layer)

「配合」要回答:**专家之间怎么交接?质量怎么保证?谁来推进 pipeline?** NEXUS 给了四套机制,通道分工的总结论:**developer 类工作走 `dispatch_agent`(同进程子会话,共享 MCP/skills,轻量),QA/Gate/roster 类工作走 `dispatch_task`(独立后台会话,context 隔离,结果回流)**,理由逐条见 §3.3 与 §7。

### 3.1 标准化交接:Handoff Templates

**上游机制**:`coordination/handoff-templates.md` 定义 7 种交接文档,每种有固定字段:

| 模板 | 用途 | 关键字段 |
|---|---|---|
| Standard Handoff | 任意 agent 间工作转移 | From/To/Phase/Task/Context(已完成状态+相关文件+依赖)/Deliverable Request(可衡量验收标准)/Quality Expectations(必须通过+证据要求+下游接收方) |
| QA PASS | QA 通过 | 验收逐条 verified + 截图证据(Desktop/Tablet/Mobile)+ 下一步:Orchestrator 推进 |
| QA FAIL | QA 失败 | Issue 列表(Severity+Expected+Actual+Evidence+Fix instruction+File to modify)+ 验收状态 + 重试指令(只修列出的,不加新功能) |
| Escalation | 3 次重试耗尽 | 3 次失败历史 + 根因分析 + 推荐处置(Reassign/Decompose/Revise/Accept/Defer)+ 影响评估 |
| Phase Gate | 阶段间过渡 | Gate Criteria 逐条 PASS/FAIL + 携带文档 + 下阶段 agent 激活时序 + 风险 |
| Sprint Handoff | sprint 边界 | 完成状态 + 质量度量(首过率/平均重试)+ 结转项 + 回顾 |
| Incident Handoff | 事故响应 | 严重度 + 时间线 + 已尝试/未尝试 + 疑似根因 + 利益相关者通信 |

**核心价值**:交接文档防止「context loss——多 agent 协作失败的第一原因」。尤其 QA FAIL 模板:把「哪里错了、期望什么、实际什么、证据、怎么修、改哪个文件」结构化,developer 拿到就能精准修复,不会发散。

**Polaris 接入**:
- **Handoff 模板作为 structured output schema**:把这 7 种模板定义成 JSON schema(`resources/nexus/schemas/*.json`),QA 类 agent(Evidence Collector / Reality Checker / API Tester)的返回强制用对应 schema 输出 verdict,而非自由文本。
- **结构化回流的具体机制**(现有 `dispatch_task` 只回流自由文本 summary,需要增量改造):
  1. `dispatch_task` 新增可选参数 `resultSchema`(schema id,如 `qa-fail`)——改 `dispatch_mcp_server.rs` 工具定义与 `ask_listener.rs::register_dispatch_task` 透传;
  2. 注册派发会话时,在 append_system_prompt 尾部注入「结束前最后一条消息必须输出符合该 schema 的 JSON 代码块」指令;
  3. 会话完成后,结果回流路径(ask_listener 的 check/回流帧)对 summary 做 JSON 提取 + 字段校验(serde_json,起步手写字段校验即可,不必引入 jsonschema crate);
  4. 校验失败→自动 `continue_dispatched_task` 一次,要求重发结构化 verdict(复用同会话 context,成本低);再失败则降级为自由文本回流并标记 `unstructured`;
  5. 校验通过→回流帧携带 parsed verdict,由 `nexus_pipeline.rs` 直接消费(**Rust 读结构化字段推进状态机,不依赖主会话 LLM 转述**——这是「结构化回流而非自由文本」的核心收益)。
- **Dev↔QA Loop 的载体**:orchestrator 持有当前 task 的 QA FAIL verdict(结构化的 Issue 列表:Severity/Expected/Actual/Evidence/Fix instruction/File to modify),回传给 developer agent 时作为 task 描述的前置上下文(「上一次 QA 失败原因:...,请只修列出的 issue」),形成闭环。
- **与 [[compact-handoff-implementation]] 的关系**:Polaris 已有压缩交接(简报卡片),Handoff Template 是其「多 agent 版」——压缩交接是会话内/跨会话的状态转移,Handoff 是 agent 间的工作转移。verdict 回流卡片复用简报卡片 UI 渲染。

### 3.2 质量门:Quality Gates

**上游机制**:7 个 phase 各有一个 gate,gate 由指定 Gate Keeper 守门,有明确通过标准:

| Phase 过渡 | Gate | Gate Keeper | 通过标准 |
|---|---|---|---|
| 0→1 | Discovery Gate | Executive Summary Generator | 市场验证、用户需求确认、合规路径清晰 |
| 1→2 | Architecture Gate | Studio Producer + Reality Checker | 架构完成、品牌定义、预算批准、sprint 计划现实 |
| 2→3 | Foundation Gate | DevOps Automator + Evidence Collector | CI/CD 可用、骨架 app 运行、监控激活 |
| 3→4 | Feature Gate | Agents Orchestrator | 所有任务过 QA、无 critical bug、性能基线达标 |
| 4→5 | Production Gate | **Reality Checker(唯一权威)** | 用户旅程完整、跨设备一致、安全验证、spec 合规 |
| 5→6 | Launch Gate | Studio Producer + Analytics Reporter | 部署成功、系统稳定、增长渠道激活 |

**Gate 失败处理**:Gate Keeper 出具失败报告 → Orchestrator 路由到责任 agent → 进 Dev↔QA loop → 最多 3 次 gate 重试 → 升级到 Studio Producer 决策(修复/裁剪/带风险接受)。

**关键设计:Reality Checker 默认判 NEEDS WORK**——要求「压倒性证据」才给 READY,「首次实现通常需 2-3 轮修订」「C+/B- 评级正常可接受」「不再给基础实现 A+」。这是反「AI 一团和气」的硬约束。

**Polaris 接入**:
- **Gate = phase 末尾的强制 QA dispatch**:orchestrator 在 phase 推进前,先 `dispatch_task` 派 Gate Keeper agent 用 Phase Gate schema 验证,verdict=PASS 才推进,verdict=FAIL 进 Dev↔QA loop。这是「pipeline integrity」的执行点。
- **Gate Keeper 映射到 Polaris 现有 agent**:Reality Checker / Evidence Collector / API Tester 这些 QA 类 agent 是 gate 的执行者;Studio Producer / Executive Summary Generator 这些是治理类。导入 corpus 时要标记 agent 的「角色类型」(developer / qa / gate-keeper / orchestrator / governance),便于 orchestrator 选 gate keeper。建议在 `AgentDefinition` 加 `role: Option<AgentRole>` 字段(从 description 或一个 `agent-roles.json` 映射)。

### 3.3 Dev↔QA Loop(任务级三审 + 重试升级)

**上游机制**:Phase 3 Build 的核心循环,`agents-orchestrator` 的 decision logic:

```
对 backlog 每个任务:
  1. 按任务类型 spawn developer(Frontend/Backend/Senior/Mobile/DevOps)
  2. developer 实现完成
  3. spawn Evidence Collector 做 QA(带截图证据、验收逐条验证)
  4. IF PASS: 标记完成,推进下一任务
  5. IF FAIL (attempt < 3): QA 反馈回传 developer,重试(只修列出的 issue)
  6. IF FAIL (attempt = 3): 升级——reassign / decompose / revise / accept / defer
```

**Polaris 接入**:
- **Loop 的两个 dispatch 通道分工**:developer 用 `dispatch_agent`(同进程子会话,轻量、共享 MCP/skills、适合实现类 subtask);QA 用 `dispatch_task`(独立会话,隔离 context,适合需要客观验证的 QA——QA 不该被 developer 的 context 污染)。这正好利用两个通道的不同特性。
- **重试计数与升级**:orchestrator 持有每任务的 `attempts` 计数(本地状态,不入会话 context),3 次后产 Escalation Report(用 §3.1 的 schema),升级到 Studio Producer 或人工。
- **与 [[ask-user-question-mcp-refactor]] 的结合**:升级决策(reassign/decompose/accept/defer)涉及取舍,可用 AskUserQuestion 让用户拍板,而非 orchestrator 自行决定——避免 AI 自作主张接受有缺陷的实现。

### 3.4 总调度:Agents Orchestrator

**上游机制**:`specialized/agents-orchestrator.md` 是一个 agent(不是代码),其 system prompt 定义了:身份(pipeline manager)、工作流(4 phase:分析规划→技术架构→Dev-QA 循环→集成验证)、decision logic(任务级质量循环)、状态报告模板(Pipeline Status Report / Completion Summary)、可用专家清单。

**Polaris 接入(关键决策——orchestrator 是 agent 还是代码?)**:

| 方案 | 描述 | 优劣 |
|---|---|---|
| **O1 纯 agent** | 直接用上游 `agents-orchestrator.md` 作为 `options.agent`,让 LLM 自行驱动 pipeline | 上游原设计,零开发;但 LLM 驱动不可靠(会跳过 gate、忘记重试计数、context 膨胀) |
| **O2 纯代码** | Rust 实现 pipeline 状态机 + gate + loop,orchestrator agent 只做选人 | 可靠、状态持久;但失去 LLM 的灵活决策,且工程量大 |
| **O3 混合(推荐)** | Rust 做「状态机骨架」(phase/attempts/gate verdict 持久化、重试上限强制、dispatch 调度),LLM 做「决策」(选谁、task 分解、根因分析) | 可靠性 + 灵活性兼顾;骨架复用 [[dispatch-task-mcp]] 的 dispatch/check/continue 三件套 |

**O3 落地**:
- 新增 `src-tauri/src/services/nexus_pipeline.rs`:持 pipeline 状态(phase / current_task / attempts / gate_verdicts / roster_dispatch_state),持久化到 `<DataRoot>/nexus/<session>.json`。
- orchestrator agent 的 system prompt 注入当前 pipeline 状态(作为 context message),LLM 决策「下一步 spawn 谁、task 是什么」,但 dispatch 由 Rust 执行(确保并发/深度限制、状态落盘)。
- gate / retry 上限是 Rust 强制(LLM 不能跳过):Rust 检查 verdict schema,verdict=FAIL 时自动回传 developer 重试,attempts=3 时强制产 Escalation。

---

## 4. 怎么组合专家团(Roster Layer)

「组队」要回答:**场景怎么映射到预编团队?activation 时序在 Polaris 怎么表达?并发≤3 下怎么派?结果怎么汇回主会话?**

### 4.1 roster 表达:runbooks.json → rosters.json + dispatch_roster 工具

**上游机制**:`runbooks.json` 把常见场景预编成团队,每个 roster 用 slug 引用 agent(与文件名 stem 一致,rename-proof),分 `activation` 时序组(always / week 3+ / as needed / post-fix)。4 个场景:

| 场景 | mode | duration | 核心团队(always) |
|---|---|---|---|
| startup-mvp | Sprint | 4-6 周 | orchestrator + senior-PM + sprint-prioritizer + UX-architect + frontend + backend + devops + evidence-collector + reality-checker(9) |
| enterprise-feature | Sprint | 6-12 周 | 15 人核心 + 合规治理/质量保障按需 |
| marketing-campaign | Sprint | 2-4 周 | social-media-strategist + content-creator + growth-hacker + brand-guardian + analytics(5) |
| incident-response | Micro | 分钟~小时 | infra-maintainer + devops + backend + frontend + support-responder + exec-summary(6)→post-fix 验证组 |

**Polaris 表达**:
- 导入器把上游 `runbooks.json` 转换为 `resources/nexus/rosters.json`:字段 `scenario / mode / duration / groups[{ activation, members[slug], trigger }]`;转换时做 slug→文件存在性校验(对齐上游 `check-runbooks.sh`,含附录 A.2 的 4 个路径映射),产 `roster_manifest.json` 供启动时校验。
- **新增 `dispatch_roster` 工具,挂在现有 polaris-dispatch MCP server 上(`dispatch_mcp_server.rs` 注册第 5 个工具),不新建 server**——复用同一条 TCP listener、深度≤2/并发≤3 治理与结果回流链路;slash 入口 `/nexus <scenario>`(注入 `cliSlashCommands.ts`)。
- 执行流:读 roster → 对每 slug `load_agent` → 填 activation prompt(§2.2)→ 按 §4.3 波次经 `dispatch_task` 派发 → 结果按 §4.4 汇聚。

**通道结论:roster 接 `dispatch_task`,不接 `dispatch_agent`**。理由:① `dispatch_agent` 子会话共享父 `abort_rx`,父中断全挂、一个挂全挂,团队派发不可接受;② 深度≤3 会截断深层 roster;③ `dispatch_task` 是独立后台 Polaris 会话,自带 role/model 选择、`check/continue` 三件套与结果回流卡片,天然适合组队。`dispatch_agent` 留给团队成员内部的轻量 subtask。

### 4.2 activation 时序 → Polaris 触发器映射

| 上游 activation | 语义 | Polaris 触发器 | 实现 |
|---|---|---|---|
| `always` | 立即出场 | roster 启动即入派发队列 | `dispatch_roster` 调用时入队,按 §4.3 波次派 |
| `week 3+` | phase 推进后出场 | **gate PASS 事件触发**(不是墙上时钟——Polaris 场景压缩到小时/天级,按 phase 语义而非周数) | `nexus_pipeline.rs` 在 gate verdict=PASS 时检查 pending groups,命中则入队 |
| `as needed` | 按需出场 | orchestrator 决策(走 §2.1 L1/L2 选人)或用户手动 `/dispatch <slug>` | 不预派,留在 roster 清单里供选人层引用 |
| `post-fix` | 修复后复验 | QA FAIL → fix 完成事件触发;**用 `continue_dispatched_task` 复用原 QA 会话复验**,而非新开会话——原会话保留了首次验证的 context(验收标准、复现步骤),复验更准且省 token | `nexus_pipeline.rs` 在 developer 任务标记完成时,对关联 QA dispatchId 发 continue |

### 4.3 并发≤3 约束:拓扑波次调度(不提并发上限)

**结论:不提升 dispatch-task 的并发上限(3 是资源保护:每个后台会话是完整 Polaris 会话,CPU/token 都真实),用「拓扑波次」把 9 人团队变成 3×3 波。**

- `nexus_pipeline.rs` 维护 roster 派发队列,按 Coordination Matrix 的 producer→consumer 依赖做拓扑排序分波:如 startup-mvp 的 always 组 9 人 → 波1(senior-PM + sprint-prioritizer + UX-architect,规划/设计产出方)→ 波2(frontend + backend + devops,消费波1产出)→ 波3(evidence-collector + reality-checker + orchestrator 汇总,消费波2产出)。
- 每波 ≤3(与并发上限对齐,波内真并行);**前波全部回流后才触发下波**,由 Rust 驱动(dispatchId 完成事件),不靠 LLM 记得。
- 这不是妥协而是收益:矩阵依赖本来就要求下游 agent 引用上游产出——并行洪泛 9 人反而让 frontend 在没有 API spec 时空转。波次调度让 activation prompt 的 `[REFERENCE DOCUMENTS]` 有实值可填(见 §4.4)。
- 波内某成员失败:不阻塞同波其他成员回流;该成员进 Dev↔QA loop 重试(§3.3),下波推进以「波内全部达到终态(成功或升级)」为准,升级项由用户拍板是否降级推进。

### 4.4 结果汇聚:三层回流

| 层 | 机制 | 现状 |
|---|---|---|
| (a) 单任务回流 | 每个 `dispatch_task` 完成 → 现有结果回流注入(主会话内联卡片 + summary 注入) | **已有,零改动**([[dispatch-task-mcp]] Phase 2 闭环) |
| (b) 结构化 verdict | QA/Gate 类返回按 §3.1 机制解析为结构化 verdict,由 Rust 写入 pipeline 状态并驱动状态机 | 需新增(`resultSchema` 参数 + 校验回流) |
| (c) 波次/场景汇总 | 每波完成后 Rust 把各成员 deliverable 摘要写入 pipeline 状态,并填进下波 activation prompt 的 `[REFERENCE DOCUMENTS]`(**跨波上下文传递由 Rust 完成,不经主会话 LLM 转述,防 context loss 与膨胀**);场景终局由 orchestrator 产 Pipeline Status Report(上游模板)作为汇总卡片呈现 | 需新增(nexus_pipeline + 汇总卡片) |

主会话 context 压力控制:9 人团队若逐个全文回流,主会话必爆。策略:(a) 层内联卡片默认折叠只显标题+verdict;全文留在各自后台会话(可点开);orchestrator 只消费 (b)(c) 层的结构化摘要。

---


## 5. 可行性评估

### 5.1 格式同构(承载基础)

Polaris `agent.rs:parse_agent` 与 agency-agents `.md` 逐字段对照:

| 字段 | agency-agents | Polaris | 差异处理 |
|---|---|---|---|
| 文件位置 | `engineering/<slug>.md` | `.polaris/agents/<slug>.md`(扁平) | 导入时扁平化为 `<division>-<slug>.md` |
| `name` | `前端开发者`(显示名) | 显示名 + stem 做 slug | **零冲突**:stem=slug、name=显示,`load_agent` 按 stem 查 |
| `description` | ✅ | ✅ | 直接兼容 |
| `emoji`/`color` | ✅ | ❌ 未解析 | 扩展 `AgentDefinition`(UI 用) |
| `tools` | ✅ | ✅ 已解析未启用 | 兼容(Phase 4d 注释"暂未启用过滤") |
| body | `# <角色> Agent 人格...` | system_prompt | **直接兼容** |

### 5.2 能力 复用/重构/舍弃

| 能力 | 处置 | 理由 |
|---|---|---|
| agent `.md` corpus(266+) | ✅ 直接复用 | 格式同构 |
| `discover_agents`/`load_agent`/`dispatch_agent` | ✅ 零改动复用 | 已落地,作 developer 通道 |
| [[dispatch-task-mcp]] | ✅ 复用作 roster/QA 通道 | 独立会话 + 结果回流,天然适合组队与客观 QA |
| `read_skill`/skill 索引 | ✅ 复用 | NEXUS doctrine 作 skill 注入 |
| `divisions.json`/`tools.json`/`runbooks.json` | 🔄 适配复用 | 英文版元数据,divisions 接 UI 分组、runbooks 接 `dispatch_roster`、tools 只取 claude-code 条目 |
| NEXUS playbooks/runbooks doctrine | 🔄 重构复用 | **本文核心**,见 §2/§3 |
| `coordination/handoff-templates.md` | 🔄 复用 | 转 structured output schema |
| `convert.sh`/`install.sh`(18 工具) | ⚠️ 舍弃大半 | Polaris 自宿主,只保留 claude-code identity 格式;codex-toml 可选给 codex 引擎 |
| `agency-orchestrator`/`agencyagents.app` | ❌ 舍弃 | Polaris 自身即桌面 App |
| `assets/`(赞助商二维码等) | ❌ 舍弃 | 与 Polaris 无关 |

### 5.3 与现有模块的关系

| 现有模块 | 关系 | 说明 |
|---|---|---|
| [[simple-ai-codex-refactor]] Phase 4d/5 | **直接承载** | agent 机制就是为这类 corpus 设计的 |
| [[simple-ai-power-up-plan]] 支柱 C | **重叠即目标** | Skill/Agent/Command 支柱正是承载点 |
| [[dispatch-task-mcp]] | **核心承载,不冲突** | roster/QA 通道;概念与 `dispatch_agent` 分层(独立会话 vs 子会话),共存 |
| [[compact-handoff-implementation]] | **协同** | 压缩交接是会话内/跨会话;Handoff Template 是 agent 间;可共用简报卡片 UI |
| [[ask-user-question-mcp-refactor]] | **协同** | Escalation 决策让用户拍板 |
| [[polaris-computer-mcp]] | 无冲突 | 正交工具维度 |
| `prompt_store.rs` | 轻微重叠,不合并 | prompt_store 管轻量片段,NEXUS playbooks 管完整 pipeline;分工 |
| `skillStore.ts` | 复用骨架 | 已声明扫 `.polaris/agents/`,扩展做 Agent Gallery |

---

## 6. 分阶段落地

### 总览

```
Phase 0:corpus + catalog 导入(准备工作,非重点)       — 让 266 agent 可被 load_agent 读到
Phase 1:选专家机制(§2)                               — 决策链 L0-L3 + Matrix + Gallery + 语义路由
Phase 2:配合与组队机制(§3/§4)                        — Handoff schema + Gate + Dev↔QA Loop + roster 波次调度 + Pipeline 状态机
Phase 3:Agents Orchestrator 接入(O3 混合)            — LLM 决策 + Rust 状态机骨架
Phase 4:许可证与来源合规
```

**MVP 边界**:Phase 0 + 4 让 corpus 可用;**真正交付价值**需要 Phase 1 + 2(选与配合);Phase 3 是完整体验。

### Phase 0(准备工作,非方案重点):corpus + catalog 导入(Rust)

**目标**:266 agent 落到可读位置,catalog 元数据可查。这是 §2–§4 的弹药库。

**落点决策**(推荐 P0-2):
| 方案 | 路径 | 优劣 |
|---|---|---|
| P0-1 | `<workspace>/.polaris/agents/` | 项目级,每项目重复装 |
| **P0-2** | `<DataRoot>/agents/` 全局 + `discover_agents` 加全局回退 | 装一次全项目可用 |
| P0-3 | `src-tauri/resources/agents/` 打包进二进制 | 出厂默认,不可增删 |

**步骤**:
1. 新增 `src-tauri/src/services/agent_corpus.rs`:`install_corpus`(把打包的 corpus 复制到 `<DataRoot>/agents/`,扁平化为 `<division>-<slug>.md`)、`list_corpus`、`uninstall_corpus`。
2. 扩展 `AgentDefinition`:`emoji`/`color`/`division`/`role`(agent 角色类型,见 §3.2)可选字段;`parse_agent` 兼容。
3. `discover_agents`/`load_agent` 加全局回退(项目级覆盖全局)。
4. 把英文版 `divisions.json`/`runbooks.json` 复制到 `resources/agents/`,合并中文版 20 部门(补 hr/legal/supply-chain 的 label/icon/color);生成 `agent-roles.json`(slug→role 映射,developer/qa/gate-keeper/orchestrator/governance)。
5. 命令 `src-tauri/src/commands/agent_corpus.rs` + 注册。

**改动文件**:新增 `services/agent_corpus.rs`、`commands/agent_corpus.rs`、`resources/agents/{*.md, divisions.json, runbooks.json, agent-roles.json}`;改 `agent.rs`、`services/mod.rs`、`commands/mod.rs`、`lib.rs`。
**依赖**:可能加 `include_dir` 或 tauri resource;无新增逻辑 crate。
**风险**:266 文件 ~1.3MB 可接受;slug 校验对齐 `check-runbooks.sh`。

### Phase 1:选专家机制(Selection Layer)

**目标**:三层选人都能用。

**1.1 Coordination Matrix + Activation Prompt(任务级)**
- 把 `nexus-strategy.md §10` 的 9×9 矩阵 + 关键 handoff pair 表固化为 `resources/nexus/coordination.json`(机器可读)。
- `agent-activation-prompts.md` 拆成 per-agent 模板,落 `<DataRoot>/agents/activation/<slug>.md`(或在 `AgentDefinition` 加 `activation_template` 字段)。
- `dispatch_agent`/`dispatch_task` 委派时,orchestrator 填占位符(phase/task/acceptance/reference docs)后传入。

**1.2 Runbook Roster(场景级,设计见 §4)**
- 新增 `dispatch_roster` 工具(或 `/nexus <scenario>` slash):读 `runbooks.json` → `load_agent` 每 slug → 填 activation prompt → `dispatch_task` 派发 → 按 activation(always/week 3+/as needed/post-fix)分批 → 结果回流。
- 复用 [[dispatch-task-mcp]] 的并发≤3 排队、深度≤2、结果回流卡片。
- slug 校验:导入器产 `roster_manifest.json`(slug→文件存在性),启动时校验。

**1.3 Agent Gallery + 自动推荐(用户级)**
- 新增 `src/stores/agentStore.ts` + `src/components/Agent/AgentGalleryPanel.tsx`(仿 skillStore,卡片网格,`divisions.json` 分组/图标/颜色,Virtuoso 虚拟化)。
- 注册 builtin view(`builtinPlugins.ts`,`panelType: 'agent-gallery'`,icon `Users`,order≈35)。
- `/agent <slug>`(写 `options.agent`)+ `/dispatch <slug> <task>`(调 dispatch_agent)+ `/nexus <scenario>`(调 dispatch_roster)注入 `cliSlashCommands.ts`。
- ToolSwitcher 加 agent 下拉。
- **自动推荐(进阶)**:轻量 `agent-router` agent,基于 description 语义匹配推荐 1-3 候选 + 理由,用户确认后派发。

**改动文件**:新增 `stores/agentStore.ts`、`components/Agent/*`、`types/agent.ts`、`resources/nexus/coordination.json`;改 `builtinPlugins.ts`、`cliSlashCommands.ts`、`ToolSwitcher.tsx`、`agent_corpus.rs`(activation template)。
**风险**:全量注入 context 爆炸——必须 progressive disclosure(只注 name+description 索引);266 卡片需虚拟化。

### Phase 2:配合编排机制(Orchestration Layer)

**目标**:Handoff + Gate + Dev↔QA Loop 可执行。

**2.1 Handoff Templates → Structured Output Schema**
- 7 种模板定义成 JSON schema(`resources/nexus/schemas/*.json`:standard-handoff / qa-pass / qa-fail / escalation / phase-gate / sprint-handoff / incident-handoff)。
- QA 类 agent(Evidence Collector/Reality Checker/API Tester)的 `dispatch_task` 返回强制用 verdict schema(`qa-pass`/`qa-fail`),结构化回流。
- Dev↔QA loop:orchestrator 持 QA FAIL 反馈,回传 developer 时作 task 前置上下文。
- 共用 [[compact-handoff-implementation]] 简报卡片 UI 渲染 verdict。

**2.2 Quality Gates**
- 7 phase gate 的 Gate Keeper + 通过标准固化为 `resources/nexus/gates.json`。
- `agent-roles.json` 标记 gate-keeper 角色;orchestrator phase 推进前 `dispatch_task` 派 Gate Keeper 用 `phase-gate` schema 验证,verdict=PASS 才推进。
- Reality Checker 默认 NEEDS_WORK 约束写进其 activation prompt。

**2.3 Dev↔QA Loop**
- developer 用 `dispatch_agent`(同进程,共享 MCP/skills,轻量实现);QA 用 `dispatch_task`(独立会话,隔离 context,客观验证)。
- orchestrator 持 `attempts` 计数(本地状态),3 次后产 `escalation` schema。
- 升级决策用 [[ask-user-question-mcp-refactor]] 让用户拍板(reassign/decompose/accept/defer)。

**2.4 Pipeline 状态机骨架(Rust)**
- 新增 `src-tauri/src/services/nexus_pipeline.rs`:持 `phase`/`current_task`/`attempts`/`gate_verdicts`/`roster_dispatch_state`,持久化 `<DataRoot>/nexus/<session>.json`。
- Rust 强制 gate/retry 上限(LLM 不可跳过):检查 verdict schema,FAIL 自动回传重试,attempts=3 强制 escalation。
- dispatch 调度复用 [[dispatch-task-mcp]] 三件套(dispatch/check/continue)。

**改动文件**:新增 `resources/nexus/{schemas/*.json, gates.json}`、`services/nexus_pipeline.rs`、`commands/nexus.rs`;改 `dispatch_mcp_server.rs`(verdict schema 回流)、`dispatch_agent`/`dispatch_task` 调用点。
**风险**:并发≤3 与 9 人核心团队冲突——roster 分批;NEXUS-Full(全量)成本爆炸,产品只暴露 Sprint/Micro。

### Phase 3:Agents Orchestrator 接入(O3 混合)

**目标**:完整 pipeline 体验。

- 用上游 `agents-orchestrator.md` 作 `options.agent`(或专门的 orchestrator 模式),system prompt 注入当前 pipeline 状态(Rust 提供)。
- LLM 决策:选谁、task 分解、根因分析;Rust 执行:dispatch、状态落盘、gate/retry 强制。
- slash `/nexus full|sprint|micro <spec>` 注入对应 phase 激活指令(对齐 `QUICKSTART.md` 三档)。
- playbooks(`phase-0..6-*.md`)落 `<DataRoot>/prompts/nexus/`,作 phase 推进时的 context 注入。
- handoff-templates 与 [[compact-handoff-implementation]] 简报卡片结合。

**改动文件**:新增 `resources/prompts/nexus/*`(playbooks);改 `cliSlashCommands.ts`(`/nexus`)、orchestrator agent 定义。
**风险**:LLM 驱动不可靠——靠 Rust 状态机骨架兜底;doctrine 中英混排需统一。

### Phase 4:许可证与来源合规

- 复制双 MIT `LICENSE` 到 `resources/agents/LICENSE-*.txt`。
- `NOTICE.md` 声明来源(© Michael Sitarzewski / © jnMetaCode,MIT,URL)。
- 保留 agent 文件原样;裁剪 `assets/`/赞助商段/`.github/`/上游 `scripts/`。
- 固化「对应上游 commit `3f78a30`」基线。
- 核对 Polaris 自身 LICENSE 与 MIT 兼容性。

---

## 7. 关键设计决策(逐项验证)

### 7.1 roster 接 `dispatch-task-mcp` 还是 `dispatch_agent`?

**接 `dispatch-task`**。roster 是多 agent 并行团队:① `dispatch_agent` 子会话共享父 `abort_rx`,一挂全挂;② 深度≤3 截断深层 roster;③ `dispatch-task` 独立会话 + 并发≤3 排队 + 结果回流卡片,天然适合组队。`dispatch_agent` 留给单次轻量 subtask。

### 7.2 Dev↔QA Loop 两个通道怎么分工?

**developer 用 `dispatch_agent`,QA 用 `dispatch_task`**。developer 需要共享父 MCP/skills(轻量实现,同进程);QA 需要隔离 context(客观验证,不被 developer context 污染)。两通道特性正好匹配。

### 7.3 orchestrator 是 agent 还是代码?

**O3 混合**。Rust 做状态机骨架(phase/attempts/gate/retry 持久化 + 强制),LLM 做决策(选人/分解/根因)。纯 agent 不可靠(跳 gate、忘计数);纯代码不灵活。骨架复用 [[dispatch-task-mcp]] 三件套。

### 7.4 agent 走 `.polaris/agents/` 还是 `.polaris/skills/`?

**走 `.polaris/agents/`**。agent = 完整 persona,可覆盖 system prompt、可被 dispatch spawn;skill = progressive disclosure,`read_skill` 按需加载,不覆盖 persona。agency-agents 是完整人设,走 agent 通道。NEXUS doctrine(playbooks/coordination)走 skill 通道(可加载指令)。

### 7.5 `name` 字段中文冲突?

零冲突。slug = 文件名 stem(`engineering-frontend-developer`),display = frontmatter `name`(`前端开发者`)。`load_agent` 按 stem 查(见 `agent.rs:47`),UI 显示 name。不重写上游。

### 7.6 是否换 YAML 解析?

当前 `parse_agent` 手写逐行,不支持多行/数组/嵌套。agency-agents frontmatter 都是单行标量,够用。若接 `tools` 白名单过滤或复杂 `agent-roles.json`,未来换 `serde_yaml`。Phase 0 不必换。

### 7.7 progressive disclosure?

**必做**。266 agent 全量注入 context 会爆炸。`discover_agents` 返回全量,但注入上下文时只取 `name`+`description` 索引;正文按需 `dispatch_agent`/`read_skill`。对齐 Claude Code skill 机制。

---

## 8. 接入点与改动清单(汇总)

| 阶段 | 接入点 | 新增文件 | 改动文件 |
|---|---|---|---|
| 0 | `simple_ai::agent` + `services` | `services/agent_corpus.rs`、`commands/agent_corpus.rs`、`resources/agents/{*.md, divisions.json, runbooks.json, agent-roles.json}` | `agent.rs`、`services/mod.rs`、`commands/mod.rs`、`lib.rs` |
| 1 | `plugin-system` + slash + ToolSwitcher + dispatch-task | `stores/agentStore.ts`、`components/Agent/*`、`types/agent.ts`、`resources/nexus/{coordination.json, rosters.json, roster_manifest.json}`、`agent-index.md`(skill) | `builtinPlugins.ts`、`cliSlashCommands.ts`(`/agent` `/dispatch` `/nexus`)、`ToolSwitcher.tsx`、`agent_corpus.rs`、`dispatch_mcp_server.rs`(新增 dispatch_roster 工具) |
| 2 | dispatch-task + dispatch_agent + 新状态机 | `resources/nexus/{schemas/*.json, gates.json}`、`services/nexus_pipeline.rs`(含波次队列/attempts/gate verdict)、`commands/nexus.rs` | `dispatch_mcp_server.rs`(resultSchema 参数)、`ask_listener.rs`(verdict 校验 + continue 重试 + 回流帧携带 parsed verdict)、dispatch 调用点 |
| 3 | orchestrator agent + slash | `resources/prompts/nexus/*`(playbooks) | `cliSlashCommands.ts`、orchestrator 定义 |
| 4 | `resources/agents/` | `LICENSE-*.txt`、`NOTICE.md` | — |

**依赖变更**:Phase 0 可能加 `include_dir`;其余无新增 crate。

---

## 9. 风险提示

1. **context 爆炸**:266 agent 全量注入必爆。强制 progressive disclosure——只注 name+description 索引,正文按需加载。
2. **corpus 质量参差**:社区产物,部分 body 含上游特定工具名(如 `apply_patch`)或平台假设。Phase 0 后抽样审计,对不存在工具做适配/标注。Reality Checker 默认 NEEDS_WORK 可部分对冲。
3. **slug 稳定性**:中文版 4 个 agent 路径与上游不同(附录 A),roster 引用须以 Polaris 实际扁平化 stem 为准,导入器产 `roster_manifest.json` 校验。
4. **并发与团队规模**:[[dispatch-task-mcp]] 并发≤3,9 人核心团队需分批派发;NEXUS-Full(全量、12-24 周)token 爆炸,**产品只暴露 Sprint(15-25)/ Micro(5-10)**,Full 仅作文档。
5. **LLM 驱动可靠性**:纯 agent orchestrator 会跳 gate/忘重试计数。Phase 2 的 Rust 状态机骨架是兜底——gate/retry 上限由代码强制,非 LLM 自觉。
6. **许可证联动**:中文版 `UPSTREAM.md` 跟踪上游 commit,上游大改时 Polaris 导入器需同步;固化 `3f78a30` 基线。
7. **codex 引擎复用(增量)**:Polaris 有 SimpleAI codex 引擎([[simple-ai-codex-refactor]]),agency-agents 的 `codex` 转换格式(`.codex/agents/*.toml`)可顺手支持,不阻塞主路径。
8. **升级决策权**:Escalation 的 reassign/decompose/accept/defer 涉及取舍,用 [[ask-user-question-mcp-refactor]] 让用户拍板,避免 AI 自作主张接受有缺陷实现。

---

## 10. 优先级

| 优先级 | 阶段 | 价值 | 工作量 |
|---|---|---|---|
| P0 | Phase 0 | corpus 可用(弹药库) | 中 |
| P0 | Phase 4 | 许可证合规(法务前置) | 低 |
| **P1** | **Phase 1** | **选专家机制(用户可见价值)** | 中 |
| **P1** | **Phase 2** | **配合编排机制(核心差异化)** | 高 |
| P2 | Phase 3 | 完整 pipeline 体验 | 高 |

**MVP = Phase 0 + 4**(corpus 可用,无 UI 也能 `options.agent`/`dispatch_agent`)。
**价值交付 = Phase 1 + 2**(选与配合,这才是整合的意义)。
**完整体验 = + Phase 3**。

---

## 附录 A:项目调研补充

### A.0 仓库元数据(2026-07-19 核实)

| 项 | msitarzewski/agency-agents(英文上游) | jnMetaCode/agency-agents-zh(中文社区版) |
|---|---|---|
| Stars / Forks | 133,074 / 21,773 | 17,634 / 2,975 |
| 创建 / 最近 push | 2025-10-13 / 2026-07-17 | 2026-03-06 / 2026-07-17 |
| License | MIT("AgentLand Contributors") | MIT 双版权行(Michael Sitarzewski 原版 + jnMetaCode 翻译本地化) |
| agent 数 | README 称 230+,最新 commit 显示 Hermes roster 已达 263(持续快速新增) | 266(译 215 + 中国原创 51,AGENT-LIST.md 为权威清单,check-counts.mjs 校验) |
| 关系 | 上游,社区 PR 驱动,有 lint/originality 质量门禁 | 非 GitHub fork,独立仓翻译+本地化;UPSTREAM.md 承诺一周内同步上游结构调整 |
| 活跃度特征 | 近期 commit 全是新 agent 合入 | 近期以文档/赞助商/生态引流为主,agent 按批次同步(最近 2026-06-18) |
| 附带生态 | agencyagents.app 桌面安装器(独立仓);convert.sh 支持 14+ 工具;OpenCode 已知只注册约 119 个(超出静默丢弃) | agency-orchestrator(npm + 桌面端,`ao compose` DAG 编排,上游无);Windows 脚本(install.ps1/convert.ps1);README 含大量商业赞助 banner(导入时须裁剪) |

**数量漂移提示**:上游 6 月后仍在快速新增(216 → 263),中文版基线停在 `3f78a30`(2026-06-16 状态)。Phase 0 导入器应固化基线 commit 并记录差集,而非假设两仓 parity 恒成立。

### A.1 两上游 commit 基线
- 英文 `msitarzewski/agency-agents`:HEAD(含 `divisions.json`/`tools.json`/`runbooks.json`)
- 中文 `jnMetaCode/agency-agents-zh`:追平上游 `3f78a30`(2026-06-18),266 agent,20 部门,51 中国原创

### A.2 中文版与上游路径差异(4 个)
| 上游路径 | 中文版路径 |
|---|---|
| `marketing/marketing-bilibili-content-strategist.md` | `marketing/marketing-bilibili-strategist.md` |
| `specialized/customer-service.md` | `support/support-support-responder.md`(拆分) |
| `specialized/sales-outreach.md` | `sales/sales-outbound-strategist.md` |
| `specialized/supply-chain-strategist.md` | `supply-chain/supply-chain-strategist.md` |

roster slug 校验时以此映射为准。

### A.3 runbooks.json 四场景 roster(完整)
见 §4.1 表。每场景含 `always`/`week 3+`/`as needed`/`post-fix` 时序组。

### A.4 agent 样例(agency-agents 格式)
```markdown
---
name: 前端开发者
description: 精通现代 Web 技术、React/Vue/Angular 框架、UI 实现和性能优化的前端开发专家
emoji: 💻
color: cyan
---
# 前端开发者 Agent 人格
你是 **前端开发者**...
## 你的核心使命
### 创建现代 Web 应用
- 使用 React、Vue、Angular 或 Svelte ...
```

与 Polaris `parse_agent` 完全同构,直接可读。

### A.5 NEXUS 三档模式
| 模式 | 用途 | agent 数 | 周期 |
|---|---|---|---|
| NEXUS-Full | 完整产品从零 | 全量 | 12-24 周(不暴露,仅文档) |
| NEXUS-Sprint | 功能/MVP | 15-25 | 2-6 周 |
| NEXUS-Micro | 单任务(bug 修复/活动/审计) | 5-10 | 1-5 天 |
