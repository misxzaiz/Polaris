/**
 * Transport 抽象层 — 统一 Tauri IPC 与 HTTP/WS 两种通信方式
 *
 * 桌面端通过 Tauri IPC invoke/listen，Web 端通过 HTTP fetch + WebSocket。
 * 所有 service 层代码只依赖此接口，无需关心底层传输。
 */

/** 通用传输适配器接口 */
export interface TransportAdapter {
  /** 调用命令（对应 Tauri invoke 或 HTTP POST） */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;

  /** 监听事件（对应 Tauri listen 或 WebSocket 消息） */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;

  /** 断开连接（仅 HTTP transport 需要，用于干净关闭 WebSocket） */
  disconnect?(): void;
}

/** 传输模式 */
export type TransportMode = 'tauri' | 'http';
