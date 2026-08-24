/**
 * 聊天组件导出
 *
 * 子目录分组：
 * - input/      — 输入相关
 * - messages/   — 消息列表与渲染
 * - session/    — 会话管理
 * - compact-handoff/ — 压缩交接
 * - dispatch/   — 任务派发
 * - common/     — Chat 内通用组件
 * - tool-calls/ — 工具调用渲染
 * - search/     — 消息搜索
 * - chatUtils/  — 工具函数
 * - chatBlocks/ — 渲染块
 * - chatBubbles/— 气泡
 */

export { ChatInput } from './input/ChatInput';
export type { EditMode } from './input/ChatInput';
export { AIPopover } from './common/AIPopover';
export { ChatStatusBar } from './common/ChatStatusBar';
export { ErrorBanner } from './common/ErrorBanner';
export { SessionHistoryPanel } from './session/SessionHistoryPanel';
export { CompactHandoffButton } from './compact-handoff/CompactHandoffButton';
export { CompactHandoffProgress } from './compact-handoff/CompactHandoffProgress';
export { PendingBriefingCard } from './compact-handoff/PendingBriefingCard';

// 分层对话流组件
export { EnhancedChatMessages } from './messages/EnhancedChatMessages';
export { ToolBubble } from './tool-calls/ToolBubble';
export { ToolGroupBubble } from './tool-calls/ToolGroupBubble';

// 多会话窗口组件
export { MultiSessionGrid } from './session/MultiSessionGrid';
export { MultiWindowMenu } from './session/MultiWindowMenu';
export { SessionCell } from './session/SessionCell';
export { NewSessionButton } from './session/NewSessionButton';
export { DispatchCenterButton } from './dispatch/DispatchCenter';

// Fork/PR 关系可视化组件
export { ForkIndicator, ForkTreeLine } from './session/ForkIndicator';
export { SessionTree } from './session/SessionTree';
export { ForkSessionDialog } from './session/ForkSessionDialog';

// 工具调用渲染
export { AgentRunBlockRenderer } from './tool-calls/AgentRunBlockRenderer';
export { PlanModeBlockRenderer } from './tool-calls/PlanModeBlockRenderer';
export { AssaultResultCard } from './tool-calls/AssaultResultCard';
export { PermissionRequestRenderer } from './tool-calls/PermissionRequestRenderer';
export { AskQuestionCard } from './tool-calls/AskQuestionCard';

// 消息渲染
export { renderChatMessage } from './messages/renderChatMessage';
export { SessionMessagesView } from './messages/SessionMessagesView';
export { MessageSearchPanel } from './search/MessageSearchPanel';

// 会话相关
export { SessionConfigSelector } from './session/SessionConfigSelector';
export { SessionPreviewModal } from './session/SessionPreviewModal';
export { ChatNavigator } from './session/ChatNavigator';

// 通用组件
export { ContextMeter } from './common/ContextMeter';
export { ThinkingOrb } from './common/ThinkingOrb';
export { ScrollToBottomButton } from './common/ScrollToBottomButton';
export { EmptyState } from './common/EmptyState';
export { MermaidDiagram } from './common/MermaidDiagram';

// 压缩交接
export { CompactHandoffModal } from './compact-handoff/CompactHandoffModal';