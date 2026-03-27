# 任务队列

## 待办
1. ~~分析项目结构~~ (已完成)
2. ~~生成需求 req-chat-empty-state-starters-022 + 原型~~ (已完成)
3. ~~生成需求 req-openai-provider-test-024 + 原型~~ (已完成)
4. ~~生成需求 req-command-palette-026 + 原型~~ (已完成)
5. ~~生成需求 req-chat-draft-autosave-027 + 原型~~ (已完成)
6. 继续分析项目，识别下一个改进点（下次触发执行）
7. 生成更多不重复的需求（逐步推进）

## 已完成
- [x] 分析项目现有需求（21→26 条），确认无重复
- [x] 识别改进点：EmptyState 组件缺少对话启动建议
- [x] 生成需求 req-chat-empty-state-starters-022 + 原型
- [x] 生成需求 req-editor-breadcrumb-023 + 原型
- [x] 分析项目 OpenAI 提供商配置流程
- [x] 识别改进点：缺少连接测试能力
- [x] 生成需求 req-openai-provider-test-024 + 原型
- [x] 分析项目 Toast/通知、命令面板、主题、面板缩放、右键菜单、设置等系统
- [x] 识别改进点：缺少命令面板（Command Palette）
- [x] 生成需求 req-command-palette-026 + 原型
- [x] 分析 Tab 持久化、聊天草稿、i18n 三个方向
- [x] 工程评分：聊天草稿最高（业务价值 ×3 + 低成本）
- [x] 生成需求 req-chat-draft-autosave-027 + 原型

## 候选需求方向（已调研未生成）
- Tab 会话持久化与恢复（tabStore persist 未配置 partialize，存在 stale rehydration 风险，复杂度高暂缓）
- TranslateTab i18n 接入（keys 已存在但组件未使用，成本极低）
- SchedulerPanel 硬编码中文（排序选项、手动清理、批量工具栏等约 20 处）
- 命令描述 i18n（27 条 slash command 描述硬编码中文）
- 类型级标签常量 i18n（TaskModeLabels、TriggerTypeLabels、IntervalUnitLabels）
- 浅色主题支持（工程量大）
- 统一右键菜单组件（代码质量改进）
