import React from "react";
import ReactDOM from "react-dom/client";
import * as ReactJSXRuntime from "react/jsx-runtime";
import App from "./App";
import { MobileConnectionGate } from "./mobile/MobileConnectionGate";
import { isMobileTauriRuntime } from "./mobile/platform";
import "./i18n";
import { syncSpiderManCssVarsToDom } from '@/utils/spiderman-theme';

// 暴露宿主 React 给外部插件面板使用
;(window as any).__POLARIS_HOST_REACT__ = React;
;(window as any).__POLARIS_HOST_REACT_JSX__ = ReactJSXRuntime;

// 主题预设：在 React render 之前同步读取 localStorage 并写入 data-theme，防止首屏闪烁（FOUC）
(() => {
  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('theme') : null;
    const theme = stored === 'spiderman' ? 'spiderman' : stored === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    // 如果是 spiderman 主题，提前同步 CSS 变量避免首屏闪烁
    // 使用共享工具函数，与 themeStore 的同步逻辑保持完全一致
    if (theme === 'spiderman') {
      syncSpiderManCssVarsToDom();
    }
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
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