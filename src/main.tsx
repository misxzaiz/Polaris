import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TokenAuthPage } from "./components/WebAccess/TokenAuthPage";
import { detectTransport, initWebAuth, getStoredToken, getServerUrl, storeToken, storeServerUrl } from "./services/transport";
import "./i18n";

const root = document.getElementById("root") as HTMLElement;

if (detectTransport() === 'http') {
  const token = initWebAuth();

  if (!token) {
    // 无 token → 渲染认证页面
    const rootEl = ReactDOM.createRoot(root);
    rootEl.render(
      <React.StrictMode>
        <TokenAuthPage
          defaultServerUrl={getServerUrl()}
          onAuthSuccess={(serverUrl, newToken) => {
            storeToken(newToken);
            storeServerUrl(serverUrl);
            window.location.reload();
          }}
        />
      </React.StrictMode>,
    );
  } else {
    // 有 token → 正常渲染主应用
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
} else {
  // Tauri 桌面端 — 直接渲染
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
