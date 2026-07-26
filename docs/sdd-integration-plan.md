# Spec-Driven Development（SDD）集成方案

> 关联：[ADR 0007](adr/0007-spec-driven-development.md)
> 版本：1.0
> 日期：2026-07-26
> 状态：Draft

---

## 一、现状分析（基于项目探查）

### 1.1 现有资产

| 资产 | 位置 | 内容 | 质量 |
|------|------|------|------|
| `PRODUCT.md` | 根目录 | 产品定义、设计原则、反参考 | ✅ 已具备宪法雏形 |
| `docs/adr/*.md` | docs/adr/ | 6 篇架构决策记录（编号 0001-0006） | ✅ 成熟 |
| `docs/design/specs/*.md` | docs/design/specs/ | 4 篇规格（攻坚 PRD、对话协议、Diff 体验） | ⚠️ 散落、无编号 |
| `plans/*.md` | plans/ | 7 份实施计划（移动端、压缩、etc） | ⚠️ 无规格关联 |
| `.kiro/specs/` | .kiro/specs/ | 1 个 Kiro 规格（404 修复） | ⚠️ 未追踪、未使用 |
| 对话协议 | `.claude/workflows/` | 攻坚 workflow | ⚠️ 轻量近似 |
| 记忆文件 | `.claude/projects/.../memory/` | 项目知识记忆 | ✅ 已具备 |

### 1.2 核心问题

1. **规格散落**：`docs/design/specs/`、`plans/`、`docs/adr/` 三处并存，无统一入口
2. **格式不统一**：PRD、设计 spec、实施计划混用，无标准模板
3. **无生命周期**：规格没有 Draft→Review→Implemented 状态流转
4. **无 EARS 验收标准**：当前 AC 是 checklist 风格，不可测试
5. **Kiro 集成未激活**：`.kiro/specs/` 存在但未被利用
6. **对话协议不可审计**：`/assault` spec 是 AI 记住的流程，不持久、不可复现

---

## 二、集成目标（按 SDD 规范）

### 2.1 目标

- 建立 `docs/specs/` 作为唯一规格真实来源
- 统一规格模板（EARS 验收标准）
- 建立规格生命周期管理（Draft→Review→Approved→Implemented）
- 激活 Kiro IDE 集成，与 `docs/specs/` 同步
- 定义对话协议与正式规格的关系（轻量 vs 可审计）

### 2.2 非目标

- 不替换现有 ADR 系统
- 不强制所有特性走完整 SDD 流程（轻量特性可用对话协议）
- 不引入外部 SDD 工具（Spec Kit 脚手架等）
- 不改变现有开发工具链（继续使用 Claude Code、Cursor、Kiro）

---

## 三、集成方案（分阶段实施）

### Phase 0：基础设施（1 小时）

**目标**：建立规格目录、模板、README

**任务**：

1. 创建 `docs/specs/` 目录结构
2. 创建规格模板 `docs/specs/templates/spec-template.md`
3. 创建规格管理指南 `docs/specs/README.md`
4. 更新 `docs/adr/0007-spec-driven-development.md`（已完成）
5. 更新 `.gitignore`（不追踪 `.kiro/specs/`）

**输出**：

```
docs/specs/
├── README.md
└── templates/
    └── spec-template.md
```

---

### Phase 1：规格迁移与标准化（2 小时）

**目标**：将现有散落规格迁移到 `docs/specs/`，补充 EARS 验收标准

**任务**：

1. 迁移 `docs/design/specs/*.md` → `docs/specs/`，重新编号（S001, S002...）
2. 为每个迁移的规格补充 EARS 验收标准
3. 为每个规格补充生命周期状态头（frontmatter）
4. 建立规格与 ADR/Plan 的交叉引用
5. 创建规格清单 `docs/specs/SPEC-CATALOG.md`

**规格编号规则**：

```
S001-hard-problem-assault  → 攻坚工作流
S002-git-diff-ide          → Git Diff IDE 体验
S003-assault-command       → /assault 对话协议
S004-agency-agents         → 专家 Agent 整合
S005-context-compaction    → 上下文压缩
```

**迁移对照表**：

| 原文件 | 新编号 | 标题 | 优先级 |
|--------|--------|------|--------|
| `docs/design/specs/hard-problem-assault-prd.md` | S001 | 硬问题攻坚工作流 | P0 |
| `docs/design/specs/assault-command-redesign-spec.md` | S002 | /assault 对话协议 | P1 |
| `docs/design/specs/git-diff-ide-experience-prd.md` | S003 | Git Diff IDEA 级体验 | P2 |
| `docs/design/specs/hard-problem-assault-m2-design.md` | S001-M2 | 攻坚 M2 设计 | P1 |

---

### Phase 2：激活 Kiro IDE 集成（1 小时）

**目标**：让 Kiro 成为规格编写的辅助工具，与 `docs/specs/` 同步

**任务**：

1. 在 Kiro 中导入 `docs/specs/` 现有规格
2. 配置 Kiro 的 `constitution.md`（从 `PRODUCT.md` + ADR 提取）
3. 建立 Kiro spec → `docs/specs/` 的同步流程（人工或脚本）
4. 文档化 Kiro SDD 工作流程（创建、审查、实现）

**注意**：`.kiro/specs/` 不追踪 Git，仅作为开发辅助。规格副本在 `docs/specs/` 追踪。

---

### Phase 3：EARS 验收标准推广（持续）

**目标**：所有新规格使用 EARS 五模式写验收标准

**EARS 五模式**：

| 模式 | 结构 | 示例 |
|------|------|------|
| Ubiquitous（普遍） | The system shall... | 系统应记录每次认证尝试 |
| Event-driven（事件驱动） | WHEN [触发] THEN [响应] | 当用户提交表单 THEN 系统验证凭证 |
| State-driven（状态驱动） | WHILE [状态] THEN [行为] | 同步进行中 THEN 显示进度指示器 |
| Unwanted behavior（负面行为） | IF [条件] THEN [响应] | 60 秒内 3 次失败 THEN 锁定账户 |
| Optional features（可选功能） | WHERE [功能启用] THEN [行为] | MFA 启用时 THEN 要求 TOTP |

**推广方式**：

1. 新规格强制使用 EARS
2. 旧规格逐步补充（Priority 优先级）
3. AI Agent 训练：在 system prompt 中提示 EARS 语法

---

### Phase 4：AI Agent 规格感知（持续）

**目标**：让 AI Agent 在开发时自动读取和遵循规格

**方式**：

1. 在 `prompt_config.json` 中增加"规格读取"模块
2. 在 system prompt 中提示：开发前先读取 `docs/specs/` 中相关规格
3. 在 Claude Code skills 中增加 `/spec` 命令（读取规格、检查验收标准）
4. 在 Kiro IDE 中利用 Agent 自动读取规格

**规格读取模块配置**：

```json
{
  "id": "module-spec-reading",
  "type": "spec-reading",
  "name": "规格读取",
  "description": "开发前先读取相关规格",
  "content": "当前项目采用 SDD（规格驱动开发）。开发任何特性前，先读取 docs/specs/ 中相关规格，理解验收标准后再开始编码。",
  "enabled": true
}
```

---

## 四、规格模板

### 4.1 标准规格模板（见 `docs/specs/templates/spec-template.md`）

### 4.2 轻量规格模板（对话协议模式）

对于探索性、快速验证的特性，使用轻量规格模板：

```markdown
---
name: <kebab-case>
status: draft | implemented
version: 1.0
date: 2026-07-26
type: lightweight  # 轻量规格，对话协议模式
---

# <标题>

## 使用方式

`/<命令> <参数>`

## 流程

Step 1: ...
Step 2: ...
Step 3: ...

## 验收标准

- AC-1: ...
- AC-2: ...

## 依赖

| 依赖 | 状态 |
|------|------|
| ...  | ...  |

## 风险

| 风险 | 缓解 |
|------|------|
| ...  | ...  |
```

**适用场景**：探索性流程、对话协议、短期验证、原型验证

---

## 五、对话协议 vs 正式规格

### 5.1 区别

| 维度 | 对话协议（轻量） | 正式规格（SDD） |
|------|-----------------|-----------------|
| 持久性 | AI 记住，不持久 | 文件持久，Git 追踪 |
| 可复现 | 依赖 AI 能力 | 可被任何 Agent 读取 |
| 可审计 | 不可审计 | 版本化、可 diff |
| 灵活性 | 高（即时调整） | 低（需审核） |
| 适用场景 | 探索、原型、短期 | 生产、长期、协作 |

### 5.2 共存策略

- 探索性/短期特性：使用对话协议，记录在 `docs/specs/` 轻量规格
- 生产/长期特性：使用正式 SDD 规格，四阶段流程
- 成熟后迁移：对话协议验证成功后，升级为正式规格

---

## 六、验证矩阵

| AC | 验证方法 | 状态 |
|----|---------|------|
| AC-1 | `docs/specs/` 目录存在，包含 README 和模板 | Phase 0 |
| AC-2 | 现有 4 篇规格迁移到 `docs/specs/`，补充 EARS | Phase 1 |
| AC-3 | Kiro IDE 集成激活，与 `docs/specs/` 同步 | Phase 2 |
| AC-4 | 新规格使用 EARS 验收标准 | Phase 3 |
| AC-5 | AI Agent system prompt 包含规格读取提示 | Phase 4 |

---

## 七、风险与缓解

| 风险 | 缓解 |
|------|------|
| 规格腐化（与代码不一致） | CI 检查规格与代码一致性（Phase 2 可选） |
| 过度规格化 | 轻量特性用对话协议，不必走完整 SDD |
| 模板僵化 | 模板是引导，不是强制；复杂填全，简单精简 |
| Kiro 规格与 docs/specs 不同步 | 人工同步（Phase 2），后续脚本自动化 |
| AI Agent 不读规格 | system prompt 提示 + /spec 命令（Phase 4） |

---

## 八、后续迭代

1. **Phase 2 可选**：CI 检查规格与代码一致性（spec linter）
2. **Phase 3 可选**：Spec Kit 工具链集成（模型无关，可选）
3. **Phase 4 可选**：规格版本迁移工具（旧规格 EARS 化）
4. **Phase 5 可选**：规格全生命周期管理面板（类似 DispatchCenter）
