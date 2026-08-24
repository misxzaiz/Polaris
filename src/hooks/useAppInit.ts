/**
 * 应用初始化 Hook
 *
 * 负责：
 * - 加载配置
 * - 引导 AI 引擎
 * - 初始化集成（QQ Bot、飞书）
 * - 预加载设置数据
 * - 检查工作区状态
 */

import { useEffect, useRef } from 'react';
import { useConfigStore, initPerformanceHotSwitch } from '@/stores/configStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useIntegrationStore } from '@/stores/integrationStore';
import { useSnippetStore } from '@/stores/snippetStore';
import { useSkillStore } from '@/stores/skillStore';
import { useCliInfoStore } from '@/stores/cliInfoStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { usePluginStore } from '@/stores/pluginStore';
import { usePluginServiceStore } from '@/stores/pluginServiceStore';
import { useLspStore } from '@/stores/lspStore';
import { sessionStoreManager } from '@/stores/conversationStore';
import { bootstrapEngines } from '../core/engine-bootstrap';
import { bootstrapTools } from '../core/tool-bootstrap';
import { voiceNotificationService } from '@/services/voiceNotificationService';
import { discoverInstalledPlugins } from '@/services/pluginDiscoveryService';
import { pluginServiceManager } from '@/services/pluginServiceManager';
import { disconnect as disconnectTransport } from '@/services/transport';
import { createLogger } from '@/utils/logger';
import { currentMode } from '@/services/transport';
import { getWebServerStatus } from '@/services/tauri/configService';
import { setMarkdownArtifactBaseUrl } from '@/utils/cache';
import { pluginRegistry } from '../plugin-system';
import { applyPluginStyles } from '../plugin-system/styles';
import { browserClearOrphanedSessions } from '@/services/tauri/browserService';
import { preloadLanguageExtensions } from '@/components/Editor/Editor';

const log = createLogger('AppInit');
const MARKDOWN_ARTIFACT_STATUS_ATTEMPTS = 5;
const MARKDOWN_ARTIFACT_STATUS_RETRY_MS = 200;

interface UseAppInitOptions {
  onNoWorkspaces: () => void;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timeout = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

async function syncMarkdownArtifactBaseUrl(signal?: AbortSignal): Promise<void> {
  if (currentMode !== 'tauri') {
    setMarkdownArtifactBaseUrl(null);
    return;
  }

  for (let attempt = 0; attempt < MARKDOWN_ARTIFACT_STATUS_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) return;

    try {
      const status = await getWebServerStatus();
      if (status.running && status.url) {
        setMarkdownArtifactBaseUrl(status.url);
        return;
      }
    } catch (error) {
      log.debug('Web server status unavailable while preparing markdown artifacts', {
        error: String(error),
      });
    }

    if (attempt < MARKDOWN_ARTIFACT_STATUS_ATTEMPTS - 1) {
      await delay(MARKDOWN_ARTIFACT_STATUS_RETRY_MS, signal);
    }
  }

  setMarkdownArtifactBaseUrl(null);
}

export function useAppInit({ onNoWorkspaces }: UseAppInitOptions) {
  const isInitialized = useRef(false);
  const hasCheckedWorkspaces = useRef(false);
  const perfHotSwitchCleanupRef = useRef<(() => void) | null>(null);

  const { loadConfig } = useConfigStore();
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const connectionState = useConfigStore(state => state.connectionState);

  // Token 鉴权通过后的初始化逻辑（工作区同步、引擎引导、集成初始化等）
  const runPostAuthInit = useRef(async (signal?: AbortSignal) => {
    await usePluginStore.getState().loadPluginStates();

    // 从服务端 Config 同步工作区列表（桌面端和 Web 端共享）
    try {
      await useWorkspaceStore.getState().syncFromServer();
    } catch (err) {
      log.warn('Workspace sync failed, using local cache', { error: String(err) });
    }

    // Web 模式兜底：如果同步后仍无工作区，用 workDir 自动创建
    if (currentMode === 'http') {
      const config = useConfigStore.getState().config;
      const workDir = config?.workDir;
      const workspaceStore = useWorkspaceStore.getState();
      if (workDir && workspaceStore.workspaces.length === 0) {
        log.info('Web mode: auto-creating default workspace', { workDir });
        try {
          await workspaceStore.createWorkspace(
            workDir.split(/[/\\]/).pop() || 'Workspace',
            workDir,
            true,
          );
        } catch (err) {
          log.error('Auto-create workspace failed', err as Error);
        }
      }
    }

    const currentWorkspacePath = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
    try {
      const result = await discoverInstalledPlugins(currentWorkspacePath);
      await pluginRegistry.replaceInstalled(result.plugins);
      // 插件清单加载后，注入已启用插件的样式
      applyPluginStyles();
      if (result.errors.length > 0) {
        log.warn('Plugin discovery completed with errors', { errors: result.errors });
      }
    } catch (err) {
      log.warn('Plugin discovery failed', { error: String(err) });
    }

    // 启动插件声明的后台服务（autoStart 服务）
    // 性能开关：pluginAutoStart=false 时跳过自动启动
    const pluginAutoStart = useConfigStore.getState().config?.performance?.pluginAutoStart ?? false;
    if (pluginAutoStart) {
      try {
        const pluginStates = usePluginStore.getState().pluginStates;
        const enabledMap: Record<string, { enabled: boolean }> = {};
        for (const plugin of pluginRegistry.listPlugins()) {
          const state = pluginStates[plugin.id];
          const enabled = state ? state.enabled : plugin.enabledByDefault;
          enabledMap[plugin.id] = { enabled };
        }
        const statuses = await pluginServiceManager.autoStartAll(enabledMap, currentWorkspacePath);
        if (statuses.length > 0) {
          const store = usePluginServiceStore.getState();
          store.updateServiceStatuses(statuses);
          log.info('Plugin services auto-started', { count: statuses.length });
        }
      } catch (err) {
        log.warn('Plugin service autostart failed', { error: String(err) });
      }
    } else {
      log.debug('Plugin service auto-start skipped (performance.pluginAutoStart=false)');
    }

    if (signal?.aborted) return;
    isInitialized.current = true;

    // 初始化性能开关热切换监听（config-changed 事件 → 停止已运行的后端守护服务）
    // 在 config 加载后注册，确保 prev 快照准确（避免 prev 漂移导致误停止）
    perfHotSwitchCleanupRef.current = initPerformanceHotSwitch(
      useConfigStore.getState().config?.performance ?? {},
    );

    // 性能开关 codeEditorLanguages：开启时在 idle 预热全部编辑器语言包，
    // 使后续打开任意文件时 dynamic import 命中模块缓存、消除首延迟。
    // 默认关闭（零预加载，打开文件时按扩展名单点 import）。
    if (useConfigStore.getState().config?.performance?.codeEditorLanguages) {
      const runPreload = () => {
        preloadLanguageExtensions().catch((e) =>
          log.warn('Editor language preload failed', { error: String(e) }),
        );
      };
      // 优先 idle 时预加载，避免与首屏渲染抢资源；不支持 requestIdleCallback 时立即降级
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        (window as unknown as { requestIdleCallback: (cb: () => void) => number })
          .requestIdleCallback(runPreload);
      } else {
        runPreload();
      }
    }

    // 清理残留的浏览器会话（页面刷新 / HMR 重挂载时，BrowserPanel cleanup 的
    // browserSetBounds hide 调用可能被取消，导致 native WebView 子窗口残留且可见，
    // 而 tabStore 不持久化导致没有 BrowserPanel 渲染出来去管理它——表现为
    // "浏览器置顶盖住界面且关不掉"）。
    if (currentMode === 'tauri') {
      void browserClearOrphanedSessions().catch((e) =>
        log.warn('Browser orphaned session cleanup failed', { error: String(e) })
      );
    }

    // 绑定语音提醒服务的配置获取
    voiceNotificationService.initialize(() => useConfigStore.getState().config);

    // 获取配置
    const config = useConfigStore.getState().config;
    const defaultEngine = config?.defaultEngine || 'claude-code';

    await sessionStoreManager.getState().initialize();
    log.info('SessionStoreManager initialized', { defaultEngine });

    // 按需初始化传统 AI Engine
    await bootstrapEngines(defaultEngine);

    // 注册 AI 工具
    bootstrapTools();

    // 恢复窗口透明度
    if (config?.window) {
      const initialOpacity = (config.window.normalOpacity ?? 100) / 100;
      if (initialOpacity < 1.0) {
        document.documentElement.style.setProperty('--window-opacity', String(initialOpacity));
        log.info(`窗口透明度已恢复: ${initialOpacity}`);
      }
    }

    // 初始化集成管理器
    const qqbotConfig = config?.qqbot ?? null;
    const feishuConfig = config?.feishu ?? null;
    const dingtalkConfig = config?.dingtalk ?? null;

    if (qqbotConfig || feishuConfig || dingtalkConfig) {
      try {
        const { initialize, startPlatform } = useIntegrationStore.getState();
        await initialize(qqbotConfig, feishuConfig, dingtalkConfig);

        if (dingtalkConfig && dingtalkConfig.instances.length > 0) {
          const activeInstance = dingtalkConfig.activeInstanceId
            ? dingtalkConfig.instances.find(i => i.id === dingtalkConfig.activeInstanceId)
            : dingtalkConfig.instances.find(i => i.enabled);

          if (activeInstance && activeInstance.autoConnect !== false) {
            log.info('自动连接 DingTalk...');
            await startPlatform('dingtalk');
          }
        }

        if (qqbotConfig && qqbotConfig.instances.length > 0) {
          const activeInstance = qqbotConfig.activeInstanceId
            ? qqbotConfig.instances.find(i => i.id === qqbotConfig.activeInstanceId)
            : qqbotConfig.instances.find(i => i.enabled);

          if (activeInstance && activeInstance.autoConnect !== false) {
            log.info('自动连接 QQ Bot...');
            await startPlatform('qqbot');
          }
        }

        if (feishuConfig && feishuConfig.instances.length > 0) {
          const activeInstance = feishuConfig.activeInstanceId
            ? feishuConfig.instances.find(i => i.id === feishuConfig.activeInstanceId)
            : feishuConfig.instances.find(i => i.enabled);

          if (activeInstance && activeInstance.autoConnect !== false) {
            log.info('自动连接 Feishu...');
            await startPlatform('feishu');
          }
        }
      } catch (error) {
        log.error('集成管理器初始化失败', error as Error);
      }
    }

// 预加载设置相关数据
    try {
      await Promise.all([
        useSnippetStore.getState().loadSnippets(),
        useSkillStore.getState().loadSkills(),
        useIntegrationStore.getState().loadInstances(),
        // 加载 LSP 持久化配置 —— 必须在启动时执行，否则重启后用户自定义的
        // 语言服务器（如 Java）不会被加载，打开对应文件时静默失效。
        useLspStore.getState().loadFromBackend(),
        // 索引引擎初始化（事件订阅 + 当前 workspace 自动 open）
        useLspStore.getState().init(),
      ]);
    } catch (error) {
      log.warn('设置数据预加载部分失败', { error: String(error) });
    }

    const currentWorkspace = useWorkspaceStore.getState().getCurrentWorkspace();
    if (currentWorkspace?.path) {
      try {
        await useTerminalStore.getState().runAutoScripts('app_start', currentWorkspace.path);
      } catch (error) {
        log.warn('终端脚本自动执行失败', { error: String(error) });
      }
    }

    // OPFS 存量会话上行（幂等，后台静默）：Web 端历史会话统一收敛到服务端存储
    void import('@/services/dialogStorage').then(({ maybeAutoMigrateOpfs }) =>
      maybeAutoMigrateOpfs(),
    );

    // 专家/专家团数据预加载(全局存储,启动即可加载)
    if (currentMode === 'tauri' || currentMode === 'http') {
      void import('@/stores/agentStore')
        .then(({ useAgentStore }) => {
          const store = useAgentStore.getState();
          return Promise.all([
            store.load(),
            store.loadRosters(),
          ]).then(() => undefined);
        })
        .catch((err) => log.warn('Agent data load failed', { error: String(err) }));
    }
  });

  // 初始化配置（只执行一次）
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const initializeApp = async () => {
      if (isInitialized.current) return;

      try {
        // 先加载配置
        await loadConfig();
        await syncMarkdownArtifactBaseUrl(controller.signal);

        // Web 模式鉴权未通过时，停止后续初始化，优先让用户输入 Token
        if (useConfigStore.getState().connectionState === 'needsToken') {
          return;
        }

        if (cancelled) return;
        await runPostAuthInit.current(controller.signal);
      } catch (error) {
        log.error('初始化失败', error as Error);
        isInitialized.current = false;
      }
    };

    initializeApp();

    // 初始化 CLI 信息事件监听
    const cleanupCliListeners = useCliInfoStore.getState().initEventListeners();

    return () => {
      cancelled = true;
      controller.abort();
      const { cleanup } = useIntegrationStore.getState();
      cleanup();
      cleanupCliListeners();
      perfHotSwitchCleanupRef.current?.();
      // 关闭所有 LSP 语言服务器进程，避免遗留子进程
      void useLspStore.getState().deactivateAll();
      disconnectTransport();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only init, all deps are stable refs
  }, []);

  // Web 模式：Token 提交成功后触发后续初始化（首次进入时 needsToken → submitToken → success）
  useEffect(() => {
    if (connectionState === 'success' && !isInitialized.current) {
      log.info('Token auth succeeded, running post-auth initialization');
      runPostAuthInit.current().catch(err => {
        log.error('Post-auth initialization failed', err as Error);
      });
    }
  }, [connectionState]);

  // 检查工作区状态
  useEffect(() => {
    if (hasCheckedWorkspaces.current) return;

    if (workspaces.length === 0 && isInitialized.current) {
      log.info('No workspaces, showing creation modal');
      onNoWorkspaces();
      hasCheckedWorkspaces.current = true;
    } else if (workspaces.length > 0) {
      hasCheckedWorkspaces.current = true;
    }
  }, [workspaces.length, onNoWorkspaces]);
}
