import { useState, useEffect, useCallback } from "react";
import { ChatPage } from "./pages/ChatPage";
import { HubPage } from "./pages/HubPage";
import { ImagesPage } from "./pages/ImagesPage";
import { TodoPage } from "./pages/TodoPage";
import { ConnectPage } from "./pages/ConnectPage";
import { SettingsPage } from "./pages/SettingsPage";

type Tab = "chat" | "hub" | "images" | "todo" | "connect" | "settings";

interface TabDef {
  id: Tab;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: "chat", label: "聊天", icon: "💬" },
  { id: "hub", label: "空间", icon: "🔖" },
  { id: "images", label: "画图", icon: "🎨" },
  { id: "todo", label: "待办", icon: "✓" },
  { id: "connect", label: "桌面", icon: "🔗" },
  { id: "settings", label: "设置", icon: "⚙" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const url = localStorage.getItem("pocket-server-url") || "";
    setConnected(!!url);
  }, []);

  const renderPage = () => {
    switch (tab) {
      case "chat":
        return <ChatPage />;
      case "hub":
        return <HubPage />;
      case "images":
        return <ImagesPage />;
      case "todo":
        return <TodoPage />;
      case "connect":
        return <ConnectPage onConnected={() => setConnected(true)} />;
      case "settings":
        return <SettingsPage />;
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background-base text-text-primary">
      {/* 顶部条 */}
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-background-elevated px-4 pb-2 pt-[calc(env(safe-area-inset-top)+8px)]">
        <span className="text-base font-semibold tracking-wide">Pocket</span>
        <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-success" : "bg-text-tertiary"}`} />
          <span>{connected ? "已连桌面" : "离线"}</span>
        </div>
      </header>

      {/* 主内容 */}
      <main className="flex-1 overflow-y-auto p-3 pb-[calc(env(safe-area-inset-bottom)+72px)]">
        {renderPage()}
      </main>

      {/* 底部导航 */}
      <nav className="fixed inset-x-0 bottom-0 border-t border-border bg-background-elevated/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm">
        <div className="grid grid-cols-6 gap-0 px-2 py-1.5">
          {TABS.map((t) => {
            const sel = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex flex-col items-center gap-0 rounded-lg px-1 py-1.5 text-[10px] transition-colors ${
                  sel ? "text-primary" : "text-text-tertiary"
                }`}
              >
                <span className="text-lg leading-5">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}