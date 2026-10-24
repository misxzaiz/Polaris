import React from "react";
import ReactDOM from "react-dom/client";
import * as ReactJSXRuntime from "react/jsx-runtime";
import App from "./App";
import { MobileConnectionGate } from "./mobile/MobileConnectionGate";
import { isMobileTauriRuntime } from "./mobile/platform";
import "./i18n";
import { bootstrapTheme } from '@/services/themeEngine';
import { remoteSessionFollower } from '@/services/remoteSessionFollower';
import { invoke, listen } from '@/services/transport';
import { createHostWorkspaceApi } from '@/plugin-system/hostWorkspaceApi';
import { eventBus } from '@/services/eventBus';

// 暴露宿主 React 给外部插件面板使用
;(window as any).__POLARIS_HOST_REACT__ = React;
;(window as any).__POLARIS_HOST_REACT_JSX__ = ReactJSXRuntime;

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
      // 只透传插件会话命名空间（mc- 前缀）；主会话/其他端内容不进插件面板
      if (typeof envelope?.contextId === 'string' && envelope.contextId.startsWith('mc-')) {
        handler(envelope)
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
function RootApp() {
  if (isMobileTauriRuntime()) {
    return (
      <MobileConnectionGate>
        {() => <App />}
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