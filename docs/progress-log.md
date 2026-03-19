# Polaris Scheduler vNext 工程日志

---

## Round 1 - 2026-03-20

### 完成内容
1. **vnext 模块基础架构**
   - 创建 `src/vnext/` 目录结构
   - 定义核心类型系统

2. **类型定义** (`src/vnext/types/index.ts`)
   - `Workflow` - 工作流数据模型
   - `WorkflowNode` - 节点数据模型
   - `AgentProfile` - Agent 模板定义
   - `AgentEvent` - 事件模型
   - `ExecutionRecord` - 执行记录
   - `WorkflowStatus` / `NodeState` - 状态枚举

3. **状态机实现** (`src/vnext/state-machine/index.ts`)
   - `WorkflowStateMachine` - 工作流状态机
   - `NodeStateMachine` - 节点状态机
   - `canNodeBeReady()` - Node READY 判定逻辑
   - `getReadyNodes()` - 获取可就绪节点
   - 状态查询工具函数

4. **EventBus 实现** (`src/vnext/event-bus/index.ts`)
   - 发布-订阅模式
   - 事件优先级支持
   - 事件过期清理
   - 批量操作支持

5. **单元测试** (70/70 通过)
   - 状态机测试 (50 个)
   - EventBus 测试 (20 个)

### 修改文件
- 新增: `src/vnext/index.ts`
- 新增: `src/vnext/types/index.ts`
- 新增: `src/vnext/state-machine/index.ts`
- 新增: `src/vnext/event-bus/index.ts`
- 新增: `src/vnext/__tests__/state-machine.test.ts`
- 新增: `src/vnext/__tests__/event-bus.test.ts`

### 技术决策
1. 状态转换规则允许从任意活跃状态重置到 CREATED
2. EventBus 使用内存版实现，后续可扩展为持久化版本
3. Node READY 判定支持三种触发类型: start/dependency/event

### 风险
- 暂无

### 下一轮建议
- 实现 Continuous Executor（连续执行引擎）
- 实现 Priority Dispatcher（优先级调度器）

---

## Round 2 - 2026-03-20

### 完成内容
1. **Continuous Executor 实现** (`src/vnext/executor/index.ts`)
   - `IExecutor` 接口定义
   - `ContinuousExecutor` 连续执行引擎
   - `DefaultNodeSelector` 默认节点选择器
   - 支持三种节点选择策略: priority/sequential/ready_first
   - 暂停/恢复/停止控制
   - 执行循环核心逻辑

2. **执行器类型定义** (`src/vnext/executor/types.ts`)
   - `ExecutorState` 执行器状态
   - `ExecutionContext` 执行上下文
   - `ExecutionResult` 单次执行结果
   - `ExecutorRunResult` 执行循环结果
   - `INodeSelector` 节点选择器接口
   - `ContinuousExecutorConfig` 配置项

3. **核心功能**
   - 节点执行: 自动将 IDLE 节点激活为 READY 后执行
   - Pipeline 推进: 依赖节点完成后自动触发下游节点
   - 事件触发: 执行后自动将事件添加到 pendingEvents
   - 防无限循环: 最大迭代次数保护

4. **单元测试** (87 个新增，总计 157 个)
   - DefaultNodeSelector 测试 (10 个)
   - ContinuousExecutor 测试 (17 个)
   - 集成测试 (2 个)

### 修改文件
- 新增: `src/vnext/executor/index.ts`
- 新增: `src/vnext/executor/types.ts`
- 新增: `src/vnext/__tests__/executor.test.ts`
- 更新: `src/vnext/index.ts` (导出执行器模块)

### 技术决策
1. 节点选择器支持策略模式，可扩展自定义选择逻辑
2. 执行器采用模板方法模式，`doExecute()` 可由子类覆盖
3. IDLE 节点在执行时自动激活为 READY，简化使用
4. 执行结果事件自动同步到 context.pendingEvents

### 风险
- 暂无

### 下一轮建议
- 实现 Priority Dispatcher（优先级调度器）
- 实现 Workflow 持久化
- 实现 AI Session Manager 抽象

---

## Round 3 - 2026-03-20

### 完成内容
1. **Priority Dispatcher 实现** (`src/vnext/dispatcher/index.ts`)
   - `IDispatcher` 接口定义
   - `PriorityDispatcher` 优先级调度器
   - `DefaultWorkflowSelector` 默认 Workflow 选择器
   - 支持四种调度策略: priority/fifo/round_robin/shortest_first
   - 并发执行控制 (maxConcurrency)
   - 暂停/恢复/停止控制

2. **调度器类型定义** (`src/vnext/dispatcher/types.ts`)
   - `DispatcherState` 调度器状态
   - `WorkflowEntry` 队列条目
   - `DispatchStrategy` 调度策略
   - `IWorkflowSelector` Workflow 选择器接口
   - `PriorityDispatcherConfig` 配置项

3. **核心功能**
   - Workflow 队列管理: enqueue/dequeue/updatePriority
   - 优先级调度: 按优先级选择执行 Workflow
   - 并发控制: 限制同时执行的 Workflow 数量
   - 执行器集成: 自动创建和管理 ContinuousExecutor

4. **单元测试** (30 个新增，总计 187 个)
   - DefaultWorkflowSelector 测试 (10 个)
   - PriorityDispatcher 测试 (15 个)
   - 集成测试 (5 个)

### 修改文件
- 新增: `src/vnext/dispatcher/index.ts`
- 新增: `src/vnext/dispatcher/types.ts`
- 新增: `src/vnext/__tests__/dispatcher.test.ts`
- 更新: `src/vnext/index.ts` (导出调度器模块)

### 技术决策
1. 调度器与执行器分离: PriorityDispatcher 管理 Workflow 调度，ContinuousExecutor 管理节点执行
2. 支持自定义执行器工厂函数，便于扩展不同的执行策略
3. Workflow 选择器采用策略模式，支持自定义选择算法
4. 异步执行 Workflow，不阻塞调度循环

### 风险
- 暂无

### 下一轮建议
- 实现 Node subscribe / emit 实现
- 实现 Pipeline 推进机制
- 实现 Execution Record 存储

---

## Round 4 - 2026-03-20

### 完成内容

#### 1. NodeEventController 节点事件控制器 (`src/vnext/event-controller/`)
- 节点订阅管理 (activateNodeSubscriptions, deactivateNodeSubscriptions)
- 事件发射 (emitNodeEvent, emitNodeEvents, emitNodeCompleted, emitNodeFailed)
- 事件匹配和路由 (isEventMatched, findMatchingNodes, matchEventsToNodes)
- 待处理事件管理 (getPendingEventsForNode, consumePendingEventsForNode)
- 全局实例支持 (getNodeEventController, resetNodeEventController)

#### 2. PipelineOrchestrator Pipeline 推进协调器 (`src/vnext/pipeline/`)
- Pipeline 生命周期控制 (start, pause, resume, stop)
- 节点依赖检查 (checkDependenciesMet, getBlockedNodes)
- 节点状态管理 (completeNode, skipNode)
- 执行进度跟踪 (getProgress, getNodesByStatus)
- 并行执行控制 (maxParallel)
- 自动推进支持 (autoAdvance)

#### 3. ExecutionStore 执行记录存储 (`src/vnext/execution-store/`)
- CRUD 操作 (create, get, update, delete)
- 状态更新方法 (startExecution, completeExecution, failExecution, timeoutExecution, cancelExecution)
- 工具调用记录 (addToolCall)
- 查询功能 (query, getByNode, getByWorkflow, getRunning, getFailed)
- 统计信息 (getStats, getNodeStats)
- 自动清理 (cleanupExpired, cleanupOverflow)
- 导入导出 (export, import)

### 修改文件
- 新增: `src/vnext/event-controller/index.ts`
- 新增: `src/vnext/event-controller/types.ts`
- 新增: `src/vnext/pipeline/index.ts`
- 新增: `src/vnext/pipeline/types.ts`
- 新增: `src/vnext/execution-store/index.ts`
- 新增: `src/vnext/execution-store/types.ts`
- 新增: `src/vnext/__tests__/event-controller.test.ts`
- 新增: `src/vnext/__tests__/pipeline.test.ts`
- 新增: `src/vnext/__tests__/execution-store.test.ts`
- 更新: `src/vnext/index.ts` (导出新模块)
- 更新: `src/vnext/types/node.ts` (添加 enabled 字段)

### 单元测试
- NodeEventController: 30 个新增测试
- PipelineOrchestrator: 33 个新增测试
- ExecutionStore: 33 个新增测试
- 总计: 283 个测试全部通过

### 技术决策
1. 事件控制器统一管理节点的订阅和发射，简化事件协同逻辑
2. Pipeline 推进支持自动推进模式，节点完成后自动触发下游节点
3. 执行存储独立定义类型，避免循环依赖问题
4. WorkflowNode 添加 enabled 字段，支持节点级别的启用/禁用

### 风险
- 暂无

### 下一轮建议
- 开始 Phase 3: Agent Runtime
- 实现 AI Session Manager 抽象
- 实现执行上下文构建器
- 实现模板系统 v1

---

## Round 5 - 2026-03-20

### 完成内容

#### 1. AI Session Manager 抽象 (`src/vnext/session/`)
- 会话状态管理 (SessionState: IDLE/RUNNING/PAUSED/COMPLETED/FAILED/CANCELLED)
- 会话配置 (SessionConfig: engineId, workDir, maxTokens, temperature, timeout, systemPrompt, profile)
- 会话信息追踪 (SessionInfo: id, nodeId, workflowId, state, tokenUsage, rounds)
- 消息管理 (Message: role, content, timestamp, tokenCount)
- 执行事件 (ExecutionEvent: thinking/reading/writing/tool_call/decision/error/complete)
- MockSession 模拟实现 (用于测试和开发)
- SessionManager 会话管理器 (createSession, getSession, getActiveSessions, closeSession)
- 流式回调支持 (SessionEventCallbacks: onThinking, onToolCall, onOutput, onError, onComplete)

#### 2. Context Builder 执行上下文构建器 (`src/vnext/context/`)
- 节点执行上下文 (NodeExecutionContext: workflow, node, profile, round, memory, pendingEvents, executionHistory, userInputs)
- 提示词上下文 (PromptContext: systemPrompt, userPrompt, contextInfo, templateVars)
- 上下文构建选项 (ContextBuildOptions: includeMemory, includeHistory, includeUserInputs, maxHistoryItems, maxMemoryLines)
- 用户输入管理 (UserInput: type, content, timestamp, processed)
- 依赖状态追踪 (DependencyStatus: nodeId, nodeName, status, outputSummary)
- 模板渲染 (renderTemplate: 变量替换, 条件块, 循环)
- Profile 约束注入系统提示词
- 内存摘要格式化

#### 3. Template System 模板系统 v1 (`src/vnext/template/`)
- 模板类型 (ProfileTemplate, PromptTemplate, WorkflowTemplate, NodeTemplate)
- 模板变量定义 (TemplateVariable: name, type, defaultValue, required, validation)
- 模板渲染上下文 (TemplateRenderContext: variables, workflowContext, nodeContext, memoryContext)
- 模板渲染结果 (TemplateRenderResult: success, content, usedVariables, errors, warnings)
- 内置 Profile 模板 (builtin-developer-v1, builtin-product-v1, builtin-tester-v1)
- 内置 Prompt 模板 (builtin-task-prompt, builtin-review-prompt)
- 内置 Workflow 模板 (builtin-dev-pipeline, builtin-feature-flow)
- 模板语法支持:
  - 简单变量 `{{variable}}`
  - 嵌套变量 `{{context.workflow.name}}`
  - 条件块 `{{#if variable}}...{{/if}}`
  - 条件-否则 `{{#if variable}}...{{else}}...{{/if}}`
  - 循环 `{{#each items}}...{{this}}...{{/each}}`

### 修改文件
- 新增: `src/vnext/session/types.ts`
- 新增: `src/vnext/session/index.ts`
- 新增: `src/vnext/context/types.ts`
- 新增: `src/vnext/context/index.ts`
- 新增: `src/vnext/template/types.ts`
- 新增: `src/vnext/template/index.ts`
- 新增: `src/vnext/__tests__/session.test.ts`
- 新增: `src/vnext/__tests__/context.test.ts`
- 新增: `src/vnext/__tests__/template.test.ts`
- 更新: `src/vnext/index.ts` (导出新模块)

### 单元测试
- SessionManager: 34 个新增测试
- ContextBuilder: 20 个新增测试
- TemplateEngine: 29 个新增测试
- Phase 3 总计: 83 个新增测试
- 全部测试: 366 个测试全部通过

### 技术决策
1. Session 抽象接口化，支持 Mock 实现和未来真实 AI 引擎集成
2. Context Builder 职责单一：构建节点执行所需的完整上下文信息
3. Template Engine 采用内置模板 + 自定义模板模式，支持灵活扩展
4. 模板渲染顺序：先处理控制结构(each/if)，再处理变量替换

### 风险
- 暂无

### 下一轮建议
- 开始 Phase 4: Memory 系统
- 实现 active / summary / archive 分层
- 实现压缩触发策略
- 实现 semantic index stub

---

## 进度评分

Round 1: +2% (新增稳定功能)
Round 2: +2% (新增稳定功能)
Round 3: +2% (新增稳定功能)
Round 4: +2% (Phase 2 协同能力完成)
Round 5: +2% (Phase 3 Agent Runtime 完成)
当前总进度: 10%
