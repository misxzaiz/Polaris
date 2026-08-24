/**
 * LSP 状态管理 Store
 *
 * 综合管理：语言服务器配置/连接/客户端、索引引擎生命周期、UI 面板状态。
 * 原分散在 lspStore / lspIndexStore / lspUiStore 三个文件，合并后统一入口。
 *
 * Per-language 单例：同一语言只创建一个 LSP 客户端，多文件共享。
 */

import { create } from 'zustand';
import {
  LSPClient,
  languageServerSupport,
  serverDiagnostics,
} from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { TauriIpcTransport } from '@/services/lsp/TauriIpcTransport';
import {
  lspConfigList,
  lspIndexOpen,
  lspIndexClose,
  lspIndexRebuild,
  lspIndexStatus,
  type IndexStatus,
} from '@/services/tauri/lspService';
import { createLogger } from '@/utils/logger';
import { ctrlHoverLink } from '../components/Editor/ctrlHoverLink';
import { smartJumpLsp } from '@/services/lsp/lspNavigation';
import { jumpToDefinitionIndex, smartJumpIndex } from '@/services/lsp/indexNavigation';
import { runFindReferences } from '@/services/lsp/lspReferences';
import { useEditorSettingsStore } from './editorSettingsStore';
import { useDiagnosticsStore, type DiagnosticItem } from './diagnosticsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { isLspIndexEnabled } from '@/utils/performanceFeatures';

const log = createLogger('LspStore');

// ============================================================
// 类型定义
// ============================================================

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
  /**
   * 运行模式：
   * - 'lsp'（默认）：启动语言服务器进程，提供补全/诊断/语义导航等完整能力；
   * - 'index'：轻量索引模式，无常驻进程，用 ripgrep 式扫描提供跳转定义/查找引用，
   *   适合低配机或重型语言（Java/C++）。
   */
  mode?: 'lsp' | 'index';
}

/** 活跃的 LSP 客户端实例 */
interface ActiveClient {
  client: LSPClient;
  transport: TauriIpcTransport;
}

export type LspConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// --- UI 面板类型 ---

interface SymbolPaletteContext {
  view: EditorView;
  client: LSPClient;
  uri: string;
}

/** 引用结果中的一条（LSP 模式与索引模式统一形态） */
export interface ReferenceItem {
  /** 本地文件路径 */
  path: string;
  /** 行号（1-based） */
  line: number;
  /** 列号（0-based） */
  column: number;
  /** 该行预览文本（索引模式有；LSP 模式可能为空） */
  preview?: string;
  /** 符号种类（class/interface/method/...） */
  kind?: string;
  /** 完整限定名 */
  fqn?: string;
  /** 引用种类（call/type/new/...）；查应用结果用 */
  refKind?: string;
}

/** References 面板上下文 */
export interface ReferencesContext {
  /** 被查询的符号名 */
  symbol: string;
  /** 是否加载中 */
  loading: boolean;
  /** 结果列表 */
  items: ReferenceItem[];
  /** 错误信息（查询失败时） */
  error: string | null;
  /** 结果是否可能被截断（达到上限） */
  truncated?: boolean;
}

/** Definition Peek 浮窗上下文 */
export interface DefinitionPeekContext {
  /** 被查询的符号名 */
  symbol: string;
  /** 候选定义（已按相关度排序，第一项是最佳猜测） */
  items: ReferenceItem[];
  /** 屏幕坐标锚点（来自 view.coordsAtPos） */
  anchor: { x: number; y: number; lineHeight: number };
}

// ============================================================
// Store 状态与 Actions
// ============================================================

interface LspState {
  // --- LSP 客户端 ---
  servers: LspServerConfig[];
  clients: Map<string, ActiveClient>;
  status: Map<string, LspConnectionStatus>;
  pendingConnections: Map<string, Promise<{ client: LSPClient | null; extensions: Extension[] } | null>>;

  // --- 索引引擎 ---
  currentStatus: IndexStatus | null;
  openedWorkspaces: Set<string>;
  unlisten: UnlistenFn | null;

  // --- UI 面板 ---
  symbolPalette: SymbolPaletteContext | null;
  references: ReferencesContext | null;
  definitionPeek: DefinitionPeekContext | null;
  indexStatuses: Record<string, IndexStatus>;
}

interface LspActions {
  // --- LSP 客户端操作 ---
  activateForFile(
    filePath: string,
    language: string,
    rootUri: string,
  ): Promise<{ client: LSPClient | null; extensions: Extension[] } | null>;
  deactivateServer(serverId: string): Promise<void>;
  deactivateAll(): Promise<void>;
  addServer(config: LspServerConfig): void;
  removeServer(id: string): void;
  toggleServer(id: string): void;
  updateServer(id: string, patch: Partial<Omit<LspServerConfig, 'id'>>): void;
  getExtensionsForFile(filePath: string, language: string): Extension[];
  loadFromBackend(): Promise<void>;

  // --- 索引引擎操作 ---
  init(): Promise<void>;
  ensureOpen(workspace: string): Promise<void>;
  ensureClose(workspace: string): Promise<void>;
  rebuild(workspace: string): Promise<void>;
  refresh(workspace: string): Promise<void>;

  // --- UI 面板操作 ---
  openSymbolPalette(ctx: SymbolPaletteContext): void;
  closeSymbolPalette(): void;
  openReferences(ctx: ReferencesContext): void;
  updateReferences(patch: Partial<ReferencesContext>): void;
  closeReferences(): void;
  openDefinitionPeek(ctx: DefinitionPeekContext): void;
  closeDefinitionPeek(): void;
  promoteDefinitionPeekToReferences(): void;
  setIndexStatus(status: IndexStatus): void;
  clearIndexStatus(workspace: string): void;
}

export type LspStore = LspState & LspActions;

// ============================================================
// 辅助函数
// ============================================================

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

/** 后端 canonicalize 后路径会把斜杠规整化；前端要保持比较一致 */
function normalizePath(p: string): string {
  return p;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_SERVERS: LspServerConfig[] = [
  {
    id: 'typescript-language-server',
    name: 'TypeScript Language Server',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    enabled: true,
    mode: 'lsp',
  },
];

// ============================================================
// Store
// ============================================================

export const useLspStore = create<LspStore>()((set, get) => ({
  // --- LSP 客户端状态 ---
  servers: [...DEFAULT_SERVERS],
  clients: new Map(),
  status: new Map(),
  pendingConnections: new Map(),

  // --- 索引引擎状态 ---
  currentStatus: null,
  openedWorkspaces: new Set(),
  unlisten: null,

  // --- UI 面板状态 ---
  symbolPalette: null,
  references: null,
  definitionPeek: null,
  indexStatuses: {},

  // ============================================================
  // LSP 客户端操作
  // ============================================================

  activateForFile: async (filePath, language, rootUri) => {
    const { servers, clients, pendingConnections } = get();
    const serverConfig = findServerForLanguage(servers, language);
    if (!serverConfig) return null;

    // 索引模式：无常驻进程，直接返回轻量导航扩展（keymap），不走进程/握手。
    if (serverConfig.mode === 'index') {
      set((state) => {
        const newStatus = new Map(state.status);
        newStatus.set(serverConfig.id, 'connected');
        return { status: newStatus };
      });
      const extensions = getIndexExtensions(filePath, language, serverConfig);
      return { client: null, extensions };
    }

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
      if (result && result.client) {
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
        const transport = new TauriIpcTransport(serverId, (reason) => {
          // 进程退出/崩溃：标记 error 并移除 client，下次激活时会自动重启
          set((state) => {
            const newClients = new Map(state.clients);
            newClients.delete(serverId);
            const newStatus = new Map(state.status);
            newStatus.set(serverId, 'error');
            const newPending = new Map(state.pendingConnections);
            newPending.delete(serverId);
            return { clients: newClients, status: newStatus, pendingConnections: newPending };
          });
          log.warn('LSP process exited, marked error', { serverId, reason });
        });
        await transport.connect(serverConfig.command, serverConfig.args);

        // 只把 LSPClientExtension 配置对象放在 client 层级：
        // - serverDiagnostics() 负责把诊断喂给每个编辑器的 linter gutter；
        // - diagnosticsAggregator 另外把同一份诊断写入全局 diagnosticsStore，
        //   供 Problems 面板 / 状态栏使用。两个 handler 都返回 false，
        //   notification 会按顺序继续传播。
        // 不要在这里再加 serverCompletion / hoverTooltips / signatureHelp 等
        // 编辑器侧扩展——languageServerSupport(...) 已经包含它们，重复注册
        // 会导致悬浮提示、补全、签名帮助等出现重复显示。
        const client = new LSPClient({
          rootUri,
          timeout: 5000,
          extensions: [serverDiagnostics(), diagnosticsAggregator],
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
    // 所有 LSP 都断开后，清掉旧的诊断避免过期信息残留在 Problems 面板
    useDiagnosticsStore.getState().clearAll();
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

  // ============================================================
  // 索引引擎操作
  // ============================================================

  init: async () => {
    if (get().unlisten) return; // 已初始化

    try {
      const un = await listen<IndexStatus>('lsp_index:status', (event) => {
        const status = event.payload;
        get().setIndexStatus(status);
        // 同步 currentStatus（仅当 workspace 与当前活跃 workspace 相同）
        const cur = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
        if (cur && status.workspace === normalizePath(cur)) {
          set({ currentStatus: status });
        }
      });
      set({ unlisten: un });
    } catch (err) {
      log.warn('failed to listen lsp_index:status', { error: String(err) });
    }

    // 当前 workspace 自动打开（仅当索引引擎开启时）
    const ws = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
    if (ws && isLspIndexEnabled()) {
      await get().ensureOpen(ws);
    }

    // 监听 workspace 变更（zustand v5：(state, prevState) => void）
    let prevWorkspace: string | null =
      useWorkspaceStore.getState().getCurrentWorkspace?.()?.path ?? null;
    useWorkspaceStore.subscribe((state) => {
      const cur = state.getCurrentWorkspace?.()?.path ?? null;
      if (cur === prevWorkspace) return;
      const old = prevWorkspace;
      prevWorkspace = cur;
      if (old) void get().ensureClose(old);
      if (cur) void get().ensureOpen(cur);
    });
  },

  ensureOpen: async (workspace) => {
    // 性能开关：lspIndex=false 时引擎不启动（不建 DB、不起 watcher、不发起调用）
    if (!isLspIndexEnabled()) {
      log.debug('lspIndex 关闭，跳过索引引擎打开', { workspace });
      return;
    }
    if (get().openedWorkspaces.has(workspace)) {
      // 仍刷一次状态（DB 可能是上一次会话留下的）
      void get().refresh(workspace);
      return;
    }
    try {
      const status = await lspIndexOpen(workspace);
      set((s) => ({
        openedWorkspaces: new Set([...s.openedWorkspaces, workspace]),
        currentStatus: status,
      }));
      get().setIndexStatus(status);
      // 没数据 → 自动后台构建
      if (status.files === 0) {
        log.debug('索引为空，触发首次后台构建', { workspace });
        await lspIndexRebuild(workspace);
      }
    } catch (err) {
      log.warn('lspIndexOpen failed', { workspace, error: String(err) });
    }
  },

  ensureClose: async (workspace) => {
    if (!get().openedWorkspaces.has(workspace)) return;
    try {
      await lspIndexClose(workspace);
    } catch (err) {
      log.warn('lspIndexClose failed', { workspace, error: String(err) });
    }
    set((s) => {
      const next = new Set(s.openedWorkspaces);
      next.delete(workspace);
      return { openedWorkspaces: next };
    });
    get().clearIndexStatus(normalizePath(workspace));
  },

  rebuild: async (workspace) => {
    if (!isLspIndexEnabled()) {
      log.debug('lspIndex 关闭，跳过重建', { workspace });
      return;
    }
    try {
      await lspIndexRebuild(workspace);
    } catch (err) {
      log.warn('lspIndexRebuild failed', { workspace, error: String(err) });
    }
  },

  refresh: async (workspace) => {
    if (!isLspIndexEnabled()) {
      return;
    }
    try {
      const s = await lspIndexStatus(workspace);
      get().setIndexStatus(s);
      set({ currentStatus: s });
    } catch (err) {
      log.warn('lspIndexStatus failed', { workspace, error: String(err) });
    }
  },

  // ============================================================
  // UI 面板操作
  // ============================================================

  openSymbolPalette: (ctx) => set({ symbolPalette: ctx }),
  closeSymbolPalette: () => set({ symbolPalette: null }),

  openReferences: (ctx) => set({ references: ctx, definitionPeek: null }),
  updateReferences: (patch) =>
    set((state) =>
      state.references ? { references: { ...state.references, ...patch } } : {},
    ),
  closeReferences: () => set({ references: null }),

  openDefinitionPeek: (ctx) => set({ definitionPeek: ctx, references: null }),
  closeDefinitionPeek: () => set({ definitionPeek: null }),
  promoteDefinitionPeekToReferences: () => {
    const peek = get().definitionPeek;
    if (!peek) return;
    set({
      definitionPeek: null,
      references: {
        symbol: peek.symbol,
        loading: false,
        items: peek.items,
        error: null,
      },
    });
  },

  setIndexStatus: (status) =>
    set((state) => {
      if (!status.workspace) return {};
      return {
        indexStatuses: { ...state.indexStatuses, [status.workspace]: status },
      };
    }),
  clearIndexStatus: (workspace) =>
    set((state) => {
      const next = { ...state.indexStatuses };
      delete next[workspace];
      return { indexStatuses: next };
    }),
}));

// ============================================================
// 编辑器扩展构建函数
// ============================================================

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
    makeCtrlClickJump(client, uri),
    makeDefinitionKeymap(client, uri),
    makeSymbolPaletteKeymap(client, uri),
    makeFindReferencesKeymap(client, uri),
    ctrlHoverLink,
  ];
}

/**
 * 跳转定义快捷键。LSP 模式下发 textDocument/definition 请求，
 * 复用 smartJumpLsp 实现「在定义处 → 查引用」的智能行为。
 * 快捷键读取 editorSettingsStore（默认 Mod-Alt-b）。
 */
function makeDefinitionKeymap(client: LSPClient, currentUri: string): Extension {
  const settings = useEditorSettingsStore.getState();
  return keymap.of([
    {
      key: settings.lspKeyDefinition,
      run: (view) => {
        void smartJumpLsp(view, client, currentUri);
        return true;
      },
    },
  ]);
}

/**
 * 索引模式的编辑器扩展：无 LSP client，仅提供 keymap/鼠标导航。
 * - Ctrl+Click：跳转定义
 * - 快捷键：从 editorSettingsStore 读取（默认 Mod-Alt-b / Alt-Shift-r）
 */
function getIndexExtensions(
  _filePath: string,
  language: string,
  server: LspServerConfig,
): Extension[] {
  const languages = server.languages;
  const settings = useEditorSettingsStore.getState();
  return [
    keymap.of([
      {
        key: settings.lspKeyDefinition,
        run: (view) => {
          void jumpToDefinitionIndex(view, language, languages, 'definition-key');
          return true;
        },
      },
      {
        key: settings.lspKeyReferences,
        run: (view) => {
          void runFindReferences(view, { mode: 'index', languages });
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false;
        if (!(event.ctrlKey || event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        view.dispatch({ selection: { anchor: pos } });
        // 智能跳转：不在定义处 → 跳定义；已在定义处 → 改查引用
        void smartJumpIndex(view, language, languages, 'ctrl-click');
        return true;
      },
    }),
    ctrlHoverLink,
  ];
}

/**
 * 把 LSP 推送的诊断写入全局 diagnosticsStore。
 *
 * 返回 `false` 让通知继续传播给其它 handler（例如 `serverDiagnostics()`
 * 的内置处理器，它会把诊断灌给每个绑定文件的 linter gutter）。
 */
const diagnosticsAggregator = {
  notificationHandlers: {
    'textDocument/publishDiagnostics': (
      _client: LSPClient,
      params: { uri: string; diagnostics: DiagnosticItem[] },
    ) => {
      try {
        useDiagnosticsStore.getState().set(params.uri, params.diagnostics ?? []);
      } catch (err) {
        log.warn('diagnosticsAggregator write failed', { error: String(err) });
      }
      return false;
    },
  },
};

/**
 * Mod+Shift+O：打开"文档符号面板"（SymbolPalette）。
 *
 * 仅在有 LSPClient 的编辑器上生效——键位通过 `getExtensionsForClient`
 * 下发，纯文本 / 无 LSP 的文件不会抢走此快捷键。
 */
function makeSymbolPaletteKeymap(client: LSPClient, uri: string): Extension {
  return keymap.of([
    {
      key: 'Mod-Shift-o',
      run: (view) => {
        useLspStore.getState().openSymbolPalette({ view, client, uri });
        return true;
      },
    },
  ]);
}

/**
 * 查找引用（查应用）快捷键。LSP 模式发 textDocument/references，
 * 结果在 ReferencesPanel 浮层展示。
 * 快捷键读取 editorSettingsStore（默认 Alt-Shift-r）。
 */
function makeFindReferencesKeymap(client: LSPClient, uri: string): Extension {
  const settings = useEditorSettingsStore.getState();
  return keymap.of([
    {
      key: settings.lspKeyReferences,
      run: (view) => {
        void runFindReferences(view, { mode: 'lsp', client, uri });
        return true;
      },
    },
  ]);
}

/**
 * Ctrl/Cmd + 左键 跳转到定义（跨文件感知）。
 *
 * `@codemirror/lsp-client` 默认的 `jumpToDefinition` Command 只在目标文件
 * 已经打开（通过其 `Workspace.requestFile`）时可用；这里绕过那层，自己
 * 发 `textDocument/definition` 请求，然后：
 * - 同文件：本地 `dispatch` 滚动到目标位置；
 * - 跨文件：走 `fileEditorStore.openFileAtPosition`，复用项目"打开文件"流程。
 */
function makeCtrlClickJump(client: LSPClient, currentUri: string): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false;
      if (!(event.ctrlKey || event.metaKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      event.preventDefault();
      view.dispatch({ selection: { anchor: pos } });
      // 智能跳转：不在定义处 → 跳定义；已在定义处 → 改查引用
      void smartJumpLsp(view, client, currentUri);
      return true;
    },
  });
}