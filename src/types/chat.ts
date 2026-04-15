/**
 * 聊天相关类型定义
 */

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system';

/** 工具调用状态 */
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partial';

/** 工具调用信息 */
export interface ToolCall {
  id: string;
  name: string;
  status: ToolStatus;
  input?: Record<string, unknown>;
  output?: string;
  startedAt: string;
  completedAt?: string;
  /** Diff 相关数据 (用于 Edit 工具) */
  diff?: {
    /** 修改前的文件内容 */
    oldContent?: string;
    /** 修改后的文件内容 */
    newContent?: string;
    /** 文件路径 */
    filePath?: string;
  };
}

/** 聊天消息 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  /** 工具调用摘要（替代完整的 toolCalls） */
  toolSummary?: {
    count: number;
    names: string[];
  };
}

/** 权限拒绝详情 */
export interface PermissionDenial {
  toolName: string;
  reason: string;
  details: Record<string, unknown>;
}

/** 权限请求 */
export interface PermissionRequest {
  id: string;
  sessionId: string;
  denials: PermissionDenial[];
  createdAt: string;
}

/**
 * ========================================
 * 新型消息类型定义 - 分层对话流
 * ========================================
 */

/** 内容块类型 - 用于 Assistant 消息的内容分段 */
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | QuestionBlock | PlanModeBlock | AgentRunBlock | ToolGroupBlock | PermissionRequestBlock;

/** 文本内容块 */
export interface TextBlock {
  type: 'text';
  content: string;
}

/** 思考过程内容块 */
export interface ThinkingBlock {
  type: 'thinking';
  /** 思考内容 */
  content: string;
  /** 是否已折叠 */
  collapsed?: boolean;
}

/** 工具调用内容块 */
export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  output?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  duration?: number;
  /** Diff 数据（用于 Edit 工具显示差异） */
  diffData?: {
    /** 修改前的文件内容（仅被替换的部分） */
    oldContent: string;
    /** 修改后的文件内容（仅被替换的部分） */
    newContent: string;
    /** 文件路径 */
    filePath: string;
    /** AI 修改前的完整文件内容（用于精确撤销） */
    fullOldContent?: string;
  };
}

/** 问题选项 */
export interface QuestionOption {
  /** 选项值 */
  value: string;
  /** 显示文本（可选，默认使用 value） */
  label?: string;
  /** 选项描述（可选） */
  description?: string;
  /** 预览文本（可选，展示示例） */
  preview?: string;
}

/** 问题回答状态 */
export type QuestionStatus = 'pending' | 'answered';

/** 问题答案 */
export interface QuestionAnswer {
  /** 选中的选项值列表 */
  selected: string[];
  /** 自定义输入内容 */
  customInput?: string;
}

/** 问题内容块 - 用于 AskUserQuestion 工具 */
export interface QuestionBlock {
  type: 'question';
  /** 工具调用 ID（与 tool_call_start 的 callId 对应） */
  id: string;
  /** 问题标题 */
  header: string;
  /** 类别标签（可选，如 "类别"、"类型" 等） */
  categoryLabel?: string;
  /** 是否多选 */
  multiSelect?: boolean;
  /** 选项列表 */
  options: QuestionOption[];
  /** 是否允许自定义输入 */
  allowCustomInput?: boolean;
  /** 回答状态 */
  status: QuestionStatus;
  /** 用户答案 */
  answer?: QuestionAnswer;
}

/** ========================================
 * PlanMode 相关类型
 * ======================================== */

/** PlanMode 状态 */
export type PlanModeStatus = 
  | 'drafting'         // 正在起草计划
  | 'pending_approval' // 等待审批
  | 'approved'         // 已批准
  | 'rejected'         // 已拒绝
  | 'executing'        // 正在执行
  | 'completed'        // 已完成
  | 'canceled';        // 已取消

/** 计划任务（内容块内） */
export interface PlanTaskBlock {
  /** 任务 ID */
  taskId: string;
  /** 任务描述 */
  description: string;
  /** 任务状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
}

/** 计划阶段（内容块内） */
export interface PlanStageBlock {
  /** 阶段 ID */
  stageId: string;
  /** 阶段名称 */
  name: string;
  /** 阶段描述 */
  description?: string;
  /** 阶段状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** 阶段内的任务列表 */
  tasks: PlanTaskBlock[];
  /** 是否折叠 */
  collapsed?: boolean;
}

/** PlanMode 内容块 - 用于计划模式 */
export interface PlanModeBlock {
  type: 'plan_mode';
  /** 计划 ID */
  id: string;
  /** 会话 ID */
  sessionId: string;
  /** 计划标题 */
  title?: string;
  /** 计划描述 */
  description?: string;
  /** 阶段列表 */
  stages: PlanStageBlock[];
  /** 当前计划状态 */
  status: PlanModeStatus;
  /** 修改建议（拒绝时的反馈） */
  feedback?: string;
  /** 是否激活（正在编辑/审批中） */
  isActive?: boolean;
}

/** ========================================
 * AgentRun 相关类型
 * ======================================== */

/** Agent 运行状态 */
export type AgentRunStatus = 
  | 'pending'    // 等待开始
  | 'running'    // 运行中
  | 'success'    // 成功完成
  | 'error'      // 出错
  | 'canceled';  // 已取消

/** 嵌套工具调用（AgentRun 内部） */
export interface AgentNestedToolCall {
  /** 工具调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** 简短描述 */
  summary?: string;
}

/** Agent 运行内容块 - 用于 Agent 任务聚合展示 */
export interface AgentRunBlock {
  type: 'agent_run';
  /** 任务 ID */
  id: string;
  /** Agent 类型/名称 */
  agentType: string;
  /** Agent 能力描述 */
  capabilities?: string[];
  /** 运行状态 */
  status: AgentRunStatus;
  /** 进度消息 */
  progressMessage?: string;
  /** 进度百分比 0-100 */
  progressPercent?: number;
  /** 输出内容（流式） */
  output?: string;
  /** 嵌套的工具调用列表 */
  toolCalls: AgentNestedToolCall[];
  /** 执行时长（毫秒） */
  duration?: number;
  /** 错误信息 */
  error?: string;
  /** 开始时间 */
  startedAt: string;
  /** 完成时间 */
  completedAt?: string;
}

/** ========================================
 * ToolGroup 相关类型
 * ======================================== */

/** 工具组状态 */
export type ToolGroupStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed';

/** 工具组内的单个工具信息 */
export interface ToolGroupItem {
  /** 工具调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** 简短描述 */
  summary?: string;
  /** 工具输入（用于详情展示） */
  input?: Record<string, unknown>;
  /** 工具输出 */
  output?: string;
  /** 开始时间 */
  startedAt: string;
  /** 完成时间 */
  completedAt?: string;
  /** 执行时长（毫秒） */
  duration?: number;
}

/** 工具组内容块 - 用于多个工具调用的聚合展示 */
export interface ToolGroupBlock {
  type: 'tool_group';
  /** 工具组 ID */
  id: string;
  /** 包含的工具列表 */
  tools: ToolGroupItem[];
  /** 工具名称列表（用于快速统计） */
  toolNames: string[];
  /** 工具组整体状态 */
  status: ToolGroupStatus;
  /** 智能摘要 */
  summary: string;
  /** 开始时间 */
  startedAt: string;
  /** 完成时间 */
  completedAt?: string;
  /** 执行时长（毫秒） */
  duration?: number;
  /** 是否折叠 */
  collapsed?: boolean;
}

/** ========================================
 * PermissionRequest 相关类型
 * ======================================== */

/** 权限请求状态 */
export type PermissionRequestStatus = 'pending' | 'approved' | 'denied';

/** 权限拒绝详情（内容块内） */
export interface PermissionDenialBlock {
  /** 工具名称 */
  toolName: string;
  /** 拒绝原因 */
  reason: string;
  /** 额外信息 */
  extra?: Record<string, unknown>;
}

/** 权限请求内容块 - 用于工具调用被拒绝时的确认界面 */
export interface PermissionRequestBlock {
  type: 'permission_request';
  /** 请求 ID */
  id: string;
  /** 会话 ID */
  sessionId: string;
  /** 拒绝详情列表 */
  denials: PermissionDenialBlock[];
  /** 当前状态 */
  status: PermissionRequestStatus;
  /** 用户决策（批准/拒绝后的额外信息） */
  decision?: {
    /** 是否批准 */
    approved: boolean;
    /** 时间戳 */
    timestamp: string;
  };
}

/** 聊天消息类型标识符 */
export type ChatMessageType = 'user' | 'assistant' | 'system' | 'tool' | 'tool_group';

/** 基础消息字段 */
interface BaseChatMessage {
  id: string;
  timestamp: string;
}

/** 用户消息 */
export interface UserChatMessage extends BaseChatMessage {
  type: 'user';
  content: string;
  /** 附件列表（用于显示） */
  attachments?: Array<{
    id: string;
    type: 'image' | 'file';
    fileName: string;
    fileSize: number;
    mimeType: string;
  }>;
}

/** 助手消息 - 使用内容块数组 */
export interface AssistantChatMessage extends BaseChatMessage {
  type: 'assistant';
  /** 内容块数组 - 实现工具穿插在文本中间 */
  blocks: ContentBlock[];
  /** 是否正在流式输出 */
  isStreaming?: boolean;
  /** 兼容字段：完整文本内容（由 blocks 合成） */
  content?: string;
  /** 工具调用摘要（用于历史恢复和导出） */
  toolSummary?: {
    count: number;
    names: string[];
  };
}

/** 系统消息 */
export interface SystemChatMessage extends BaseChatMessage {
  type: 'system';
  content: string;
}

/** 工具消息 - 单个工具调用的独立消息 */
export interface ToolChatMessage {
  id: string;
  type: 'tool';
  timestamp: string;
  /** 工具唯一标识 */
  toolId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具状态 */
  status: ToolStatus;
  /** 智能摘要（单行描述） */
  summary: string;
  /** 工具输入参数 */
  input?: Record<string, unknown>;
  /** 工具输出结果 */
  output?: string;
  /** 关联的助手消息 ID */
  relatedMessageId?: string;
  /** 开始时间 */
  startedAt: string;
  /** 完成时间 */
  completedAt?: string;
  /** 执行时长（毫秒） */
  duration?: number;
  /** 错误信息 */
  error?: string;
}

/** 工具组消息 - 多个工具调用的聚合展示 */
export interface ToolGroupChatMessage {
  id: string;
  type: 'tool_group';
  timestamp: string;
  /** 包含的工具 ID 列表 */
  toolIds: string[];
  /** 包含的工具名称列表 */
  toolNames: string[];
  /** 工具组状态 */
  status: ToolStatus;
  /** 智能摘要 */
  summary: string;
  /** 开始时间 */
  startedAt: string;
  /** 完成时间 */
  completedAt?: string;
  /** 执行时长（毫秒） */
  duration?: number;
}

/** 联合聊天消息类型 */
export type ChatMessage =
  | UserChatMessage
  | AssistantChatMessage
  | SystemChatMessage
  | ToolChatMessage
  | ToolGroupChatMessage;

/** 类型守卫：判断是否为工具消息 */
export function isToolMessage(message: ChatMessage): message is ToolChatMessage {
  return message.type === 'tool';
}

/** 类型守卫：判断是否为工具组消息 */
export function isToolGroupMessage(message: ChatMessage): message is ToolGroupChatMessage {
  return message.type === 'tool_group';
}

/** 类型守卫：判断是否为助手消息 */
export function isAssistantMessage(message: ChatMessage): message is AssistantChatMessage {
  return message.type === 'assistant';
}

/** 类型守卫：判断是否为用户消息 */
export function isUserMessage(message: ChatMessage): message is UserChatMessage {
  return message.type === 'user';
}

/** 类型守卫：判断是否为系统消息 */
export function isSystemMessage(message: ChatMessage): message is SystemChatMessage {
  return message.type === 'system';
}

/** 类型守卫：判断是否为文本块 */
export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

/** 类型守卫：判断是否为思考块 */
export function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

/** 类型守卫：判断是否为工具调用块 */
export function isToolCallBlock(block: ContentBlock): block is ToolCallBlock {
  return block.type === 'tool_call';
}

/** 类型守卫：判断是否为问题块 */
export function isQuestionBlock(block: ContentBlock): block is QuestionBlock {
  return block.type === 'question';
}

/** 类型守卫：判断是否为计划模式块 */
export function isPlanModeBlock(block: ContentBlock): block is PlanModeBlock {
  return block.type === 'plan_mode';
}

/** 类型守卫：判断是否为 Agent 运行块 */
export function isAgentRunBlock(block: ContentBlock): block is AgentRunBlock {
  return block.type === 'agent_run';
}

/** 类型守卫：判断是否为工具组块 */
export function isToolGroupBlock(block: ContentBlock): block is ToolGroupBlock {
  return block.type === 'tool_group';
}

/** 类型守卫：判断是否为权限请求块 */
export function isPermissionRequestBlock(block: ContentBlock): block is PermissionRequestBlock {
  return block.type === 'permission_request';
}
