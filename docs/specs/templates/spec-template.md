---
name: <kebab-case>
status: draft
version: 1.0
date: <YYYY-MM-DD>
author: <name>
reviewers: []
related-adrs: []
related-plans: []
priority: p0 | p1 | p2 | p3
---

# <标题>

## 1. Context（背景）

### 1.1 问题陈述

<要解决什么问题？当前痛点是什么？>

### 1.2 用户故事

> 作为 <角色>，我想要 <能力>，以便于 <价值>。

### 1.3 动机

<为什么需要这个特性？不做会有什么后果？>

## 2. Intent（意图）

### 2.1 功能需求

<系统应该做什么？>

### 2.2 验收标准（EARS）

使用 EARS 五模式写验收标准：

| # | 模式 | 验收标准 |
|---|------|---------|
| AC-1 | Ubiquitous | The system shall... |
| AC-2 | Event-driven | WHEN <触发> THEN <响应> |
| AC-3 | State-driven | WHILE <状态> THEN <行为> |
| AC-4 | Unwanted behavior | IF <条件> THEN <响应> |
| AC-5 | Optional features | WHERE <功能启用> THEN <行为> |

### 2.3 非功能需求

- **性能**：<性能要求>
- **安全**：<安全要求>
- **兼容性**：<兼容性要求>
- **可观测性**：<日志/指标/追踪要求>

## 3. Architecture（架构）

### 3.1 关键组件

<核心模块和组件列表>

### 3.2 数据模型

<涉及的数据结构和 schema>

### 3.3 API 契约

<接口定义和调用关系>

### 3.4 系统交互

<与其他模块/服务的交互>

## 4. Constraints（约束）

### 4.1 技术约束

<技术栈限制、依赖、性能预算>

### 4.2 组织约束

<团队能力、时间线、合规要求>

### 4.3 排除范围（Out-of-Scope）

<明确不做什么，约束 AI Agent 行为>

## 5. Risks（风险）

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| <风险> | 高/中/低 | 高/中/低 | <缓解> |

## 6. Traceability（可追溯性）

- **关联 ADR**：
- **关联 Plan**：
- **关联测试**：

## 7. Validation Plan（验证计划）

### 7.1 单元测试

<需要覆盖的测试用例>

### 7.2 集成测试

<需要覆盖的集成场景>

### 7.3 用户体验验收

<用户侧验收步骤>

## 8. Rollout（发布策略）

<分阶段发布计划、回滚策略>

## 9. References（参考）

- <链接或文件引用>
