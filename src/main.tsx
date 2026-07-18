import React from "react";
import ReactDOM from "react-dom/client";
import * as ReactJSXRuntime from "react/jsx-runtime";
import App from "./App";
import MobileApp from "./mobile/MobileApp";
import { MobileConnectionGate } from "./mobile/MobileConnectionGate";
import { isMobileTauriRuntime, shouldRenderMobileApp } from "./mobile/platform";
import "./i18n";

// 暴露宿主 React 给外部插件面板使用
;(window as any).__POLARIS_HOST_REACT__ = React;
;(window as any).__POLARIS_HOST_REACT_JSX__ = ReactJSXRuntime;

// 主题预设：在 React render 之前同步读取 localStorage 并写入 data-theme，防止首屏闪烁（FOUC）
// 同时注入自定义主题（颜色变量 + 背景/字体等装饰），避免自定义主题在 React 挂载后才生效造成闪白。
// 注意：此脚本在 bundle 之前内联执行，必须自包含，不能依赖任何模块 import。
(() => {
  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('theme') : null;
    const theme = stored === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  // 自定义主题预注入（与 src/utils/customThemeRuntime.ts 的逻辑保持精简一致）
  try {
    const raw = window.localStorage.getItem('theme-custom-active');
    if (!raw) return;
    const t = JSON.parse(raw);
    if (!t || typeof t !== 'object') return;
    const root = document.documentElement;

    // 颜色变量
    if (t.colors && typeof t.colors === 'object') {
      for (const key of Object.keys(t.colors)) {
        const v = t.colors[key];
        if (typeof v === 'string') root.style.setProperty('--c-' + key, v);
      }
    }
    // 窗口透明度
    if (t.effects && typeof t.effects.windowOpacity === 'number') {
      root.style.setProperty('--window-opacity', String(t.effects.windowOpacity));
    }

    // 装饰样式（背景/字体等）——最小实现，覆盖最影响首屏观感的项
    const rules: string[] = [];
    const bg = t.background;
    if (bg && bg.type && bg.type !== 'none') {
      if (bg.type === 'solid' && bg.solidColor) {
        rules.push('body { background-color: rgb(' + bg.solidColor + ' / var(--window-opacity, 1)) !important; }');
      } else if (bg.type === 'gradient' && bg.gradient && Array.isArray(bg.gradient.stops)) {
        const stops = bg.gradient.stops
          .slice()
          .sort((a: any, b: any) => a.position - b.position)
          .map((s: any) => 'rgb(' + s.color + ') ' + s.position + '%')
          .join(', ');
        rules.push('body { background: linear-gradient(' + bg.gradient.direction + ', ' + stops + ') fixed !important; }');
      } else if (bg.type === 'image' && bg.image && bg.image.url) {
        const img = bg.image;
        const safeUrl = String(img.url).replace(/["\\]/g, '');
        rules.push(
          'body::before { content:""; position:fixed; inset:0; z-index:-1;' +
          ' background-image:url("' + safeUrl + '");' +
          ' background-size:' + (img.size || 'cover') + ';' +
          ' background-position:' + (img.position || 'center center') + ';' +
          ' background-repeat:' + (img.repeat || 'no-repeat') + ';' +
          ' opacity:' + (typeof img.opacity === 'number' ? img.opacity : 1) + ';' +
          ' filter:blur(' + (typeof img.blur === 'number' ? img.blur : 0) + 'px);' +
          ' pointer-events:none; }',
          'body { background-color: transparent !important; }',
        );
      }
    }
    if (rules.length) {
      const el = document.createElement('style');
      el.id = 'polaris-custom-theme';
      el.textContent = rules.join('\n');
      document.head.appendChild(el);
    }
  } catch {
    /* 自定义主题预注入失败不阻塞启动 */
  }
})();

const root = document.getElementById("root") as HTMLElement;

/**
 * 根组件选择：
 * - ?mobile=1：旧 MobileApp companion（调试）
 * - 移动端 Tauri APK：完整 Web App + 连接配置 Gate（无 serverUrl 时先配地址/Token）
 * - 其它（桌面 / 手机浏览器访问 polaris-web）：完整 Web App
 */
function RootApp() {
  if (shouldRenderMobileApp()) {
    return <MobileApp />;
  }

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
