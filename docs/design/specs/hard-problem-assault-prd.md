# 硬问题攻坚工作流 PRD

> 版本:1.0.0
> 日期:2026-07-25
> 关联:[ADR 0006](../../adr/0006-hard-problem-assault-workflow.md) · [实施计划](../../plan/hard-problem-assault-implementation.md) · [原型](../prototypes/polaris-hard-problem-assault.html)

---

## 一、背景与目标

### 1.1 背景

OpenAI 公开 CDC 证明 prompt(圈双覆盖猜想),其方法论价值在于**多 agent 攻坚编排**:堵退出口、多元化投资组合、方法族注册表、blocked 门控、对抗性审计清单、根 agent 反复综合、最低工时门控、拒绝模糊报告。

Polaris 已具备落地全部原语(Workflow 并发、Agency Agents corpus、dispatch_task 闭环、prd-preview),但缺一个把它们组装成"攻坚模式"的顶层范式。

### 1.2 目标

为 Polaris 引入一种可复用的 **Hard-Problem Assault Workflow** 范式,覆盖以下场景:

| 场景 | 典型用法 |
|---|---|
| 仓库级重构方案设计 | 多架构视角并行 + 对抗证伪 |
| 复杂 bug 根因排查 | 多假设并行 + 证伪 |
| 安全审计 | 多维度扫描 + adversarial verify |
| 技术选型/方案比选 | judge panel + 多轮 |
| 跨模块影响面分析 | 多视角拆解 + 综合 |

核心指标:
- **结构化产出**:每个 agent 返回具体 artifacts(引理/构造/方程/反例),拒绝 status 汇报。
- **对抗审计**:候选解必须逐条过陷阱清单,默认 refuted。
- **多轮收敛**:支持 N 轮(默认 6),blocked 方法族仅在新机制出现时重启。
- **成本可控**:budget 天花板 + 轮数上限双重保护。

### 1.3 非目标

- 不实现新引擎,不改 Rust 侧(纯 workflow 脚本)。
- 不做链式 DAG 编排(沿用 dispatch-phase2 "回流感知 + continue"决策)。
- 不假设解一定存在(与 CDC 原文差异)。
- 不替代日常 `dispatch_task` 单人派发场景。

---

## 二、用户故事

### US-1:架构师做仓库级重构方案

> 作为架构师,我想让系统并行从"模块边界/数据流/依赖图/迁移成本/回滚策略"5 个视角探索重构方案,并对抗证伪每个候选,最后给我一份带"已证推导 + 精确缺口"的综合报告。

### US-2:安全工程师做安全审计

> 作为安全工程师,我想并行从"输入校验/鉴权绕过/注入/配置泄露/依赖漏洞"5 个维度扫描,每个发现都过对抗验证(默认 refuted),只把 survivor 回流给我。

### US-3:开发者排查复杂 bug

> 作为开发者,我想并行派发多个根因假设(竞态/缓存/时区/类型/状态机),每假设返回具体复现路径或反例,blocked 假设不浪费算力,最终收敛到真因或报告 open。

### US-4:人工介入根综合

> 作为主审,我希望每轮 Synth 阶段可选地派给我一个后台会话(`dispatch_task`),用 `continue_dispatched_task` 多轮追问,避免 LLM 对抗审计被同款幻觉绕过。

---

## 三、功能需求

### 3.1 核心工作流(`hard-problem-assault` 命名 workflow)

**输入参数**:
```ts
interface AssaultArgs {
  problem: string                  // 硬问题陈述(含"必须解决什么"和"哪些不算解")
  families?: FamilyDef[]           // 方法族清单(可选,缺省由 profile 提供)
  auditChecklist?: string[]        // 对抗审计陷阱清单(领域相关)
  maxRounds?: number               // 默认 6
  minDurationSec?: number          // 最低工时,默认 0(不强制)
  voteThreshold?: number           // 审计投票通过数,高风险≥3,低风险 1
  budgetTotalTokens?: number       // token 天花板
  agentType?: string               // corpus 专家 slug,缺省由 family 决定
}
```

**执行流程**:

```
每轮:
  1. Scout: 并行派发未 blocked 方法族 agent(≤16),独立性保护(不透露其他族结论)
  2. 更新注册表: theorem-strength && !newMechanism → blocked; newMechanism → 解锁
  3. Audit: 对 gap==='none' 的候选用陷阱清单对抗审计(voteThreshold 票)
  4. Synth: 若有 survivor → 返回 solved;否则综合重定向,进入下一轮
终止:
  - solved(survivor 通过审计)
  - open(rounds 达上限 / budget 耗尽,返回最强已证推导 + 精确缺口)
```

### 3.2 方法族注册表

- **数据结构**:`{ key, label, blocked, attempts, lastNewMechanism, findings[] }`
- **分类原则**:按"数学/工程思想"分组,不按措辞。
- **来源**:
  - 内置 profile(见 3.4);
  - 用户传入;
  - 可选:开轮前由 `agents-orchestrator` corpus agent 拟定(人审后采用)。

### 3.3 对抗审计清单

- **领域相关**:每个 profile 内置一组陷阱(如安全审计的"误报/重复/可利用性不足";重构的"等价归约/迁移成本低估/回滚缺失")。
- **投票**:`voteThreshold` 票 survives 才算通过。
- **默认 refuted**:除非每条陷阱都过。

### 3.4 内置 Profile(`assault-profiles.json`)

```json
{
  "profiles": {
    "security-audit": {
      "families": ["input-validation","auth-bypass","injection","config-leak","dep-cve"],
      "auditChecklist": ["误报","重复报告","可利用性不足","修复建议不可执行","漏报前提假设"],
      "voteThreshold": 3
    },
    "refactor-design": {
      "families": ["module-boundary","data-flow","dependency-graph","migration-cost","rollback"],
      "auditChecklist": ["等价归约","迁移成本低估","回滚缺失","兼容性破坏","未覆盖边界"],
      "voteThreshold": 2
    },
    "root-cause": {
      "families": ["race","cache","timezone","type","state-machine"],
      "auditChecklist": ["无法复现","归因单一","忽略日志反证","修复未触达根因"],
      "voteThreshold": 2
    }
  }
}
```

### 3.5 人工介入闭环

- 每轮 Synth 可选 `dispatch_task` 派"主审"后台会话。
- 用 `continue_dispatched_task` 多轮追问。
- 主审结论作为下一轮重定向依据。

### 3.6 可观测性(Phase 2)

- 攻坚过程实时面板(类比 DispatchCenter):方法族状态、blocked、轮次、token 消耗。
- 走 `prd-preview` MCP 内联卡片展示中间综合。

---

## 四、非功能需求

| 维度 | 要求 |
|---|---|
| 成本 | budget.total 硬天花板,超出抛错停止 |
| 并发 | 单轮 ≤16(Workflow 上限),不强行突破 64 |
| 持久化 | Phase 2 选做:状态落 `dispatch_tasks.json` 跨重启恢复 |
| 可观测 | 中间综合可走 prd-preview 内联展示 |
| 安全 | 高风险结论(solved)强制人工复核闸门 |

---

## 五、验收标准

- [x] AC-1: workflow 可被调用,参数 `problem` 必填。**调用方式:`Workflow({scriptPath: ".claude/workflows/hard-problem-assault.md", args: {...}})`**(非命名 workflow——SDK 注册表只有 `deep-research`/`code-review` 是内置命名 workflow,自定义脚本不被自动注册,只能 scriptPath 调)。(2026-07-25 验证通过)
- [x] AC-2: scout agent 返回符合 `FINDING_SCHEMA` 的结构化结果,无 status 汇报。(3 scout 全结构化)
- [x] AC-3: `gapStrength==='theorem-strength' && !newMechanism` 的方法族被标记 blocked,下一轮不再派发。(逻辑就位)
- [x] AC-4: `newMechanism` 命中的 blocked 方法族被解锁。(逻辑就位,scout:cache/state-machine 提出新机制)
- [x] AC-5: `gap==='none'` 的候选解必须过 audit(`voteThreshold` 票)才返回 solved。(2/2 survives 验证)
- [x] AC-6: rounds 达上限或 budget 耗尽时返回 `{status:'open', strongest, gap}`,不返回"尽力而为"。(solved/open 双路径验证)
- [x] AC-7: 三个内置 profile(security-audit/refactor-design/root-cause)可被选用。(root-cause + refactor-design 端到端跑通,security-audit 静态验证)
- [x] AC-8: 高风险场景 `voteThreshold≥3` 时,solved 结论可选触发 `dispatch_task` 人工复核。(needsHumanReview 标志已落地)
- [x] AC-9: 原型 HTML 可在 `prd-preview` 渲染;**完成态 AssaultResultCard 在 chatBlocks 按 `name==='workflow'` + `isAssaultWorkflowOutput(output)` 精确路由**(避免误捕获 deep-research/code-review)。

> M1 端到端验证(2026-07-25):用 `[1,2,3].map(parseInt)` 根因排查题,root-cause profile(3 族)、maxRounds=2、effort=low,Round 1 即收敛 `status:'solved'`,217k token / 9 agent。详细记录见 [实施方案 §九](../../plan/hard-problem-assault-implementation.md#九m1-验证记录2026-07-25)。

## 五补、搜索治理六点对照(2026-07-25 增补)

对照 [Cairn/CDC/wp2shell 三案例归纳](https://mp.weixin.qq.com/s/j2vX2huwPUKc5YFjVDu0yQ) 的 AI 搜索治理六点:

| 治理点 | 本实现 | 状态 |
|---|---|---|
| 1 目标固定,路径不固定 | `problem` 必填 + `gap==='none'`+`acceptanceArtifact` 才算解 | ✅ |
| 2 不用固定角色代替搜索 | persona 是**初始多样性种子**,非固化岗位(同 wp2shell 把"解析/字符集/上传"当种子) | ✅ |
| 3 多条实质不同路线并行 | `FAMILIES[]` 多族并行,独立性保护(scout prompt 不透露其他族结论) | ✅ |
| 4 中间搜索状态外化 | 内存 JS state + 每轮 `STATE_SNAPSHOT` 结构化 log | ⚠️ M1 快照 log / M2 落盘 |
| 5 据新增事实循环生成下一步 | `Synth` schema + while 循环 + blocked 重开门控 | ✅ |
| 6 完成由可验证目标决定 | `gap==='none'` + `acceptanceArtifact` + audit 投票 | ✅ |

**核心论断落地:** 模型负责搜索内容(scout 提候选),Harness 负责搜索治理(方法族注册表/blocked 门控/对抗审计/STATE_SNAPSHOT/终止条件)。wp2shell 节俭参数(4 agent/6h/~$25)在 glm-5.2 上印证:effort=low + 3 族 + 3 工具上限,217k token 收敛。

**边界声明:** 本范式不证明最优、不证明每项机制不可少、不证明共同结构就是成功原因。三案例实际只有两条独立设计源(CDC→wp2shell 直接继承,Cairn 独立同构),无消融实验。

---

## 六、里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | ADR + PRD + 原型 + workflow 脚本骨架 | 本文档 |
| M1 | 三个内置 profile + 端到端跑通一个 profile | 待实施 |
| M2 | 可观测面板 + 持久化恢复 | 待实施 |

---

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| token 失控 | budget.total 硬天花板 + 轮数上限 |
| 对抗审计被同款幻觉绕过 | 高风险强制人工复核闸门 |
| 方法族分类假多样 | profile 由人 + orchestrator 共同拟定,不自动生成 |
| 单机并发不足 | 多轮流水线弥补,文档说明 wall-clock 较长 |
| 工程问题"假设有解"诱发幻觉 | 终止条件显式 `open`,返回最强已证 + 缺口 |
