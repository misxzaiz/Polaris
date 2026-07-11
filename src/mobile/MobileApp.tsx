import { useState } from 'react';
import { MobileConnectionGate } from './MobileConnectionGate';
import { MobileShell } from './MobileShell';
import '../index.css';

type MobileTab = 'sessions' | 'tasks' | 'workspaces' | 'settings';

export default function MobileApp() {
  const [activeTab, setActiveTab] = useState<MobileTab>('sessions');

  // 多会话状态（Tab 条 / 激活会话）由 mobileMultiSessionStore 驱动，
  // 不再在 App 层持有 activeSession，避免 Tab 切换时清空。
  // 见 MobileSessions / MobileSessionTabs。

  const handleTabChange = (tab: MobileTab) => {
    setActiveTab(tab);
  };

  return (
    <MobileConnectionGate>
      {({ config, connected, serverUrl, openSettings }) => (
        <MobileShell
          activeTab={activeTab}
          config={config}
          connected={connected}
          serverUrl={serverUrl}
          onTabChange={handleTabChange}
          onOpenConnectionSettings={openSettings}
        />
      )}
    </MobileConnectionGate>
  );
}
