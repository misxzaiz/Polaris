import React from "react";
import ReactDOM from "react-dom/client";
import * as ReactJSXRuntime from "react/jsx-runtime";
import App from "./App";
import { MobileConnectionGate } from "./mobile/MobileConnectionGate";
import { isMobileTauriRuntime } from "./mobile/platform";
import "./i18n";

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
    if (theme === 'spiderman') {
      const storedBg = window.localStorage.getItem('spiderman-theme');
      if (storedBg) {
        try {
          const config = JSON.parse(storedBg);
          if (config.backgroundImage) {
            document.documentElement.style.setProperty('--spiderman-bg-image', `url('${config.backgroundImage}')`);
          } else {
            document.documentElement.setAttribute('data-spiderman-bg-off', '');
          }
          const bgOpacity = config.backgroundOpacity ?? 0.2;
          const overlayAlpha = Math.max(0, Math.min(1, 1 - bgOpacity));
          document.documentElement.style.setProperty('--spiderman-bg-overlay', String(overlayAlpha));
          document.documentElement.style.setProperty('--spiderman-web-opacity', String(config.webTextureOpacity ?? 0.15));
          document.documentElement.style.setProperty('--spiderman-panel-opacity', String(config.panelOpacity ?? 0.55));
          const blur = config.panelBlur ?? 8;
          document.documentElement.style.setProperty('--spiderman-panel-blur', blur > 0 ? `blur(${blur}px)` : 'none');
          document.documentElement.style.setProperty('--spiderman-bg-position',
            `${config.backgroundPositionX ?? 50}% ${config.backgroundPositionY ?? 50}%`);
          if (config.backgroundSize) {
            document.documentElement.style.setProperty('--spiderman-bg-size', config.backgroundSize);
          }
          if (config.avatarUrl) {
            document.documentElement.style.setProperty('--spiderman-avatar-url', `url('${config.avatarUrl}')`);
          }
        } catch { /* ignore */ }
      }
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