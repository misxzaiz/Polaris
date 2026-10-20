# AI 大任务拆分实施分析（复杂 ERP 改造视角）

> 面向：把 AI（Polaris）当主力做复杂 ERP 级多模块改造时的拆分方法论
> 日期：2026-10-20
> 状态：调研 + 落地建议（不含代码改动）

---

## 一、问题背景

复杂 ERP 改造的典型特征：
- **模块多且耦合深**（订单 → 库存 → 财务 → 报表，牵一发动全身）
- **状态迁移跨度长**（数据迁移 + 协议升级 + UI 重构并存）
- **上下文窗口有限**（AI 记不住 3000 行文件 + 12 个调用点）
- **验证环薄弱**（改完不知道哪里坏了，除非有测试或 typecheck）

用一个 AI 端到端跑一个大任务 = **上下文爆炸 + 目标漂移 + 幻觉**。这是所有主流方法论的核心共识。

---

## 二、网上方法论提炼（8 份资料交叉验证）

| 来源 | 核心观点 |
|---|---|
| Anthropic《Building Effective Agents》 | 不要过度复杂化。推荐 6 种模式：Prompt Chaining / Routing / Parallelization / **Orchestrator-Workers** / Evaluator-Optimizer / Autonomous Agents。**每一步必须确定性可判定**。 |
| Zylos《Long-Running AI Agents 2026》 | 每个 subtask ≤ 15 分钟，否则必须再拆。中间产物落**文件**而非塞 context。 |
| arXiv 2503.09572《Plan-and-Act》 | 先 plan 再对每 step 独立 act；**失败时局部 replan，不重跑全量**。plan 用贵模型、act 用便宜模型是常见组合。 |
| arXiv 2508.11126 AI Agentic Programming Survey | 长程代码失败 top3：上下文爆炸 / 状态漂移 / 缺验证环。对策：**每步原子改动 + 每步 typecheck + 独立 verification agent**。 |
| NxCode《MirrorCode 团队实践》 | 子任务之间用**文件**传递，不共享对话；每张任务卡有明确 acceptance criteria。 |
| 0degrees.ai Task Decomposition | 拆分的三个维度：**功能域 / 数据流 / 依赖**。**按"数据流+依赖"拆最安全**；按"功能名"拆最容易失控。 |
| AugmentCode Multi-Agent Workspace | **Planner / Worker / Reviewer 三角色**强制 handoff，交接必须是结构化产物（plan / diff / review），不是口头摘要。 |
| EPAM Long-horizon in Production | 生产环境必须：可观测 + 可回滚 + 幂等。单步失败**局部重试**，不重启整个流水线。 |

**综合结论**（可执行版）：

1. **拆分的三个维度**：优先按「数据流 + 依赖」拆，其次按「功能域」，**永远不要**按"看起来像一件事"拆。
2. **每个子任务三件套**：owner + 输入/输出 + acceptance criteria（可机器判定的）。
3. **Handoff 走文件，不走对话**：结构化产物 > 自然语言摘要 > 隐式记忆。
4. **每个子任务必跑验证**：typecheck / test / lint，验证失败=子任务未完成。
5. **失败局部 replan**：不要因为第 5 步错了就重跑第 1-4 步。
6. **上下文是稀缺资源**：中间产物落文件 / KV，AI 只带路径不带内容。

---

## 三、对照 Polaris 现状（我读到的实际情况）

### ✅ 已经做得对的地方

| 维度 | Polaris 现状 | 对应方法论 |
|---|---|---|
| Spec 先行 | `plans/` 下 80+ spec，AGENTS.md 明确要求「先 spec 后代码」 | Plan-and-Act / Anthropic |
| 分 P0-P3 分级 | git-panel 已按 P0/P1/P2/P3 拆，P2 下还有 8 个子 spec（conflict-predict / lane-cache / lane-collapse / lane-graph / lane-increment / operations / undo / watcher） | 数据流+依赖拆分典范 |
| 明确所有权 | Cap 总线是统一权限/审计；数据根单点在 `services/data_root.rs` | Unique owner 原则 |
| 已知边界清单 | AGENTS.md 第九节明确列了「10 个巨型文件」「命令门控双向挂」「协议无运行时 schema 校验」 | 承认边界不硬扛 |
| 多 agent 编排能力 | `dispatch_agent` / `dispatch_roster`（波次+并发）已经具备 | Orchestrator-Workers 雏形 |
| 类型检查门槛 | `pnpm typecheck` 已在 CI 里，`cargo check` 是 Rust 门槛 | 每步验证 |

### ⚠️ 现有短板（AI 大任务落地时的真实痛点）

| 短板 | 现状 | 后果（大任务场景） |
|---|---|---|
| **plans/ 没有主索引** | 80+ spec 无 roadmap index，也没有跨 spec 依赖图 | AI 接手大任务时不知道先看哪份，容易漏 spec 或重复读 |
| **Spec 缺 acceptance criteria** | 现有 spec 多为散文描述，无机器可读的完成判定 | 子任务「做完了」无法自动判定，全靠 AI 自觉 |
| **Spec 缺 owner 字段** | 不知道谁在做，做完怎么验 | 多 agent 场景下 owner 归属混乱 |
| **依赖关系是文字** | git-panel-p2-lane-cache 依赖 lane-graph，只是文字描述 | 无法拓扑排序，无法自动判断先做哪个 |
| **commands/ 迁移无 dashboard** | AGENTS.md 说「每迁一个砍一个旧命令」，但没可视化进度 | 不知道哪些还没迁，容易踩雷 |
| **Handoff 无结构化协议** | dispatch_roster 是波次概念，但没硬约束「产物必须结构化」 | Worker 之间靠对话传递信息，易漂移 |
| **Verification 不强制** | CI 有 typecheck/test，但每个 subtask 落地后没有独立 verification agent | 长程任务里失败累积到最后才发现 |
| **协议无运行时校验** | AGENTS.md 明确「已知缺口」 | 长程任务最大的隐性风险：改协议时前后端漂移 |
| **缺少「原子提交」硬约束** | commitlint 只管 message，不检查 diff 粒度 | 一次改 30 个文件 = 出问题无从回滚 |

---

## 四、可落地的拆分方法论（Polaris 版）

### 4.1 大任务 → spec 的三级拆分

**Level 1：路线图**（1 份，长期）
- 例：`plans/git-panel-master-plan.md`
- 定义：目标、成功指标、总体时间盒
- 不写细节，只写里程碑

**Level 2：功能域 spec**（每个大功能 1 份）
- 例：`plans/git-panel-p2-lane-graph-spec.md`
- 定义：owner、依赖、验收标准
- **必须包含结构化头部**（见下）

**Level 3：原子任务**（每个可独立验证的小步 1 份 or 内嵌在 Level 2）
- 每个 ≤ 15 分钟工作量
- 每个必带：输入文件、输出文件、验证命令、回滚方式

### 4.2 Spec 强制头部模板（建议）

在每份 Level 2 spec 顶部加 YAML front-matter：

```yaml
---
id: git-panel-p2-lane-cache
owner: @alice                # 或 agent slug
phase: P2
depends: [git-panel-p2-lane-graph]
blocks: [git-panel-p2-conflict-merger]
acceptance:
  - "cargo check 通过"
  - "pnpm typecheck 通过"
  - "pnpm test:run -- git-panel 通过"
  - "cache 命中/未命中路径均有单测"
risk: medium
---
```

有了这个，AI 可以：
- **拓扑排序**决定先做哪个
- **自动判定子任务完成**（跑 acceptance 里的命令）
- **追溯回滚**（依赖失败时连锁取消）

### 4.3 三级 Agent 分工（对齐 Polaris 现有 dispatch 能力）

| 角色 | 职责 | 对应 Polaris 能力 |
|---|---|---|
| **Planner** | 读 master plan，产出 Level 2 spec 列表 + 拓扑顺序 | 主会话（当前角色） |
| **Worker** | 实现单个 Level 2 spec，产出 diff + 验证日志 | `dispatch_task`（每次 1 个 agent） |
| **Reviewer** | 独立跑 typecheck/test/lint + code review，产出 review 结论 | `dispatch_task` + `resultSchema: qa-verdict` |

**关键规则**：
- Planner 和 Worker **不同会话**，Worker 不共享 Planner 上下文
- Worker 之间的 handoff **只走文件**（spec + diff + review），不共享对话
- Reviewer **必须独立**，不能是 Worker 自己验自己

### 4.4 上下文管理纪律

**不要塞进 context 的东西**：
- 超过 100 行的完整文件（AI 用 read_file + offset 只读相关段）
- 超过 5 个文件的目录列表（用 search_files 精准定位）
- 完整构建日志（只带 error 行）

**必须落文件的东西**：
- 中间产物（生成的代码片段、schema、配置）
- 验证结果（截图、日志、覆盖率）
- 决策记录（为什么这么拆、放弃了什么方案）

---

## 五、Polaris 下一步的具体建议（优先级排序）

### P0（一周内可做，收益最大）

1. **给 `plans/` 加一份 master index**
   - 文件：`plans/INDEX.md`
   - 内容：分类 + 每张 spec 的 1 行摘要 + 状态（draft/active/done）
   - 收益：AI 接手任何大任务都能 O(1) 定位

2. **给 3-5 份 P0 级 spec 补 YAML front-matter**
   - 试点：`git-panel-p0-spec.md` / `pending-queue-optimization-final.md` / `mcp-bridge-selfheal.md`
   - 收益：验证 acceptance 字段是否真的能让 AI 自动判定完成

3. **规范 dispatch_task 的 prompt 模板**
   - Worker prompt 必须包含：spec 路径、依赖 spec 路径、acceptance 命令、可回滚方式
   - Reviewer prompt 必须要求 `resultSchema: qa-verdict`

### P1（2-4 周，工程化）

4. **写一个 `tools/plans-index.js`**
   - 扫描 `plans/` 下所有 md，解析 front-matter
   - 输出：`plans/INDEX.md`（自动生成）+ `plans/dep-graph.json`（依赖图）
   - 收益：spec 数量翻倍后依然可管理

5. **commands/ 迁移 dashboard**
   - 文件：`src-tauri/src/commands/MIGRATION.md`
   - 内容：40 个命令 → 哪个已迁 cap、哪个未迁、哪个已砍
   - 收益：AGENTS.md 里「每迁一个砍一个」不再靠记忆

6. **协议运行时校验（最小可行）**
   - 针对 `models/ai_event.rs` 里的关键枚举，加一版 serde 校验 + 失败日志
   - 收益：堵住长程任务最大的隐性风险

### P2（长期）

7. **Spec 生命周期工具链**
   - `plan:new` / `plan:validate` / `plan:topo`（拓扑排序）/ `plan:graph`（可视化依赖图）
   - 收益：AI 也能自维护 spec 树

8. **Handoff 协议结构化**
   - dispatch 之间通过标准 handoff 文件（`handoff.json`）传参，而非 prompt 里塞内容
   - 收益：多 agent 编排可追溯、可重放

---

## 六、一句话总结

> **大任务拆分的胜负不在 AI 模型能力，而在「任务卡片是否够原子 + 依赖是否结构化 + 验证是否强制 + handoff 是否走文件」这四件事上。**

Polaris 已经有 spec 文化和 dispatch 能力，但**缺一个把两者串起来的协议层**（front-matter + INDEX + 依赖图 + 强制验证）。补上这一层，Polaris 才能真的承接 ERP 级改造；否则 80 份 spec 会像 ERP 里的模块一样，越加越乱。

---

## 参考来源

- Anthropic Engineering Blog — Building Effective Agents
- Zylos Research — Long-Running AI Agents and Task Decomposition (2026-01)
- arXiv 2503.09572 — Plan-and-Act: Improving Planning of Agents for Long-Horizon Tasks
- arXiv 2508.11126 — AI Agentic Programming: A Survey of Techniques, Challenges, and Applications
- NxCode — MirrorCode and Long-Horizon AI Coding Agents (2026)
- 0degrees.ai — Task Decomposition for AI Coding Agents
- AugmentCode — How to Run a Multi-Agent Coding Workspace (2026)
- EPAM — How to Use Long-Horizon Agents in Production
