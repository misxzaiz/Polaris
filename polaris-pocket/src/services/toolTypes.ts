/**
 * toolTypes — 工具调用相关的类型定义
 *
 * 涵盖消息块结构、工具定义、协议适配器接口、Agent 循环状态。
 *
 * 设计约束（交叉对抗性审查结论）：
 * - content 双形态：旧消息保持 string，新消息支持 Array<MsgBlock>
 * - 工具结果在 API 协议中按 wireApi 不同采用不同 role 格式
 * - tool_use_id 必须稳定（用于结果匹配）
 */

// ============================================================================
// 消息内容块
// ============================================================================

/** 纯文本块 */
export interface TextBlock {
  type: "text";
  text: string;
}

/** 图片块（多模态输入，base64 编码） */
export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

/** 工具调用块（模型发出，前端解析后执行） */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 工具结果块（执行后回送给模型） */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** 消息内容块联合类型 */
export type MsgBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

/** 消息内容：兼容旧 string + 新 Array<MsgBlock> */
export type ContentValue = string | MsgBlock[];

// ============================================================================
// 消息
// ============================================================================

export interface MsgBlockItem {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  content: ContentValue;
  ts: number;
}

// ============================================================================
// 工具定义
// ============================================================================

/** 工具类别：前端浏览器 API / 系统（需 Tauri 后端） */
export type ToolCategory = "frontend" | "system";

/** 工具运行时能力 */
export type ToolCapability = "available" | "unavailable" | "not-probed";

/** 工具定义（注册表条目） */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category: ToolCategory;
  /** 该工具支持的 wireApi；null = 全部支持 */
  wireApis?: ("anthropic-messages" | "openai-chat-completions")[] | null;
  /** 图标（emoji） */
  icon?: string;
  /** 是否允许模型连续多次调用相同参数（默认 false，防死循环） */
  allowRepeat?: boolean;
}

/** 工具处理器（返回结果或错误） */
export type ToolHandler = (input: Record<string, unknown>, signal?: AbortSignal) => Promise<{
  content: string;
  is_error?: boolean;
}>;

/** 运行时可用的工具信息 */
export interface ToolAvailability {
  definition: ToolDefinition;
  capability: ToolCapability;
}

// ============================================================================
// Wire API 协议
// ============================================================================

export type WireApi = "anthropic-messages" | "openai-chat-completions" | "openai-responses";

/**
 * 协议适配器：把内部消息格式转换为特定 wireApi 的 API 请求体
 */
export interface ProtocolAdapter {
  formatTool(tool: ToolDefinition): Record<string, unknown>;
  formatMessages(
    messages: { role: string; content: ContentValue }[]
  ): Record<string, unknown>[];
}

// ============================================================================
// Agent 循环
// ============================================================================

/** 单轮 API 请求结果 */
export interface AgentTurnResult {
  /** 助手消息的纯文本内容（模型说的 + 工具调用说明） */
  text: string;
  /** 工具调用列表 */
  toolCalls: ToolCall[];
}

/** 工具调用（从响应中解析） */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Agent 循环状态 */
export interface AgentLoopState {
  isRunning: boolean;
  turnCount: number;
  currentToolName: string | null;
  currentToolStatus: "idle" | "running" | "success" | "error";
  totalToolResults: ToolResult[];
}

/** 工具执行结果（循环内） */
export interface ToolResult {
  tool_use_id: string;
  toolName: string;
  content: string;
  is_error: boolean;
}

// ============================================================================
// SSE 流解析
// ============================================================================

/** SSE 流解析中间结果 */
export interface StreamParseResult {
  text: string;
  toolCalls: ToolCall[];
  done: boolean;
}

// ============================================================================
// 工具执行卡片 UI 状态
// ============================================================================

export interface ToolCardState {
  id: string;
  name: string;
  icon: string;
  input: Record<string, unknown>;
  status: "running" | "success" | "error";
  result: string | null;
}

/** 工具执行卡片数据（传给 ToolBlockCard） */
export interface ToolCardData {
  id: string;
  name: string;
  icon: string;
  input: Record<string, unknown>;
  status: "running" | "success" | "error";
  result?: string;
  resultIsError?: boolean;
}
