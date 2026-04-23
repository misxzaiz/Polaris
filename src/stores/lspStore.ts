/**
 * LSP 状态管理 Store
 *
 * 管理语言服务器配置、活跃的 LSP 客户端实例、连接状态。
 * Per-language 单例：同一语言只创建一个 LSP 客户端，多文件共享。
 */

import { create } from 'zustand';
import { LSPClient, languageServerExtensions } from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import { TauriIpcTransport } from '../services/lsp/TauriIpcTransport';
import { createLogger } from '../utils/logger';

const log = createLogger('LspStore');

/** 语言服务器配置 */
export interface LspServerConfig {
  /** 服务器唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 支持的语言 ID 列表 */
  languages: string[];
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args: string[];
}

/** 活跃的 LSP 客户端实例 */
interface ActiveClient {
  client: LSPClient;
  transport: TauriIpcTransport;
}

/** LSP Store 状态 */
interface LspState {
  /** 已配置的语言服务器 */
  servers: LspServerConfig[];
  /** 活跃的 LSP 客户端（key = serverId） */
  clients: Map<string, ActiveClient>;
  /** 连接状态（key = serverId） */
  status: Map<string, LspConnectionStatus>;
}

type LspConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** LSP Store 操作 */
interface LspActions {
  /** 为指定文件激活 LSP（如已有同语言 client 则复用） */
  activateForFile(
    filePath: string,
    language: string,
    rootUri: string,
  ): Promise<{ client: LSPClient; extensions: Extension[] } | null>;

  /** 断开指定服务器的连接 */
  deactivateServer(serverId: string): Promise<void>;

  /** 断开所有连接 */
  deactivateAll(): Promise<void>;

  /** 添加语言服务器配置 */
  addServer(config: LspServerConfig): void;

  /** 移除语言服务器配置 */
  removeServer(id: string): void;

  /** 获取指定服务器对应语言的 CM6 extensions */
  getExtensionsForFile(filePath: string, language: string): Extension[];
}

export type LspStore = LspState & LspActions;

/** 查找支持指定语言的服务器配置 */
function findServerForLanguage(
  servers: LspServerConfig[],
  language: string,
): LspServerConfig | null {
  return servers.find((s) => s.languages.includes(language)) ?? null;
}

/** 将文件路径转为 LSP URI 格式 */
function pathToUri(filePath: string): string {
  // Windows: D:\path\to\file.ts → file:///D:/path/to/file.ts
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}

export const useLspStore = create<LspStore>()((set, get) => ({
  // --- 状态 ---
  servers: [],
  clients: new Map(),
  status: new Map(),

  // --- 操作 ---

  activateForFile: async (filePath, language, rootUri) => {
    const { servers, clients } = get();
    const serverConfig = findServerForLanguage(servers, language);
    if (!serverConfig) return null;

    // 复用已有 client
    const existing = clients.get(serverConfig.id);
    if (existing) {
      log.debug('Reusing existing LSP client', { serverId: serverConfig.id });
      const extensions = getExtensionsForClient(existing.client, filePath);
      return { client: existing.client, extensions };
    }

    // 创建新 client
    set((state) => {
      const newStatus = new Map(state.status);
      newStatus.set(serverConfig.id, 'connecting');
      return { status: newStatus };
    });

    try {
      const serverId = serverConfig.id;
      const transport = new TauriIpcTransport(serverId);
      await transport.connect(serverConfig.command, serverConfig.args);

      const client = new LSPClient({
        rootUri,
        timeout: 5000,
      }).connect(transport);

      // 等待初始化完成（LSPClient 自动处理 initialize handshake）
      await client.initializing;

      const newClients = new Map(get().clients);
      newClients.set(serverId, { client, transport });

      const newStatus = new Map(get().status);
      newStatus.set(serverId, 'connected');

      set({ clients: newClients, status: newStatus });

      log.debug('LSP client connected', {
        serverId,
        language,
        capabilities: !!client.serverCapabilities,
      });

      const extensions = getExtensionsForClient(client, filePath);
      return { client, extensions };
    } catch (err) {
      log.error('Failed to activate LSP', {
        serverId: serverConfig.id,
        error: String(err),
      });

      const newStatus = new Map(get().status);
      newStatus.set(serverConfig.id, 'error');
      set({ status: newStatus });
      return null;
    }
  },

  deactivateServer: async (serverId) => {
    const { clients } = get();
    const active = clients.get(serverId);
    if (!active) return;

    active.client.disconnect();
    await active.transport.disconnect();

    const newClients = new Map(clients);
    newClients.delete(serverId);
    const newStatus = new Map(get().status);
    newStatus.set(serverId, 'disconnected');

    set({ clients: newClients, status: newStatus });
    log.debug('LSP server deactivated', { serverId });
  },

  deactivateAll: async () => {
    const { clients } = get();
    for (const [id, active] of clients) {
      active.client.disconnect();
      await active.transport.disconnect();
      log.debug('LSP server deactivated', { serverId: id });
    }
    const newStatus = new Map(get().status);
    for (const id of clients.keys()) {
      newStatus.set(id, 'disconnected');
    }
    set({ clients: new Map(), status: newStatus });
  },

  addServer: (config) => {
    set((state) => {
      const filtered = state.servers.filter((s) => s.id !== config.id);
      return { servers: [...filtered, config] };
    });
  },

  removeServer: (id) => {
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== id),
    }));
    // 同时断开连接
    get().deactivateServer(id);
  },

  getExtensionsForFile: (filePath, language) => {
    const { servers, clients } = get();
    const serverConfig = findServerForLanguage(servers, language);
    if (!serverConfig) return [];

    const active = clients.get(serverConfig.id);
    if (!active) return [];

    return getExtensionsForClient(active.client, filePath);
  },
}));

/** 从 LSPClient 构建完整的 CM6 extensions */
function getExtensionsForClient(client: LSPClient, filePath: string): Extension[] {
  const uri = pathToUri(filePath);
  return [
    ...languageServerExtensions(),
    client.plugin(uri),
  ];
}
