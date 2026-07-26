# Assault 命令重构：从 Workflow 到对话式 + 派发审计

> 版本: v1.1
> 日期: 2026-07-26
> 状态: Draft
> 审计记录: 本次 spec 在 v1.0 基础上经 3 审计员对抗审计（21 项发现）后修订
> 关联: `docs/plan/hard-problem-assault-implementation.md` · `.claude/workflows/hard-problem-assault.md` · `docs/design/specs/hard-problem-assault-prd.md`

---

## 1. 动机

### 1.1 问题

现有硬问题攻坚工作流基于 Claude Code SDK `Workflow` 工具实现，存在以下体验问题：

| 问题 | 表现 | 根因 |
|------|------|------|
| 启动慢 | 几十秒后才开始执行 | Workflow 初始化开销 |
| 中间不可见 | `log()` 仅完成后集中输出，运行中无感知 | Workflow 是主会话内工具调用，运行中不实时到达前端 |
| 被打断需重来 | 中断后 resume 才有缓存，但进度丢失 | Workflow 无持久化 checkpoint |
| 交互不直接 | 不能中途提问、调整方向 | 后台 batch 模式，非对话式 |
| 黑盒感强 | 用户看不到"现在在做什么" | 无实时进度反馈 |

### 1.2 目标

- 提供**实时可见、可打断**的对话式攻坚分析交互
- 对抗审计改为 **`dispatch_task` 派发**，实现多视角并行验证
- 注册为 CLI 斜杠命令 `/assault`，输入 `/` 即可看到建议和参数提示
- **保留 Workflow 脚本作为备选**（batch 批量模式），两者能力不等价，按场景选择
- **声明能力差异**：对话式采用单轮 5 方法族分析 + 一次审计，**不追求多轮收敛**；复杂疑难问题请使用 Workflow 脚本

### 1.3 非目标

- 不替换已有的 Workflow 脚本（保留为 batch 批量模式）
- 不做实时面板（AssaultResultCard 仅渲染 Workflow 结果，不用于 `/assault`）
- 不改 Rust 后端
- 不做自动化多轮收敛（对话式按需追加轮次）

---

## 2. 设计

### 2.1 使用方式

```
/assault <profile> <问题描述>
```

参数：

| 参数 | 必填 | 说明 |
|------|------|------|
| `profile` | 是 | 攻坚 profile：`root-cause` / `refactor-design` / `security-audit` |
| `问题描述` | 是 | 要攻坚分析的问题，自然语言描述 |

**实现方式**：前端 `ChatInput` 拦截 `/assault` 开头的消息，剥离 `/` 前缀后作为普通文本发给引擎。引擎收到 `assault <profile> <问题>` 后识别并执行分析。

### 2.2 流程

```
用户输入: /assault refactor-design 评估专家存储全局化重构方案
                    ↓ ChatInput 拦截，剥离 /，发送 "assault refactor-design 评估..."
                    ↓ 我识别到 "assault" 开头，进入攻坚模式

🟢 Step 1/5: 模块边界分析       ← 对话内即时分析，输出结果
🟢 Step 2/5: 数据流分析         ← 对话内即时分析，输出结果
🟢 Step 3/5: 依赖图分析         ← 对话内即时分析，输出结果
🟢 Step 4/5: 迁移成本分析       ← 对话内即时分析，输出结果
🟢 Step 5/5: 回滚策略分析       ← 对话内即时分析，输出结果
📋 综合结论                     ← 汇总 5 方法族分析结果

🤖 对抗审计                     ← dispatch_task 派发到后台并行
   ├── dispatch 审计员-1: 验证模块边界分析
   ├── dispatch 审计员-2: 验证迁移成本评估
   └── dispatch 审计员-3: 验证回滚策略
   └── 等待中...（完成后通知你）
```

### 2.3 5 方法族分析方法

每个方法族的分析步骤：

#### 2.3.1 模块边界（Module Boundary）

- 列出受影响的模块/文件
- 检查每个函数签名变更是否影响调用链
- 标记未同步的调用点
- 检查 `#[cfg(feature="...")]` 门控下的编译单元

#### 2.3.2 数据流（Data Flow）

- 追踪数据写入路径：入口 → 处理 → 落盘
- 追踪数据读取路径：读取 → 解析 → 消费
- 验证数据格式一致性（frontmatter 字段、序列化/反序列化）
- 标记数据流断裂点

#### 2.3.3 依赖图（Dependency Graph）

- 收集所有受影响的文件
- 构造调用依赖链
- 标记遗漏的引用点
- 检查编译状态（`cargo check` / `tsc`）

#### 2.3.4 迁移成本（Migration Cost）

- 评估升级影响范围
- 评估旧数据兼容性
- 评估用户操作成本
- 评估 slug 冲突风险
- **评估隐含成本**：双轨维护成本、用户心智迁移成本、对话记忆脆弱性

#### 2.3.5 回滚策略（Rollback）

- 分析回滚场景
- 评估数据丢失风险
- 评估版本兼容性
- 建议回滚安全措施
- **评估对话压缩风险**：Polaris compact-handoff 机制可能导致分析丢失

### 2.4 对抗审计设计

#### 2.4.1 审计派发规则

**硬上限**：并发派发不超过 3 个（dispatch_task 并发上限）。超过 3 的审计任务改为串行派发。

| Profile | 审计数 | 审计员选择方式 | 回退方式 |
|---------|--------|---------------|---------|
| `root-cause` | 2 | `find_expert` 选 root-cause 相关审计员 | `find_expert` 无结果时，用预设角色名直接派发 |
| `refactor-design` | 3 | `find_expert` 选架构相关审计员 | `find_expert` 无结果时，用预设角色名直接派发 |
| `security-audit` | 3 | `find_expert` 选安全相关审计员 | `find_expert` 无结果时，用预设角色名直接派发 |

**审计员 slug 与 dispatch role 映射**：`find_expert` 返回的候选 slug 直接作为 `dispatch_task` 的 `role` 参数传入。当前无候选时，默认使用 `engineering-software-architect`（架构审计）/ `engineering-code-reviewer`（代码审查）/ `engineering-codebase-onboarding-engineer`（完整性验证）。

**dispatch_task 不可用时降级**：如果 `dispatch_task` 工具不可用，对抗审计降级为对话内交叉验证——我主动从反面视角审视每步分析结论，并说明"该结论在什么条件下可能不成立"。

#### 2.4.2 审计流程

```
1. 主分析完成 → 输出综合结论（含 Step 级完整输出）
2. 根据结论和 profile 确定审计主题（每个审计员一个独立视角）
3. 用 dispatch_task 派发审计任务到后台
4. 每个审计员接收：
   - 问题描述（含工作目录/仓库根路径，确保独立可验证）
   - 主分析结论摘要
   - Step 级完整输出（文件清单、调用链、编译结果等）
   - 审计视角（如"验证模块边界分析是否遗漏了调用点"）
   - 验收标准含 auditChecklist 陷阱清单
   - 输出格式约定（verdict + issues + suggestion）
5. 审计员完成后，我汇总审计结果
6. 分歧处理：
   - 审计员禁止二次 dispatch_task（深度上限 2 约束）
   - 分歧仅由主会话追加派发新的审计员
   - 最多追加 1 轮，之后按多数决（3 审计员时 2/3 通过）
```

#### 2.4.3 审计员 prompt 模板

```
你是一位独立审计员，负责验证以下分析结论。

## 问题
{问题描述}

## 工作上下文
{工作目录/仓库根路径，供审计员独立验证}

## 主分析结论摘要
{主分析结论摘要}

## Step 级完整输出
- 受影响文件清单：{文件路径列表}
- 调用链/依赖图：{关键调用链说明}
- 编译/类型检查结果：{cargo check / tsc 结果}

## 审计视角
{审计视角，如"验证模块边界分析是否遗漏了调用点"}

## 陷阱清单（逐条检查）
- 循环论证（用等价命题证等价命题）
- 等价归约（归约到原命题强度的子问题，非真进展）
- 归因单一（忽略多因素叠加）
- 忽略日志反证（与观测数据矛盾）
- 修复未触达根因（只治症状）
- 边界遗漏（并发/时区/缓存/空值）

## 验收标准
- PASS: 主分析结论在该视角下完整、无遗漏
- FAIL: 主分析结论在该视角下存在遗漏或错误
- UNCERTAIN: 上下文不足以做出判断（请说明缺什么信息）

## 输出格式
{
  "verdict": "pass" | "fail" | "uncertain",
  "issues": ["发现的遗漏/错误列表"],
  "suggestion": "改进建议（可选）"
}
```

### 2.5 Profile 定义

**单一真源策略**：profile 定义以本 spec 为准，Workflow 脚本的 profile 与本 spec 保持一致。所有 profile 字段只在此处维护。

```typescript
const PROFILES = {
  'root-cause': {
    label: '根因排查',
    families: [
      { key: 'race', label: '竞态/并发' },
      { key: 'cache', label: '缓存/一致性' },
      { key: 'state-machine', label: '状态机/生命周期' },
    ],
    auditCount: 2,
    auditQuery: 'root cause analysis debug specialist',
    defaultAuditorSlugs: ['engineering-code-reviewer', 'engineering-codebase-onboarding-engineer'],
  },
  'refactor-design': {
    label: '重构方案评估',
    families: [
      { key: 'module-boundary', label: '模块边界' },
      { key: 'data-flow', label: '数据流' },
      { key: 'dependency-graph', label: '依赖图' },
      { key: 'migration-cost', label: '迁移成本' },
      { key: 'rollback', label: '回滚策略' },
    ],
    auditCount: 3,
    auditQuery: 'software architecture code review',
    defaultAuditorSlugs: [
      'engineering-software-architect',
      'engineering-code-reviewer',
      'engineering-codebase-onboarding-engineer',
    ],
  },
  'security-audit': {
    label: '安全审计',
    families: [
      { key: 'input-validation', label: '输入校验/注入' },
      { key: 'auth-bypass', label: '鉴权/越权' },
      { key: 'config-leak', label: '配置/密钥泄露' },
      { key: 'dep-cve', label: '依赖漏洞' },
      { key: 'crypto-misuse', label: '加密误用' },
    ],
    auditCount: 3,  // 硬上限 3，不超过 dispatch_task 并发上限
    auditQuery: 'security audit penetration testing',
    defaultAuditorSlugs: [
      'engineering-software-architect',
      'engineering-code-reviewer',
      'engineering-codebase-onboarding-engineer',
    ],
  },
}
```

### 2.6 输出格式

每个 Steps 的输出格式：

```markdown
## 🟢 Step N/5: {方法族名称}

### 分析
{分析内容，包括检查项列表、每个检查项的结果}

### 发现
- ✅ {通过项说明}
- ⚠️ {风险项说明}
- 🔴 {问题项说明}
```

综合结论格式：

```markdown
## 📋 综合结论

### 已确认（✅）
{验证通过的部分}

### 待修复（🔴）
{需要修复的问题，按优先级排列}

### 风险提示（⚠️）
{需要关注的风险点}

### 建议
{综合建议}
```

对抗审计结果格式：

```markdown
## 🤖 对抗审计

### 审计员 1: {视角}
- 结论: pass/fail/uncertain
- 发现的 issues: {列表}
- 改进建议: {建议}

### 审计员 2: {视角}
...

### 汇总
{审计结果汇总，分歧按多数决处理}
```

### 2.7 展示层说明

`/assault` 分析的输出为**对话 Markdown 文本**，不使用 `AssaultResultCard` 组件（该组件仅渲染 Workflow 工具结果，按 `toolName==='workflow'` + `isAssaultWorkflowOutput` 路由）。

如果后续需要卡片化展示，可新增 `AssaultResultCard` 的路由分支，但当前不做。

### 2.8 对话持久化风险

Polaris 的 compact-handoff 压缩机制可能在长对话中压缩历史分析内容。缓解措施：

1. 每步分析以**结构化 Markdown 格式**输出，便于压缩后仍可读
2. 综合结论以**要点列表**总结，便于快速回顾
3. 如果对话被压缩后需要回顾分析细节，可重新发起 `/assault` 分析

---

## 3. 实施计划

### 3.1 实施方式

**已注册 CLI 斜杠命令**。`/assault` 已加入 `CLI_SUGGESTED_COMMANDS`，输入框输入 `/` 即可看到建议列表。

前端 `ChatInput.handleSend` 中拦截 `/assault` 开头消息，剥离 `/` 前缀后作为普通文本发送。

### 3.2 依赖

| 依赖 | 说明 | 状态 |
|------|------|------|
| `dispatch_task` MCP 工具 | 对抗审计派发 | ✅ 已有 |
| `find_expert` MCP 工具 | 审计员选择 | ✅ 已有 |
| 5 方法族方法论 | 核心分析框架 | ✅ 已定义 |
| CLI 斜杠命令系统 | `/assault` 注册 | ✅ 已实施 |

### 3.3 实施步骤

| 步骤 | 内容 | 工作量 |
|------|------|--------|
| 1 | 编写本 spec 文档 | ✅ 本文 |
| 2 | 注册 CLI 斜杠命令 | ✅ `cliSlashCommands.ts` + `ChatInput.tsx` 拦截 |
| 3 | 验证：用 `/assault` 方式分析当前问题 | ✅ 已完成（v1.0 分析 + 审计发现 21 项） |
| 4 | 调优：根据实际使用反馈调整方法族和审计数 | 持续 |
| 5 | 可选：补充 AssaultResultCard 分支 | 待需求验证 |

### 3.4 验证矩阵

| AC | 验证方法 |
|----|---------|
| AC-1 | `assault refactor-design <问题>` 输出 5 步分析 |
| AC-2 | 每步分析有具体检查项和结果 |
| AC-3 | 综合结论按优先级排列 |
| AC-4 | 对抗审计派发到后台（并发 ≤ 3） |
| AC-5 | 审计结果返回后汇总，分歧按多数决处理 |
| AC-6 | 中途可打断（如用户提问） |
| AC-7 | 三个 profile 均可使用 |
| AC-8 | dispatch_task 不可用时降级为对话内交叉验证 |
| AC-9 | find_expert 无结果时使用预设审计员回退 |

---

## 4. 与现有 Workflow 对比

| 维度 | Workflow 方式 | `/assault` 方式 |
|------|-------------|----------------|
| 启动速度 | 几十秒 | 即时 |
| 中间可见性 | ❌ 不可见 | ✅ 每步可见 |
| 可打断 | ❌ 中断重来 | ✅ 随时可打断 |
| 并行能力 | ✅ 多 agent 并行 | ✅ dispatch_task 并行（上限 3） |
| 对抗审计 | 多 vote 投票（同候选解） | 多视角分工验证（异视角） |
| 多轮收敛 | ✅ blocked 门控 + synth 重定向 | ❌ 单轮，按需追加 |
| 方法族 | 5 方法族 | 5 方法族 |
| 交互方式 | 后台 batch | 对话式 |
| 持久化 | 无 | 对话历史（有 compact 压缩风险） |
| 实现复杂度 | ~200 行 workflow 脚本 | ~20 行前端拦截 + 对话协议 |

**注意**：两种方式能力不等价。Workflow 适合无人干预的批量多轮攻坚，`/assault` 适合需要实时交互的单轮分析。选择规则：

- 需要**多轮自动收敛**（如安全审计需要多轮 blocked 门控）→ 用 Workflow 脚本
- 需要**实时可见、可打断**（如方案评估、根因排查）→ 用 `/assault`
- 不确定时，先用 `/assault`，不够深再切 Workflow

---

## 5. 风险与边界

| 风险 | 缓解 |
|------|------|
| 对话式分析依赖我的能力，不如 Workflow 可复现 | 方法族分析步骤固定，保证一致性 |
| dispatch_task 并发上限 3 | 审计数硬上限 3，超过串行 |
| 分析结果不可自动化消费 | 对话即产出，可复制粘贴用于文档 |
| 复杂问题分析时间长 | 每步可见，用户可随时打断调整方向 |
| 对话 compact 压缩导致分析丢失 | 结构化输出 + 要点总结，可重新发起分析 |
| auditChecklist 陷阱清单未执行 | 审计 prompt 已包含，每次审计都会检查 |
| PROFILES 与 Workflow 脚本不一致 | 以本 spec 为单一真源，Workflow 脚本同步更新 |

---

## 6. 回滚策略

| 回滚场景 | 操作 | 风险 |
|---------|------|------|
| `/assault` 不可用 | 切回 Workflow 脚本 | 无风险，脚本未删除 |
| dispatch_task 不可用 | 降级为对话内交叉验证 | 无风险 |
| 对话分析不够深 | 切 Workflow 或追加轮次 | 无风险 |
| 对话产出被 compact 压缩丢失 | 重新发起 `/assault` 分析 | 低风险，分析可复现 |

**回滚安全**：代码变更仅涉及前端 `cliSlashCommands.ts`（+3 行建议）和 `ChatInput.tsx`（~10 行拦截），回滚删除即可。Workflow 脚本未修改，AssaultResultCard 未修改，Rust 后端未修改。