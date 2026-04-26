import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";

const root = document.getElementById("root") as HTMLElement;

// Both Tauri desktop and Web (HTTP) modes render the main App directly.
// No token authentication required.
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
