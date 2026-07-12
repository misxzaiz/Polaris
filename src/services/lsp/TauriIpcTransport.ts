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

import { listen as transportListen } from '@/services/transport';
import { lspStart, lspSend, lspStop } from '../tauri/lspService';
import { createLogger } from '@/utils/logger';

const log = createLogger('LspTransport');

type UnlistenFn = () => void;

export class TauriIpcTransport {
  private handlers: ((value: string) => void)[] = [];
  private unlistenData: UnlistenFn | null = null;
  private unlistenExit: UnlistenFn | null = null;
  readonly serverId: string;
  /** 进程退出回调（崩溃感知）：由 lspStore 注入，用于把状态翻成 error */
  private onExit: ((reason: string) => void) | null = null;

  constructor(serverId: string, onExit?: (reason: string) => void) {
    this.serverId = serverId;
    this.onExit = onExit ?? null;
  }

  /** 启动语言服务器并建立消息通道 */
  async connect(command: string, args: string[]): Promise<void> {
    // 1. 通知 Rust 后端启动 LS 进程
    await lspStart(this.serverId, command, args);
    log.debug('LSP server started', { serverId: this.serverId, command });

    // 2. 监听 Rust 转发的 stdout 数据（完整 JSON-RPC 消息）
    this.unlistenData = await transportListen<string>(
      `lsp-data-${this.serverId}`,
      (data) => {
        for (const handler of this.handlers) {
          handler(data);
        }
      },
    );

    // 3. 监听进程退出事件 — 通知 lspStore 标记 error 并清理 client
    this.unlistenExit = await transportListen<string>(
      `lsp-exit-${this.serverId}`,
      (reason) => {
        log.warn('LSP server process exited', { serverId: this.serverId, reason });
        this.onExit?.(typeof reason === 'string' ? reason : 'process exited');
      },
    );
  }

  /** Transport.send — LSPClient 调用此方法发送 JSON-RPC 消息 */
  send(message: string): void {
    lspSend(this.serverId, message).catch((err) => {
      log.error('Failed to send LSP message', undefined, { serverId: this.serverId, error: String(err) });
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
      log.error('Failed to stop LSP server', undefined, { serverId: this.serverId, error: String(err) });
    }
  }
}
