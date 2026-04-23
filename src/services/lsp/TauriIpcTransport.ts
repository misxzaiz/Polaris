/**
 * Tauri IPC Transport — 连接 @codemirror/lsp-client 和 Rust 管道层
 *
 * 实现 @codemirror/lsp-client 的 Transport 接口：
 *   send(message)      → invoke("lsp_send") → Rust → LS stdin
 *   subscribe(handler) ← listen("lsp-data-{id}") ← Rust ← LS stdout
 *
 * LSP 协议（JSON-RPC 帧、请求关联、初始化握手）由 LSPClient 在 JS 端完整处理，
 * Rust 层只做 Content-Length 帧拆装的纯管道转发。
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { lspStart, lspSend, lspStop } from '../tauri/lspService';
import { createLogger } from '../../utils/logger';

const log = createLogger('LspTransport');

export class TauriIpcTransport {
  private handlers: ((value: string) => void)[] = [];
  private unlistenData: UnlistenFn | null = null;
  private unlistenExit: UnlistenFn | null = null;
  readonly serverId: string;

  constructor(serverId: string) {
    this.serverId = serverId;
  }

  /** 启动语言服务器并建立消息通道 */
  async connect(command: string, args: string[]): Promise<void> {
    // 1. 通知 Rust 后端启动 LS 进程
    await lspStart(this.serverId, command, args);
    log.debug('LSP server started', { serverId: this.serverId, command });

    // 2. 监听 Rust 转发的 stdout 数据（完整 JSON-RPC 消息）
    this.unlistenData = await listen<string>(
      `lsp-data-${this.serverId}`,
      (event) => {
        for (const handler of this.handlers) {
          handler(event.payload);
        }
      },
    );

    // 3. 监听进程退出事件
    this.unlistenExit = await listen<string>(
      `lsp-exit-${this.serverId}`,
      () => {
        log.warn('LSP server process exited', { serverId: this.serverId });
      },
    );
  }

  /** Transport.send — LSPClient 调用此方法发送 JSON-RPC 消息 */
  send(message: string): void {
    lspSend(this.serverId, message).catch((err) => {
      log.error('Failed to send LSP message', { serverId: this.serverId, error: String(err) });
    });
  }

  /** Transport.subscribe — 注册消息接收处理器 */
  subscribe(handler: (value: string) => void): void {
    this.handlers.push(handler);
  }

  /** Transport.unsubscribe — 移除消息接收处理器 */
  unsubscribe(handler: (value: string) => void): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  /** 断开连接并停止语言服务器 */
  async disconnect(): Promise<void> {
    if (this.unlistenData) {
      this.unlistenData();
      this.unlistenData = null;
    }
    if (this.unlistenExit) {
      this.unlistenExit();
      this.unlistenExit = null;
    }
    this.handlers = [];
    try {
      await lspStop(this.serverId);
      log.debug('LSP server stopped', { serverId: this.serverId });
    } catch (err) {
      log.error('Failed to stop LSP server', { serverId: this.serverId, error: String(err) });
    }
  }
}
