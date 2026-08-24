import React from "react";
import ReactDOM from "react-dom/client";
import * as ReactJSXRuntime from "react/jsx-runtime";
import App from "./App";
import { MobileConnectionGate } from "./mobile/MobileConnectionGate";
import { isMobileTauriRuntime } from "./mobile/platform";
import "./i18n";
import { bootstrapTheme } from '@/services/themeEngine';
import { invoke } from '@/services/transport';

// 暴露宿主 React 给外部插件面板使用
;(window as any).__POLARIS_HOST_REACT__ = React;
;(window as any).__POLARIS_HOST_REACT_JSX__ = ReactJSXRuntime;
// 暴露后端 invoke 给外部插件面板使用（无状态调用，零服务进程）
;(window as any).__POLARIS_HOST_INVOKE__ = invoke;

// 暴露当前工作区路径给外部插件面板（wheel：监听 workspace-changed 事件，
// 初始取 localStorage 兜底。外部插件如 polaris-git 可据此自动初始化。）
;(window as any).__POLARIS_HOST_WORKSPACE__ = '';
window.addEventListener('workspace-changed', ((e: CustomEvent) => {
  const ws = (e as CustomEvent<{ workspacePath?: string; path?: string }>).detail;
  const p = ws?.workspacePath ?? ws?.path;
  if (p) {
    (window as any).__POLARIS_HOST_WORKSPACE__ = p;
  }
}) as EventListener);

// 主题引导：在 React render 之前同步读取 localStorage 并注入 CSS 变量，防止首屏闪烁（FOUC）
(() => {
  bootstrapTheme();
})();

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