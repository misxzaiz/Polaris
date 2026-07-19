# Agency Agents 整合 — 实施方案(任务级拆解)

> 上位文档:`docs/agency-agents-integration-plan.md`(方案设计,§6 分阶段 / §7 关键决策 / §8 改动清单 / §10 优先级)。
> 本文将其拆解为可执行开发任务:每任务给出改动文件、依赖、验证方式、工作量估算,并说明 §7 已裁决决策在实施层面如何落地。
> 状态:仅分析与方案输出,未改动代码。估算单位:人日(1d = 一个有效开发日,含自测)。

**通用约定**
- Rust 侧验证:本机 `cargo check --lib`(本机无法运行 lib 测试,Tauri 原生 DLL 限制);纯逻辑单测(状态机/解析器)写成不依赖 tauri 的模块,由 CI 跑 `cargo test`。
- 前端验证:`npx tsc --noEmit` + vitest(已有 `cliSlashCommands.test.ts`、`pluginStore.test.ts` 先例)+ 手工冒烟。
- 所有新增 `#[tauri::command]` 及其 `mod.rs` re-export 必须加 `#[cfg(feature = "tauri-app")]` 门控(web-only 打包约束,见 pitfalls 记忆)。
- 里程碑:**M0**=Phase 0+4 完成(corpus 可用+合规);**M1**=Phase 1 完成(选人可见);**M2**=Phase 2 完成(配合+组队闭环);**M3**=Phase 3 完成(完整 pipeline)。

---

## 1. Phase 0(准备工作):corpus + catalog 导入 — 约 4.5d

| # | 任务 | 改动文件 | 依赖 | 验证 | 估算 |
|---|---|---|---|---|---|
| P0-1 | **corpus 打包与导入器**:`install_corpus`(把打包 corpus 复制到 `<DataRoot>/agents/`,扁平化 `<division>-<slug>.md`)、`list_corpus`、`uninstall_corpus`;双仓合并(zh 为主体,附录 A.2 的 4 个路径映射做去重);固化基线 commit `3f78a30` 到 manifest | 新增 `src-tauri/src/services/agent_corpus.rs`、`src-tauri/resources/agents/*.md`(约 266 文件 ~1.3MB);改 `src-tauri/src/services/mod.rs` | — | 单测(临时目录):导入计数=266、扁平化命名无冲突、重复导入幂等;`cargo check --lib` | 2d |
| P0-2 | **AgentDefinition 扩展**:`emoji`/`color`/`division`/`role` 可选字段,`parse_agent` 兼容缺省(zh 版部分缺 `vibe`,一律 Option) | `src-tauri/src/ai/engine/simple_ai/agent.rs:12-52` | — | parse 单测:含/缺新字段均通过;旧 `.polaris/agents` 文件不受影响 | 0.5d |
| P0-3 | **discover/load 全局回退**:`discover_agents`/`load_agent` 先查 `work_dir/.polaris/agents/`(项目级,优先),miss 再查 `<DataRoot>/agents/`(全局) | `agent.rs`(同上);DataRoot 取值复用 `data_root` 抽象(见 data-root-unification) | P0-1 | 单测:项目级同名覆盖全局;`dispatch_agent` 能 spawn 全局 corpus 中的 agent | 0.5d |
| P0-4 | **catalog 元数据生成**(一次性离线脚本,产物入库):`divisions.json`(合并 zh 20 部门,补 hr/legal/supply-chain 的 label/icon/color)、`rosters.json`(由上游 runbooks.json 转换+slug 存在性校验,产 `roster_manifest.json`)、`agent-roles.json`(slug→developer/qa/gate-keeper/orchestrator/governance) | 新增 `src-tauri/resources/agents/{divisions.json, rosters.json, roster_manifest.json, agent-roles.json}`;脚本放 `scripts/gen-agent-catalog.mjs`(仓库内,非运行时依赖) | P0-1 | 脚本自校验:roster 每个 slug 在 corpus 中存在(对齐上游 check-runbooks.sh);计数与 AGENT-LIST.md 一致 | 1d |
| P0-5 | **Tauri 命令与注册**:`agent_corpus_install/list/uninstall/get_catalog`;全部加 `tauri-app` 门控 | 新增 `src-tauri/src/commands/agent_corpus.rs`;改 `commands/mod.rs`、`lib.rs`(invoke_handler 注册) | P0-1..4 | `cargo check --lib` 双形态:默认 features 与 `--no-default-features` 均过 | 0.5d |

**Phase 0 出口标准**:前端可经命令拿到 catalog;`dispatch_agent`(SimpleAI)可按全局 corpus slug spawn;claude 引擎用户可手动把 corpus 目录复制为 `.claude/agents/`(Phase 0 不做 claude 侧自动安装,见 §4 决策 7.4 落地)。

## 2. Phase 4(合规,与 Phase 0 并行)— 约 0.5d

| # | 任务 | 改动文件 | 依赖 | 验证 | 估算 |
|---|---|---|---|---|---|
| P4-1 | 双 MIT LICENSE 复制 + `NOTICE.md`(© Michael Sitarzewski / © jnMetaCode,MIT,URL,基线 commit);裁剪 assets/赞助商段/.github/上游 scripts | 新增 `src-tauri/resources/agents/{LICENSE-agency-agents.txt, LICENSE-agency-agents-zh.txt, NOTICE.md}` | P0-1(与导入器同批入库) | 人工核对;`NOTICE.md` 随 corpus 一起被 install_corpus 复制 | 0.5d |

## 2.5 M0 复盘与后续任务调整(2026-07-19)

M0 已交付(P0-1..P0-5 + P4-1,双形态 `cargo check` 通过)。实际落地产物与原拆解有四处偏差/超前,影响后续任务如下:

1. **slug 不带 division 前缀(关键偏差)**:上游 roster slug 就是文件 stem 且不总带部门前缀(如 `agents-orchestrator`),扁平化改为保留原始 stem,division 记入 `catalog.json`。→ P1-1 的 agent-index、Phase 2 的 coordination.json 一律引用 stem;文档中所有 `<division>-<slug>` 表述作废。
2. **rosters.json / roster_manifest.json 已在 M0 产出**(原计划归 P1-1/P2-5 前置):4 场景 64 slug 全部解析,3 个别名映射生效。→ P2-5 的数据依赖已就绪,P1-1 只剩 coordination.json + agent-index.md。
3. **catalog.json + `agent_corpus_catalog` 命令已就绪**(超出原计划):267 条含 emoji/color/division 的元数据可直接经命令获取。→ P1-3 Gallery 不必经 discover_agents 拼装,直接消费 catalog 命令,估算 3d→2.5d。
4. **corpus 实际 267 个**(AGENT-LIST 标 266):照实收录;文档计数断言以 `corpus-manifest.json` 为准,不硬编码 266。

新增/调整任务:

- **新增 P1-0(安装入口,0.5d)**:M0 只有命令,无人调用。在 `useAppInit`(或 Gallery 首开)检测 `agent_corpus_status`:未安装或 `bundledVersion > installedVersion` 时提示/静默安装。改 `src/hooks/useAppInit`(参照 pluginService autoStart 模式)。验证:首启后 `<DataRoot>/agents/corpus/` 就位。这是 P1-3/P1-6/P1-7 的运行时前提。
- **P1-6 需补后端命令(估算 1d→1.5d)**:SimpleAI 的 `discover_agents` 是后端内部函数,前端无入口。新增 `simple_ai_list_agents(workDir)` 命令(tauri-app 门控,返回 name/description/emoji/slug,顺带消费 AgentDefinition 新字段、摘掉 `allow(dead_code)`)。
- **P1-1 中 coordination.json 移交 Phase 2 前置**:L1 查表由 Rust(P2-4)消费,M1 用不上;P1-1 只产 agent-index.md(L2 语义索引,行数以 manifest 计数为准),估算 1d→0.5d。coordination.json 并入 P2-1(资源任务,+0.5d)。

调整后:Phase 1 合计 8d → **8d**(P1-0 +0.5、P1-1 −0.5、P1-3 −0.5、P1-6 +0.5);Phase 2 合计 13d → **13.5d**;总量 ~31d → **~31.5d**。

## 3. Phase 1:选专家机制 — 约 8d

| # | 任务 | 改动文件 | 依赖 | 验证 | 估算 |
|---|---|---|---|---|---|
| P1-0 | **corpus 安装入口**:`useAppInit`(或 Gallery 首开)检测 `agent_corpus_status`,未安装/可升级时自动安装(参照 pluginService autoStart 模式) | 改 `src/hooks/useAppInit`、`src/services/`(轻量 corpusService 封装 invoke) | M0 | 手工:首启后 `<DataRoot>/agents/corpus/` 就位;重复启动幂等 | 0.5d |
| P1-1 | **agent-index.md 生成**(L2 语义索引):每行 `slug — name — description`,由 P0-4 脚本扩展产出,slug 用原始 stem(M0 偏差 1);coordination.json 移至 P2-1 | 改 `scripts/gen-agent-catalog.mjs`;新增 `resources/agents/agent-index.md` | P0-4 | 脚本校验:index 行数 = corpus-manifest agentCount | 0.5d |
| P1-2 | **activation 模板库**:拆 `agent-activation-prompts.md` 为 per-agent 模板 + 通用回退模板;`agent_corpus.rs` 加 `load_activation(slug)`(查不到回退通用) | `resources/agents/activation/*.md`(install_corpus 一并落盘,SIDE_FILES 机制扩展为目录);改 `services/agent_corpus.rs` | P0-1 | 单测:有/无专属模板两路;占位符(`[PHASE]`/`[TASK]`/`[ACCEPTANCE CRITERIA]`/`[REFERENCE DOCUMENTS]`)完整保留 | 1d |
| P1-3 | **agentStore + Agent Gallery 面板**:直接消费 `agent_corpus_catalog` 命令(267 条含 emoji/color/division,M0 已就绪);卡片网格 + divisions 分组/筛选/搜索,Virtuoso 虚拟化;动作「设为当前专家」(写 options.agent)与「派发任务」 | 新增 `src/stores/agentStore.ts`、`src/types/agent.ts`、`src/components/Agent/AgentGalleryPanel.tsx` 等 | P1-0 | vitest(store 加载/筛选);`tsc --noEmit`;手工:267 卡滚动流畅 | 2.5d |
| P1-4 | **内置面板注册**:panelType `agent-gallery`,icon Users,order≈35 | 改 `src/plugin-system/builtinPlugins.ts`、`panelRegistry.ts` | P1-3 | 手工:侧栏出现入口、面板可开 | 0.5d |
| P1-5 | **slash 命令**:`/agent <slug>`(写 options.agent)、`/dispatch <slug> <task>` | 改 `src/services/cliSlashCommands.ts` + `cliSlashCommands.test.ts` | P0-5 | vitest 补用例(补全/参数解析/引擎适配) | 1d |
| P1-6 | **ToolSwitcher agent 下拉 + 后端列举命令**:新增 `simple_ai_list_agents(workDir)` 命令(tauri-app 门控,项目级+全局两级,消费 AgentDefinition 新字段并摘掉 `allow(dead_code)`);claude 引擎沿用 `cliInfoStore.agents`(cliInfoStore.ts:135) | 新增命令入 `commands/agent_corpus.rs`;改 `src/components/.../ToolSwitcher.tsx`、`src/stores/cliInfoStore.ts` | P1-0 | 双形态 cargo check;手工:两引擎下拉数据源正确、项目级覆盖全局 | 1.5d |
| P1-7 | **L2 语义路由 skill 落位**:`agent-index.md` 作为 `nexus-agent-index` skill 供 SimpleAI `read_skill`(skill.rs 通道);orchestrator 场景外的「该找谁」推荐交互(AskUserQuestion)列为进阶可选,不阻塞 M1 | install_corpus 落 `<DataRoot>/skills/nexus-agent-index/`(或项目级 `.polaris/skills/`);无代码改动(skill 发现机制已有) | P1-1 | 手工:SimpleAI 会话内 read_skill 可加载索引 | 0.5d |

**Phase 1 出口标准(M1)**:corpus 自动安装;用户可浏览/搜索/启用 267 专家;`/agent` `/dispatch` 可用;L2 索引可被 read_skill 加载。

## 4. Phase 2:配合 + 组队机制 — 约 13.5d(核心攻坚)

| # | 任务 | 改动文件 | 依赖 | 验证 | 估算 |
|---|---|---|---|---|---|
| P2-1 | **schema 与 gate 资源 + coordination.json**:7 种 handoff schema(standard/qa-pass/qa-fail/escalation/phase-gate/sprint/incident)+ `gates.json`(7 gate 的 keeper+标准)+ `coordination.json`(L1 任务类型→slug 查表,从 nexus-strategy.md §10 矩阵人工固化,slug 用原始 stem) | 新增 `src-tauri/resources/nexus/{schemas/*.json, gates.json, coordination.json}` | — | schema 自检脚本(必填字段齐全 + coordination slug 对 corpus 存在性校验) | 1.5d |
| P2-2 | **dispatch_task 增加 `resultSchema` 参数**:工具定义加可选参数;注册派发会话时在 append_system_prompt 尾部注入「结束前最后一条消息输出符合 schema 的 JSON 代码块」 | 改 `src-tauri/src/services/dispatch_mcp_server.rs:158-264`(工具 schema)、`ask_listener.rs`(register_dispatch_task 透传+注入) | P2-1 | 手工派发:后台会话 system prompt 含注入指令;无 resultSchema 时行为不变(回归) | 1d |
| P2-3 | **verdict 校验回流**:完成路径对 summary 做 JSON 提取+手写字段校验(serde_json,不引 jsonschema crate);失败→自动 `continue_dispatched_task` 一次;再失败标记 `unstructured` 降级自由文本;通过→回流帧携带 parsedVerdict;前端回流卡片渲染 verdict(默认折叠,复用简报卡片样式) | 改 `ask_listener.rs`(检查/回流帧)、`src/services/dispatchTaskService.ts`、`src/stores/dispatchStore.ts`、回流卡片组件 | P2-2 | Rust 纯逻辑单测(JSON 提取/校验,不依赖 tauri,CI 跑);手工:构造 QA FAIL 会话看结构化卡片与一次重试 | 3d |
| P2-4 | **nexus_pipeline.rs 状态机**:`phase/current_task/attempts/gate_verdicts/roster 波次队列` 持久化 `<DataRoot>/nexus/<session>.json`;拓扑分波(读 coordination.json,每波≤3);gate/retry 上限 Rust 强制 | 新增 `src-tauri/src/services/nexus_pipeline.rs`、`src-tauri/src/commands/nexus.rs`(门控);改 `services/mod.rs`、`commands/mod.rs`、`lib.rs` | P2-1、P0-4 | **状态机写成纯逻辑模块**(输入事件→状态转移,不碰 IO/tauri),单测覆盖:波次推进/attempts=3 强制 escalation/gate FAIL 不推进/崩溃恢复(反序列化续跑) | 3d |
| P2-5 | **dispatch_roster 工具**(polaris-dispatch 第 5 个工具):读 rosters.json → load_agent → 填 activation 模板 → 按波次经 dispatch_task 派发;always 立即、week3+ 挂 gate PASS 事件、post-fix 对关联 QA dispatchId 发 continue | 改 `dispatch_mcp_server.rs`(新工具)、`ask_listener.rs`(新帧处理,接 nexus_pipeline 波次队列;复用 eventRouter 早退路由) | P2-4、P1-2 | 手工:`startup-mvp` 场景 9 人分 3 波派发,前波全部终态才触发下波;并发始终≤3 | 2d |
| P2-6 | **Dev↔QA loop + Escalation**:QA FAIL verdict 回传 developer(issue 列表作 task 前置上下文);attempts 由 nexus_pipeline 计数;3 次后产 escalation schema 并经 AskUserQuestion(polaris-ask 通道)让用户拍板 reassign/decompose/accept/defer | 改 `nexus_pipeline.rs`、`ask_listener.rs`(escalation→ask 桥接) | P2-3、P2-4 | 单测:计数与升级路径;手工:3 连 FAIL 弹用户选择卡片 | 2d |
| P2-7 | **`/nexus` slash + 汇总卡片**:`/nexus <scenario>` 入口;波次进度胶囊(复用后台进度胶囊模式);场景终局 Pipeline Status Report 汇总卡片 | 改 `src/services/cliSlashCommands.ts`(+test)、`dispatchStore.ts`、新增汇总卡片组件 | P2-5 | vitest + 手工全场景演练 | 1d |

**Phase 2 出口标准(M2)**:一条命令组队派发、波次推进、结构化 verdict 驱动状态机、3 次重试升级到用户,全程主会话只见折叠卡片与摘要。

## 5. Phase 3:Orchestrator O3 混合 — 约 5d

| # | 任务 | 改动文件 | 依赖 | 验证 | 估算 |
|---|---|---|---|---|---|
| P3-1 | **orchestrator agent 定义适配**:以上游 `agents-orchestrator.md` 为底,改写为「决策者」角色(选人/分解/根因),明确 dispatch/gate/retry 由系统执行;pipeline 状态由 Rust 作为 context message 注入 | 新增 corpus 内定制 `specialized-agents-orchestrator.md`(覆盖上游版);改 `nexus_pipeline.rs`(状态→context 注入) | M2 | 手工:orchestrator 会话可读到状态、给出的派发建议被 Rust 执行 | 2d |
| P3-2 | **playbooks 落地 + 三档模式**:phase-0..6 playbook 落 `<DataRoot>/prompts/nexus/`;`/nexus full\|sprint\|micro <spec>`(full 仅文档不暴露入口,产品只出 sprint/micro) | install_corpus 扩展;改 `cliSlashCommands.ts` | P3-1 | 手工:sprint/micro 两档注入正确 phase 指令 | 1d |
| P3-3 | **端到端联调**:startup-mvp(sprint)与 incident-response(micro)各走一遍完整 pipeline,校准 activation 模板质量与 token 消耗 | — | P3-1/2 | 演练记录 + token 成本报告(对照 context-cost-meter) | 2d |

---

## 6. §7 关键决策的实施落地

- **7.1 roster 接 dispatch-task-mcp**:实施上体现在 P2-5——`dispatch_roster` 直接注册进现有 `dispatch_mcp_server.rs`(`polaris-dispatch`,mcp_config_service.rs:23 已注册的 server),不新增 `[[bin]]`、不动 `builtin_mcp_contribution_registry`;派发复用 `ask_listener.rs` 的 register_dispatch_task 路径,自动继承 `dispatch-{depth}-{id}` 深度≤2、并发≤3 治理与结果回流。`dispatch_agent`(simple_ai/tools/agent.rs)完全不改。
- **7.2 Dev↔QA 通道分工**:developer 走 `dispatch_agent` 在 P2-6 中由 nexus_pipeline 生成 task 描述后经 SimpleAI 子会话执行(仅 SimpleAI 引擎场景);跨引擎/claude 场景 developer 亦可走 dispatch_task(role 预设选引擎)。QA/Gate 一律 dispatch_task + resultSchema(P2-2/2-3)。
- **7.3 orchestrator = O3 混合**:代码侧(P2-4)先行——gate、attempts、波次是纯 Rust 状态机,M2 时即便没有 orchestrator agent 也能按 rosters.json 机械推进;LLM 决策(P3-1)后补,只负责「选人/分解/根因」,其输出经现有 MCP 工具调用落到 Rust 执行。这保证了 Phase 2 可独立交付。
- **7.4 agent 走 `.polaris/agents/`(+ 全局 `<DataRoot>/agents/`)**:P0-3 的两级回退实现;claude 引擎不解析该目录(其 subagent 由 CLI 处理),Phase 0 不做 `.claude/agents/` 自动安装,后续可选用 claude CLI `--agents <json>` 免落盘方案(docs/cli-integration/claude-cli-capability-alignment.md)作为增量。NEXUS doctrine 走 skill 目录(P1-7、P3-2)。
- **7.5/7.6 name 中文与 YAML 解析**:P0-2 只加 Option 字段、不换解析器;`slug=文件名 stem、display=frontmatter name` 在 agentStore 与 Gallery 层约定,`load_agent` 按 stem 查不变。
- **7.7 progressive disclosure**:P1-7 的 index skill + Gallery 只在前端展示(不进 LLM context);任何注入点只用 name+description,正文仅在 spawn 时由 agent 定义 body 进入子会话。

## 7. 依赖顺序与里程碑(M0 后更新)

```
[M0 已完成: P0-1..P0-5 + P4-1]
        │
        ├─ P1-0(安装入口) ─┬─ P1-3 ─ P1-4        [前端线]
        │                  └─ P1-6
        ├─ P1-1(index) ─ P1-7                     [脚本线]
        ├─ P1-2(activation 模板)                  [Rust 线]
        └─ P1-5(slash)
                │
        ├─ P2-1(schemas+gates+coordination) ─ P2-2 ─ P2-3   [关键路径]
        │                  └────────── P2-4 ─ P2-5(←P1-2) ─ P2-6 ─ P2-7
                │
        └─ P3-1 → P3-2 → P3-3
```

| 里程碑 | 内容 | 累计工作量 |
|---|---|---|
| M0 ✅ | Phase 0 + 4(corpus 可用 + 合规) | ~5d(已完成) |
| M1 | + Phase 1(选人可见价值) | ~13d |
| M2 | + Phase 2(配合+组队闭环,核心差异化) | ~26.5d |
| M3 | + Phase 3(完整 pipeline) | ~31.5d |

**下一步起点**:P1-0(安装入口,一切运行时消费的前提)与 P1-1/P1-2(脚本+Rust,无前端依赖)同批起步。
**并行建议**:M1 期间三线并行——前端线(P1-0→P1-3→P1-4/P1-6)、脚本线(P1-1→P1-7)、Rust 线(P1-2,可提前做 P2-1 资源);P2-2/2-3(resultSchema→verdict 回流)是 M2 关键路径,P2-4 状态机可与其并行;P1-5 独立可插空。

## 8. 实施层风险与对策

1. **本机测试限制**:Rust lib 测试本机跑不了(Tauri DLL)。对策:状态机/解析/校验全部写成无 IO 纯逻辑模块,本机 `cargo check`,CI 跑测试(P2-3/P2-4 已按此设计)。
2. **web-only 门控回归**:新增命令(P0-5、P2-4)漏加 `tauri-app` cfg 会炸 `--no-default-features` 打包。对策:出口标准强制双形态 check。
3. **resultSchema 兼容性**:注入指令对不同引擎/模型的服从度不一。对策:P2-3 的「一次 continue 重试 + unstructured 降级」保证永不阻塞回流;灰度期统计结构化成功率。
4. **corpus 体积与启动**:266 文件入 resources 增包 ~1.3MB(可接受);install_corpus 幂等 + 版本号(基线 commit)避免每次启动重复复制。
5. **token 成本**:M2 全场景演练前先在 P3-3 用 sprint 小规模校准;产品默认只暴露 sprint/micro。
