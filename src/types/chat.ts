/**
 * 聊天相关类型定义
 */

import type { EngineId } from './config';

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
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ArtifactPreviewBlock | MediaPreviewBlock | QuestionBlock | PlanModeBlock | AgentRunBlock | ToolGroupBlock | PermissionRequestBlock;

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

/** Artifact 预览内容块 - 用于 MCP 生成的 HTML/原型预览 */
export interface ArtifactPreviewBlock {
  type: 'artifact_preview';
  /** 预览 ID（由 MCP server 返回） */
  previewId: string;
  /** 展示标题 */
  title: string;
  /** 内容类型，Phase 1 仅支持 HTML */
  contentType: 'html';
  /** 自包含 HTML 源码；用于 Web/Tauri 统一 iframe srcDoc 渲染 */
  html: string;
  /** 后端保存的源文件路径（可选，仅作引用展示） */
  sourcePath?: string;
  /** 预览创建时间（ISO 8601） */
  createdAt?: string;
  /** 同一需求下的递增版本号 */
  version?: number;
  /** 展示版本名，如 v1、v2、方案 A */
  versionLabel?: string;
  /** 关联需求 ID（可选） */
  requirementId?: string;
  /** 预览说明或本版本变更摘要（可选） */
  description?: string;
}

/** 媒体预览内容块 - 用于图片/视频等媒体资源的渲染 */
export interface MediaPreviewBlock {
  type: 'media_preview';
  /** 媒体类型 */
  mediaType: 'image' | 'video';
  /** 媒体 URL（优先使用） */
  url?: string;
  /** Base64 数据（图片时使用） */
  base64?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 模型名称 */
  model?: string;
  /** 尺寸信息 */
  size?: string;
  /** 生成提示词 */
  prompt?: string;
  /** 视频时长（秒） */
  seconds?: string;
  /** 视频 ID（用于轮询状态） */
  videoId?: string;
  /** 任务状态 */
  status?: string;
  /** 进度百分比 */
  progress?: number;
  /** 是否正在等待中 */
  waiting?: boolean;
  /** 错误信息 */
  error?: string;
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

/** 单条子答案（与 QuestionItem 一一对齐） */
export interface SubAnswer {
  /** 选中的选项值（按 label 文本对齐） */
  selected: string[];
  /** 自定义输入 */
  customInput?: string;
  /** 该题是否被单独跳过（部分跳过场景） */
  declined?: boolean;
}

/** 问题答案（兼容字段保留 selected/customInput 以承接旧路径） */
export interface QuestionAnswer {
  /** 多题答案数组（新版） */
  answers?: SubAnswer[];
  /** 是否整体跳过 */
  declined?: boolean;
  /** @deprecated 兼容字段：单题路径下的 selected */
  selected?: string[];
  /** @deprecated 兼容字段：单题路径下的 customInput */
  customInput?: string;
}

/** 单条子问题（同一 MCP call 包含 1-4 个） */
export interface QuestionItem {
  /** 完整问题文本（卡片正文） */
  question: string;
  /** 短标签（≤12 字，类别 chip） */
  header: string;
  /** 是否多选 */
  multiSelect?: boolean;
  /** 选项列表 */
  options: QuestionOption[];
  /** 是否允许自定义输入 */
  allowCustomInput?: boolean;
}

/** 问题内容块 - 用于 AskUserQuestion 工具 */
export interface QuestionBlock {
  type: 'question';
  /** 工具调用 ID（与 tool_call_start 的 callId 对应） */
  id: string;
  /** 后端/路由会话 ID，用于提交答案和 question_answered 事件回路 */
  sessionId?: string;
  /** 同一 call 内的全部问题（新版主字段） */
  questions: QuestionItem[];
  /** 回答状态 */
  status: QuestionStatus;
  /** 每题答案数组（新版） */
  answers?: SubAnswer[];
  /** 是否整体被跳过 */
  declined?: boolean;
  // ===== 兼容字段（旧单题路径） =====
  /** @deprecated 旧字段：问题标题（首题摘要） */
  header?: string;
  /** @deprecated 旧字段：类别标签 */
  categoryLabel?: string;
  /** @deprecated 旧字段：是否多选 */
  multiSelect?: boolean;
  /** @deprecated 旧字段：选项列表 */
  options?: QuestionOption[];
  /** @deprecated 旧字段：是否允许自定义输入 */
  allowCustomInput?: boolean;
  /** @deprecated 旧字段：用户答案（首题摘要） */
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

/**
 * 权限请求状态
 * - pending: 待用户处理（仅在「实时且后端正在等待授权」时有效）
 * - approved/denied: 用户已决策
 * - expired: 已失效（上下文推进 / 历史会话恢复后归一化），不可再交互
 */
export type PermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

/**
 * 授权范围
 * - once: 仅本次（当前回合放行，下次同样操作仍询问）
 * - session: 本会话（会话存活期内不再询问）
 * - global: 全局永久（写入 ~/.claude/settings.json 的 permissions.allow）
 */
export type PermissionScope = 'once' | 'session' | 'global';

/** 权限拒绝详情（内容块内） */
export interface PermissionDenialBlock {
  /** 工具名称 */
  toolName: string;
  /** 拒绝原因 */
  reason: string;
  /** 工具入参（来自后端 flatten 的 tool_input，按工具类型展示文件/命令/内容等） */
  toolInput?: Record<string, unknown>;
  /** 工具调用 ID（来自后端 tool_use_id） */
  toolUseId?: string;
  /** 逐项决策状态（支持单卡内多工具独立批准/拒绝；缺省视为 pending） */
  status?: 'pending' | 'approved' | 'denied';
  /** 该项批准时选择的授权范围 */
  scope?: PermissionScope;
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
  /** 生成此回复的 AI 引擎 */
  engineId?: EngineId;
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

/** 类型守卫：判断是否为 Artifact 预览块 */
export function isArtifactPreviewBlock(block: ContentBlock): block is ArtifactPreviewBlock {
  return block.type === 'artifact_preview';
}

/** 类型守卫：判断是否为媒体预览块 */
export function isMediaPreviewBlock(block: ContentBlock): block is MediaPreviewBlock {
  return block.type === 'media_preview';
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
