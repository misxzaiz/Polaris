/** Sky 前端类型 — 对齐后端 WS 事件与 dispatch reply 契约 */

/** 后端 WS 事件(经 EventBus 推送) */
export interface SkyEvent {
  type: string;
  stream_id?: string;
  data?: unknown;
  trace?: string;
  ts: number;
}

/** WS 推送的消息信封 */
export interface WsMessage {
  type: 'event' | 'reply' | 'error' | 'pong';
  reqId?: string;
  event?: SkyEvent;
  reply?: { ok: boolean; data?: unknown; error?: string };
  error?: string;
}

/** 对话流中的块类型 */
export type BlockKind = 'user' | 'assistant' | 'form' | 'system';
export type BlockStatus = 'streaming' | 'done' | 'pending' | 'answered' | 'skipped';

export interface FormField {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'textarea' | 'select' | 'secret' | string;
  options?: string[];
  label?: string;
  hidden?: boolean;
  secret?: boolean;
}

export interface FormHold {
  formId: string;
  title?: string;
  target?: string;
  action?: string;
  read?: 'full' | 'none' | string;
  mode?: 'dispatch' | 'collect';
  fields: FormField[];
  style?: Record<string, unknown>;
}

/** 浮窗(ui.window 事件) */
export interface WindowState {
  id: string;
  title: string;
  html: string;
  css: string;
  js: string;
  width?: number;
  height?: number;
}

/** 流式 AI 消息的累积态 */
export interface StreamState {
  streamId: string;
  text: string;
  reasoning: string;
  toolCalls: Array<{ name: string; args?: unknown; result?: unknown }>;
  done: boolean;
  aborted: boolean;
  error?: string;
}
