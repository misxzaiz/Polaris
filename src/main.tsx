import React from "react";
import { useEffect } from 'react';
import ReactDOM from "react-dom/client";
import * as ReactDOMBase from "react-dom";
import * as ReactJSXRuntime from "react/jsx-runtime";
import { useTranslation as _hostUseTranslation } from 'react-i18next';
import App from "./App";
import { MobileConnectionGate } from "./mobile/MobileConnectionGate";
import { isMobileTauriRuntime } from "./mobile/platform";
import { registerExternalLinkGlobalHandler } from './services/linkExternal';
import "./i18n";
import { bootstrapTheme } from '@/services/themeEngine';
import { remoteSessionFollower } from '@/services/remoteSessionFollower';
import { invoke, listen } from '@/services/transport';
import { createHostWorkspaceApi } from '@/plugin-system/hostWorkspaceApi';
import { createHostThemeApi } from '@/plugin-system/themeHostApi';
import { createHostSessionApi } from '@/plugin-system/sessionHostApi';
import { createChatCardsApi } from '@/plugin-system/chatCardsHostApi';
import { currentPluginContext } from '@/plugin-system/pluginContext';
import { pluginRegistry, chatCardRegistry } from '@/plugin-system';
import { eventBus } from '@/services/eventBus';
import { initPluginToolUsageObserver } from '@/services/pluginToolUsageObserver';
import { installAppCoreBridge } from '@/plugin-system/appCoreBridge';

// chat-desk（P3 重构）：面板搬入真实 Chat UI，依赖的宿主 stores/services/组件
// 经本桥共享同一实例（同窗口同源，core 插件专用；见 appCoreBridge.ts）。
installAppCoreBridge();

// 暴露宿主 React 给外部插件面板使用
;(window as any).__POLARIS_HOST_REACT__ = React;
;(window as any).__POLARIS_HOST_REACT_JSX__ = ReactJSXRuntime;
// react-dom shim（ai-chat-plugin-extraction-spec P1.4）：Chat 域插件（chat-desk）
// 面板含 createPortal（NewSessionPanel/MarkdownImageViewer 等），宿主 bundle
// 已含 react-dom，导出同一实例避免插件内嵌第二份 React 副本。
;(window as unknown as { __POLARIS_HOST_REACT_DOM__: typeof ReactDOM }).__POLARIS_HOST_REACT_DOM__ = {
  ...ReactDOMBase,
  createRoot: ReactDOM.createRoot,
  hydrateRoot: ReactDOM.hydrateRoot,
};
// i18n shim（chat-desk P3）：面板 bundle external react-i18next，经此拿到宿主
// 同实例（同词典同语言，见 appCoreBridge i18n 挂载）。
;(window as any).__POLARIS_HOST_USE_TRANSLATION__ = _hostUseTranslation;

// ============================================================================
// 批 7（审计 1.9）：宿主桥白名单包装。
//
// 此前裸挂 invoke / listen：插件面板是同源非沙箱加载（pluginModuleLoader
// Blob import 进主窗口），任意面板脚本可调用全部 40 个后端命令、监听所有
// 会话（含其他端）的 chat-event 明文。包装后：
// - INVOKE 白名单：只放行插件运行所需的只读/插件域命令；危险面（文件读写、
//   终端、bash、会话消息整写等）一律拒绝。后续按插件 manifest permissions
//   细化（裁决方案批 7 完整形态）。
// - LISTEN 过滤：chat-event 只透传 mc- 前缀（插件会话命名空间）信封——
//   插件只能看到自己发起的会话流，不再能监听主会话/其他端内容。
// ============================================================================

const HOST_INVOKE_ALLOWLIST: ReadonlySet<string> = new Set([
  // 插件域（config / kv / 服务管理）
  'plugin_get_config', 'plugin_set_config', 'plugin_service_list', 'plugin_service_start',
  'plugin_service_stop', 'plugin_service_logs', 'plugin_discovery_list',
  'plugin_discovery_install', 'plugin_discovery_uninstall',
  // 会话只读（MultiChat 回补）
  'message_read',
  // AI 会话（经 RouterBus，后端仍有权限 gate）
  'router_dispatch', 'router_dispatch_stream',
  // 基础
  'health_check', 'get_cli_info',
  // chat-desk（ai-chat-plugin-extraction-spec P3.b）：会话配置选择器数据源。
  // 全部为只读元数据/清单查询；写路径（profile 保存等）仍走 cap.config，不在白名单。
  'get_engine_metadata_list', 'cli_get_agents', 'cli_get_version',
  'cli_get_auth_status', 'agent_corpus_rosters', 'custom_agent_list',
  'simple_ai_list_agents',
  // chat-desk 附件落盘/引用物化（与宿主 ChatInput 同通道；写面受路径约束在命令层）
  'create_file', 'read_directory', 'get_file_content',
  // chat-desk 全局权限规则写入（PermissionRequestRenderer scope=global）
  'add_claude_permission_rules',
])

;(window as any).__POLARIS_HOST_INVOKE__ = (cmd: string, args?: Record<string, unknown>) => {
  if (!HOST_INVOKE_ALLOWLIST.has(cmd)) {
    console.warn(`[PolarisHostBridge] 命令不在插件白名单: ${cmd}`)
    return Promise.reject(new Error(`命令不在插件白名单: ${cmd}`))
  }
  return invoke(cmd, args)
}

;(window as any).__POLARIS_HOST_LISTEN__ = (
  event: string,
  handler: (payload: unknown) => void,
) => {
  return listen<{ contextId?: string }>(event, (envelope) => {
    if (event === 'chat-event') {
      // chat-event 订阅授权（ai-chat-plugin-extraction-spec P1.3）：
      // 按调用方插件 manifest permissions.chatEvents 裁决——
      // - full：全量透传（chat-desk 对话域插件；正文 token/thinking/工具流可见）；
      // - lifecycle（缺省，现状行为）：mc- 前缀命名空间（MultiChat）+
      //   session_start/session_end 低敏元数据（history-desk 自动刷新）；
      // - none：不透传。
      // 插件归属判定两级：
      // 1) currentPluginContext()——面板 loader 同步 import 期间（订阅注册发生在
      //    模块顶层/初始化时）；
      // 2) 回调分发期读不到栈（异步边界）→ 用 mc- contextId 前缀反查已注册插件
      //    （chat-desk 约定 mc-cd-<sid>，multichat 约定 mc-<id>；前缀匹配 manifest
      //    permissions.chatEvents，匹配不到按 lifecycle 兜底——正文永不泄露给
      //    未授权调用方）。
      const resolveChatEvents = (contextId?: string): 'full' | 'lifecycle' | 'none' => {
        const pluginId = currentPluginContext();
        if (pluginId) {
          return pluginRegistry.getPlugin(pluginId)?.permissions?.chatEvents ?? 'lifecycle';
        }
        if (typeof contextId === 'string' && contextId.startsWith('mc-')) {
          for (const plugin of pluginRegistry.listPlugins()) {
            const level = plugin.permissions?.chatEvents ?? 'lifecycle';
            if (level !== 'full') continue;
            // chat-desk 约定：mc-cd- 前缀（cd = chat-desk 子命名空间）
            const ns = plugin.id === 'chat-desk' ? 'mc-cd-' : `mc-${plugin.id}-`;
            if (contextId.startsWith(ns)) return 'full';
          }
        }
        return 'lifecycle';
      };
      const chatEvents = resolveChatEvents(envelope?.contextId);
      if (chatEvents === 'none') return;
      if (chatEvents === 'full') {
        handler(envelope);
        return;
      }
      // lifecycle 过滤（既有语义，plans/session-history-plugin-prd.md P0）
      const type = (envelope as { payload?: { payload?: { type?: string } } })
        ?.payload?.payload?.type;
      if (typeof envelope?.contextId === 'string' && envelope.contextId.startsWith('mc-')) {
        handler(envelope)
        return
      }
      if (type === 'session_start' || type === 'session_end') {
        handler(envelope)
        return
      }
      return
    }
    handler(envelope)
  })
}
// 暴露"发送消息到活跃会话"给外部插件面板（news-curator 等面板的 sendToChat 兜底通道；
// 实际实现在 App.tsx 挂载真实 sendMessage；此声明保证通道始终存在（空实现静默降级））
;(window as any).__POLARIS_SEND_TO_CHAT__ = () => {};
// 暴露工作区宿主 API 给外部插件面板（如 workspace-manager）。
// 所有工作区变更委托主应用 workspaceStore 执行：持久化、事件派发、
// 全 UI 响应式刷新由 store 自带，主应用工作区绑定天然更新。
;(window as any).__POLARIS_WORKSPACE_API__ = createHostWorkspaceApi();
// 主题宿主 API：插件面板（如未来的主题管理插件）经此委托 themeStore 读写主题，
// 不旁路 localStorage / 直写 CSS 变量（结构化数据回传由本 API 承担，弥补
// cap.ui.theme forward-only 无数据返回的缺口）。
;(window as any).__POLARIS_THEME_API__ = createHostThemeApi();
// 会话桥（plans/session-history-plugin-prd.md P0）：插件面板（history-desk 等）
// 经此恢复历史会话 / 创建分支。内部委托 sessionRestore（宿主保留的恢复核心），
// conversationId 必须经调用方证实存在（cap.history query/archive_page）后才传入；
// 不暴露 store 句柄（最小面）。eslint-disable 与上方既有 window 挂载点同款
// （window 全局桥是本文件的既定模式，逐点豁免而非全局关闭规则）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).__POLARIS_SESSION_API__ = createHostSessionApi();
// 聊天卡片只读桥（ai-chat-plugin-extraction-spec P1.6）：chat-desk 插件渲染
// plugin_card 块时查宿主 chatCardRegistry（他插件注册的卡片渲染器）。
// 只读（match/resolve/listKeys），不含 loader 与注册入口；卡片组件加载仍走
// 各自插件的模块通道。模型目录/引擎元数据走既有 cap.config / engine metadata，
// 不设新桥（spec §5.6）。
;(window as unknown as { __POLARIS_CHAT_CARDS_API__: ReturnType<typeof createChatCardsApi> })
  .__POLARIS_CHAT_CARDS_API__ = createChatCardsApi(chatCardRegistry);

// 暴露当前工作区路径给外部插件面板（wheel：监听 workspace-changed 事件，
// 初始取 localStorage 兜底。外部插件如 polaris-git 可据此自动初始化。）
;(window as any).__POLARIS_HOST_WORKSPACE__ = '';
eventBus.on('workspace-changed', (ws) => {
  const p = ws?.workspacePath ?? ws?.path;
  if (p) {
    (window as any).__POLARIS_HOST_WORKSPACE__ = p;
  }
});

// 主题引导：在 React render 之前同步读取 localStorage 并注入 CSS 变量，防止首屏闪烁（FOUC）
(() => {
  bootstrapTheme();
})();

// 插件 MCP 工具调用观测（needs/027）：订阅全局 AIEvent tool_call_end，
// 按真实注册表把调用归属到插件并落 plugin.toolusage.*（守望台读时合并）。
// fire-and-forget、失败静默，不阻塞启动主链路。
initPluginToolUsageObserver();

// PWA Service Worker 注册（阶段 1B）：仅生产构建，dev 的 HMR 与之互不干扰。
// 注册失败静默降级（PWA 是增强项，不是功能依赖）；协议数据 /api/、/ws 在 SW 内直连。
if (import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[PWA] Service Worker 注册失败（离线壳不可用，功能不受影响）', err)
    })
  })
}

// 跨端只读会话跟随（批 3/v2）：lifecycle 轮询发现 + chat-event 实时订阅。
// 静态 import + 顶层启动——此前动态 import 排在 useAppInit 长链尾部（连坐跳过）
// 和 main 动态 import（早期时序不稳）两种形态都实测未执行；静态模块图无失败面。
// start 内部幂等；invoke 懒初始化 transport，此处无需等待连接建立。
remoteSessionFollower.start();

const root = document.getElementById("root") as HTMLElement;

/**
 * 根组件选择：
 * - 移动端 Tauri APK：完整 Web App + 连接配置 Gate（无 serverUrl 时先配地址/Token）
 * - 其它（桌面 / 手机浏览器访问 polaris-web）：完整 Web App
 *
 * 旧版独立 MobileApp companion 壳（?mobile=1）已废弃（2026-07-12 产品决策）。
 */
function MobileLinkHandler() {
  useEffect(() => {
    void registerExternalLinkGlobalHandler();
  }, []);
  return null;
}

function RootApp() {
  if (isMobileTauriRuntime()) {
    return (
      <MobileConnectionGate>
        {(_state) => (
          <>
            <MobileLinkHandler />
            <App />
          </>
        )}
      </MobileConnectionGate>
    );
  }

  return <App />;
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);