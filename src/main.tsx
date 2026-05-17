import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import { installPluginRuntime } from "./plugin-system/runtime";

// Install the plugin runtime singleton before rendering so any code path
// downstream (including builtin panels) sees a consistent `window.__POLARIS__`.
// Idempotent under Vite HMR.
installPluginRuntime();

const root = document.getElementById("root") as HTMLElement;

// Both Tauri desktop and Web (HTTP) modes render the main App directly.
// No token authentication required.
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
