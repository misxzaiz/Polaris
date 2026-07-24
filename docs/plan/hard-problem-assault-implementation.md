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
