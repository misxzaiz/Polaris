# AI 主动陪伴助手 — 实施报告

> 日期：2026-08-22
> 阶段：Phase 0（基础工具，已完成并验证）
> 状态：✅ 待验证后可进行 Phase 1 集成

---

## 1. 交付内容概述

本阶段交付了一套 **AI 主动陪伴助手的基础工具层**，不依赖主应用 UI、可独立测试：

```
src/services/companion/
├── index.ts                      # 统一导出
├── types.ts                      # 类型定义（内容/记忆/触发/人格/配置/引擎）
├── companionConfig.ts            # 配置模块（加载/校验/回退/持久化）
├── companionConfig.test.ts       # 13 测试
├── companionMemory.ts            # 记忆模块（活动记录/技能/交互历史）
├── companionMemory.test.ts       # 14 测试
├── companionTrigger.ts           # 触发决策引擎（疲劳抑制为核心）
├── companionTrigger.test.ts      # 19 测试
├── companionPersona.ts           # 人格系统（3 种预设人格）
├── companionPersona.test.ts      # 12 测试
├── companionContent.ts           # 内容策划引擎（上下文感知生成）
├── companionContent.test.ts      # 18 测试
└── companion.integration.test.ts # 6 端到端集成测试
```

## 2. 设计决策回顾

### 2.1 与 Polaris 现有能力的复用
- **polarisPetStore** — 已有成就系统/计数/情绪，此处建立独立的"学习技能进度"模型（`CompanionSkill`），Phase 1 可对接
- **voiceCompanion** — 已有语音人格注入，此处为"文字/卡片形态"建立 `CompanionPersona`
- **scheduler** — Rust 定时任务触发，此处在前端建立"触发决策"层，Phase 1 可挂接到 scheduler 事件
- **eventRouter / configStore** — 事件订阅与配置持久化的既有模式，此处用相同模式（Zustand persist + localStorage + 校验回退）

### 2.2 疲劳抑制（调研最核心结论）
"主动 ≠ 打扰"。多层抑制设计：
1. 上下文门槛（冷启动/无项目不主动）
2. 频率上限（默认 3 次/天，按人格 1-5 可调）
3. 冷却期（默认 120 分钟）
4. 活跃时间窗（默认 09:00-21:00，可跨天如夜间工作）
5. 静默日（如周末）
6. **事件豁免**（构建失败/错误激增属高价值事件，可突破频率/冷却但绝不在静默时段打扰）

### 2.3 内容质量把关
- 每条内容强制走 `validateContent`：非空、长度合理、类型匹配、拒绝空话
- LLM 不可用/返回空 → 安全降级 null，不崩溃、不重复打扰

### 2.4 可测试性
- 所有存储/生成器抽象为可注入接口（MemoryStorage / ConfigStorage / ContentGenerator）
- 纯逻辑与 I/O 分离，使 88 个测试全部在 mock 环境下运行
- 测试覆盖边界：冷启动、深夜、静默日、频率超限、冷却期、事件豁免、异常降级

## 3. 与调研证据的映射

| 调研结论 | 设计落地 |
|----------|----------|
| 主动 AI 必须"尊重用户主权，可推迟/关闭" | 用户动作四态（接受/忽略/推迟/永久拒绝）+ 内容类型可配置 |
| 过度打扰比被动更糟（通知疲劳） | 6 层疲劳抑制 |
| 过错不在"主动"而在"时机"（sub-task boundary） | 事件触发（构建失败时最相关） |
| 陪伴型学习需游戏化激励 | CompanionSkill 进度 + 完成标记（Phase 1 对接极地成就） |
| 冷启动不应主动（无上下文） | 触发决策显式拒绝 |
| 内容质量保底 | validateContent + LLM 安全降级 |

## 4. Phase 1 集成路线（后续）

1. **UI 呈现**：CompanionPanel / 侧栏卡片渲染（复用现有 panelRegistry）
2. **触发挂接**：将决定逻辑挂到 scheduler 事件与 eventRouter 构建事件
3. **成就对接**：将 CompanionSkill 完成映射到 polarisPet 成就
4. **配置面板**：设置页编辑人格/频率/内容类型
5. **真 LLM 接入**：将 MockContentGenerator 替换为 engine-registry 真实引擎

## 5. 验证记录

- ✅ 88/88 单元+集成测试通过
- ✅ TS 类型检查 0 错误
- ✅ ESLint 0 错误
- ✅ 测试报告见 `04-test-report.md`
- 📌 待验证：真实 LLM 生成内容质量、真实调度器触发、用户接受度（需用户在应用中使用后反馈）