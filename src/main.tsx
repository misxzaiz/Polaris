import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TokenAuthPage } from "./components/WebAccess/TokenAuthPage";
import { detectTransport, initWebAuth, getServerUrl, storeToken, storeServerUrl } from "./services/transport";
import "./i18n";

const root = document.getElementById("root") as HTMLElement;

if (detectTransport() === 'http') {
  const token = initWebAuth();

  if (token === null) {
    // 从未认证过 → 渲染认证页面
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
    // '' = auth disabled (no token needed) 或有实际 token → 正常渲染主应用
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
