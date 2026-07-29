import { useState, useEffect } from "react";
import { ChatPage } from "./pages/ChatPage";
import { SpacePage } from "./pages/SpacePage";
import { SettingsPage } from "./pages/SettingsPage";

type Tab = "chat" | "space" | "settings";

interface TabDef {
  id: Tab;
  label: string;
  /** 内联 SVG path（stroke 风格，受 currentColor 控制） */
  icon: string;
}

const TABS: TabDef[] = [
  { id: "chat", label: "AI", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  { id: "space", label: "空间", icon: "M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" },
  { id: "settings", label: "设置", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1.1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1.1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1.1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.1z" },
];

const TITLES: Record<Tab, string> = { chat: "AI 对话", space: "个人空间", settings: "设置" };

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");

  // 监听文件页"发送到 AI"导航事件
  useEffect(() => {
    const handler = () => setTab("chat");
    window.addEventListener("pocket-navigate-to-ai", handler);
    return () => window.removeEventListener("pocket-navigate-to-ai", handler);
  }, []);

  const renderPage = () => {
    switch (tab) {
      case "chat": return <ChatPage />;
      case "space": return <SpacePage />;
      case "settings": return <SettingsPage />;
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background-base text-text-primary">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-background-elevated px-4 pb-2.5 pt-[calc(env(safe-area-inset-top)+12px)]">
        <span className="text-[17px] font-semibold tracking-[0.3px]">{TITLES[tab]}</span>
        <span className="font-mono text-[10px] tracking-wide text-text-tertiary">POCKET</span>
      </header>

      {/* Main */}
      <main className="flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+76px)] pt-3.5">
        {renderPage()}
      </main>

      {/* Tab Bar */}
      <nav className="fixed inset-x-0 bottom-0 border-t border-border bg-background-elevated/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm">
        <div className="mx-auto grid max-w-[430px] grid-cols-3">
          {TABS.map((t) => {
            const sel = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative flex flex-col items-center gap-1 py-2 text-[10px] transition-colors ${sel ? "text-primary" : "text-text-tertiary"}`}
              >
                {sel && <span className="absolute left-1/2 top-0 h-[2px] w-[18px] -translate-x-1/2 rounded-full bg-primary" />}
                <svg viewBox="0 0 24 24" className={`h-[20px] w-[20px] fill-none stroke-current ${sel ? "stroke-[2px]" : "stroke-[1.7px]"}`} strokeLinecap="round" strokeLinejoin="round">
                  <path d={t.icon} />
                </svg>
                <span className={sel ? "font-medium" : ""}>{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
