import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

(() => {
  try {
    const stored = window.localStorage.getItem("pocket-theme");
    document.documentElement.setAttribute("data-theme", stored || "dark");
  } catch {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();

createRoot(document.getElementById("root")!).render(<App />);
