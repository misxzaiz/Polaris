import React from "react";
import ReactDOM from "react-dom/client";
import * as ReactJSXRuntime from "react/jsx-runtime";
import App from "./App";
import "./i18n";

// 暴露宿主 React 给外部插件面板使用
;(window as any).__POLARIS_HOST_REACT__ = React;
;(window as any).__POLARIS_HOST_REACT_JSX__ = ReactJSXRuntime;

// 主题预设：在 React render 之前同步读取 localStorage 并写入 data-theme，防止首屏闪烁（FOUC）
(() => {
  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('theme') : null;
    const theme = stored === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

const root = document.getElementById("root") as HTMLElement;

// Both Tauri desktop and Web (HTTP) modes render the main App directly.
// No token authentication required.
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
