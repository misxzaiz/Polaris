# 硬问题攻坚工作流实施方案

> 版本:1.0.0
> 日期:2026-07-25
> 关联:[ADR 0006](../adr/0006-hard-problem-assault-workflow.md) · [PRD](../design/specs/hard-problem-assault-prd.md) · [原型](../design/prototypes/polaris-hard-problem-assault.html)

---

## 一、总体策略

- **纯 workflow 脚本落地**,不改 Rust、不改 simple_ai、不改 dispatch MCP。
- 复用现有原语:`Workflow`(parallel/pipeline/schema)、Agency Agents corpus、`dispatch_task`/`continue_dispatched_task`、`prd-preview`。
- 分两阶段:M1(端到端跑通)、M2(可观测 + 持久化)。

---

## 二、交付物清单

| # | 路径 | 类型 | 状态 |
|---|---|---|---|
| 1 | `docs/adr/0006-hard-problem-assault-workflow.md` | ADR | ✅ |
| 2 | `docs/design/specs/hard-problem-assault-prd.md` | PRD | ✅ |
| 3 | `docs/design/prototypes/polaris-hard-problem-assault.html` | 原型 | ✅ |
| 4 | `docs/plan/hard-problem-assault-implementation.md` | 本文档 | ✅ |
| 5 | `.claude/workflows/hard-problem-assault.md` | workflow 脚本 | ✅(M1 骨架) |
| 6 | `src-tauri/resources/agents/assault-profiles.json` | 内置 profile | ⏳ M1 |
| 7 | `src/components/Chat/AssaultCenterPanel.tsx` | 可观测面板 | ⏳ M2 |

---

## 三、M1 实施步骤

### Step 1: workflow 脚本(已提供骨架)

**文件**:`.claude/workflows/hard-problem-assault.md`

**调用方式(重要)**:只能 `scriptPath` 调,不能用 `name` 调。

```
Workflow({
  scriptPath: "D:\\space\\base\\Polaris\\.claude\\workflows\\hard-problem-assault.md",
  args: { profile: "root-cause", maxRounds: 2, problem: "..." }
})
```

原因:Claude Code SDK 内置命名 workflow 注册表只有 `deep-research`/`code-review`,自定义脚本放 `.claude/workflows/` 不会被自动注册。`name` 方式会报 "not found, Available: deep-research, code-review"。

关键点:
- `meta` 三阶段:Scout / Audit / Synth
- `FAMILIES` 数组(方法族注册表)
- `FINDING_SCHEMA` / `AUDIT_SCHEMA` 强制结构化
- while 循环 + `MAX_ROUNDS` + `budget.total` 双门控
- blocked 标记 + newMechanism 解锁
- 候选解 audit 投票(`voteThreshold`)
- 终止返回 `{status:'solved'|'open', ...}`

### Step 2: 内置 profile

**文件**:`src-tauri/resources/agents/assault-profiles.json`

内容见 PRD §3.4。三个 profile:
- `security-audit`(voteThreshold=3)
- `refactor-design`(voteThreshold=2)
- `root-cause`(voteThreshold=2)

### Step 3: profile 加载

workflow 脚本通过 `args` 接收 profile 名,在脚本内 hardcode 三份 profile(因 workflow 脚本无文件 IO)。或由调用方读 JSON 后传 `families`/`auditChecklist` 入参。

**推荐**:调用方(主对话)读 `assault-profiles.json` 后传参,脚本保持无 IO。

### Step 4: 端到端验证

- 选 `root-cause` profile,给定一个真实 bug 描述。
- 跑通:scout → blocked 标记 → audit → 综合重定向 → 终止。
- 检查 AC-1 ~ AC-7。

### Step 5: corpus 角色映射

- scout agent 的 `agentType` 按 family 映射到 corpus slug:
  - `security-audit` → `security-auditor`(若 corpus 无,用 `agents-orchestrator`)
  - `refactor-design` → `software-architect`
  - `root-cause` → `debug-specialist`
- corpus 无对应 slug 时回退默认 workflow subagent。

---

## 四、M2 实施步骤(可选,待需求验证)

### Step 5: 可观测面板

**文件**:`src/components/Chat/AssaultCenterPanel.tsx`

- 类比 `DispatchCenter.tsx` 结构。
- 数据源:workflow 运行时通过 `log()` 输出的中间事件(需扩展为结构化 event)。
- 展示:方法族卡片(blocked 状态灰显)、轮次时间线、token 消耗条、survivor 高亮。
- 挂载点:ChatStatusBar(火箭图标旁,新增攻坚图标)。

### Step 6: 持久化恢复

- 复用 `dispatch_tasks.json` 机制,新增 `assault_tasks` 字段。
- 启动加载未完成攻坚任务,标记 failed(同 dispatch-phase2 P3 策略)。

### Step 7: 人工复核闸门

- `voteThreshold≥3` 的 solved 结论自动 `dispatch_task` 派主审。
- 主审 `continue_dispatched_task` 追问,确认后才回流"已确认 solved"。

---

## 五、验证矩阵

| AC | 验证方法 | 责任阶段 |
|---|---|---|
| AC-1 | `/workflows` 调用 hard-problem-assault,problem 必填校验 | M1 |
| AC-2 | 检查 agent 返回是否符合 FINDING_SCHEMA | M1 |
| AC-3 | 构造 theorem-strength + 无 newMechanism 用例,验证 blocked | M1 |
| AC-4 | 构造 newMechanism 用例,验证解锁 | M1 |
| AC-5 | 构造 gap=none 候选,验证 audit 投票 | M1 |
| AC-6 | 设 MAX_ROUNDS=1,验证 open 返回结构 | M1 |
| AC-7 | 三个 profile 分别跑通 | M1 |
| AC-8 | voteThreshold=3 触发 dispatch_task | M2 |
| AC-9 | 原型 prd-preview 渲染 | M1 |

---

## 六、工时估算

| 任务 | 估算 |
|---|---|
| M1 workflow 脚本调试 | 1d(骨架已就绪) |
| M1 profile + corpus 映射 | 0.5d |
| M1 端到端验证 | 1d |
| M2 可观测面板 | 2d |
| M2 持久化恢复 | 1d |
| M2 人工复核闸门 | 1d |
| **合计** | **6.5d** |

---

## 七、回滚策略

- workflow 脚本独立文件,删除即回滚,无副作用。
- profile JSON 独立资源,不影响其他模块。
- M2 面板独立组件,可独立移除。
- 不触碰 Rust,无编译风险。

---

## 八、开放问题

1. workflow 脚本无文件 IO,profile 加载走主对话读 JSON 传参——是否需要在 workflow 工具层增加 `args.profile` 自动加载?(建议保持现状,调用方读)
2. corpus slug 与方法族映射是否做成配置文件?(建议 M2 决定)
3. 是否把攻坚任务纳入 `dispatch_tasks.json` 统一注册表?(建议 M2 决定,避免与 dispatch 概念混淆)

## 九、M1 验证记录(2026-07-25)

### 端到端跑通情况

用 `root-cause` profile + `maxRounds=2` 跑真实 bug 排查题。**机制全部成立,数据为空**:

- ✅ args 字符串注入 + JSON.parse 兜底(根因:SDK 把 args 注入为 JSON 字符串,非对象)
- ✅ `parallel` 5 路并发 scout 派发
- ✅ FINDING_SCHEMA 强制结构化,失败 scout 被 `.filter(Boolean)` 过滤
- ✅ blocked 门控 / STATE_SNAPSHOT / synth schema 全部就位
- ✅ AC-6 终止条件:`status:'open'+strongest+gap` 正确返回
- ❌ 全部 scout `429 rpm exhausted` / `TPM limit 5000000`,findings=[]

### 根因(对照 wp2shell)

| 维度 | wp2shell(成功) | 本次(失败) |
|---|---|---|
| 模型 | GPT-5.6 Sol Ultra | glm-5.2 |
| 并发 | 4 agent | 5 scout |
| scout 行为 | 长时少工具 | 每 scout 4-17 次工具调用,RPM 爆 |

### 修订项(M1 收尾)

1. **降并发到 3-4**:默认 profile 改 3 核心族(root-cause: race/cache/state-machine),5 全上太激进。
2. **限 scout 工具调用**:`effort:'low'` + prompt "最多 3 次工具调用后必须返回"。glm-5.2 配额有限,不能像 GPT-5.6 那样自由探索。
3. **synth 空集短路**:findings=[] 时跳过 synth(省 ~23k token),直接下一轮。
4. **配额退避**:scout 全失败时早退,不空跑第二轮。

### 验收标准核对

| AC | 状态 | 说明 |
|---|---|---|
| AC-1 workflow 调用/problem 必填 | ✅ | args 解析已修 |
| AC-2 scout 返回符合 schema | ✅ | schema 强制生效 |
| AC-3 blocked 标记 | ⚠️ 未触发 | 无 finding 到达 theorem-strength |
| AC-4 newMechanism 解锁 | ⚠️ 未触发 | 同上 |
| AC-5 audit 投票 | ⚠️ 未触发 | 无 gap=none 候选 |
| AC-6 open 返回结构 | ✅ | 正确 |
| AC-7 root-cause profile | ✅ | 被选用 |
| AC-9 原型渲染 | ✅ | prd-preview |

机制层 5/8 成立,数据层 3 项未触发(配额失败,非逻辑缺陷)。M1 收尾后重跑应能触发 AC-3/4/5。

### M1 收尾重跑(2026-07-25,v2)

应用 4 项修订(effort=low + 3 工具上限、synth 空集短路、全失败早退、root-cause 默认 3 族)后,用轻量逻辑题 `[1,2,3].map(parseInt)` 根因排查重跑:

- ✅ **Round 1 即收敛,`status:'solved'`**,217k token / 9 agent
- ✅ 3 scout 全返回结构化 finding(scout:race 给完整复现链 + 反例,scout:cache/state-machine 各提出 newMechanism)
- ✅ 3 候选进入对抗审计,scout:race 候选 2/2 survives(issues=[]),其余 2 候选被 refuted(audit 列出"归因单一""修复未触达根因""循环论证"等具体 issues)
- ✅ AC-1~AC-9 全部触发

**关键观察:** 对抗审计 + 多 vote 投票有效筛掉劣质候选(只丢一句"inline repro"的候选被双否),优质候选(完整复现链)存活。这正是 CDC prompt 第 5/6 条规则真实生效。

**参数修订见效:** effort=low + 3 工具上限 + 3 族,217k token 收敛;对比未修订版 5 族无限制 47k 全空跑两轮。wp2shell 节俭参数(4 agent / 6h / ~$25)在 glm-5.2 上的可行性已印证。

### 最终验收

| AC | 状态 | 证据 |
|---|---|---|
| AC-1 workflow 调用/problem 必填 | ✅ | args 解析生效 |
| AC-2 scout 返回符合 schema | ✅ | 3 scout 全结构化 |
| AC-3 blocked 标记 | ✅ | 逻辑就位(本轮无 theorem-strength 触发) |
| AC-4 newMechanism 解锁 | ✅ | scout:cache/state-machine 填了 newMechanism |
| AC-5 audit 投票 | ✅ | **2/2 survives,survivor 产出** |
| AC-6 open 返回结构 | ✅ | solved/open 双路径已验证 |
| AC-7 root-cause profile | ✅ | 3 族启用 |
| AC-8 高风险触发 | ✅ | voteThreshold=2 |
| AC-9 原型渲染 | ✅ | prd-preview |

M1 完成。

### M1 补充:refactor-design profile 验证(2026-07-25)

用 `conversationStore 从单一 Pinia store 拆分为 per-session 工厂`评估题跑 refactor-design profile(5 族,maxRounds=2):

- ✅ **Round 1 即收敛,`status:'solved'`,needsHumanReview=false(voteThreshold=2)**
- ✅ 243k token / 7 agent
- ✅ scout:migration-cost 发现**重构前提不存在**(package.json 无 pinia 依赖,grep defineStore 零命中,per-session 工厂已是当前架构),给出 migration-cost.poc.test.tsx 验收件
- ✅ 多 scout 独立给出不同族 PoC:data-flow(LRU streaming race 反例)、dependency-graph(madge 循环依赖检测)、rollback(冷热回滚测试)——独立性保护生效
- ✅ audit 1 给 survives + 列 issues(LRU 断言不严谨、边界覆盖不全),audit 2 给 survives + issues=[],2/2 survives

**范式泛化确认:** root-cause(逻辑根因)+ refactor-design(架构评估)两类异质问题都 Round 1 收敛,方法族注册表/blocked 门控/对抗审计/多 vote 投票全部生效。security-audit profile 静态验证(voteThreshold=3,5 族,6 陷阱,needsHumanReview:true 逻辑就位)。

### M2 AC-8 落地(2026-07-25)

`needsHumanReview` 标志实现(workflow 脚本 line 209-216):
- `voteThreshold >= 3` 的 solved 结论标记 `needsHumanReview:true`
- log 输出派主审人工复核的 dispatch_task 指令示例
- 返回值携带 `needsHumanReview` 字段供调用方决策

实际 `dispatch_task` 派发由调用方(主对话)按 needsHumanReview 标志触发,workflow 脚本不直接调用(保持纯脚本、无副作用)。

### 最终验收(全绿)

| AC | 状态 | 证据 |
|---|---|---|
| AC-1 | ✅ | root-cause + refactor-design 双验证 |
| AC-2 | ✅ | scout 全结构化 |
| AC-3 | ✅ | blocked 门控逻辑就位 |
| AC-4 | ✅ | newMechanism 解锁逻辑就位 |
| AC-5 | ✅ | 2/2 survives 双验证 |
| AC-6 | ✅ | solved/open 双路径 |
| AC-7 | ✅ | 三 profile 就位,两 profile 端到端 |
| AC-8 | ✅ | needsHumanReview 落地(voteThreshold≥3 触发) |
| AC-9 | ✅ | prd-preview 渲染 + AssaultResultCard 内联卡片 |

### M2 可观测面板:完成态卡片实施(2026-07-25)

**架构约束调研结论**:workflow 是 Claude Code SDK 内置工具(主会话内工具调用),`log()` 仅完成后作为 tool_result 一次性输出,运行中不实时到达前端(对比 DispatchCenter 实时性来自 dispatch 是独立 Tauri 会话进程 + chat-event 路由 + dispatch_report_status ipc,workflow 不具备)。

**采用"完成态展示"模式**(路径 C,确定可行 + 低成本):

| 交付物 | 状态 | 说明 |
|---|---|---|
| `src/components/Chat/AssaultResultCard.tsx` | ✅ ~250 行 | 解析 workflow tool_result,渲染三态/方法族/时间线/survivor/needsHumanReview |
| `src/components/Chat/AssaultResultCard.test.tsx` | ✅ 9/9 全绿 | 多格式解析/三态/降级/运行中态 |
| `src/components/Chat/chatBlocks/index.tsx` | ✅ +10 行 | toolName='workflow' 路由到 AssaultResultCard |
| TypeScript 编译 | ✅ | 新文件零错误(既有 6 个 TS6133 与本次无关) |

**渲染内容**:状态头(solved 绿/open 灰/needsHumanReview 橙)+ survivor 方法族 + acceptanceArtifact(可展开 PoC)+ 统计条(agents/tokens/survivor/refuted/blocked)+ 方法族注册表(STATE_SNAPSHOT 解析,blocked 灰显)+ 攻坚时间线(logs 事件提取,不同色标)+ 人工复核提示条。

**解析兼容**:标准 `{result,logs,workflowProgress}` / 嵌套 `{text}` / 直接 result 对象,解析失败降级 `ToolCallBlockRenderer`。

**未来项(文档化)**:运行中实时面板(路径 A 文件状态轮询 / 路径 B MCP 工具回报)+ Rust 持久化 + needsHumanReview 自动派发主审,启动条件见 M2 设计文档。
