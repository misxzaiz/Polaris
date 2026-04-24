/**
 * LSP 状态管理 Store
 *
 * 管理语言服务器配置、活跃的 LSP 客户端实例、连接状态。
 * Per-language 单例：同一语言只创建一个 LSP 客户端，多文件共享。
 */

import { create } from 'zustand';
import {
  LSPClient,
  jumpToDefinition,
  languageServerSupport,
  serverDiagnostics,
} from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { TauriIpcTransport } from '../services/lsp/TauriIpcTransport';
import { lspConfigList } from '../services/tauri/lspService';
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
  /** 是否启用 */
  enabled: boolean;
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
  /** 进行中的连接 Promise（防止并发重复创建） */
  pendingConnections: Map<string, Promise<{ client: LSPClient; extensions: Extension[] } | null>>;
}

export type LspConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

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

  /** 切换服务器启用/禁用 */
  toggleServer(id: string): void;

  /** 更新服务器配置 */
  updateServer(id: string, patch: Partial<Omit<LspServerConfig, 'id'>>): void;

  /** 获取指定服务器对应语言的 CM6 extensions */
  getExtensionsForFile(filePath: string, language: string): Extension[];

  /** 从后端加载配置（初始化时调用一次） */
  loadFromBackend(): Promise<void>;
}

export type LspStore = LspState & LspActions;

/** 查找支持指定语言的已启用服务器配置 */
function findServerForLanguage(
  servers: LspServerConfig[],
  language: string,
): LspServerConfig | null {
  return servers.find((s) => s.enabled && s.languages.includes(language)) ?? null;
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

/** 内置语言服务器配置 */
const DEFAULT_SERVERS: LspServerConfig[] = [
  {
    id: 'typescript-language-server',
    name: 'TypeScript Language Server',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    enabled: true,
  },
];

export const useLspStore = create<LspStore>()((set, get) => ({
  // --- 状态 ---
  servers: [...DEFAULT_SERVERS],
  clients: new Map(),
  status: new Map(),
  pendingConnections: new Map(),

  // --- 操作 ---

  activateForFile: async (filePath, language, rootUri) => {
    const { servers, clients, pendingConnections } = get();
    const serverConfig = findServerForLanguage(servers, language);
    if (!serverConfig) return null;

    // 复用已有 client
    const existing = clients.get(serverConfig.id);
    if (existing) {
      log.debug('Reusing existing LSP client', { serverId: serverConfig.id });
      const extensions = getExtensionsForClient(existing.client, filePath, language);
      return { client: existing.client, extensions };
    }

    // 复用进行中的连接 Promise（防止竞态重复创建）
    const pending = pendingConnections.get(serverConfig.id);
    if (pending) {
      log.debug('Waiting for pending LSP connection', { serverId: serverConfig.id });
      const result = await pending;
      if (result) {
        const extensions = getExtensionsForClient(result.client, filePath, language);
        return { client: result.client, extensions };
      }
      return null;
    }

    // 创建新 client（用 Promise 包裹防止竞态）
    const connectionPromise = (async () => {
      set((state) => {
        const newStatus = new Map(state.status);
        newStatus.set(serverConfig.id, 'connecting');
        return { status: newStatus };
      });

      try {
        const serverId = serverConfig.id;
        const transport = new TauriIpcTransport(serverId);
        await transport.connect(serverConfig.command, serverConfig.args);

        // 只把 LSPClientExtension 配置对象放在 client 层级：
        // - serverDiagnostics() 负责接收 textDocument/publishDiagnostics 推送，
        //   必须在 client 级注册。
        // 不要在这里再加 serverCompletion / hoverTooltips / signatureHelp 等
        // 编辑器侧扩展——languageServerSupport(...) 已经包含它们，重复注册
        // 会导致悬浮提示、补全、签名帮助等出现重复显示。
        const client = new LSPClient({
          rootUri,
          timeout: 5000,
          extensions: [serverDiagnostics()],
        }).connect(transport);

        // 等待初始化完成（LSPClient 自动处理 initialize handshake）
        await client.initializing;

        set((state) => {
          // 检查是否在连接过程中被 deactivate
          if (!state.pendingConnections.has(serverId)) return {};
          const newClients = new Map(state.clients);
          newClients.set(serverId, { client, transport });
          const newStatus = new Map(state.status);
          newStatus.set(serverId, 'connected');
          const newPending = new Map(state.pendingConnections);
          newPending.delete(serverId);
          return { clients: newClients, status: newStatus, pendingConnections: newPending };
        });

        log.debug('LSP client connected', {
          serverId,
          language,
          capabilities: !!client.serverCapabilities,
        });

        // 连接过程中被 deactivate 时返回 null
        if (!get().clients.has(serverId)) return null;

        const extensions = getExtensionsForClient(client, filePath, language);
        return { client, extensions };
      } catch (err) {
        log.error('Failed to activate LSP', undefined, {
          serverId: serverConfig.id,
          error: String(err),
        });

        set((state) => {
          const newStatus = new Map(state.status);
          newStatus.set(serverConfig.id, 'error');
          const newPending = new Map(state.pendingConnections);
          newPending.delete(serverConfig.id);
          return { status: newStatus, pendingConnections: newPending };
        });
        return null;
      }
    })();

    // 注册 pending Promise 供并发调用复用
    set((state) => {
      const newPending = new Map(state.pendingConnections);
      newPending.set(serverConfig.id, connectionPromise);
      return { pendingConnections: newPending };
    });

    return connectionPromise;
  },

  deactivateServer: async (serverId) => {
    const { clients } = get();
    const active = clients.get(serverId);
    if (active) {
      active.client.disconnect();
      await active.transport.disconnect();
    }

    set((state) => {
      const newClients = new Map(state.clients);
      newClients.delete(serverId);
      const newStatus = new Map(state.status);
      newStatus.set(serverId, 'disconnected');
      const newPending = new Map(state.pendingConnections);
      newPending.delete(serverId);
      return { clients: newClients, status: newStatus, pendingConnections: newPending };
    });
    log.debug('LSP server deactivated', { serverId });
  },

  deactivateAll: async () => {
    const { clients } = get();
    for (const [id, active] of clients) {
      active.client.disconnect();
      await active.transport.disconnect();
      log.debug('LSP server deactivated', { serverId: id });
    }
    set((state) => {
      const newStatus = new Map(state.status);
      for (const id of clients.keys()) {
        newStatus.set(id, 'disconnected');
      }
      return { clients: new Map(), status: newStatus, pendingConnections: new Map() };
    });
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

  toggleServer: (id) => {
    const { servers } = get();
    const server = servers.find((s) => s.id === id);
    if (!server) return;

    const newEnabled = !server.enabled;
    set((state) => ({
      servers: state.servers.map((s) =>
        s.id === id ? { ...s, enabled: newEnabled } : s,
      ),
    }));

    // 禁用时断开连接
    if (!newEnabled) {
      get().deactivateServer(id);
    }
  },

  updateServer: (id, patch) => {
    set((state) => ({
      servers: state.servers.map((s) =>
        s.id === id ? { ...s, ...patch } : s,
      ),
    }));
  },

  getExtensionsForFile: (filePath, language) => {
    const { servers, clients } = get();
    const serverConfig = findServerForLanguage(servers, language);
    if (!serverConfig) return [];

    const active = clients.get(serverConfig.id);
    if (!active) return [];

    return getExtensionsForClient(active.client, filePath, language);
  },

  loadFromBackend: async () => {
    try {
      const config = await lspConfigList();
      if (config.length > 0) {
        // 后端有配置，以后端为准（保留运行时连接状态不变）
        set({ servers: config });
        log.debug('Loaded LSP config from backend', { count: config.length });
      } else {
        // 首次使用：DEFAULT_SERVERS 作为种子写入后端
        const defaults = [...DEFAULT_SERVERS];
        set({ servers: defaults });
        log.debug('Initialized LSP config with defaults');
      }
    } catch (err) {
      log.error('Failed to load LSP config from backend, using defaults', undefined, { error: String(err) });
      // 降级：使用默认配置
      set({ servers: [...DEFAULT_SERVERS] });
    }
  },
}));

/**
 * 从 LSPClient 构建给编辑器用的 CM6 extensions。
 *
 * 关键：`languageServerExtensions()` 返回的数组里混有 LSPClientExtension 配置
 * 对象（如 `{ clientCapabilities }`），它们不是 CodeMirror Extension，塞进
 * EditorState 会抛 "Unrecognized extension value"。应把它们传给 LSPClient
 * 构造函数；这里只用 `languageServerSupport` 来获取真正的编辑器扩展（包含
 * plugin、诊断、补全、hover、keymap 等）。
 */
function getExtensionsForClient(
  client: LSPClient,
  filePath: string,
  languageID?: string,
): Extension[] {
  const uri = pathToUri(filePath);
  return [
    languageServerSupport(client, uri, languageID),
    ctrlClickJumpToDefinition,
    ctrlHoverTheme,
  ];
}

/**
 * Ctrl/Cmd + 左键 跳转到定义。
 *
 * CodeMirror LSP 客户端默认只给了 F12 键位；这里加一个鼠标事件处理器：
 * 按住 Ctrl（macOS 下 Cmd）点击某个符号，先把光标移到点击位置，再触发
 * `jumpToDefinition` 命令（内部会走 LSP 的 textDocument/definition）。
 */
const ctrlClickJumpToDefinition = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    if (!(event.ctrlKey || event.metaKey)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    event.preventDefault();
    view.dispatch({ selection: { anchor: pos } });
    // jumpToDefinition 返回 true 表示有定义可跳；失败（未连接/无定义）静默忽略
    jumpToDefinition(view);
    return true;
  },
});

/**
 * 按住 Ctrl/Cmd 时给编辑器内容加一个可点击的视觉样式（手型指针 + 下划线提示）。
 */
const ctrlHoverTheme = EditorView.theme({
  '.cm-content.cm-ctrl-hover': {
    cursor: 'pointer',
  },
});
