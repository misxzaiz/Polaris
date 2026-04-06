# 对话渲染系统流式 Markdown 渲染修复需求文档

## 引言

本文档定义对话渲染系统的流式 Markdown 渲染修复需求。

**核心问题：** 当前系统存在严重的流式 Markdown 渲染错误（rendering bugs），导致在 AI 回复流式输出期间，Markdown 内容显示不正确、布局错乱或出现渲染异常。为避免这些错误，StreamingTextContent 组件被迫采用简化策略：流式阶段仅显示纯文本（仅高亮代码块标记），只有在流式完成后才渲染完整的 Markdown 格式。这导致用户体验严重下降，无法实时看到格式化的内容。

**解决方案：** 完全重写 TextBlockRenderer 和 StreamingTextContent 组件，从根本上修复流式渲染期间的 Markdown 显示错误，实现正确的实时 Markdown 渲染。这不是性能优化项目，而是功能正确性修复项目。

**保持不变的架构：** Layer_System（分层渲染）、Virtual_Scroller（Virtuoso 虚拟滚动）、Content_Block 架构（text/thinking/tool_call 块类型）均保持不变，这些组件已经正常工作。

## 需求优先级

### 核心需求（必须实现）
1. 需求 1: 修复流式 Markdown 渲染错误
2. 需求 2: 完全重写 TextBlockRenderer 和 StreamingTextContent 组件
3. 需求 9: Markdown 解析器和美化打印器

### 保持不变（不需要修改）
1. 需求 3: 保持现有架构组件（Layer_System, Virtual_Scroller, Content_Block）
2. 需求 6: 分层渲染性能优化（已实现，保持不变）
3. 需求 7: 工具调用块折叠优化（已实现，保持不变）
4. 需求 8: 虚拟滚动性能优化（已实现，保持不变）

### 次要需求（核心修复完成后考虑）
1. 需求 4: 评估和优化节流机制
2. 需求 5: Mermaid 渲染（可选，如影响性能可移除）

### 未来工作（可选）
所有"可选需求"部分的性能优化和高级功能

## 术语表

- **Chat_Renderer**: 对话渲染系统，负责将消息内容渲染为可视化界面
- **Markdown_Parser**: Markdown 解析器，将 Markdown 文本转换为 HTML
- **Mermaid_Renderer**: Mermaid 图表渲染器，将 Mermaid 代码渲染为 SVG 图表（可选功能，如影响性能可移除）
- **Content_Block**: 内容块，消息的基本组成单元（文本、思考、工具调用等）
- **Streaming_Message**: 流式消息，正在实时接收的消息内容
- **Layer_System**: 分层渲染系统，将消息分为 Active/Preview/Archive 三层（保持不变）
- **Virtual_Scroller**: 虚拟滚动组件（Virtuoso），仅渲染可见区域的消息（保持不变）
- **Throttle_Mechanism**: 节流机制，限制渲染频率（需评估是否必要）
- **Tool_Call_Block**: 工具调用块，显示 AI 工具执行过程和结果（保持不变）
- **Message_Round**: 消息轮次，一个用户消息和一个助手回复组成一轮对话（保持不变）
- **TextBlockRenderer**: 文本块渲染组件，负责渲染 Markdown 内容（需重写）
- **StreamingTextContent**: 流式文本内容组件，当前仅高亮代码块标记（需重写以支持完整 Markdown）

## 需求

### 需求 1: 修复流式 Markdown 渲染错误（核心需求）

**用户故事:** 作为用户，我希望在 AI 回复时能实时看到正确格式化的 Markdown 内容，而不是等到流式完成后才看到格式，以便更好地理解正在生成的内容。

**当前问题:** StreamingTextContent 组件在流式阶段仅显示纯文本（仅高亮代码块标记 ```），完全不渲染 Markdown 格式。这是因为之前的实现存在严重的渲染错误，包括：
- 不完整的 Markdown 语法导致布局错乱
- 代码块边界识别错误
- 列表和标题渲染异常
- 实时更新导致 DOM 闪烁和重排

#### 验收标准

1. WHEN THE Streaming_Message 正在接收内容, THE StreamingTextContent SHALL 渲染完整的 Markdown 格式（标题、列表、粗体、斜体、链接、代码块等），不得出现渲染错误或布局错乱
2. WHEN THE Streaming_Message 包含不完整的 Markdown 语法（如未闭合的代码块、列表项）, THE StreamingTextContent SHALL 优雅降级显示，保持布局稳定
3. WHEN THE Streaming_Message 包含代码块, THE StreamingTextContent SHALL 正确识别代码块边界（```），即使代码块尚未完成
4. WHEN THE Streaming_Message 接收完成, THE TextBlockRenderer SHALL 渲染完整的 Markdown 内容（包括代码语法高亮）
5. FOR ALL 流式阶段的 Markdown 渲染, THE StreamingTextContent SHALL 避免 DOM 闪烁、重排和布局跳动

### 需求 2: 完全重写 TextBlockRenderer 和 StreamingTextContent 组件（核心需求）

**用户故事:** 作为开发者，我需要完全重写渲染组件以从根本上修复流式渲染错误，而不是修补现有实现。

**当前实现问题:**
- TextBlockRenderer: 使用 react-markdown，但在流式阶段无法正确处理不完整的 Markdown 语法
- StreamingTextContent (line 234-330): 仅实现代码块标记高亮（``` 符号），完全不渲染 Markdown 格式，这是为了规避渲染错误的临时方案

**重写目标:** 设计新的渲染策略，能够在流式阶段正确处理不完整的 Markdown 语法，同时保持现有样式和架构。

#### 验收标准

1. THE TextBlockRenderer SHALL 完全重写实现，采用新的渲染策略修复流式渲染期间的 Markdown 显示错误
2. THE StreamingTextContent SHALL 完全重写实现，移除当前的代码块标记高亮逻辑（line 234-330），实现完整的流式 Markdown 渲染
3. THE TextBlockRenderer SHALL 保持现有的 CSS 类名和样式（prose prose-invert prose-sm max-w-none），确保视觉一致性
4. THE TextBlockRenderer SHALL 继续支持分层渲染模式（full/preview/archive），不改变现有架构
5. THE 新实现 SHALL 提供清晰的错误处理机制，当 Markdown 解析失败时降级为纯文本显示，而不是崩溃或显示错误

### 需求 3: 保持现有架构组件

**用户故事:** 作为开发者，我希望保持已经正常工作的架构组件，避免不必要的重构风险。

#### 验收标准

1. THE Layer_System SHALL 保持不变（Active/Preview/Archive 三层分层逻辑）
2. THE Virtual_Scroller SHALL 保持不变（Virtuoso 虚拟滚动实现）
3. THE Content_Block 架构 SHALL 保持不变（text/thinking/tool_call 等块类型）
4. THE Message_Round 分组逻辑 SHALL 保持不变（groupConversationRounds 函数）
5. THE 现有样式系统 SHALL 保持不变（Tailwind CSS 类名和主题变量）

### 需求 4: 评估和优化节流机制（次要需求）

**用户故事:** 作为开发者，我希望评估现有节流机制是否必要，并根据新实现调整或移除，但这不是核心优先级。

**说明:** 节流机制的优化应在流式 Markdown 渲染正确性修复完成后进行。如果新实现性能足够好，节流机制可能不再必要。

#### 验收标准

1. THE 开发团队 SHALL 在修复流式渲染错误后，评估 200ms 节流机制是否仍然必要
2. IF THE 新实现性能足够好且渲染正确, THEN THE Throttle_Mechanism SHALL 被移除或调整为更短间隔
3. WHEN THE Throttle_Mechanism 被保留, THE Chat_Renderer SHALL 确保节流不影响 Markdown 渲染的正确性（优先正确性而非性能）
4. THE Chat_Renderer SHALL 在流式阶段使用 useDeferredValue 降低渲染优先级（保持现有实现）
5. THE Chat_Renderer SHALL 在流式完成时立即触发最终完整渲染，不受节流限制

### 需求 5: Mermaid 渲染（可选，可移除）

**用户故事:** 作为用户，我希望 Mermaid 图表能正确渲染，但如果影响核心渲染性能或增加复杂度，可以完全移除此功能。

**优先级说明:** Mermaid 渲染是可选功能，不是核心需求。如果实现 Mermaid 渲染会影响流式 Markdown 渲染的正确性或性能，应直接移除此功能。

#### 验收标准

1. IF THE Mermaid_Renderer 导致性能问题或增加渲染复杂度, THEN THE 开发团队 SHALL 完全移除 Mermaid 渲染功能
2. WHERE THE Mermaid_Renderer 被保留, THE Chat_Renderer SHALL 仅在流式完成后渲染 Mermaid 图表，流式阶段显示代码文本
3. WHERE THE Mermaid_Renderer 被保留, IF THE 渲染失败, THEN THE Chat_Renderer SHALL 显示原始代码和错误提示
4. WHERE THE Mermaid_Renderer 被保留, THE Chat_Renderer SHALL 缓存已渲染的图表，避免重复渲染
5. THE Mermaid_Renderer SHALL 不影响核心 Markdown 渲染的正确性和性能

### 需求 6: 分层渲染性能优化（保持现有实现）

**用户故事:** 作为用户，我希望在查看长对话历史时界面保持流畅，以便快速浏览和定位内容。

#### 验收标准

1. THE Layer_System SHALL 继续将消息分为三层：Active（最近 5 轮）、Preview（中间 10 轮）、Archive（更早轮次）
2. WHEN THE Message_Round 位于 Active 层, THE Chat_Renderer SHALL 渲染完整的 Markdown 内容
3. WHEN THE Message_Round 位于 Preview 层, THE Chat_Renderer SHALL 渲染简化的 Markdown（使用 PreviewTextContent 组件）
4. WHEN THE Message_Round 位于 Archive 层, THE Chat_Renderer SHALL 仅显示消息摘要（前 200 字符）
5. WHEN THE 用户滚动到 Archive 层消息, THE Chat_Renderer SHALL 在 100ms 内将该消息提升为 Preview 层渲染

### 需求 7: 工具调用块折叠优化（保持现有实现）

**用户故事:** 作为用户，我希望大量工具调用能自动折叠，以便专注于重要内容而不被细节淹没。

#### 验收标准

1. WHEN THE Content_Block 序列包含超过 5 个连续的 Tool_Call_Block, THE Chat_Renderer SHALL 自动折叠超出前 4 个的工具调用块
2. WHEN THE 用户点击"展开全部"按钮, THE Chat_Renderer SHALL 在 50ms 内展开所有折叠的 Tool_Call_Block
3. THE Chat_Renderer SHALL 为折叠的工具调用块显示摘要信息（工具名称、状态、耗时）
4. WHEN THE Tool_Call_Block 状态为 failed, THE Chat_Renderer SHALL 始终显示该块而不折叠
5. THE Chat_Renderer SHALL 记忆用户的展开/折叠状态，刷新页面后保持

### 需求 8: 虚拟滚动性能优化（保持现有实现）

**用户故事:** 作为用户，我希望在包含数百条消息的对话中滚动时界面保持流畅，以便快速浏览历史记录。

#### 验收标准

1. THE Virtual_Scroller SHALL 继续仅渲染可见区域上下各 2 屏的消息内容
2. WHEN THE 用户快速滚动, THE Virtual_Scroller SHALL 在 16ms 内完成一帧渲染（保持 60fps）
3. THE Virtual_Scroller SHALL 缓存已渲染消息的高度，避免重复计算
4. WHEN THE Streaming_Message 导致消息高度变化, THE Virtual_Scroller SHALL 平滑调整滚动位置
5. THE Virtual_Scroller SHALL 在流式输出时自动滚动到底部，除非用户主动向上滚动

### 需求 9: Markdown 解析器和美化打印器（核心需求）

**用户故事:** 作为开发者，我需要可靠的 Markdown 解析和格式化能力，以便支持流式渲染和往返转换测试。

**说明:** 这是实现正确流式 Markdown 渲染的基础。解析器必须能够处理不完整的 Markdown 语法，美化打印器用于测试和验证。

#### 验收标准

1. THE Markdown_Parser SHALL 解析标准 Markdown 语法（标题、列表、代码块、链接、图片、表格）
2. THE Markdown_Parser SHALL 解析 GFM 扩展语法（删除线、任务列表、自动链接）
3. THE Markdown_Parser SHALL 能够处理不完整的 Markdown 语法（如未闭合的代码块），返回部分解析结果而不是失败
4. THE Pretty_Printer SHALL 将解析后的 AST 格式化为标准 Markdown 文本
5. FOR ALL 有效的完整 Markdown 文本, 执行 parse → print → parse 应产生等价的 AST（往返属性）

## 未来工作（可选需求）

以下需求为可选的性能优化和高级功能，在核心流式渲染修复完成后可以考虑实现：

### 可选需求 1: 消息搜索性能优化

**用户故事:** 作为用户，我希望能快速搜索对话历史，以便找到特定信息。

#### 验收标准

1. WHEN THE 用户输入搜索关键词, THE Chat_Renderer SHALL 在 100ms 内返回搜索结果
2. THE Chat_Renderer SHALL 使用 Web Worker 在后台线程执行全文搜索
3. WHEN THE 搜索结果超过 100 条, THE Chat_Renderer SHALL 仅显示前 100 条并提示总数
4. THE Chat_Renderer SHALL 高亮显示搜索关键词，每个关键词使用不同颜色
5. WHEN THE 用户点击搜索结果, THE Virtual_Scroller SHALL 在 200ms 内滚动到目标消息并高亮显示

### 可选需求 2: Markdown 解析器性能优化

**用户故事:** 作为开发者，我希望 Markdown 解析器能高效处理长文本，以便避免正则表达式性能瓶颈。

#### 验收标准

1. THE Markdown_Parser SHALL 使用增量解析算法，仅解析新增内容
2. THE Markdown_Parser SHALL 缓存已解析的 Markdown 内容，相同内容不重复解析
3. WHEN THE Markdown_Parser 处理超过 5000 字符的文本, THE Markdown_Parser SHALL 分块解析（每块 2000 字符）
4. THE Markdown_Parser SHALL 避免使用回溯正则表达式（如 `.*` 和嵌套量词）
5. THE Markdown_Parser SHALL 在解析时间超过 100ms 时降级为纯文本显示

### 可选需求 3: 内存管理优化

**用户故事:** 作为用户，我希望长时间使用应用时内存占用保持稳定，以便避免浏览器卡顿或崩溃。

#### 验收标准

1. THE Chat_Renderer SHALL 在消息数量超过 100 条时自动归档早期消息
2. THE Chat_Renderer SHALL 释放 Archive 层消息的 DOM 节点，仅保留数据
3. WHEN THE 用户滚动到归档消息, THE Chat_Renderer SHALL 按需重建 DOM 节点
4. THE Chat_Renderer SHALL 限制 Markdown 缓存大小为 50MB，超出时清理最旧的缓存
5. THE Chat_Renderer SHALL 在会话切换时清理未使用的 Mermaid 图表缓存

### 可选需求 4: 多窗口模式性能优化

**用户故事:** 作为用户，我希望在多窗口模式下每个窗口都能流畅渲染，以便同时查看多个对话。

#### 验收标准

1. WHEN THE 用户打开多个会话窗口, THE Chat_Renderer SHALL 为每个窗口独立管理渲染状态
2. THE Chat_Renderer SHALL 限制同时渲染的窗口数量为 3 个，其他窗口暂停渲染
3. WHEN THE 窗口失去焦点, THE Chat_Renderer SHALL 降低该窗口的渲染优先级
4. THE Chat_Renderer SHALL 共享 Markdown 和 Mermaid 缓存，避免重复解析
5. WHEN THE 系统内存使用超过 80%, THE Chat_Renderer SHALL 自动关闭非活跃窗口的渲染

### 可选需求 5: 性能监控和降级

**用户故事:** 作为开发者，我希望系统能自动检测性能问题并降级渲染，以便在低性能设备上保持可用性。

#### 验收标准

1. THE Chat_Renderer SHALL 监控每帧渲染时间，连续 10 帧超过 16ms 时触发性能警告
2. WHEN THE 性能警告触发, THE Chat_Renderer SHALL 自动禁用 Mermaid 实时渲染
3. WHEN THE 性能警告持续 30 秒, THE Chat_Renderer SHALL 降级为纯文本模式
4. THE Chat_Renderer SHALL 在控制台输出性能指标（渲染时间、内存占用、缓存命中率）
5. THE Chat_Renderer SHALL 提供性能配置选项，允许用户手动调整渲染质量

