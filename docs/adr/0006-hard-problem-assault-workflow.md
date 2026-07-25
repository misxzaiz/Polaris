# ADR 0006: 硬问题攻坚工作流(Hard-Problem Assault Workflow)

## Status

Proposed

## Date

2026-07-25

## Context

### 起因

OpenAI 公开了引导 GPT 5.6 Sol Ultra 证明"圈双覆盖猜想(CDC)"的完整 prompt(见 `https://cdn.openai.com/pdf/04d1d1e4-bc75-476a-97cf-49055cd98d31/cdc_prompt.pdf`)。该 prompt 的价值不在数学陈述本身,而在其**多 agent 攻坚编排方法论**:

1. **堵退出口**:预先封掉"这是开放问题所以我答不了"的逃避路径。
2. **多元化投资组合 + 独立性保护**:起步派发真正不同的思想族,早期不告诉大多数 agent 主推方案,防止塌缩。
3. **方法族注册表 + blocked 门控**:按思想(而非措辞)分类;卡在"定理强度缺失引理"标记 blocked,只有新机制才解锁重派。
4. **等价强度识别**:归约到等价于原命题的引理不算进展——这是数学/工程里常见的伪进展。
5. **对抗性审计清单**:候选解必须逐条过具体陷阱(2-圈、闭迹伪圈、循环论证等),默认 refuted。
6. **根 agent 反复综合重定向**:第一波失败不停,持续开新轮。
7. **强制最低工时 + 拒绝模糊报告**:只要具体产物(引理/构造/方程/反例),拒绝 status 汇报。

Polaris 当前已具备落地的全部原语,但缺一个把它们组装成"攻坚模式"的顶层范式:

| CDC 机制 | Polaris 现状 |
|---|---|
| 多 agent 并发 | Workflow 并发 16,生命周期 1000(单机 < 64,靠多轮弥补) |
| 角色多样性 | Agency Agents corpus 267 专家,含 `agents-orchestrator` |
| 上下文隔离 | Workflow 每个 `agent()` 独立上下文天然成立 |
| 强制结构化 | `agent(schema)` 已支持 |
| 对抗审计 | adversarial verify 模式已有,需固化陷阱清单 |
| 人工综合闭环 | `dispatch_task` + `continue_dispatched_task` 已就绪 |
| 方法族注册表 / blocked 门控 | **缺失**——本 ADR 补这一层 |
| 最低工时门控 | **缺失**——本 ADR 补这一层 |

### 为什么需要它

当前 Polaris 的 workflow 多用于"理解→设计→实现→审查"的确定性流水线,或"发现→验证"两段式。但有一类问题需要**长时、多轮、多视角、带对抗审计的搜索**:

- 仓库级重构方案设计(多架构视角并行,需对抗证伪)
- 复杂 bug 根因排查(多假设并行 + 证伪)
- 安全审计(多维度扫描 + 对抗验证,正是 Workflow 文档的 canonical 用例)
- 技术选型/方案比选(judge panel)
- 跨模块影响面分析

这类问题的共性是:**解空间宽、单视角易塌缩到"漂亮但不推进"的归约、需要多轮独立探索后才交叉**。CDC prompt 的方法论正是为此而生。

### 约束与边界

1. **不假设解存在**:数学可以假设有解,工程问题未必。本 ADR 把 CDC 的"假设有解"改为"假设存在可行路径,但允许 N 轮无进展后返回 open"——避免诱发幻觉证明。
2. **不绑定 64 并发**:单机 16 是硬上限,64 路扇出靠"每轮 16 并发 × 多轮"实现,不强行突破。
3. **不与 `dispatch_task` 混用做扇出**:`dispatch_task` 并发≤3、深度≤2,只用于事后人工复核/根 agent 综合闭环。
4. **token 成本可控**:本范式单轮可能烧十几万 token,必须有 `budget.total` 硬天花板和轮数上限。

## Decision

引入 **Hard-Problem Assault Workflow**(硬问题攻坚工作流),作为 Polaris workflow 的一种命名范式,而非新引擎:

### 1. 架构:三层

```
┌─────────────────────────────────────────────────────────┐
│  Root Loop(主脚本,JS)                                   │
│  - 方法族注册表 FAMILIES[]                                │
│  - blocked 集合 + newMechanism 解锁门控                  │
│  - 轮次计数 + budget/time 门控                           │
│  - 候选解筛选 → 对抗审计                                  │
│  - 综合重定向(可选 dispatch_task 人工介入)                │
└──────────────┬──────────────────────────────────────────┘
               │ parallel(每轮 ≤16)
┌──────────────▼──────────────────────────────────────────┐
│  Scout Agents(每方法族一个,上下文隔离)                  │
│  - 不被告知其他族结论(独立性)                             │
│  - agentType 接 corpus 专家 slug                         │
│  - schema 强制:artifacts/gap/gapStrength/newMechanism   │
└──────────────┬──────────────────────────────────────────┘
               │ candidates.filter(gap==='none')
┌──────────────▼──────────────────────────────────────────┐
│  Adversarial Audit Agents                               │
│  - 陷阱清单固化(领域相关)                                │
│  - 默认 refuted,逐条过关才 survives                       │
│  - 多 vote 投票(高风险 ≥3 票,低风险单票)                 │
└─────────────────────────────────────────────────────────┘
```

### 2. 核心数据结构

**方法族注册表**(脚本内 JS state,纯内存):

```js
const FAMILIES = [
  { key, label, blocked: false, attempts: 0, lastNewMechanism: null, findings: [] }
]
```

**Finding schema**(强制结构化,拒绝模糊报告):

```json
{
  "family": "string",
  "artifacts": ["具体引理/构造/方程/反例"],
  "gap": "none | <精确缺口描述>",
  "gapStrength": "none | routine | theorem-strength",
  "blockedReason": "若 theorem-strength 描述卡点",
  "newMechanism": "若提出新机制/不变量"
}
```

**Audit schema**:

```json
{ "verdict": "survives | refuted", "issues": ["..."] }
```

### 3. 门控规则

| 规则 | 实现 |
|---|---|
| blocked 标记 | `gapStrength==='theorem-strength' && !newMechanism` → `fam.blocked=true` |
| 解锁 | `newMechanism` 命中 → `fam.blocked=false` |
| 终止-成功 | 候选解 `gap==='none'` 且审计 `verdict==='survives'` |
| 终止-放弃 | `rounds >= MAX_ROUNDS` 或 `budget.remaining() < 50_000` |
| 最低工时 | `ScheduleWakeup` 心跳,每 20 分钟唤起一轮,未达 `MIN_DURATION_SEC` 不允许返回 open |

### 4. 与现有系统的接线

- **角色**:scout agent 用 `agentType` 接 corpus 专家 slug(如 `agents-orchestrator`、`software-architect` 等),天然多样性。
- **人工介入**:每轮 `Synth` 阶段可选 `dispatch_task` 派给"主审"后台会话,用 `continue_dispatched_task` 多轮追问——CDC 的"根 agent 反复综合"在这里人机协同。
- **结果回流**:workflow `return` 走 `task-notification` 注入主对话(与 `dispatch-task-mcp` 结果回流同通道)。
- **原型展示**:攻坚过程可视化走 `prd-preview` MCP 内联卡片。
- **调度持久化**:可选用 `dispatch_tasks.json` 落盘(已有注册表机制)记录长任务状态,跨重启恢复。

### 5. 不做什么

- **不做新引擎**:纯 workflow 脚本,不碰 Rust、不碰 simple_ai。
- **不做链式编排**:与 dispatch-phase2 决策一致,"结果回流感知 + continue 已可人机协同",不引入显式 DAG。
- **不假设解存在**:与 CDC 原文的关键差异。
- **不绕过对抗审计**:即使 `gap==='none'` 也必须过 audit,审计失败视为未解。

## Consequences

### 正面

- 填补"长时多轮对抗搜索"范式空缺,覆盖安全审计/根因排查/方案比选等高价值场景。
- 方法族注册表 + blocked 门控是**通用**工程模式,不止服务数学问题。
- 全部复用现有原语,零引擎改动,落地风险低。

### 负面

- token 成本高:单轮十几万 token 是常态,必须有 budget 天花板。
- 单机并发 16 < 64,靠多轮弥补,wall-clock 比 CDC 原设想长。
- 对抗审计 agent 仍是 LLM,有被同款幻觉绕过的风险——高风险结论需叠加人工 `continue_dispatched_task` 复核。
- 方法族分类质量决定成败:若列不出"真正不同的思想族",多样性是假的。这是落地时最该花心思的地方。

### 风险缓解

1. budget 天花板 + 轮数上限双重保护。
2. 高风险场景强制人工复核闸门(`dispatch_task` 续派主审)。
3. 方法族清单由人 + `agents-orchestrator` corpus agent 共同拟定,不交给主循环自动生成。
4. 终止条件显式区分 `solved` / `open`,open 时返回最强已证推导 + 精确缺口,不返回"尽力而为"。

## Alternatives Considered

1. **用 `dispatch_task` 做扇出**:并发≤3、深度≤2,无法支撑 16+ 路并行探索。否决。
2. **新建 Rust 引擎**:改动面大,与 simple_ai/nexus 职责重叠,无必要。否决。
3. **沿用现有 pipeline 模式**:无 blocked 门控和对抗审计固化,无法表达"长时多轮搜索"。否决。
4. **只做 prompt 模板不做 workflow**:失去并发与结构化保证,回到单 agent 文本模式。否决。

## Open Questions

1. 方法族清单是否需要持久化到 `dispatch_tasks.json` 以跨重启恢复?(建议 Phase 2 决定)
2. 是否把攻坚过程做成实时可观测面板(类似 DispatchCenter)?原型已提供,实现待 Phase 2。
3. corpus 专家 slug 与方法族的映射是否做成配置文件?(建议 `assault-profiles.json`)

## References

- CDC prompt 原文: `https://cdn.openai.com/pdf/04d1d1e4-bc75-476a-97cf-49055cd98d31/cdc_prompt.pdf`
- **搜索治理结构分析**(Cairn / CDC / wp2shell 三案例归纳): `https://mp.weixin.qq.com/s/j2vX2huwPUKc5YFjVDu0yQ`
  - 六点压缩:固定目标 → 开放路径 → 并行分支 → 状态外化 → 动态循环 → 证据收敛
  - 核心论断:模型负责搜索的内容,Harness 负责搜索的治理
  - wp2shell 节俭参数:4 agent / 6h / ~$25 产出真实 RCE(印证单机 16 并发够用)
- 实施计划: [docs/plan/hard-problem-assault-implementation.md](../plan/hard-problem-assault-implementation.md)
- PRD: [docs/design/specs/hard-problem-assault-prd.md](../design/specs/hard-problem-assault-prd.md)
- M2 设计: [docs/design/specs/hard-problem-assault-m2-design.md](../design/specs/hard-problem-assault-m2-design.md)
- 原型: [docs/design/prototypes/polaris-hard-problem-assault.html](../design/prototypes/polaris-hard-problem-assault.html)
- 关联 ADR: [ADR 0005](0005-simpleai-hybrid-context-compaction.md) 长会话可靠性
- 关联实现: [docs/dispatch-phase2-plan.md](../dispatch-phase2-plan.md) 派发闭环

## 附录:对照搜索治理六点(2026-07-25 增补)

对照文章归纳的六点 AI 搜索治理结构,本实现的位置:

| 治理点 | 本实现 | 状态 |
|---|---|---|
| 1 目标固定,路径不固定 | `problem` 必填 + `gap==='none'` 才算解 | ✅ |
| 2 不用固定角色代替搜索 | persona 是**初始多样性种子**,非固化岗位(同 wp2shell 把"解析/字符集/上传"当种子) | ✅(文档已澄清) |
| 3 多条实质不同路线并行 | `FAMILIES[]` 多族并行,独立性保护 | ✅ |
| 4 中间搜索状态外化 | 内存 JS state;每轮 `STATE_SNAPSHOT` log 输出结构化快照 | ⚠️ M1 快照 log / M2 落盘 |
| 5 据新增事实循环生成下一步 | `Synth` schema + while 循环 + blocked 重开门控 | ✅ |
| 6 完成由可验证目标决定 | `gap==='none'` + `acceptanceArtifact` + audit 投票 | ✅(加严:验收件) |

**两个关键修订(基于文章):**

1. **状态外化(点 4)升级为 M1 必做**:每轮 Synth 后 `log('STATE_SNAPSHOT ' + JSON.stringify(FAMILIES 状态))` 输出结构化快照(blocked/attempts/lastNewMechanism/strongest/gap)。零成本实现"中间状态外化",可被未来面板消费,也便于排错。持久化落盘仍放 M2。理由:文章强调外化的意义是"后续调度面对的不是一段难追踪的长对话,而是一份显式表示的当前研究状态"。

2. **新增 `acceptanceArtifact` 字段**:FINDING_SCHEMA 加可执行验收件(复现命令/PoC/测试用例),与 `gap==='none'` 同时满足才算 solved。对应 wp2shell 的 /flag——"一个不会含糊的验收测试"。

**边界声明(沿用文章的克制):** 本范式不证明最优、不证明每项机制不可少、不证明共同结构就是成功原因。三案例实际只有两条独立设计源(CDC→wp2shell 直接继承,Cairn 独立同构),无消融实验。能支持的结论仅限:对"终点可验证、路径不可穷举"的任务,把模型已有能力组织成一次长期、可分叉、可回溯、可验证的搜索,是关键增量。
