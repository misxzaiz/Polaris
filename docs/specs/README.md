# Polaris Specs — 规格目录

本目录是 Polaris 项目的**规格真实来源（Single Source of Truth）**，采用规格驱动开发（SDD）模式。

## 目录结构

```
docs/specs/
├── README.md                    # 本文件
├── SPEC-CATALOG.md              # 规格清单
├── templates/
│   └── spec-template.md         # 规格模板
├── S001-hard-problem-assault.md
├── S002-xxx-spec.md
└── ...
```

## 规格编号规则

- 编号格式：`S<三位数字>-<kebab-case-slug>.md`
- 示例：`S001-hard-problem-assault.md`
- 编号由 ADR 0007 或项目负责人分配，避免冲突

## 规格生命周期

```
Draft → In Review → Approved → Implemented → Superseded/Deprecated
```

| 状态 | 含义 | 操作 |
|------|------|------|
| Draft | 初稿，编写中 | 作者编写 |
| In Review | 待审核 | 技术负责人审查 |
| Approved | 已批准，可实施 | 开始实施计划 |
| Implemented | 已实现 | 验证验收标准 |
| Superseded | 被新版替代 | 不再修改 |
| Deprecated | 已废弃 | 保留文档，不实施 |

## 规格类型

### 正式规格（Standard Spec）

用于生产特性、长期架构、跨模块协作。四阶段流程：

1. Specify（规格）→ 2. Plan（计划）→ 3. Tasks（任务）→ 4. Implement（实施）

每个阶段边界设有人工审核点。

### 轻量规格（Lightweight Spec）

用于探索性流程、对话协议、短期验证。不强制四阶段流程，但保留验收标准。

在 frontmatter 中标注 `type: lightweight`。

## EARS 验收标准

所有规格使用 EARS（Easy Approach to Requirements Syntax）五模式写验收标准：

| 模式 | 结构 |
|------|------|
| Ubiquitous | The system shall... |
| Event-driven | WHEN [触发] THEN [响应] |
| State-driven | WHILE [状态] THEN [行为] |
| Unwanted behavior | IF [条件] THEN [响应] |
| Optional features | WHERE [功能启用] THEN [行为] |

## 与现有体系的关系

- **ADR（`docs/adr/`）**：架构决策记录，回答"为什么"
- **Specs（`docs/specs/`）**：特性规格，回答"做什么"（本目录）
- **Plans（`plans/`）**：实施计划，回答"怎么做"，与规格关联

三者通过 frontmatter 中的 `related-adrs`、`related-plans` 交叉引用。

## 规格创建流程

1. 复制 `templates/spec-template.md`
2. 填写 frontmatter（编号、状态、作者）
3. 编写 Context、Intent、Architecture、Constraints、EARS AC
4. 提交 PR，状态改为 In Review
5. 技术负责人审核通过后，状态改为 Approved
6. 实施计划创建，关联规格
7. 实施完成后，验证 AC，状态改为 Implemented

## 参考

- [ADR 0007: SDD 集成](../adr/0007-spec-driven-development.md)
- [集成方案](../sdd-integration-plan.md)
- [GitHub Spec Kit 概念](https://github.github.com/spec-kit/concepts/sdd.html)
