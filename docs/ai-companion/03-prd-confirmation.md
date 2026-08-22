# AI 主动陪伴助手 — 最终需求规格书 (PRD)

> 版本：v1.0（最终确认）
> 日期：2026-08-22
> 基于：20 轮 Web 调研 + 架构分析 + 对抗性验证
> 状态：待实施

---

## 1. 产品定位

**一句话描述：**
一个在 Polaris 开发者工作流中，主动感知用户上下文、带着用户学习新技能/集成新功能、且不打扰的 AI 陪伴助手。

**不是：**
- ❌ 不是纯情感聊天（Replika/Character.AI）
- ❌ 不是脉冲式通知（ChatGPT Pulse）
- ❌ 不是教学平台（Duolingo/Code.org）
- ❌ 不是语音伴侣（voiceCompanion 人设分离）

**而是：**
- ✅ 开发者工作流中的"主动学习伙伴"
- ✅ 基于项目上下文的行为引导型 AI
- ✅ 温和低打扰的呈现方式
- ✅ 游戏化激励维持长期参与

---

## 2. 最终用户痛点（来自 20 轮调研）

| 痛点 | 严重度 | 本功能解决 |
|------|--------|-----------|
| P1：AI 被动等待，不主动 | ★★★★★ | 触发引擎根据上下文主动发起 |
| P2：AI 学了就忘 | ★★★★☆ | 记忆层持久化用户画像 |
| P3：AI 回答千篇一律 | ★★★★☆ | 上下文感知内容 + 多样性约束 |
| P4：不知道学什么 | ★★★★☆ | 基于项目状态推荐学习路径 |
| P5：通知打扰 | ★★★☆☆ | 温和卡片 + 可配置频率 + 疲劳抑制 |
| P6：缺乏成就感 | ★★★☆☆ | 复用 polarisPet 成就系统 + 进度追踪 |

---

## 3. 功能模块（Phase 0 — 基础工具）

### 3.1 companionMemory — 记忆模块
- **文件**: `src/services/companion/companionMemory.ts`
- **职责**: 记录用户活动上下文，支持持久化
- **数据字段**:
  ```typescript
  interface CompanionMemory {
    // 会话统计
    totalSessions: number;
    recentSessions: Array<{ date: string; engineId: string; duration: number }>;
    
    // 项目活动
    recentEdits: Array<{ file: string; timestamp: number }>;
    recentBuilds: Array<{ success: boolean; timestamp: number }>;
    recentErrors: Array<{ message: string; count: number }>;
    
    // 学习进度
    learnedSkills: Array<{ skillId: string; name: string; progress: number; completedAt?: number }>;
    activeChallenges: Array<{ challengeId: string; accepted: boolean; completed: boolean }>;
    
    // 交互历史
    companionInteractions: Array<{ type: ContentType; timestamp: number; userAction: 'accepted' | 'dismissed' | 'deferred' }>;
    
    // 疲劳抑制
    lastInteractionTimestamp: number;
    todayInteractionCount: number;
    lastContentTypes: ContentType[];
  }
  ```
- **持久化**: JSONL 文件 (`companion/memory.jsonl`)，遵循 dialogStorage 模式
- **测试**: 独立测试（无 UI 依赖）

### 3.2 companionTrigger — 触发决策引擎
- **文件**: `src/services/companion/companionTrigger.ts`
- **职责**: 检测触发条件，决定是否主动发起
- **触发类型**:
  | 触发类型 | 条件 | 权重 |
  |----------|------|------|
  | 定期触发 | 每 8 小时（可配置）| 低 |
  | 项目事件触发 | build 失败/成功, session 结束 | 中 |
  | 空闲触发 | 5 分钟无操作（可配置）| 低 |
  | 里程碑触发 | 成就解锁、代码量达到阈值 | 高 |
  | 学习触发 | 用户使用了可优化的 API/模式 | 中 |
- **疲劳抑制算法**:
  ```typescript
  function shouldTrigger(memory: CompanionMemory, config: CompanionConfig): boolean {
    // 1. 频率限制：每天不超过 maxDailyInteractions（默认 3）
    if (memory.todayInteractionCount >= config.maxDailyInteractions) return false;
    // 2. 时间窗口：不在静默时段
    if (!isInActiveWindow(config.activeWindow)) return false;
    // 3. 内容多样性：最近 3 次内容类型不同
    if (isRecentContentRepeated(memory, config)) return false;
    // 4. 冷却期：距离上次触发至少 2 小时
    if (Date.now() - memory.lastInteractionTimestamp < config.cooldownMinutes * 60 * 1000) return false;
    // 5. 上下文质量：必须有足够的上下文信息
    if (!hasSufficientContext(memory)) return false;
    return true;
  }
  ```

### 3.3 companionContent — 内容策划引擎
- **文件**: `src/services/companion/companionContent.ts`
- **职责**: 基于上下文生成主动内容
- **内容类型**:
  ```typescript
  type ContentType = 
    | 'project_insight'    // 项目洞察
    | 'learning_challenge' // 学习挑战
    | 'skill_explore'     // 技能探索
    | 'achievement_celebrate' // 成就祝贺
    | 'tip_curiosity'     // 趣味知识
    | 'daily_review';     // 每日回顾
  ```
- **生成流程**:
  1. 收集上下文（memory + 当前项目状态）
  2. 选择内容类型（基于触发条件 + 轮换策略）
  3. 构建 prompt（含上下文 + 人格）
  4. 调用 LLM（通过 engine-registry）
  5. 验证内容质量（非空、非泛泛而谈）
  6. 返回结构化内容

### 3.4 companionPersona — 人格系统
- **文件**: `src/services/companion/companionPersona.ts`
- **职责**: 定义 AI 陪伴者的身份、语气、行为约束
- **人格模板**:
  ```typescript
  interface CompanionPersona {
    name: string;
    tone: 'warm' | 'professional' | 'playful' | 'minimal';
    greeting: string;
    systemPrompt: string;  // 注入 LLM 的系统提示
    // 示教行为
    teachingStyle: 'socratic' | 'demonstration' | 'guided' | 'exploration';
    // 主动频率偏好
    initiativeLevel: 'low' | 'medium' | 'high';
  }
  ```
- **默认人格**: "小白"风格（姐姐型，温暖但专业）

### 3.5 companionConfig — 配置模块
- **文件**: `src/services/companion/companionConfig.ts`
- **职责**: 全部行为的可配置参数
- **配置项**:
  ```typescript
  interface CompanionConfig {
    enabled: boolean;
    personality: CompanionPersona;
    // 触发配置
    maxDailyInteractions: number;      // 默认 3
    cooldownMinutes: number;           // 默认 120
    activeWindow: { start: string; end: string }; // 默认 09:00-21:00
    quietDays: string[];               // 周末不触发
    // 内容类型启用
    enabledContentTypes: ContentType[];
    // 学习偏好
    preferredSkills: string[];
    difficultyLevel: 'beginner' | 'intermediate' | 'advanced';
    // 存储
    persistencePath: string;
  }
  ```

---

## 4. Phase 0 实施计划

### 4.1 文件结构
```
src/services/companion/
├── companionMemory.ts      # 记忆模块
├── companionMemory.test.ts # 记忆模块测试
├── companionTrigger.ts     # 触发引擎
├── companionTrigger.test.ts# 触发引擎测试
├── companionContent.ts     # 内容引擎
├── companionContent.test.ts# 内容引擎测试
├── companionPersona.ts     # 人格系统
├── companionPersona.test.ts# 人格系统测试
├── companionConfig.ts      # 配置模块
├── companionConfig.test.ts # 配置模块测试
├── index.ts                # 统一导出
└── types.ts               # 类型定义
```

### 4.2 测试策略
- 每个模块独立工具测试（vitest）
- Mock 外部依赖（LLM 调用、文件系统时间）
- 覆盖边界条件（空上下文、频率超限、配置无效）
- 集成测试验证多模块协同

### 4.3 排除项（Phase 1 做）
- ❌ 前端 UI 组件（CompanionPanel、卡片渲染）
- ❌ 侧栏入口
- ❌ 设置页面
- ❌ polarisPet 成就系统扩展
- ❌ Scheduler 任务类型扩展

---

## 5. 质量门禁

| 门禁 | 标准 | 验证方式 |
|------|------|----------|
| 单元测试覆盖率 | ≥ 90% | vitest --coverage |
| 疲劳抑制正确性 | 100% 场景不误推 | 参数化测试 |
| 内容非空 | 99% 生成内容不为空字符串 | 内容验证 |
| 内容多样性 | 连续 3 次不重复类型 | 集成测试 |
| 冷启动安全 | 无上下文时不触发 | 直接测试 |
| 配置校验 | 非法配置自动回退到默认值 | 配置测试 |

---

## 6. 验证设计

### 6.1 独立验证方式
- 用 vitest 运行所有模块测试
- 手动模拟场景：提供 mock 上下文，验证触发决策
- 检查输出内容结构化

### 6.2 集成验证方式（Phase 1）
- 在 Polaris 中加载模块，验证 eventRouter 集成
- 端到端：真实 LLM 调用（1 次），验证内容质量
- A/B 测试：用户开启/关闭，比较留存

---

## 7. 参考文档

- [用户痛点调研](01-user-pain-points-research.md)
- [架构设计](02-architecture-design.md)
- 现有代码：polarisPetStore, voiceCompanion, schedulerStore, eventRouter, configStore