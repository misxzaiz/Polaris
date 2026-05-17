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
import { useConfigStore } from '../stores';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useIntegrationStore } from '../stores/integrationStore';
import { useAutoModeStore } from '../stores/autoModeStore';
import { useSnippetStore } from '../stores/snippetStore';
import { useCliInfoStore } from '../stores/cliInfoStore';
import { useTerminalScriptStore } from '../stores/terminalScriptStore';
import { usePluginStore } from '../stores/pluginStore';
import { sessionStoreManager } from '../stores/conversationStore';
import { bootstrapEngines, type EngineId } from '../core/engine-bootstrap';
import { bootstrapTools } from '../core/tool-bootstrap';
import { voiceNotificationService } from '../services/voiceNotificationService';
import { discoverInstalledPlugins } from '../services/pluginDiscoveryService';
import { disconnect as disconnectTransport } from '../services/transport';
import { createLogger } from '../utils/logger';
import { currentMode } from '../services/transport';
import { getWebServerStatus } from '../services/tauri/configService';
import { setMarkdownArtifactBaseUrl } from '../utils/cache';
import { pluginRegistry } from '../plugin-system';

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
      pluginRegistry.replaceInstalled(result.plugins);
      if (result.errors.length > 0) {
        log.warn('Plugin discovery completed with errors', { errors: result.errors });
      }
    } catch (err) {
      log.warn('Plugin discovery failed', { error: String(err) });
    }

    if (signal?.aborted) return;
    isInitialized.current = true;

    // 绑定语音提醒服务的配置获取
    voiceNotificationService.initialize(() => useConfigStore.getState().config);

    // 获取配置
    const config = useConfigStore.getState().config;
    const defaultEngine = config?.defaultEngine || 'claude-code';

    await sessionStoreManager.getState().initialize();
    log.info('SessionStoreManager initialized', { defaultEngine });

    // 按需初始化传统 AI Engine
    await bootstrapEngines(defaultEngine as EngineId);

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

    if (qqbotConfig || feishuConfig) {
      try {
        const { initialize, startPlatform } = useIntegrationStore.getState();
        await initialize(qqbotConfig, feishuConfig);

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
        useIntegrationStore.getState().loadInstances(),
        useAutoModeStore.getState().fetchConfig(),
      ]);
    } catch (error) {
      log.warn('设置数据预加载部分失败', { error: String(error) });
    }

    const currentWorkspace = useWorkspaceStore.getState().getCurrentWorkspace();
    if (currentWorkspace?.path) {
      try {
        await useTerminalScriptStore.getState().runAutoScripts('app_start', currentWorkspace.path);
      } catch (error) {
        log.warn('终端脚本自动执行失败', { error: String(error) });
      }
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
      disconnectTransport();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
