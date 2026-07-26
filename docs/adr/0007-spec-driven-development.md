# ADR 0007: 规格驱动开发（SDD）框架集成

## Status

Accepted

## Date

2026-07-26

## Context

### 1. 问题现状

Polaris 是一个大型 Rust/TS 双语言项目（Tauri + React + SimpleAI 引擎），当前有：
- 6 篇 ADR（架构决策记录）
- `PRODUCT.md`（产品定义，类似 SDD 的宪法雏形）
- `docs/design/specs/` 目录（4 篇规格文档）
- `plans/` 目录（7 份计划文档）
- AWS Kiro 集成（`.kiro/specs/`，但仅 1 个规格且未追踪）
- "对话协议"模式（如 `/assault` spec，规格即实现）

规格文档分散在三处，格式不统一，无生命周期管理，无标准流转。

### 2. 为什么需要 SDD

1. **AI 编码代理主导开发**：Polaris 的核心开发模式是 AI Agent（dispatch_task、Workflow、对话协议），需要规格作为真实来源约束 AI 行为
2. **多工程师/多 Agent 协作**：架构决策、功能规格、实施计划需要统一的真实来源
3. **防止意图漂移**：复杂特性（如 SimpleAI 压缩、攻坚工作流）的需求在实现过程中容易偏离原始意图
4. **可追溯性**：ADR 解决了"为什么"，缺一个"做什么+怎么做"的规格层
5. **已有工具支持**：AWS Kiro（SDD IDE）已集成，GitHub Spec Kit 可用，Claude Code 有 cc-sdd skills

### 3. 参考来源

- [GitHub Spec Kit 概念文档](https://github.github.com/spec-kit/concepts/sdd.html)
- [Martin Fowler: Understanding SDD](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)
- [ThoughtWorks: SDD 2025 新兴工程实践](https://www.thoughtworks.com/en-us/insights/blog/agile-engineering-practices/spec-driven-development-unpacking-2025-new-engineering-practices)
- [TheBCMS: 2026 SDD 指南](https://thebcms.com/blog/spec-driven-development)
- [Wikipedia: Specification-driven development](https://en.wikipedia.org/wiki/Specification-driven_development)

## Decision

### 1. 整体架构：三层规格体系

```
┌─────────────────────────────────────────────────────────────┐
│  L1: Constitution（宪法）                                    │
│  - PROJECT.md + ADR + 架构约束                               │
│  - 项目级全局规则，所有 Agent 行为的前置约束                  │
│  - 更新频率：低频（架构变更时）                               │
├─────────────────────────────────────────────────────────────┤
│  L2: Feature Specs（特性规格）                               │
│  - specs/ 目录，编号 S001, S002...                           │
│  - 用户故事 + EARS 验收标准 + 功能/非功能需求 + 排除范围     │
│  - 每个规格独立生命周期（Draft→Review→Implemented→Superseded）│
├─────────────────────────────────────────────────────────────┤
│  L3: Implementation Plans（实施计划）                        │
│  - plans/ 目录，与规格关联                                   │
│  - 架构选择 + 数据模型 + API 契约 + 迁移策略 + 任务分解      │
│  - 由规格派生，不是独立决策                                  │
└─────────────────────────────────────────────────────────────┘
```

### 2. 目录结构

```
Polaris/
├── PROJECT.md                          # 产品定义（宪法雏形，保留）
├── docs/
│   ├── adr/                            # 架构决策记录（保留，L1 的一部分）
│   ├── specs/                          # ★ 新增：特性规格（L2，唯一真实来源）
│   │   ├── README.md                   # 规格管理指南
│   │   ├── S001-xxx-spec.md
│   │   ├── S002-xxx-spec.md
│   │   └── templates/
│   │       └── spec-template.md        # 规格模板
│   └── plans/                          # 保留：实施计划（L3，与规格关联）
├── .kiro/specs/                        # Kiro IDE 规格（不追踪，开发辅助）
└── .claude/
    ├── skills/                         # SDD 相关 skills（可选）
    └── workflows/                      # 攻坚等 workflow（对话协议，L2 的轻量近似）
```

### 3. 规格生命周期

```
Draft → In Review → Approved → Implemented → Superseded/Deprecated
```

每个规格头部包含：

```markdown
---
name: <kebab-case>
status: draft | in-review | approved | implemented | superseded
version: 1.0
date: 2026-07-26
author: <engineer/agent>
reviewers: [<name>]
related-adrs: [ADR-0005]
related-plans: [plan/xxx.md]
priority: p0 | p1 | p2 | p3
---
```

### 4. 规格模板结构（EARS 标准化）

每个规格包含以下章节：

1. **Context（背景）**：问题陈述、用户故事
2. **Intent（意图）**：系统应该做什么（EARS 验收标准）
3. **Architecture（架构）**：数据模型、API 契约、关键组件
4. **Constraints（约束）**：非功能需求（性能、安全、兼容性）
5. **Out-of-Scope（排除范围）**：明确不做什么，约束 Agent
6. **Acceptance Criteria（验收标准）**：EARS 五模式
7. **Risks（风险）**：已知风险和缓解措施
8. **Traceability（可追溯性）**：关联 ADR、Plan、测试

### 5. 与现有体系的映射

| 现有资产 | SDD 角色 | 处理方式 |
|----------|----------|----------|
| `PRODUCT.md` | Constitution | 保留，补充为正式宪法 |
| `docs/adr/*.md` | L1 架构约束 | 保留，与规格交叉引用 |
| `docs/design/specs/*.md` | 迁移到 `docs/specs/` | 重新编号，补充 EARS |
| `plans/*.md` | L3 实施计划 | 保留，增加"关联规格"字段 |
| `.kiro/specs/` | 开发辅助 | 不追踪，与 `docs/specs/` 同步 |
| `/assault` 对话协议 | L2 轻量近似 | 补充 EARS 标准，保留灵活性 |

### 6. 关键约束

1. **规格是唯一真实来源**：Plan 和代码由规格派生，不是独立决策
2. **EARS 验收标准**：所有规格使用 EARS 五模式写验收标准
3. **人工审核点**：Draft→Review（人审），Review→Approved（人审），Approved→Implemented（CI 验证）
4. **与 Git 同步**：规格与代码同仓库，版本号递增
5. **Agent 可读**：规格格式对 AI Agent 友好（结构化、EARS 语法）

## Consequences

### 正面

- 建立统一的规格真实来源，AI Agent 行为有明确约束
- ADR（为什么）+ Specs（做什么）+ Plans（怎么做）三层清晰可追溯
- Kiro IDE 集成提供可视化规格管理
- 新工程师/新 Agent 通过规格快速了解项目意图
- 防止多 Agent 协作时的意图漂移

### 负面/成本

- 初期规格编写增加 20-30% 前置时间（但减少 3-10 倍返工，见 [TheBCMS 数据](https://thebcms.com/blog/spec-driven-development)）
- 规格腐化风险：需求变更后需同步更新规格
- 现有 `docs/design/specs/` 文档需重新编号和 EARS 化
- Agent 需要学习 EARS 语法（但一次学习、持续受益）

### 风险缓解

1. 规格腐化：CI 检查规格与代码一致性（可选 Phase 2）
2. 过度规格化：轻量特性可用对话协议模式，不必走完整 SDD 流程
3. 模板僵化：模板是引导，不是强制；复杂特性填全，简单特性精简

## Alternatives Considered

### Alt 1: 不引入 SDD，继续现状

缺点：规格散落、格式不一、AI Agent 无统一约束、意图漂移风险高。**否决**。

### Alt 2: 完全采用 GitHub Spec Kit（全量）

优点：标准化工具链、模型无关、与 Claude Code/Cursor 无缝集成。
缺点：脚手架成本高、`.specify/` 目录与现有 `docs/` 结构冲突、过度工程化。
**折中**：采用 Spec Kit 的哲学和 EARS 语法，但不强制使用其脚手架。

### Alt 3: 只用 Kiro IDE（不写文档）

优点：可视化、与 AWS 集成。
缺点：规格在 `.kiro/specs/` 不追踪、依赖单一工具、其他 Agent 不可读。
**折中**：Kiro 作为开发辅助，规格副本在 `docs/specs/` 追踪。

## References

- [ADR 0006: 硬问题攻坚工作流](0006-hard-problem-assault-workflow.md)
- [集成方案](../sdd-integration-plan.md)
- [规格模板](../specs/templates/spec-template.md)
